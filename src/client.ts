import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type CreateTerminalRequest,
  type CreateTerminalResponse,
  type InitializeResponse,
  type KillTerminalCommandRequest,
  type KillTerminalCommandResponse,
  type PromptResponse,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type ReleaseTerminalRequest,
  type ReleaseTerminalResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type TerminalOutputRequest,
  type TerminalOutputResponse,
  type WaitForTerminalExitRequest,
  type WaitForTerminalExitResponse,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
} from "@agentclientprotocol/sdk";
import { spawn, type ChildProcess, type ChildProcessByStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { classifyPermissionDecision, resolvePermissionRequest } from "./permissions.js";
import type { AcpClientOptions, PermissionStats } from "./types.js";

type CommandParts = {
  command: string;
  args: string[];
};

type InternalTerminal = {
  process: ChildProcessByStdio<null, Readable, Readable>;
  output: Buffer;
  truncated: boolean;
  outputByteLimit: number;
  exitCode: number | null | undefined;
  signal: NodeJS.Signals | null | undefined;
  waiters: Array<(response: WaitForTerminalExitResponse) => void>;
};

const DEFAULT_TERMINAL_OUTPUT_LIMIT_BYTES = 64 * 1024;
const REPLAY_IDLE_MS = 80;
const REPLAY_DRAIN_TIMEOUT_MS = 5_000;
const DRAIN_POLL_INTERVAL_MS = 20;

type LoadSessionOptions = {
  suppressReplayUpdates?: boolean;
  replayIdleMs?: number;
  replayDrainTimeoutMs?: number;
};

type AgentDisconnectReason =
  | "process_exit"
  | "process_close"
  | "pipe_close"
  | "connection_close";

export type AgentExitInfo = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  exitedAt: string;
  reason: AgentDisconnectReason;
  unexpectedDuringPrompt: boolean;
};

export type AgentLifecycleSnapshot = {
  pid?: number;
  startedAt?: string;
  running: boolean;
  lastExit?: AgentExitInfo;
};

function isoNow(): string {
  return new Date().toISOString();
}

function waitForSpawn(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSpawn = () => {
      child.off("error", onError);
      resolve();
    };
    const onError = (error: Error) => {
      child.off("spawn", onSpawn);
      reject(error);
    };

    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

function splitCommandLine(value: string): CommandParts {
  const parts: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;

  for (const ch of value) {
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }

    if (ch === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }

    if (/\s/.test(ch)) {
      if (current.length > 0) {
        parts.push(current);
        current = "";
      }
      continue;
    }

    current += ch;
  }

  if (escaping) {
    current += "\\";
  }

  if (quote) {
    throw new Error("Invalid --agent command: unterminated quote");
  }

  if (current.length > 0) {
    parts.push(current);
  }

  if (parts.length === 0) {
    throw new Error("Invalid --agent command: empty command");
  }

  return {
    command: parts[0],
    args: parts.slice(1),
  };
}

function asAbsoluteCwd(cwd: string): string {
  return path.resolve(cwd);
}

function toEnvObject(env: CreateTerminalRequest["env"]): NodeJS.ProcessEnv | undefined {
  if (!env || env.length === 0) {
    return undefined;
  }

  const merged: NodeJS.ProcessEnv = { ...process.env };
  for (const entry of env) {
    merged[entry.name] = entry.value;
  }
  return merged;
}

export class AcpClient {
  private readonly options: AcpClientOptions;
  private connection?: ClientSideConnection;
  private agent?: ChildProcessByStdio<Writable, Readable, Readable>;
  private initResult?: InitializeResponse;
  private readonly permissionStats: PermissionStats = {
    requested: 0,
    approved: 0,
    denied: 0,
    cancelled: 0,
  };
  private readonly terminals = new Map<string, InternalTerminal>();
  private sessionUpdateChain: Promise<void> = Promise.resolve();
  private observedSessionUpdates = 0;
  private processedSessionUpdates = 0;
  private suppressSessionUpdates = false;
  private activePrompt?: {
    sessionId: string;
    promise: Promise<PromptResponse>;
  };
  private readonly cancellingSessionIds = new Set<string>();
  private closing = false;
  private agentStartedAt?: string;
  private lastAgentExit?: AgentExitInfo;
  private lastKnownPid?: number;

