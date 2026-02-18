import type { SessionNotification, StopReason } from "@agentclientprotocol/sdk";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { AcpClient } from "./client.js";
import type {
  OutputFormatter,
  PermissionMode,
  SessionEnqueueResult,
  SessionSendOutcome,
  RunPromptResult,
  SessionRecord,
  SessionSendResult,
} from "./types.js";

const SESSION_BASE_DIR = path.join(os.homedir(), ".acpx", "sessions");
const QUEUE_BASE_DIR = path.join(os.homedir(), ".acpx", "queues");
const PROCESS_EXIT_GRACE_MS = 1_500;
const PROCESS_POLL_MS = 50;
const QUEUE_CONNECT_ATTEMPTS = 40;
const QUEUE_CONNECT_RETRY_MS = 50;
export const DEFAULT_QUEUE_OWNER_TTL_MS = 300_000;

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
  waitForCompletion?: boolean;
  ttlMs?: number;
} & TimedRunOptions;

function sessionFilePath(id: string): string {
  const safeId = encodeURIComponent(id);
  return path.join(SESSION_BASE_DIR, `${safeId}.json`);
}

async function ensureSessionDir(): Promise<void> {
  await fs.mkdir(SESSION_BASE_DIR, { recursive: true });
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs?: number): Promise<T> {
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
  const closed =
    record.closed == null
      ? false
      : typeof record.closed === "boolean"
        ? record.closed
        : null;
  const closedAt =
    record.closedAt == null
      ? undefined
      : typeof record.closedAt === "string"
        ? record.closedAt
        : null;

  if (
    typeof record.id !== "string" ||
    typeof record.sessionId !== "string" ||
    typeof record.agentCommand !== "string" ||
    typeof record.cwd !== "string" ||
    name === null ||
    typeof record.createdAt !== "string" ||
    typeof record.lastUsedAt !== "string" ||
    pid === null ||
    closed === null ||
    closedAt === null
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
    closed,
    closedAt,
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

export function normalizeQueueOwnerTtlMs(ttlMs: number | undefined): number {
  if (ttlMs == null) {
    return DEFAULT_QUEUE_OWNER_TTL_MS;
  }

  if (!Number.isFinite(ttlMs) || ttlMs < 0) {
    return DEFAULT_QUEUE_OWNER_TTL_MS;
  }

  // 0 means keep alive forever (no TTL)
  return Math.round(ttlMs);
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

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
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

type QueueOwnerRecord = {
  pid: number;
  sessionId: string;
  socketPath: string;
};

type QueueOwnerLease = {
  lockPath: string;
  socketPath: string;
};

type QueueSubmitRequest = {
  type: "submit_prompt";
  requestId: string;
  message: string;
  permissionMode: PermissionMode;
  timeoutMs?: number;
  waitForCompletion: boolean;
};

type QueueOwnerAcceptedMessage = {
  type: "accepted";
  requestId: string;
};

type QueueOwnerSessionUpdateMessage = {
  type: "session_update";
  requestId: string;
  notification: SessionNotification;
};

type QueueOwnerDoneMessage = {
  type: "done";
  requestId: string;
  stopReason: StopReason;
};

type QueueOwnerResultMessage = {
  type: "result";
  requestId: string;
  result: SessionSendResult;
};

type QueueOwnerErrorMessage = {
  type: "error";
  requestId: string;
  message: string;
};

type QueueOwnerMessage =
  | QueueOwnerAcceptedMessage
  | QueueOwnerSessionUpdateMessage
  | QueueOwnerDoneMessage
  | QueueOwnerResultMessage
  | QueueOwnerErrorMessage;

type QueueTask = {
  requestId: string;
  message: string;
  permissionMode: PermissionMode;
  timeoutMs?: number;
  waitForCompletion: boolean;
  send: (message: QueueOwnerMessage) => void;
  close: () => void;
};

type RunSessionPromptOptions = {
  sessionRecordId: string;
  message: string;
  permissionMode: PermissionMode;
  outputFormatter: OutputFormatter;
  timeoutMs?: number;
  verbose?: boolean;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function isPermissionMode(value: unknown): value is PermissionMode {
  return value === "approve-all" || value === "approve-reads" || value === "deny-all";
}

function parseQueueOwnerRecord(raw: unknown): QueueOwnerRecord | null {
  const record = asRecord(raw);
  if (!record) {
    return null;
  }

  if (
    !Number.isInteger(record.pid) ||
    (record.pid as number) <= 0 ||
    typeof record.sessionId !== "string" ||
    typeof record.socketPath !== "string"
  ) {
    return null;
  }

  return {
    pid: record.pid as number,
    sessionId: record.sessionId,
    socketPath: record.socketPath,
  };
}

function parseQueueSubmitRequest(raw: unknown): QueueSubmitRequest | null {
  const request = asRecord(raw);
  if (!request) {
    return null;
  }

  if (
    request.type !== "submit_prompt" ||
    typeof request.requestId !== "string" ||
    typeof request.message !== "string" ||
    !isPermissionMode(request.permissionMode) ||
    typeof request.waitForCompletion !== "boolean"
  ) {
    return null;
  }

  const timeoutRaw = request.timeoutMs;
  const timeoutMs =
    typeof timeoutRaw === "number" && Number.isFinite(timeoutRaw) && timeoutRaw > 0
      ? Math.round(timeoutRaw)
      : undefined;

  return {
    type: "submit_prompt",
    requestId: request.requestId,
    message: request.message,
    permissionMode: request.permissionMode,
    timeoutMs,
    waitForCompletion: request.waitForCompletion,
  };
}

function parseSessionSendResult(raw: unknown): SessionSendResult | null {
  const result = asRecord(raw);
  if (!result) {
    return null;
  }

  if (
    typeof result.stopReason !== "string" ||
    typeof result.sessionId !== "string" ||
    typeof result.resumed !== "boolean"
  ) {
    return null;
  }

  const permissionStats = asRecord(result.permissionStats);
  const record = asRecord(result.record);
  if (!permissionStats || !record) {
    return null;
  }

  const statsValid =
    typeof permissionStats.requested === "number" &&
    typeof permissionStats.approved === "number" &&
    typeof permissionStats.denied === "number" &&
    typeof permissionStats.cancelled === "number";
  if (!statsValid) {
    return null;
  }

  const recordValid =
    typeof record.id === "string" &&
    typeof record.sessionId === "string" &&
    typeof record.agentCommand === "string" &&
    typeof record.cwd === "string" &&
    typeof record.createdAt === "string" &&
    typeof record.lastUsedAt === "string";
  if (!recordValid) {
    return null;
  }

  return result as SessionSendResult;
}

function parseQueueOwnerMessage(raw: unknown): QueueOwnerMessage | null {
  const message = asRecord(raw);
  if (!message || typeof message.type !== "string") {
    return null;
  }

  if (typeof message.requestId !== "string") {
    return null;
  }

  if (message.type === "accepted") {
    return {
      type: "accepted",
      requestId: message.requestId,
    };
  }

  if (message.type === "session_update") {
    const notification = message.notification as SessionNotification | undefined;
    if (!notification || typeof notification !== "object") {
      return null;
    }
    return {
      type: "session_update",
      requestId: message.requestId,
      notification,
    };
  }

  if (message.type === "done") {
    if (typeof message.stopReason !== "string") {
      return null;
    }
    return {
      type: "done",
      requestId: message.requestId,
      stopReason: message.stopReason as StopReason,
    };
  }

  if (message.type === "result") {
    const parsedResult = parseSessionSendResult(message.result);
    if (!parsedResult) {
      return null;
    }
    return {
      type: "result",
      requestId: message.requestId,
      result: parsedResult,
    };
  }

  if (message.type === "error") {
    if (typeof message.message !== "string") {
      return null;
    }
    return {
      type: "error",
      requestId: message.requestId,
      message: message.message,
    };
  }

  return null;
}

function queueKeyForSession(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 24);
}

function queueLockFilePath(sessionId: string): string {
  return path.join(QUEUE_BASE_DIR, `${queueKeyForSession(sessionId)}.lock`);
}

function queueSocketPath(sessionId: string): string {
  const key = queueKeyForSession(sessionId);
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\acpx-${key}`;
  }
  return path.join(QUEUE_BASE_DIR, `${key}.sock`);
}

async function ensureQueueDir(): Promise<void> {
  await fs.mkdir(QUEUE_BASE_DIR, { recursive: true });
}

async function removeSocketFile(socketPath: string): Promise<void> {
  if (process.platform === "win32") {
    return;
  }

  try {
    await fs.unlink(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

async function readQueueOwnerRecord(
  sessionId: string,
): Promise<QueueOwnerRecord | undefined> {
  const lockPath = queueLockFilePath(sessionId);
  try {
    const payload = await fs.readFile(lockPath, "utf8");
    const parsed = parseQueueOwnerRecord(JSON.parse(payload));
    return parsed ?? undefined;
  } catch {
    return undefined;
  }
}

async function cleanupStaleQueueOwner(
  sessionId: string,
  owner: QueueOwnerRecord | undefined,
): Promise<void> {
  const lockPath = queueLockFilePath(sessionId);
  const socketPath = owner?.socketPath ?? queueSocketPath(sessionId);

  await removeSocketFile(socketPath).catch(() => {
    // ignore stale socket cleanup failures
  });

  await fs.unlink(lockPath).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  });
}

async function tryAcquireQueueOwnerLease(
  sessionId: string,
): Promise<QueueOwnerLease | undefined> {
  await ensureQueueDir();
  const lockPath = queueLockFilePath(sessionId);
  const socketPath = queueSocketPath(sessionId);
  const payload = JSON.stringify(
    {
      pid: process.pid,
      sessionId,
      socketPath,
      createdAt: isoNow(),
    },
    null,
    2,
  );

  try {
    await fs.writeFile(lockPath, `${payload}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    await removeSocketFile(socketPath).catch(() => {
      // best-effort stale socket cleanup after ownership is acquired
    });
    return { lockPath, socketPath };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }

    const owner = await readQueueOwnerRecord(sessionId);
    if (!owner || !isProcessAlive(owner.pid)) {
      await cleanupStaleQueueOwner(sessionId, owner);
    }
    return undefined;
  }
}

async function releaseQueueOwnerLease(lease: QueueOwnerLease): Promise<void> {
  await removeSocketFile(lease.socketPath).catch(() => {
    // ignore best-effort cleanup failures
  });

  await fs.unlink(lease.lockPath).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  });
}

