import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type AnyMessage,
  type AuthMethod,
  type CreateTerminalRequest,
  type CreateTerminalResponse,
  type InitializeResponse,
  type KillTerminalCommandRequest,
  type KillTerminalCommandResponse,
  type LoadSessionResponse,
  type PromptResponse,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type ReleaseTerminalRequest,
  type ReleaseTerminalResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type SetSessionConfigOptionResponse,
  type TerminalOutputRequest,
  type TerminalOutputResponse,
  type WaitForTerminalExitRequest,
  type WaitForTerminalExitResponse,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
} from "@agentclientprotocol/sdk";
import { spawn, type ChildProcess, type ChildProcessByStdio } from "node:child_process";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import {
  AgentSpawnError,
  AuthPolicyError,
  PermissionPromptUnavailableError,
} from "./errors.js";
import { isSessionUpdateNotification } from "./acp-jsonrpc.js";
import { FileSystemHandlers } from "./filesystem.js";
import { classifyPermissionDecision, resolvePermissionRequest } from "./permissions.js";
import { extractRuntimeSessionId } from "./runtime-session-id.js";
import { TerminalManager } from "./terminal.js";
import type { AcpClientOptions, PermissionStats } from "./types.js";

type CommandParts = {
  command: string;
  args: string[];
};

const REPLAY_IDLE_MS = 80;
const REPLAY_DRAIN_TIMEOUT_MS = 5_000;
const DRAIN_POLL_INTERVAL_MS = 20;

type LoadSessionOptions = {
  suppressReplayUpdates?: boolean;
  replayIdleMs?: number;
  replayDrainTimeoutMs?: number;
};

export type SessionCreateResult = {
  sessionId: string;
  agentSessionId?: string;
};

export type SessionLoadResult = {
  agentSessionId?: string;
};

type AgentDisconnectReason =
  | "process_exit"
  | "process_close"
  | "pipe_close"
  | "connection_close";

type AuthSelection = {
  methodId: string;
  credential: string;
  source: "env" | "config";
};

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

type ConsoleErrorMethod = typeof console.error;

function shouldSuppressSdkConsoleError(args: unknown[]): boolean {
  if (args.length === 0) {
    return false;
  }
  return typeof args[0] === "string" && args[0] === "Error handling request";
}

function installSdkConsoleErrorSuppression(): () => void {
  const originalConsoleError: ConsoleErrorMethod = console.error;
  console.error = (...args: unknown[]) => {
    if (shouldSuppressSdkConsoleError(args)) {
      return;
    }
    originalConsoleError(...args);
  };
  return () => {
    console.error = originalConsoleError;
  };
}

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

function toEnvToken(value: string): string {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}

function authEnvKeys(methodId: string): string[] {
  const token = toEnvToken(methodId);
  const keys = new Set<string>([methodId]);
  if (token) {
    keys.add(token);
    keys.add(`ACPX_AUTH_${token}`);
  }
  return [...keys];
}

