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
      cb();
    };

    const onSigint = () => {
      void onInterrupt().finally(() => {
        finish(() => reject(new InterruptedError()));
      });
    };

    process.once("SIGINT", onSigint);

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
  if (
    typeof record.id !== "string" ||
    typeof record.sessionId !== "string" ||
    typeof record.agentCommand !== "string" ||
    typeof record.cwd !== "string" ||
    typeof record.createdAt !== "string" ||
    typeof record.lastUsedAt !== "string"
  ) {
    return null;
  }

  return {
    ...record,
    id: record.id,
    sessionId: record.sessionId,
    agentCommand: record.agentCommand,
    cwd: record.cwd,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
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

function isoNow(): string {
  return new Date().toISOString();
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
          createdAt: now,
          lastUsedAt: now,
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

        let resumed = false;
        let loadError: string | undefined;
        let activeSessionId = record.sessionId;

        if (client.supportsLoadSession()) {
          try {
            await withTimeout(
              client.loadSession(record.sessionId, record.cwd),
              options.timeoutMs,
            );
            resumed = true;
          } catch (error) {
            loadError = error instanceof Error ? error.message : String(error);
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

export async function closeSession(sessionId: string): Promise<SessionRecord> {
  const record = await resolveSessionRecord(sessionId);
  const file = sessionFilePath(record.id);
  await fs.unlink(file);
  return record;
}