function shouldRetryQueueConnect(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ECONNREFUSED";
}

async function waitMs(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function connectToSocket(socketPath: string): Promise<net.Socket> {
  return await new Promise<net.Socket>((resolve, reject) => {
    const socket = net.createConnection(socketPath);

    const onConnect = () => {
      socket.off("error", onError);
      resolve(socket);
    };
    const onError = (error: Error) => {
      socket.off("connect", onConnect);
      reject(error);
    };

    socket.once("connect", onConnect);
    socket.once("error", onError);
  });
}

async function connectToQueueOwner(
  owner: QueueOwnerRecord,
): Promise<net.Socket | undefined> {
  let lastError: unknown;

  for (let attempt = 0; attempt < QUEUE_CONNECT_ATTEMPTS; attempt += 1) {
    try {
      return await connectToSocket(owner.socketPath);
    } catch (error) {
      lastError = error;
      if (!shouldRetryQueueConnect(error)) {
        throw error;
      }

      if (!isProcessAlive(owner.pid)) {
        return undefined;
      }
      await waitMs(QUEUE_CONNECT_RETRY_MS);
    }
  }

  if (lastError && !shouldRetryQueueConnect(lastError)) {
    throw lastError;
  }

  return undefined;
}

function writeQueueMessage(socket: net.Socket, message: QueueOwnerMessage): void {
  if (socket.destroyed || !socket.writable) {
    return;
  }
  socket.write(`${JSON.stringify(message)}\n`);
}

class QueueTaskOutputFormatter implements OutputFormatter {
  private readonly requestId: string;
  private readonly send: (message: QueueOwnerMessage) => void;

  constructor(task: QueueTask) {
    this.requestId = task.requestId;
    this.send = task.send;
  }

  onSessionUpdate(notification: SessionNotification): void {
    this.send({
      type: "session_update",
      requestId: this.requestId,
      notification,
    });
  }

  onDone(stopReason: StopReason): void {
    this.send({
      type: "done",
      requestId: this.requestId,
      stopReason,
    });
  }

  flush(): void {
    // no-op for stream forwarding
  }
}

const DISCARD_OUTPUT_FORMATTER: OutputFormatter = {
  onSessionUpdate() {
    // no-op
  },
  onDone() {
    // no-op
  },
  flush() {
    // no-op
  },
};

class SessionQueueOwner {
  private readonly server: net.Server;
  private readonly pending: QueueTask[] = [];
  private readonly waiters: Array<(task: QueueTask | undefined) => void> = [];
  private closed = false;

  private constructor(server: net.Server) {
    this.server = server;
  }

  static async start(lease: QueueOwnerLease): Promise<SessionQueueOwner> {
    const ownerRef: { current: SessionQueueOwner | undefined } = { current: undefined };
    const server = net.createServer((socket) => {
      ownerRef.current?.handleConnection(socket);
    });
    ownerRef.current = new SessionQueueOwner(server);

    await new Promise<void>((resolve, reject) => {
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };

      server.once("listening", onListening);
      server.once("error", onError);
      server.listen(lease.socketPath);
    });

    return ownerRef.current!;
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter(undefined);
    }

    for (const task of this.pending.splice(0)) {
      if (task.waitForCompletion) {
        task.send({
          type: "error",
          requestId: task.requestId,
          message: "Queue owner shutting down before prompt execution",
        });
      }
      task.close();
    }

    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });
  }

  async nextTask(timeoutMs?: number): Promise<QueueTask | undefined> {
    if (this.pending.length > 0) {
      return this.pending.shift();
    }
    if (this.closed) {
      return undefined;
    }

    return await new Promise<QueueTask | undefined>((resolve) => {
      const shouldTimeout = timeoutMs != null;
      const timer =
        shouldTimeout &&
        setTimeout(
          () => {
            const index = this.waiters.indexOf(waiter);
            if (index >= 0) {
              this.waiters.splice(index, 1);
            }
            resolve(undefined);
          },
          Math.max(0, timeoutMs),
        );

      const waiter = (task: QueueTask | undefined) => {
        if (timer) {
          clearTimeout(timer);
        }
        resolve(task);
      };

      this.waiters.push(waiter);
    });
  }

  private enqueue(task: QueueTask): void {
    if (this.closed) {
      if (task.waitForCompletion) {
        task.send({
          type: "error",
          requestId: task.requestId,
          message: "Queue owner is shutting down",
        });
      }
      task.close();
      return;
    }

    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(task);
      return;
    }

    this.pending.push(task);
  }

  private handleConnection(socket: net.Socket): void {
    socket.setEncoding("utf8");

    if (this.closed) {
      writeQueueMessage(socket, {
        type: "error",
        requestId: "unknown",
        message: "Queue owner is closed",
      });
      socket.end();
      return;
    }

    let buffer = "";
    let handled = false;

    const fail = (requestId: string, message: string): void => {
      writeQueueMessage(socket, {
        type: "error",
        requestId,
        message,
      });
      socket.end();
    };

    const processLine = (line: string): void => {
      if (handled) {
        return;
      }
      handled = true;

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        fail("unknown", "Invalid queue request payload");
        return;
      }

      const request = parseQueueSubmitRequest(parsed);
      if (!request) {
        fail("unknown", "Invalid queue request");
        return;
      }

      const task: QueueTask = {
        requestId: request.requestId,
        message: request.message,
        permissionMode: request.permissionMode,
        timeoutMs: request.timeoutMs,
        waitForCompletion: request.waitForCompletion,
        send: (message) => {
          writeQueueMessage(socket, message);
        },
        close: () => {
          if (!socket.destroyed) {
            socket.end();
          }
        },
      };

      writeQueueMessage(socket, {
        type: "accepted",
        requestId: request.requestId,
      });

      if (!request.waitForCompletion) {
        task.close();
      }

      this.enqueue(task);
    };

    socket.on("data", (chunk: string) => {
      buffer += chunk;

      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);

        if (line.length > 0) {
          processLine(line);
        }

        index = buffer.indexOf("\n");
      }
    });

    socket.on("error", () => {
      // no-op: queue processing continues even if client disconnects
    });
  }
}