function readEnvCredential(methodId: string): string | undefined {
  for (const key of authEnvKeys(methodId)) {
    const value = process.env[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

function buildAgentEnvironment(
  authCredentials: Record<string, string> | undefined,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (!authCredentials) {
    return env;
  }

  for (const [methodId, credential] of Object.entries(authCredentials)) {
    if (typeof credential !== "string" || credential.trim().length === 0) {
      continue;
    }

    if (
      !methodId.includes("=") &&
      !methodId.includes("\u0000") &&
      env[methodId] == null
    ) {
      env[methodId] = credential;
    }

    const normalized = toEnvToken(methodId);
    if (normalized) {
      const prefixed = `ACPX_AUTH_${normalized}`;
      if (env[prefixed] == null) {
        env[prefixed] = credential;
      }
      if (env[normalized] == null) {
        env[normalized] = credential;
      }
    }
  }

  return env;
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
  private readonly filesystem: FileSystemHandlers;
  private readonly terminalManager: TerminalManager;
  private sessionUpdateChain: Promise<void> = Promise.resolve();
  private observedSessionUpdates = 0;
  private processedSessionUpdates = 0;
  private suppressSessionUpdates = false;
  private suppressReplaySessionUpdateMessages = false;
  private activePrompt?: {
    sessionId: string;
    promise: Promise<PromptResponse>;
  };
  private readonly cancellingSessionIds = new Set<string>();
  private closing = false;
  private agentStartedAt?: string;
  private lastAgentExit?: AgentExitInfo;
  private lastKnownPid?: number;
  private readonly promptPermissionFailures = new Map<
    string,
    PermissionPromptUnavailableError
  >();

  constructor(options: AcpClientOptions) {
    this.options = {
      ...options,
      cwd: asAbsoluteCwd(options.cwd),
      authPolicy: options.authPolicy ?? "skip",
    };

    const emitOperation = this.options.onClientOperation;
    this.filesystem = new FileSystemHandlers({
      cwd: this.options.cwd,
      permissionMode: this.options.permissionMode,
      nonInteractivePermissions: this.options.nonInteractivePermissions,
      onOperation: emitOperation,
    });
    this.terminalManager = new TerminalManager({
      cwd: this.options.cwd,
      permissionMode: this.options.permissionMode,
      nonInteractivePermissions: this.options.nonInteractivePermissions,
      onOperation: emitOperation,
    });
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

  hasActivePrompt(sessionId?: string): boolean {
    if (!this.activePrompt) {
      return false;
    }
    if (sessionId == null) {
      return true;
    }
    return this.activePrompt.sessionId === sessionId;
  }

  async start(): Promise<void> {
    if (this.connection && this.agent) {
      return;
    }

    const { command, args } = splitCommandLine(this.options.agentCommand);
    this.log(`spawning agent: ${command} ${args.join(" ")}`);

    const child = spawn(command, args, {
      cwd: this.options.cwd,
      env: buildAgentEnvironment(this.options.authCredentials),
      stdio: ["pipe", "pipe", "pipe"],
    });

    try {
      await waitForSpawn(child);
    } catch (error) {
      throw new AgentSpawnError(this.options.agentCommand, error);
    }
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
    const stream = this.createTappedStream(ndJsonStream(input, output));

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

      await this.authenticateIfRequired(connection, initResult.authMethods ?? []);

      this.connection = connection;
      this.agent = child;
      this.initResult = initResult;
      this.log(`initialized protocol version ${initResult.protocolVersion}`);
    } catch (error) {
      child.kill();
      throw error;
    }
  }

  private createTappedStream(base: {
    readable: ReadableStream<AnyMessage>;
    writable: WritableStream<AnyMessage>;
  }): {
    readable: ReadableStream<AnyMessage>;
    writable: WritableStream<AnyMessage>;
  } {
    const onAcpMessage = this.options.onAcpMessage;
    const onAcpOutputMessage = this.options.onAcpOutputMessage;

    if (!onAcpMessage && !onAcpOutputMessage) {
      return base;
    }

    const shouldSuppressInboundReplaySessionUpdate = (message: AnyMessage): boolean => {
      return (
        this.suppressReplaySessionUpdateMessages && isSessionUpdateNotification(message)
      );
    };

    const readable = new ReadableStream<AnyMessage>({
      async start(controller) {
        const reader = base.readable.getReader();
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) {
              break;
            }
            if (!value) {
              continue;
            }
            if (!shouldSuppressInboundReplaySessionUpdate(value)) {
              onAcpOutputMessage?.("inbound", value);
              onAcpMessage?.("inbound", value);
            }
            controller.enqueue(value);
          }
        } finally {
          reader.releaseLock();
          controller.close();
        }
      },
    });

    const writable = new WritableStream<AnyMessage>({
      async write(message) {
        onAcpOutputMessage?.("outbound", message);
        onAcpMessage?.("outbound", message);
        const writer = base.writable.getWriter();
        try {
          await writer.write(message);
        } finally {
          writer.releaseLock();
        }
      },
    });

    return { readable, writable };
  }

  async createSession(cwd = this.options.cwd): Promise<SessionCreateResult> {
    const connection = this.getConnection();
    const result = await connection.newSession({
      cwd: asAbsoluteCwd(cwd),
      mcpServers: [],
    });
    return {
      sessionId: result.sessionId,
      agentSessionId: extractRuntimeSessionId(result._meta),
    };
  }

  async loadSession(
    sessionId: string,
    cwd = this.options.cwd,
  ): Promise<SessionLoadResult> {
    this.getConnection();
    return await this.loadSessionWithOptions(sessionId, cwd, {});
  }

  async loadSessionWithOptions(
    sessionId: string,
    cwd = this.options.cwd,
    options: LoadSessionOptions = {},
  ): Promise<SessionLoadResult> {
    const connection = this.getConnection();
    const previousSuppression = this.suppressSessionUpdates;
    const previousReplaySuppression = this.suppressReplaySessionUpdateMessages;
    this.suppressSessionUpdates =
      previousSuppression || Boolean(options.suppressReplayUpdates);
    this.suppressReplaySessionUpdateMessages =
      previousReplaySuppression || Boolean(options.suppressReplayUpdates);

    let response: LoadSessionResponse | undefined;

    try {
      response = await connection.loadSession({
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
      this.suppressReplaySessionUpdateMessages = previousReplaySuppression;
    }

    return {
      agentSessionId: extractRuntimeSessionId(response?._meta),
    };
  }

  async prompt(sessionId: string, text: string): Promise<PromptResponse> {
    const connection = this.getConnection();
    const restoreConsoleError = this.options.suppressSdkConsoleErrors
      ? installSdkConsoleErrorSuppression()
      : undefined;

    let promptPromise: Promise<PromptResponse>;
    try {
      promptPromise = connection.prompt({
        sessionId,
        prompt: [
          {
            type: "text",
            text,
          },
        ],
      });
    } catch (error) {
      restoreConsoleError?.();
      throw error;
    }

    this.activePrompt = {
      sessionId,
      promise: promptPromise,
    };

    try {
      const response = await promptPromise;
      const permissionFailure = this.consumePromptPermissionFailure(sessionId);
      if (permissionFailure) {
        throw permissionFailure;
      }
      return response;
    } catch (error) {
      const permissionFailure = this.consumePromptPermissionFailure(sessionId);
      if (permissionFailure) {
        throw permissionFailure;
      }
      throw error;
    } finally {
      restoreConsoleError?.();
      if (this.activePrompt?.promise === promptPromise) {
        this.activePrompt = undefined;
      }
      this.cancellingSessionIds.delete(sessionId);
      this.promptPermissionFailures.delete(sessionId);
    }
  }

  async setSessionMode(sessionId: string, modeId: string): Promise<void> {
    const connection = this.getConnection();
    await connection.setSessionMode({
      sessionId,
      modeId,
    });
  }

  async setSessionConfigOption(
    sessionId: string,
    configId: string,
    value: string,
  ): Promise<SetSessionConfigOptionResponse> {
    const connection = this.getConnection();
    return await connection.setSessionConfigOption({
      sessionId,
      configId,
      value,
    });
  }

  async cancel(sessionId: string): Promise<void> {
    const connection = this.getConnection();
    this.cancellingSessionIds.add(sessionId);
    await connection.cancel({
      sessionId,
    });
  }

  async requestCancelActivePrompt(): Promise<boolean> {
    const active = this.activePrompt;
    if (!active) {
      return false;
    }
    await this.cancel(active.sessionId);
    return true;
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

    await this.terminalManager.shutdown();

    const agent = this.agent;
    if (agent) {
      // Some adapters keep stdio handles alive after SIGTERM; explicitly
      // destroy/unref so CLI calls can exit deterministically.
      if (!agent.killed) {
        agent.kill();
      }
      this.detachAgentHandles(agent);
    }

    this.sessionUpdateChain = Promise.resolve();
    this.observedSessionUpdates = 0;
    this.processedSessionUpdates = 0;
    this.suppressSessionUpdates = false;
    this.suppressReplaySessionUpdateMessages = false;
    this.activePrompt = undefined;
    this.cancellingSessionIds.clear();
    this.promptPermissionFailures.clear();
    this.connection = undefined;
    this.agent = undefined;
  }

  private detachAgentHandles(agent: ChildProcess): void {
    const stdin = agent.stdin as Writable | null;
    const stdout = agent.stdout as Readable | null;
    const stderr = agent.stderr as Readable | null;

    stdin?.destroy();
    stdout?.destroy();
    stderr?.destroy();

    try {
      agent.unref();
    } catch {
      // best effort
    }
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

  private selectAuthMethod(methods: AuthMethod[]): AuthSelection | undefined {
    const configCredentials = this.options.authCredentials ?? {};

    for (const method of methods) {
      const envCredential = readEnvCredential(method.id);
      if (envCredential) {
        return {
          methodId: method.id,
          credential: envCredential,
          source: "env",
        };
      }

      const configCredential =
        configCredentials[method.id] ?? configCredentials[toEnvToken(method.id)];
      if (typeof configCredential === "string" && configCredential.trim().length > 0) {
        return {
          methodId: method.id,
          credential: configCredential,
          source: "config",
        };
      }
    }

    return undefined;
  }

  private async authenticateIfRequired(
    connection: ClientSideConnection,
    methods: AuthMethod[],
  ): Promise<void> {
    if (methods.length === 0) {
      return;
    }

    const selected = this.selectAuthMethod(methods);
    if (!selected) {
      if (this.options.authPolicy === "fail") {
        throw new AuthPolicyError(
          `agent advertised auth methods [${methods.map((m) => m.id).join(", ")}] but no matching credentials found`,
        );
      }

      this.log(
        `agent advertised auth methods [${methods.map((m) => m.id).join(", ")}] but no matching credentials found — skipping (agent may handle auth internally)`,
      );
      return;
    }

    await connection.authenticate({
      methodId: selected.methodId,
    });

    this.log(`authenticated with method ${selected.methodId} (${selected.source})`);
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

    let response: RequestPermissionResponse;
    try {
      response = await resolvePermissionRequest(
        params,
        this.options.permissionMode,
        this.options.nonInteractivePermissions ?? "deny",
      );
    } catch (error) {
      if (error instanceof PermissionPromptUnavailableError) {
        this.notePromptPermissionFailure(params.sessionId, error);
        this.permissionStats.requested += 1;
        this.permissionStats.cancelled += 1;
        return {
          outcome: {
            outcome: "cancelled",
          },
        };
      }
      throw error;
    }

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

  private notePromptPermissionFailure(
    sessionId: string,
    error: PermissionPromptUnavailableError,
  ): void {
    if (!this.promptPermissionFailures.has(sessionId)) {
      this.promptPermissionFailures.set(sessionId, error);
    }
  }

  private consumePromptPermissionFailure(
    sessionId: string,
  ): PermissionPromptUnavailableError | undefined {
    const error = this.promptPermissionFailures.get(sessionId);
    if (error) {
      this.promptPermissionFailures.delete(sessionId);
    }
    return error;
  }

  private async handleReadTextFile(
    params: ReadTextFileRequest,
  ): Promise<ReadTextFileResponse> {
    return await this.filesystem.readTextFile(params);
  }

  private async handleWriteTextFile(
    params: WriteTextFileRequest,
  ): Promise<WriteTextFileResponse> {
    try {
      return await this.filesystem.writeTextFile(params);
    } catch (error) {
      if (error instanceof PermissionPromptUnavailableError) {
        this.notePromptPermissionFailure(params.sessionId, error);
      }
      throw error;
    }
  }

  private async handleCreateTerminal(
    params: CreateTerminalRequest,
  ): Promise<CreateTerminalResponse> {
    try {
      return await this.terminalManager.createTerminal(params);
    } catch (error) {
      if (error instanceof PermissionPromptUnavailableError) {
        this.notePromptPermissionFailure(params.sessionId, error);
      }
      throw error;
    }
  }

  private async handleTerminalOutput(
    params: TerminalOutputRequest,
  ): Promise<TerminalOutputResponse> {
    return await this.terminalManager.terminalOutput(params);
  }

  private async handleWaitForTerminalExit(
    params: WaitForTerminalExitRequest,
  ): Promise<WaitForTerminalExitResponse> {
    return await this.terminalManager.waitForTerminalExit(params);
  }

  private async handleKillTerminal(
    params: KillTerminalCommandRequest,
  ): Promise<KillTerminalCommandResponse> {
    return await this.terminalManager.killTerminal(params);
  }

  private async handleReleaseTerminal(
    params: ReleaseTerminalRequest,
  ): Promise<ReleaseTerminalResponse> {
    return await this.terminalManager.releaseTerminal(params);
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