  constructor(options: AcpClientOptions) {
    this.options = {
      ...options,
      cwd: asAbsoluteCwd(options.cwd),
    };
  }

  get initializeResult(): InitializeResponse | undefined {
    return this.initResult;
  }

  getAgentPid(): number | undefined {
    return this.agent?.pid ?? this.lastKnownPid;
  }

  getPermissionStats(): PermissionStats {
    return { ...this.permissionStats };
  }

  getAgentLifecycleSnapshot(): AgentLifecycleSnapshot {
    const pid = this.agent?.pid ?? this.lastKnownPid;
    const running =
      Boolean(this.agent) &&
      this.agent?.exitCode == null &&
      this.agent?.signalCode == null &&
      !this.agent?.killed;
    return {
      pid,
      startedAt: this.agentStartedAt,
      running,
      lastExit: this.lastAgentExit ? { ...this.lastAgentExit } : undefined,
    };
  }

  supportsLoadSession(): boolean {
    return Boolean(this.initResult?.agentCapabilities?.loadSession);
  }

  async start(): Promise<void> {
    if (this.connection && this.agent) {
      return;
    }

    const { command, args } = splitCommandLine(this.options.agentCommand);
    this.log(`spawning agent: ${command} ${args.join(" ")}`);

    const child = spawn(command, args, {
      cwd: this.options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    await waitForSpawn(child);
    this.closing = false;
    this.agentStartedAt = isoNow();
    this.lastAgentExit = undefined;
    this.lastKnownPid = child.pid ?? undefined;
    this.attachAgentLifecycleObservers(child);

    child.stderr.on("data", (chunk: Buffer | string) => {
      if (!this.options.verbose) {
        return;
      }
      process.stderr.write(chunk);
    });

    const input = Writable.toWeb(child.stdin);
    const output = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
    const stream = ndJsonStream(input, output);

    const connection = new ClientSideConnection(
      () => ({
        sessionUpdate: async (params: SessionNotification) => {
          await this.handleSessionUpdate(params);
        },
        requestPermission: async (
          params: RequestPermissionRequest,
        ): Promise<RequestPermissionResponse> => {
          return this.handlePermissionRequest(params);
        },
        readTextFile: async (
          params: ReadTextFileRequest,
        ): Promise<ReadTextFileResponse> => {
          return this.handleReadTextFile(params);
        },
        writeTextFile: async (
          params: WriteTextFileRequest,
        ): Promise<WriteTextFileResponse> => {
          return this.handleWriteTextFile(params);
        },
        createTerminal: async (
          params: CreateTerminalRequest,
        ): Promise<CreateTerminalResponse> => {
          return this.handleCreateTerminal(params);
        },
        terminalOutput: async (
          params: TerminalOutputRequest,
        ): Promise<TerminalOutputResponse> => {
          return this.handleTerminalOutput(params);
        },
        waitForTerminalExit: async (
          params: WaitForTerminalExitRequest,
        ): Promise<WaitForTerminalExitResponse> => {
          return this.handleWaitForTerminalExit(params);
        },
        killTerminal: async (
          params: KillTerminalCommandRequest,
        ): Promise<KillTerminalCommandResponse> => {
          return this.handleKillTerminal(params);
        },
        releaseTerminal: async (
          params: ReleaseTerminalRequest,
        ): Promise<ReleaseTerminalResponse> => {
          return this.handleReleaseTerminal(params);
        },
      }),
      stream,
    );
    connection.signal.addEventListener(
      "abort",
      () => {
        this.recordAgentExit(
          "connection_close",
          child.exitCode ?? null,
          child.signalCode ?? null,
        );
      },
      { once: true },
    );

    try {
      const initResult = await connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          fs: {
            readTextFile: true,
            writeTextFile: true,
          },
          terminal: true,
        },
        clientInfo: {
          name: "acpx",
          version: "0.1.0",
        },
      });

      this.connection = connection;
      this.agent = child;
      this.initResult = initResult;
      this.log(`initialized protocol version ${initResult.protocolVersion}`);
    } catch (error) {
      child.kill();
      throw error;
    }
  }

  async createSession(cwd = this.options.cwd): Promise<string> {
    const connection = this.getConnection();
    const result = await connection.newSession({
      cwd: asAbsoluteCwd(cwd),
      mcpServers: [],
    });
    return result.sessionId;
  }

  async loadSession(sessionId: string, cwd = this.options.cwd): Promise<void> {
    this.getConnection();
    await this.loadSessionWithOptions(sessionId, cwd, {});
  }

  async loadSessionWithOptions(
    sessionId: string,
    cwd = this.options.cwd,
    options: LoadSessionOptions = {},
  ): Promise<void> {
    const connection = this.getConnection();
    const previousSuppression = this.suppressSessionUpdates;
    this.suppressSessionUpdates =
      previousSuppression || Boolean(options.suppressReplayUpdates);

    try {
      await connection.loadSession({
        sessionId,
        cwd: asAbsoluteCwd(cwd),
        mcpServers: [],
      });

      await this.waitForSessionUpdateDrain(
        options.replayIdleMs ?? REPLAY_IDLE_MS,
        options.replayDrainTimeoutMs ?? REPLAY_DRAIN_TIMEOUT_MS,
      );
    } finally {
      this.suppressSessionUpdates = previousSuppression;
    }
  }

  async prompt(sessionId: string, text: string): Promise<PromptResponse> {
    const connection = this.getConnection();
    const promptPromise = connection.prompt({
      sessionId,
      prompt: [
        {
          type: "text",
          text,
        },
      ],
    });

    this.activePrompt = {
      sessionId,
      promise: promptPromise,
    };

    try {
      return await promptPromise;
    } finally {
      if (this.activePrompt?.promise === promptPromise) {
        this.activePrompt = undefined;
      }
      this.cancellingSessionIds.delete(sessionId);
    }
  }

  async cancel(sessionId: string): Promise<void> {
    const connection = this.getConnection();
    this.cancellingSessionIds.add(sessionId);
    await connection.cancel({
      sessionId,
    });
  }

  async cancelActivePrompt(waitMs = 2_500): Promise<PromptResponse | undefined> {
    const active = this.activePrompt;
    if (!active) {
      return undefined;
    }

    try {
      await this.cancel(active.sessionId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`failed to send session/cancel: ${message}`);
    }

    if (waitMs <= 0) {
      return undefined;
    }

    let timer: NodeJS.Timeout | number | undefined;
    const timeoutPromise = new Promise<undefined>((resolve) => {
      timer = setTimeout(resolve, waitMs);
    });

    try {
      return await Promise.race([
        active.promise.then(
          (response) => response,
          () => undefined,
        ),
        timeoutPromise,
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const terminalId of [...this.terminals.keys()]) {
      await this.releaseTerminalById(terminalId);
    }

    if (this.agent && !this.agent.killed) {
      this.agent.kill();
    }

    this.sessionUpdateChain = Promise.resolve();
    this.observedSessionUpdates = 0;
    this.processedSessionUpdates = 0;
    this.suppressSessionUpdates = false;
    this.activePrompt = undefined;
    this.cancellingSessionIds.clear();
    this.connection = undefined;
    this.agent = undefined;
  }

  private getConnection(): ClientSideConnection {
    if (!this.connection) {
      throw new Error("ACP client not started");
    }
    return this.connection;
  }

  private log(message: string): void {
    if (!this.options.verbose) {
      return;
    }
    process.stderr.write(`[acpx] ${message}\n`);
  }

  private async handlePermissionRequest(
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    if (this.cancellingSessionIds.has(params.sessionId)) {
      return {
        outcome: {
          outcome: "cancelled",
        },
      };
    }

    const response = await resolvePermissionRequest(
      params,
      this.options.permissionMode,
    );

    const decision = classifyPermissionDecision(params, response);
    this.permissionStats.requested += 1;
    if (decision === "approved") {
      this.permissionStats.approved += 1;
    } else if (decision === "denied") {
      this.permissionStats.denied += 1;
    } else {
      this.permissionStats.cancelled += 1;
    }

    return response;
  }

  private attachAgentLifecycleObservers(
    child: ChildProcessByStdio<Writable, Readable, Readable>,
  ): void {
    child.once("exit", (exitCode, signal) => {
      this.recordAgentExit("process_exit", exitCode, signal);
    });

    child.once("close", (exitCode, signal) => {
      this.recordAgentExit("process_close", exitCode, signal);
    });

    child.stdout.once("close", () => {
      this.recordAgentExit(
        "pipe_close",
        child.exitCode ?? null,
        child.signalCode ?? null,
      );
    });
  }

  private recordAgentExit(
    reason: AgentDisconnectReason,
    exitCode: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (this.lastAgentExit) {
      return;
    }

    this.lastAgentExit = {
      exitCode,
      signal,
      exitedAt: isoNow(),
      reason,
      unexpectedDuringPrompt: !this.closing && Boolean(this.activePrompt),
    };
  }

  private async handleReadTextFile(
    params: ReadTextFileRequest,
  ): Promise<ReadTextFileResponse> {
    const content = await fs.readFile(params.path, "utf8");
    if (params.line == null && params.limit == null) {
      return { content };
    }

    const lines = content.split("\n");
    const start = Math.max(0, (params.line ?? 1) - 1);
    const end = params.limit == null ? lines.length : start + Math.max(params.limit, 0);
    return {
      content: lines.slice(start, end).join("\n"),
    };
  }

  private async handleWriteTextFile(
    params: WriteTextFileRequest,
  ): Promise<WriteTextFileResponse> {
    await fs.mkdir(path.dirname(params.path), { recursive: true });
    await fs.writeFile(params.path, params.content, "utf8");
    return {};
  }

  private async handleCreateTerminal(
    params: CreateTerminalRequest,
  ): Promise<CreateTerminalResponse> {
    const outputByteLimit = Math.max(
      1,
      params.outputByteLimit ?? DEFAULT_TERMINAL_OUTPUT_LIMIT_BYTES,
    );

    const proc = spawn(params.command, params.args ?? [], {
      cwd: params.cwd ?? this.options.cwd,
      env: toEnvObject(params.env),
      stdio: ["ignore", "pipe", "pipe"],
    });

    await waitForSpawn(proc);

    const terminalId = randomUUID();
    const terminal: InternalTerminal = {
      process: proc,
      output: Buffer.alloc(0),
      truncated: false,
      outputByteLimit,
      exitCode: undefined,
      signal: undefined,
      waiters: [],
    };

    const appendOutput = (chunk: Buffer | string): void => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      terminal.output = Buffer.concat([terminal.output, buf]);

      if (terminal.output.length > terminal.outputByteLimit) {
        terminal.output = terminal.output.subarray(
          terminal.output.length - terminal.outputByteLimit,
        );
        terminal.truncated = true;
      }
    };

    proc.stdout.on("data", appendOutput);
    proc.stderr.on("data", appendOutput);

    proc.once("exit", (exitCode, signal) => {
      terminal.exitCode = exitCode;
      terminal.signal = signal;
      const response: WaitForTerminalExitResponse = {
        exitCode: exitCode ?? null,
        signal: signal ?? null,
      };
      for (const waiter of terminal.waiters.splice(0)) {
        waiter(response);
      }
    });

    this.terminals.set(terminalId, terminal);
    return { terminalId };
  }

  private async handleTerminalOutput(
    params: TerminalOutputRequest,
  ): Promise<TerminalOutputResponse> {
    const terminal = this.getTerminal(params.terminalId);
    if (!terminal) {
      throw new Error(`Unknown terminal: ${params.terminalId}`);
    }

    const hasExitStatus =
      terminal.exitCode !== undefined || terminal.signal !== undefined;

    return {
      output: terminal.output.toString("utf8"),
      truncated: terminal.truncated,
      exitStatus: hasExitStatus
        ? {
            exitCode: terminal.exitCode ?? null,
            signal: terminal.signal ?? null,
          }
        : undefined,
    };
  }

  private async handleWaitForTerminalExit(
    params: WaitForTerminalExitRequest,
  ): Promise<WaitForTerminalExitResponse> {
    const terminal = this.getTerminal(params.terminalId);
    if (!terminal) {
      throw new Error(`Unknown terminal: ${params.terminalId}`);
    }

    if (terminal.exitCode !== undefined || terminal.signal !== undefined) {
      return {
        exitCode: terminal.exitCode ?? null,
        signal: terminal.signal ?? null,
      };
    }

    return new Promise<WaitForTerminalExitResponse>((resolve) => {
      terminal.waiters.push(resolve);
    });
  }

  private async handleKillTerminal(
    params: KillTerminalCommandRequest,
  ): Promise<KillTerminalCommandResponse> {
    const terminal = this.getTerminal(params.terminalId);
    if (!terminal) {
      throw new Error(`Unknown terminal: ${params.terminalId}`);
    }

    if (!terminal.process.killed) {
      terminal.process.kill();
    }

    return {};
  }

  private async handleReleaseTerminal(
    params: ReleaseTerminalRequest,
  ): Promise<ReleaseTerminalResponse> {
    await this.releaseTerminalById(params.terminalId);
    return {};
  }

  private async releaseTerminalById(terminalId: string): Promise<void> {
    const terminal = this.getTerminal(terminalId);
    if (!terminal) {
      return;
    }

    if (!terminal.process.killed) {
      terminal.process.kill();
    }

    this.terminals.delete(terminalId);
  }

  private getTerminal(terminalId: string): InternalTerminal | undefined {
    return this.terminals.get(terminalId);
  }

  private async handleSessionUpdate(notification: SessionNotification): Promise<void> {
    const sequence = ++this.observedSessionUpdates;
    this.sessionUpdateChain = this.sessionUpdateChain.then(async () => {
      try {
        if (!this.suppressSessionUpdates) {
          this.options.onSessionUpdate?.(notification);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log(`session update handler failed: ${message}`);
      } finally {
        this.processedSessionUpdates = sequence;
      }
    });

    await this.sessionUpdateChain;
  }

  private async waitForSessionUpdateDrain(
    idleMs: number,
    timeoutMs: number,
  ): Promise<void> {
    const normalizedIdleMs = Math.max(0, idleMs);
    const normalizedTimeoutMs = Math.max(normalizedIdleMs, timeoutMs);
    const deadline = Date.now() + normalizedTimeoutMs;
    let lastObserved = this.observedSessionUpdates;
    let idleSince = Date.now();

    while (Date.now() <= deadline) {
      const observed = this.observedSessionUpdates;
      if (observed !== lastObserved) {
        lastObserved = observed;
        idleSince = Date.now();
      }

      if (
        this.processedSessionUpdates === this.observedSessionUpdates &&
        Date.now() - idleSince >= normalizedIdleMs
      ) {
        await this.sessionUpdateChain;
        if (this.processedSessionUpdates === this.observedSessionUpdates) {
          return;
        }
      }

      await new Promise<void>((resolve) => {
        setTimeout(resolve, DRAIN_POLL_INTERVAL_MS);
      });
    }

    throw new Error(
      `Timed out waiting for session replay drain after ${normalizedTimeoutMs}ms`,
    );
  }
}