type SubmitToQueueOwnerOptions = {
  sessionId: string;
  message: string;
  permissionMode: PermissionMode;
  outputFormatter: OutputFormatter;
  timeoutMs?: number;
  waitForCompletion: boolean;
  verbose?: boolean;
};

async function submitToQueueOwner(
  owner: QueueOwnerRecord,
  options: SubmitToQueueOwnerOptions,
): Promise<SessionSendOutcome | undefined> {
  const socket = await connectToQueueOwner(owner);
  if (!socket) {
    return undefined;
  }

  socket.setEncoding("utf8");
  const requestId = randomUUID();
  const request: QueueSubmitRequest = {
    type: "submit_prompt",
    requestId,
    message: options.message,
    permissionMode: options.permissionMode,
    timeoutMs: options.timeoutMs,
    waitForCompletion: options.waitForCompletion,
  };

  return await new Promise<SessionSendOutcome>((resolve, reject) => {
    let settled = false;
    let acknowledged = false;
    let buffer = "";
    let sawDone = false;

    const finishResolve = (result: SessionSendOutcome) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.removeAllListeners();
      if (!socket.destroyed) {
        socket.end();
      }
      resolve(result);
    };

    const finishReject = (error: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.removeAllListeners();
      if (!socket.destroyed) {
        socket.destroy();
      }
      reject(error);
    };

    const processLine = (line: string): void => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        finishReject(new Error("Queue owner sent invalid JSON payload"));
        return;
      }

      const message = parseQueueOwnerMessage(parsed);
      if (!message || message.requestId !== requestId) {
        finishReject(new Error("Queue owner sent malformed message"));
        return;
      }

      if (message.type === "accepted") {
        acknowledged = true;
        if (!options.waitForCompletion) {
          const queued: SessionEnqueueResult = {
            queued: true,
            sessionId: options.sessionId,
            requestId,
          };
          finishResolve(queued);
        }
        return;
      }

      if (!acknowledged) {
        finishReject(new Error("Queue owner did not acknowledge request"));
        return;
      }

      if (message.type === "session_update") {
        options.outputFormatter.onSessionUpdate(message.notification);
        return;
      }

      if (message.type === "done") {
        options.outputFormatter.onDone(message.stopReason);
        sawDone = true;
        return;
      }

      if (message.type === "result") {
        if (!sawDone) {
          options.outputFormatter.onDone(message.result.stopReason);
        }
        options.outputFormatter.flush();
        finishResolve(message.result);
        return;
      }

      finishReject(new Error(message.message));
    };

    socket.on("data", (chunk: string) => {
      buffer += chunk;

      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);

        if (line.length > 0) {
          processLine(line);
        }

        index = buffer.indexOf("\n");
      }
    });

    socket.once("error", (error) => {
      finishReject(error);
    });

    socket.once("close", () => {
      if (settled) {
        return;
      }

      if (!acknowledged) {
        finishReject(
          new Error("Queue owner disconnected before acknowledging request"),
        );
        return;
      }

      if (!options.waitForCompletion) {
        const queued: SessionEnqueueResult = {
          queued: true,
          sessionId: options.sessionId,
          requestId,
        };
        finishResolve(queued);
        return;
      }

      finishReject(new Error("Queue owner disconnected before prompt completion"));
    });

    socket.write(`${JSON.stringify(request)}\n`);
  });
}

