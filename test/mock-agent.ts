#!/usr/bin/env node

import {
  AgentSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type Agent,
  type AgentSideConnection as AgentConnection,
  type ContentBlock,
  type InitializeResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type SessionId,
} from "@agentclientprotocol/sdk";
import { randomUUID } from "node:crypto";
import { Readable, Writable } from "node:stream";

type ParsedCommand = {
  command: string;
  args: string[];
};

type MockAgentOptions = {
  newSessionMeta?: Record<string, string>;
  loadSessionMeta?: Record<string, string>;
  supportsLoadSession: boolean;
  loadSessionInternalNotFound?: boolean;
  requireLoadSessionId?: string;
};

type SessionState = {
  pendingPrompt?: AbortController;
};

class CancelledError extends Error {
  constructor() {
    super("cancelled");
    this.name = "CancelledError";
  }
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (error && typeof error === "object") {
    const fromMessage = (error as { message?: unknown }).message;
    if (typeof fromMessage === "string" && fromMessage.trim().length > 0) {
      return fromMessage;
    }

    const fromNested = (
      error as {
        error?: {
          message?: unknown;
        };
      }
    ).error?.message;
    if (typeof fromNested === "string" && fromNested.trim().length > 0) {
      return fromNested;
    }

    try {
      return JSON.stringify(error);
    } catch {
      // ignore serialization failure and fall through
    }
  }
  return String(error);
}

function getPromptText(prompt: ContentBlock[]): string {
  const parts: string[] = [];

  for (const block of prompt) {
    if (block.type === "text") {
      parts.push(block.text);
    }
  }

  return parts.join("").trim();
}

function splitCommandLine(value: string): ParsedCommand {
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
    throw new Error(`Invalid command line: ${value}`);
  }

  if (current.length > 0) {
    parts.push(current);
  }

  if (parts.length === 0) {
    throw new Error("Command is required");
  }

  return {
    command: parts[0],
    args: parts.slice(1),
  };
}

function assertNotCancelled(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new CancelledError();
  }
}

async function sleepWithCancel(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return;
  }

  assertNotCancelled(signal);

  await new Promise<void>((resolve, reject) => {
    let settled = false;

    const finish = (run: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener("abort", onAbort);
      run();
    };

    const onAbort = () => {
      finish(() => reject(new CancelledError()));
    };

    const timer = setTimeout(() => {
      finish(() => resolve());
    }, ms);

    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        onAbort();
      },
      { once: true },
    );
  });
}

function parseOptionValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${flag} requires a non-empty value`);
  }
  return value.trim();
}

type MetaFlagTarget = "newSessionMeta" | "loadSessionMeta";

type MetaFlagSpec = {
  target: MetaFlagTarget;
  key: string;
  supportsLoadSession?: boolean;
};

const META_FLAG_SPECS: Record<string, MetaFlagSpec> = {
  "--agent-session-id": {
    target: "newSessionMeta",
    key: "agentSessionId",
  },
  "--meta-session-id": {
    target: "newSessionMeta",
    key: "sessionId",
  },
  "--load-agent-session-id": {
    target: "loadSessionMeta",
    key: "agentSessionId",
    supportsLoadSession: true,
  },
  "--load-meta-session-id": {
    target: "loadSessionMeta",
    key: "sessionId",
    supportsLoadSession: true,
  },
};

function parseMockAgentOptions(argv: string[]): MockAgentOptions {
  const newSessionMeta: Record<string, string> = {};
  const loadSessionMeta: Record<string, string> = {};
  let supportsLoadSession = false;
  let loadSessionInternalNotFound = false;
  let requireLoadSessionId: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === "--supports-load-session") {
      supportsLoadSession = true;
      continue;
    }

    if (token === "--load-internal-session-not-found") {
      supportsLoadSession = true;
      loadSessionInternalNotFound = true;
      continue;
    }

    if (token === "--require-load-session-id") {
      supportsLoadSession = true;
      requireLoadSessionId = parseOptionValue(argv, index + 1, token);
      index += 1;
      continue;
    }

    const metaFlag = META_FLAG_SPECS[token];
    if (metaFlag) {
      const value = parseOptionValue(argv, index + 1, token);
      if (metaFlag.target === "newSessionMeta") {
        newSessionMeta[metaFlag.key] = value;
      } else {
        loadSessionMeta[metaFlag.key] = value;
      }
      if (metaFlag.supportsLoadSession) {
        supportsLoadSession = true;
      }
      index += 1;
      continue;
    }

    throw new Error(`Unknown mock-agent option: ${token}`);
  }

  return {
    newSessionMeta:
      Object.keys(newSessionMeta).length > 0 ? { ...newSessionMeta } : undefined,
    loadSessionMeta:
      Object.keys(loadSessionMeta).length > 0 ? { ...loadSessionMeta } : undefined,
    supportsLoadSession,
    loadSessionInternalNotFound,
    requireLoadSessionId,
  };
}

class MockAgent implements Agent {
  private readonly connection: AgentConnection;
  private readonly sessions = new Map<SessionId, SessionState>();
  private readonly options: MockAgentOptions;

  constructor(connection: AgentConnection, options: MockAgentOptions) {
    this.connection = connection;
    this.options = options;
  }

  async initialize(): Promise<InitializeResponse> {
    return {
      protocolVersion: PROTOCOL_VERSION,
      authMethods: [],
      agentCapabilities: this.options.supportsLoadSession ? { loadSession: true } : {},
    };
  }

  async authenticate(): Promise<void> {
    return;
  }

  async newSession(): Promise<NewSessionResponse> {
    const sessionId = randomUUID();
    this.sessions.set(sessionId, {});

    if (this.options.newSessionMeta) {
      return {
        sessionId,
        _meta: { ...this.options.newSessionMeta },
      };
    }

    return { sessionId };
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    if (!this.options.supportsLoadSession) {
      throw new Error("loadSession is not supported");
    }

    if (
      this.options.requireLoadSessionId &&
      params.sessionId !== this.options.requireLoadSessionId
    ) {
      throw new Error(JSON.stringify({ details: "Session not found" }));
    }

    if (this.options.loadSessionInternalNotFound) {
      throw new Error(JSON.stringify({ details: "Session not found" }));
    }

    this.sessions.set(params.sessionId, this.sessions.get(params.sessionId) ?? {});

    if (this.options.loadSessionMeta) {
      return {
        _meta: { ...this.options.loadSessionMeta },
      };
    }

    return {};
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw new Error(`Unknown session: ${params.sessionId}`);
    }

    session.pendingPrompt?.abort();
    const promptAbort = new AbortController();
    session.pendingPrompt = promptAbort;

    try {
      const text = getPromptText(params.prompt);
      const response = await this.handlePrompt(
        params.sessionId,
        text,
        promptAbort.signal,
      );
      await this.sendAssistantMessage(params.sessionId, response);
      return { stopReason: "end_turn" };
    } catch (error) {
      if (promptAbort.signal.aborted || error instanceof CancelledError) {
        return { stopReason: "cancelled" };
      }

      await this.sendAssistantMessage(
        params.sessionId,
        `error: ${toErrorMessage(error)}`,
      );
      return { stopReason: "end_turn" };
    } finally {
      if (session.pendingPrompt === promptAbort) {
        session.pendingPrompt = undefined;
      }
    }
  }

  async cancel(params: { sessionId: SessionId }): Promise<void> {
    this.sessions.get(params.sessionId)?.pendingPrompt?.abort();
  }

  private async sendAssistantMessage(
    sessionId: SessionId,
    text: string,
  ): Promise<void> {
    await this.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text,
        },
      },
    });
  }

  private async handlePrompt(
    sessionId: SessionId,
    text: string,
    signal: AbortSignal,
  ): Promise<string> {
    assertNotCancelled(signal);

    if (text.startsWith("echo ")) {
      return text.slice("echo ".length);
    }
    if (text === "echo") {
      return "";
    }

    if (text.startsWith("read ")) {
      const filePath = text.slice("read ".length).trim();
      if (!filePath) {
        throw new Error("Usage: read <path>");
      }

      const readResult = await this.connection.readTextFile({
        sessionId,
        path: filePath,
      });
      return readResult.content;
    }

    if (text.startsWith("write ")) {
      const rest = text.slice("write ".length).trim();
      const firstSpace = rest.search(/\s/);

      if (firstSpace <= 0) {
        throw new Error("Usage: write <path> <content>");
      }

      const filePath = rest.slice(0, firstSpace).trim();
      const content = rest.slice(firstSpace + 1);

      await this.connection.writeTextFile({
        sessionId,
        path: filePath,
        content,
      });

      return `wrote ${filePath}`;
    }

    if (text.startsWith("terminal ")) {
      const rawCommand = text.slice("terminal ".length).trim();
      if (!rawCommand) {
        throw new Error("Usage: terminal <command>");
      }

      return await this.runTerminalCommand(sessionId, rawCommand, signal);
    }

    if (text.startsWith("sleep ")) {
      const rawMs = text.slice("sleep ".length).trim();
      if (!rawMs) {
        throw new Error("Usage: sleep <milliseconds>");
      }

      const ms = Number(rawMs);
      if (!Number.isFinite(ms) || ms < 0) {
        throw new Error("Usage: sleep <milliseconds>");
      }

      await sleepWithCancel(Math.round(ms), signal);
      return `slept ${Math.round(ms)}ms`;
    }

    if (text.startsWith("kill-terminal ")) {
      const rawCommand = text.slice("kill-terminal ".length).trim();
      if (!rawCommand) {
        throw new Error("Usage: kill-terminal <command>");
      }

      return await this.runKillTerminalCommand(sessionId, rawCommand, signal);
    }

    return `unrecognized prompt: ${text}`;
  }

  private async runTerminalCommand(
    sessionId: SessionId,
    rawCommand: string,
    signal: AbortSignal,
  ): Promise<string> {
    const { command, args } = splitCommandLine(rawCommand);
    const terminal = await this.connection.createTerminal({
      sessionId,
      command,
      args,
    });

    try {
      let outputSnapshot = await terminal.currentOutput();
      for (let attempt = 0; attempt < 6; attempt += 1) {
        assertNotCancelled(signal);
        if (outputSnapshot.exitStatus) {
          break;
        }

        await sleepWithCancel(40, signal);
        outputSnapshot = await terminal.currentOutput();
      }

      const exitStatus = await terminal.waitForExit();
      const finalOutput = await terminal.currentOutput();

      return [
        finalOutput.output.trimEnd(),
        `exit: ${exitStatus.exitCode ?? "null"} signal: ${exitStatus.signal ?? "null"}`,
      ]
        .filter((line) => line.length > 0)
        .join("\n");
    } finally {
      await terminal.release();
    }
  }

  private async runKillTerminalCommand(
    sessionId: SessionId,
    rawCommand: string,
    signal: AbortSignal,
  ): Promise<string> {
    const { command, args } = splitCommandLine(rawCommand);
    const terminal = await this.connection.createTerminal({
      sessionId,
      command,
      args,
    });

    try {
      await sleepWithCancel(120, signal);
      await terminal.kill();
      const exitStatus = await terminal.waitForExit();
      const finalOutput = await terminal.currentOutput();

      return [
        `killed terminal`,
        `exit: ${exitStatus.exitCode ?? "null"} signal: ${exitStatus.signal ?? "null"}`,
        finalOutput.output.trimEnd(),
      ]
        .filter((line) => line.length > 0)
        .join("\n");
    } finally {
      await terminal.release();
    }
  }
}

const output = Writable.toWeb(process.stdout);
const input = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
const stream = ndJsonStream(output, input);
const mockAgentOptions = parseMockAgentOptions(process.argv.slice(2));
new AgentSideConnection(
  (connection) => new MockAgent(connection, mockAgentOptions),
  stream,
);
