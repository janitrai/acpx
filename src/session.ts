import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AcpClient } from "./client.js";
import type {
  OutputFormatter,
  PermissionMode,
  RunPromptResult,
  SessionRecord,
  SessionSendResult,
} from "./types.js";

const SESSION_BASE_DIR = path.join(os.homedir(), ".acpx", "sessions");
const PROCESS_EXIT_GRACE_MS = 1_500;
const PROCESS_POLL_MS = 50;

export class TimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Timed out after ${timeoutMs}ms`);
    this.name = "TimeoutError";
  }
}

export class InterruptedError extends Error {
  constructor() {
    super("Interrupted");
    this.name = "InterruptedError";
  }
}

type TimedRunOptions = {
  timeoutMs?: number;
};

export type RunOnceOptions = {
  agentCommand: string;
  cwd: string;
  message: string;
  permissionMode: PermissionMode;
  outputFormatter: OutputFormatter;
  verbose?: boolean;
} & TimedRunOptions;

export type SessionCreateOptions = {
  agentCommand: string;
  cwd: string;
  name?: string;
  permissionMode: PermissionMode;
  verbose?: boolean;
} & TimedRunOptions;

export type SessionSendOptions = {
  sessionId: string;
  message: string;
  permissionMode: PermissionMode;
  outputFormatter: OutputFormatter;
  verbose?: boolean;
} & TimedRunOptions;

function sessionFilePath(id: string): string {
  const safeId = encodeURIComponent(id);
  return path.join(SESSION_BASE_DIR, `${safeId}.json`);
}

async function ensureSessionDir(): Promise<void> {
  await fs.mkdir(SESSION_BASE_DIR, { recursive: true });
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs?: number,
): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) {
    return promise;
  }

  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new TimeoutError(timeoutMs));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function withInterrupt<T>(
  run: () => Promise<T>,
  onInterrupt: () => Promise<void>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;

    const finish = (cb: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      cb();
    };

    const onSigint = () => {
      void onInterrupt().finally(() => {
        finish(() => reject(new InterruptedError()));
      });
    };

    const onSigterm = () => {
      void onInterrupt().finally(() => {
        finish(() => reject(new InterruptedError()));
      });
    };

    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);

    void run().then(
      (result) => finish(() => resolve(result)),
      (error) => finish(() => reject(error)),
    );
  });
}

function parseSessionRecord(raw: unknown): SessionRecord | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const record = raw as Partial<SessionRecord>;
  const name =
    record.name == null
      ? undefined
      : typeof record.name === "string" && record.name.trim().length > 0
        ? record.name.trim()
        : null;
  const pid =
    record.pid == null
      ? undefined
      : Number.isInteger(record.pid) && record.pid > 0
        ? record.pid
        : null;

  if (
    typeof record.id !== "string" ||
    typeof record.sessionId !== "string" ||
    typeof record.agentCommand !== "string" ||
    typeof record.cwd !== "string" ||
    name === null ||
    typeof record.createdAt !== "string" ||
    typeof record.lastUsedAt !== "string" ||
    pid === null
  ) {
    return null;
  }

  return {
    ...record,
    id: record.id,
    sessionId: record.sessionId,
    agentCommand: record.agentCommand,
    cwd: record.cwd,
    name,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
    pid,
  };
}

async function writeSessionRecord(record: SessionRecord): Promise<void> {
  await ensureSessionDir();
  const file = sessionFilePath(record.id);
  const tempFile = `${file}.${process.pid}.${Date.now()}.tmp`;
  const payload = JSON.stringify(record, null, 2);
  await fs.writeFile(tempFile, `${payload}\n`, "utf8");
  await fs.rename(tempFile, file);
}

async function resolveSessionRecord(sessionId: string): Promise<SessionRecord> {
  await ensureSessionDir();

  const directPath = sessionFilePath(sessionId);
  try {
    const directPayload = await fs.readFile(directPath, "utf8");
    const directRecord = parseSessionRecord(JSON.parse(directPayload));
    if (directRecord) {
      return directRecord;
    }
  } catch {
    // fallback to search
  }

  const sessions = await listSessions();

  const exact = sessions.filter(
    (session) => session.id === sessionId || session.sessionId === sessionId,
  );
  if (exact.length === 1) {
    return exact[0];
  }
  if (exact.length > 1) {
    throw new Error(`Multiple sessions match id: ${sessionId}`);
  }

  const suffixMatches = sessions.filter(
    (session) =>
      session.id.endsWith(sessionId) || session.sessionId.endsWith(sessionId),
  );
  if (suffixMatches.length === 1) {
    return suffixMatches[0];
  }
  if (suffixMatches.length > 1) {
    throw new Error(`Session id is ambiguous: ${sessionId}`);
  }

  throw new Error(`Session not found: ${sessionId}`);
}

function toPromptResult(
  stopReason: RunPromptResult["stopReason"],
  sessionId: string,
  client: AcpClient,
): RunPromptResult {
  return {
    stopReason,
    sessionId,
    permissionStats: client.getPermissionStats(),
  };
}

function absolutePath(value: string): string {
  return path.resolve(value);
}

function normalizeName(value: string | undefined): string | undefined {
  if (value == null) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isoNow(): string {
  return new Date().toISOString();
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (error && typeof error === "object") {
    const maybeMessage = (error as { message?: unknown }).message;
    if (typeof maybeMessage === "string" && maybeMessage.length > 0) {
      return maybeMessage;
    }

    try {
      return JSON.stringify(error);
    } catch {
      // fall through
    }
  }

  return String(error);
}

function shouldFallbackToNewSession(error: unknown): boolean {
  if (error instanceof TimeoutError || error instanceof InterruptedError) {
    return false;
  }

  const message = formatError(error).toLowerCase();
  if (
    message.includes("resource_not_found") ||
    message.includes("resource not found") ||
    message.includes("session not found") ||
    message.includes("unknown session") ||
    message.includes("invalid session")
  ) {
    return true;
  }

  const code =
    error && typeof error === "object" && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
  return code === -32001 || code === -32002;
}

function isProcessAlive(pid: number | undefined): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0 || pid === process.pid) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(
  pid: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() <= deadline) {
    if (!isProcessAlive(pid)) {
      return true;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, PROCESS_POLL_MS);
    });
  }

  return !isProcessAlive(pid);
}

async function terminateProcess(pid: number): Promise<boolean> {
  if (!isProcessAlive(pid)) {
    return false;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return false;
  }

  if (await waitForProcessExit(pid, PROCESS_EXIT_GRACE_MS)) {
    return true;
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return false;
  }

  await waitForProcessExit(pid, PROCESS_EXIT_GRACE_MS);
  return true;
}

function firstAgentCommandToken(command: string): string | undefined {
  const trimmed = command.trim();
  if (!trimmed) {
    return undefined;
  }
  const token = trimmed.split(/\s+/, 1)[0];
  return token.length > 0 ? token : undefined;
}

async function isLikelyMatchingProcess(
  pid: number,
  agentCommand: string,
): Promise<boolean> {
  const expectedToken = firstAgentCommandToken(agentCommand);
  if (!expectedToken) {
    return false;
  }

  const procCmdline = `/proc/${pid}/cmdline`;
  try {
    const payload = await fs.readFile(procCmdline, "utf8");
    const argv = payload
      .split("\u0000")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    if (argv.length === 0) {
      return false;
    }

    const executableBase = path.basename(argv[0]);
    const expectedBase = path.basename(expectedToken);
    return (
      executableBase === expectedBase ||
      argv.some((entry) => path.basename(entry) === expectedBase)
    );
  } catch {
    // If /proc is unavailable, fall back to PID liveness checks only.
    return true;
  }
}

export async function runOnce(options: RunOnceOptions): Promise<RunPromptResult> {
  const output = options.outputFormatter;
  const client = new AcpClient({
    agentCommand: options.agentCommand,
    cwd: absolutePath(options.cwd),
    permissionMode: options.permissionMode,
    verbose: options.verbose,
    onSessionUpdate: (notification) => output.onSessionUpdate(notification),
  });

  try {
    return await withInterrupt(
      async () => {
        await withTimeout(client.start(), options.timeoutMs);
        const sessionId = await withTimeout(
          client.createSession(absolutePath(options.cwd)),
          options.timeoutMs,
        );
        const response = await withTimeout(
          client.prompt(sessionId, options.message),
          options.timeoutMs,
        );
        output.onDone(response.stopReason);
        output.flush();
        return toPromptResult(response.stopReason, sessionId, client);
      },
      async () => {
        await client.close();
      },
    );
  } finally {
    await client.close();
  }
}

export async function createSession(
  options: SessionCreateOptions,
): Promise<SessionRecord> {
  const client = new AcpClient({
    agentCommand: options.agentCommand,
    cwd: absolutePath(options.cwd),
    permissionMode: options.permissionMode,
    verbose: options.verbose,
  });

  try {
    return await withInterrupt(
      async () => {
        await withTimeout(client.start(), options.timeoutMs);
        const sessionId = await withTimeout(
          client.createSession(absolutePath(options.cwd)),
          options.timeoutMs,
        );

        const now = isoNow();
        const record: SessionRecord = {
          id: sessionId,
          sessionId,
          agentCommand: options.agentCommand,
          cwd: absolutePath(options.cwd),
          name: normalizeName(options.name),
          createdAt: now,
          lastUsedAt: now,
          pid: client.getAgentPid(),
          protocolVersion: client.initializeResult?.protocolVersion,
          agentCapabilities: client.initializeResult?.agentCapabilities,
        };

        await writeSessionRecord(record);
        return record;
      },
      async () => {
        await client.close();
      },
    );
  } finally {
    await client.close();
  }
}

export async function sendSession(
  options: SessionSendOptions,
): Promise<SessionSendResult> {
  const output = options.outputFormatter;
  const record = await resolveSessionRecord(options.sessionId);
  const storedProcessAlive = isProcessAlive(record.pid);

  if (storedProcessAlive && options.verbose) {
    process.stderr.write(
      `[acpx] saved session pid ${record.pid} is running; reconnecting with loadSession\n`,
    );
  }

  const client = new AcpClient({
    agentCommand: record.agentCommand,
    cwd: absolutePath(record.cwd),
    permissionMode: options.permissionMode,
    verbose: options.verbose,
    onSessionUpdate: (notification) => output.onSessionUpdate(notification),
  });

  try {
    return await withInterrupt(
      async () => {
        await withTimeout(client.start(), options.timeoutMs);
        record.pid = client.getAgentPid();

        let resumed = false;
        let loadError: string | undefined;
        let activeSessionId = record.sessionId;

        if (client.supportsLoadSession()) {
          try {
            await withTimeout(
              client.loadSessionWithOptions(record.sessionId, record.cwd, {
                suppressReplayUpdates: true,
              }),
              options.timeoutMs,
            );
            resumed = true;
          } catch (error) {
            loadError = formatError(error);
            if (!shouldFallbackToNewSession(error)) {
              throw error;
            }
            activeSessionId = await withTimeout(
              client.createSession(record.cwd),
              options.timeoutMs,
            );
            record.sessionId = activeSessionId;
          }
        } else {
          activeSessionId = await withTimeout(
            client.createSession(record.cwd),
            options.timeoutMs,
          );
          record.sessionId = activeSessionId;
        }

        const response = await withTimeout(
          client.prompt(activeSessionId, options.message),
          options.timeoutMs,
        );

        output.onDone(response.stopReason);
        output.flush();

        record.lastUsedAt = isoNow();
        record.protocolVersion = client.initializeResult?.protocolVersion;
        record.agentCapabilities = client.initializeResult?.agentCapabilities;
        await writeSessionRecord(record);

        return {
          ...toPromptResult(response.stopReason, record.id, client),
          record,
          resumed,
          loadError,
        };
      },
      async () => {
        await client.close();
      },
    );
  } finally {
    await client.close();
  }
}

export async function listSessions(): Promise<SessionRecord[]> {
  await ensureSessionDir();

  const entries = await fs.readdir(SESSION_BASE_DIR, { withFileTypes: true });
  const records: SessionRecord[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }

    const fullPath = path.join(SESSION_BASE_DIR, entry.name);
    try {
      const payload = await fs.readFile(fullPath, "utf8");
      const parsed = parseSessionRecord(JSON.parse(payload));
      if (parsed) {
        records.push(parsed);
      }
    } catch {
      // ignore corrupt session files
    }
  }

  records.sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
  return records;
}

type FindSessionOptions = {
  agentCommand: string;
  cwd: string;
  name?: string;
};

export async function listSessionsForAgent(
  agentCommand: string,
): Promise<SessionRecord[]> {
  const sessions = await listSessions();
  return sessions.filter((session) => session.agentCommand === agentCommand);
}

export async function findSession(
  options: FindSessionOptions,
): Promise<SessionRecord | undefined> {
  const normalizedCwd = absolutePath(options.cwd);
  const normalizedName = normalizeName(options.name);
  const sessions = await listSessionsForAgent(options.agentCommand);

  return sessions.find((session) => {
    if (session.cwd !== normalizedCwd) {
      return false;
    }

    if (normalizedName == null) {
      return session.name == null;
    }

    return session.name === normalizedName;
  });
}

export async function closeSession(sessionId: string): Promise<SessionRecord> {
  const record = await resolveSessionRecord(sessionId);
  if (
    record.pid != null &&
    isProcessAlive(record.pid) &&
    (await isLikelyMatchingProcess(record.pid, record.agentCommand))
  ) {
    await terminateProcess(record.pid);
  }
  const file = sessionFilePath(record.id);
  await fs.unlink(file);
  return record;
}