async function trySubmitToRunningOwner(
  options: SubmitToQueueOwnerOptions,
): Promise<SessionSendOutcome | undefined> {
  const owner = await readQueueOwnerRecord(options.sessionId);
  if (!owner) {
    return undefined;
  }

  if (!isProcessAlive(owner.pid)) {
    await cleanupStaleQueueOwner(options.sessionId, owner);
    return undefined;
  }

  const submitted = await submitToQueueOwner(owner, options);
  if (submitted) {
    if (options.verbose) {
      process.stderr.write(
        `[acpx] queued prompt on active owner pid ${owner.pid} for session ${options.sessionId}\n`,
      );
    }
    return submitted;
  }

  if (!isProcessAlive(owner.pid)) {
    await cleanupStaleQueueOwner(options.sessionId, owner);
    return undefined;
  }

  throw new Error("Session queue owner is running but not accepting queue requests");
}

async function runQueuedTask(
  sessionRecordId: string,
  task: QueueTask,
  verbose?: boolean,
): Promise<void> {
  const outputFormatter = task.waitForCompletion
    ? new QueueTaskOutputFormatter(task)
    : DISCARD_OUTPUT_FORMATTER;

  try {
    const result = await runSessionPrompt({
      sessionRecordId,
      message: task.message,
      permissionMode: task.permissionMode,
      outputFormatter,
      timeoutMs: task.timeoutMs,
      verbose,
    });

    if (task.waitForCompletion) {
      task.send({
        type: "result",
        requestId: task.requestId,
        result,
      });
    }
  } catch (error) {
    const message = formatError(error);
    if (task.waitForCompletion) {
      task.send({
        type: "error",
        requestId: task.requestId,
        message,
      });
    }

    if (error instanceof InterruptedError) {
      throw error;
    }
  } finally {
    task.close();
  }
}

async function runSessionPrompt(
  options: RunSessionPromptOptions,
): Promise<SessionSendResult> {
  const output = options.outputFormatter;
  const record = await resolveSessionRecord(options.sessionRecordId);
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
        record.closed = false;
        record.closedAt = undefined;
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
          closed: false,
          closedAt: undefined,
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
): Promise<SessionSendOutcome> {
  const waitForCompletion = options.waitForCompletion !== false;
  const queueOwnerTtlMs = normalizeQueueOwnerTtlMs(options.ttlMs);

  const queuedToOwner = await trySubmitToRunningOwner({
    sessionId: options.sessionId,
    message: options.message,
    permissionMode: options.permissionMode,
    outputFormatter: options.outputFormatter,
    timeoutMs: options.timeoutMs,
    waitForCompletion,
    verbose: options.verbose,
  });
  if (queuedToOwner) {
    return queuedToOwner;
  }

  for (;;) {
    const lease = await tryAcquireQueueOwnerLease(options.sessionId);
    if (!lease) {
      const retryQueued = await trySubmitToRunningOwner({
        sessionId: options.sessionId,
        message: options.message,
        permissionMode: options.permissionMode,
        outputFormatter: options.outputFormatter,
        timeoutMs: options.timeoutMs,
        waitForCompletion,
        verbose: options.verbose,
      });
      if (retryQueued) {
        return retryQueued;
      }
      await waitMs(QUEUE_CONNECT_RETRY_MS);
      continue;
    }

    let owner: SessionQueueOwner | undefined;
    try {
      owner = await SessionQueueOwner.start(lease);

      const localResult = await runSessionPrompt({
        sessionRecordId: options.sessionId,
        message: options.message,
        permissionMode: options.permissionMode,
        outputFormatter: options.outputFormatter,
        timeoutMs: options.timeoutMs,
        verbose: options.verbose,
      });

      const idleWaitMs =
        queueOwnerTtlMs === 0 ? undefined : Math.max(0, queueOwnerTtlMs);

      while (true) {
        const task = await owner.nextTask(idleWaitMs);
        if (!task) {
          if (queueOwnerTtlMs > 0 && options.verbose) {
            process.stderr.write(
              `[acpx] queue owner TTL expired after ${Math.round(queueOwnerTtlMs / 1_000)}s for session ${options.sessionId}; shutting down\n`,
            );
          }
          break;
        }
        await runQueuedTask(options.sessionId, task, options.verbose);
      }

      return localResult;
    } finally {
      if (owner) {
        await owner.close();
      }
      await releaseQueueOwnerLease(lease);
    }
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
  includeClosed?: boolean;
};

type FindSessionByDirectoryWalkOptions = {
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

    if (!options.includeClosed && session.closed) {
      return false;
    }

    if (normalizedName == null) {
      return session.name == null;
    }

    return session.name === normalizedName;
  });
}

export async function findSessionByDirectoryWalk(
  options: FindSessionByDirectoryWalkOptions,
): Promise<SessionRecord | undefined> {
  const normalizedName = normalizeName(options.name);
  const normalizedStart = absolutePath(options.cwd);
  const sessions = await listSessionsForAgent(options.agentCommand);

  const matchesScope = (session: SessionRecord, dir: string): boolean => {
    if (session.cwd !== dir) {
      return false;
    }

    if (session.closed) {
      return false;
    }

    if (normalizedName == null) {
      return session.name == null;
    }

    return session.name === normalizedName;
  };

  let dir = normalizedStart;
  const root = path.parse(dir).root;

  for (;;) {
    const match = sessions.find((session) => matchesScope(session, dir));
    if (match) {
      return match;
    }

    if (dir === root) {
      return undefined;
    }

    const parent = path.dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

async function terminateQueueOwnerForSession(sessionId: string): Promise<void> {
  const owner = await readQueueOwnerRecord(sessionId);
  if (!owner) {
    return;
  }

  if (isProcessAlive(owner.pid)) {
    await terminateProcess(owner.pid);
  }

  await cleanupStaleQueueOwner(sessionId, owner);
}

export async function closeSession(sessionId: string): Promise<SessionRecord> {
  const record = await resolveSessionRecord(sessionId);
  await terminateQueueOwnerForSession(record.id);

  if (
    record.pid != null &&
    isProcessAlive(record.pid) &&
    (await isLikelyMatchingProcess(record.pid, record.agentCommand))
  ) {
    await terminateProcess(record.pid);
  }

  record.pid = undefined;
  record.closed = true;
  record.closedAt = isoNow();
  await writeSessionRecord(record);

  return record;
}
