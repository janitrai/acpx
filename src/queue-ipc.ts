import type {
  SetSessionConfigOptionResponse,
  SessionNotification,
  StopReason,
} from "@agentclientprotocol/sdk";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type {
  ClientOperation,
  OutputFormatter,
  PermissionMode,
  SessionEnqueueResult,
  SessionSendOutcome,
  SessionSendResult,
} from "./types.js";

const PROCESS_EXIT_GRACE_MS = 1_500;
const PROCESS_POLL_MS = 50;
const QUEUE_CONNECT_ATTEMPTS = 40;
export const QUEUE_CONNECT_RETRY_MS = 50;

function queueBaseDir(): string {
  return path.join(os.homedir(), ".acpx", "queues");
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

export function isProcessAlive(pid: number | undefined): boolean {
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

export async function terminateProcess(pid: number): Promise<boolean> {
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

type QueueOwnerRecord = {
  pid: number;
  sessionId: string;
  socketPath: string;
};

export type QueueOwnerLease = {
  lockPath: string;
  socketPath: string;
};

export type QueueSubmitRequest = {
  type: "submit_prompt";
  requestId: string;
  message: string;
  permissionMode: PermissionMode;
  timeoutMs?: number;
  waitForCompletion: boolean;
};

type QueueCancelRequest = {
  type: "cancel_prompt";
  requestId: string;
};

type QueueSetModeRequest = {
  type: "set_mode";
  requestId: string;
  modeId: string;
  timeoutMs?: number;
};

type QueueSetConfigOptionRequest = {
  type: "set_config_option";
  requestId: string;
  configId: string;
  value: string;
  timeoutMs?: number;
};

type QueueRequest =
  | QueueSubmitRequest
  | QueueCancelRequest
  | QueueSetModeRequest
  | QueueSetConfigOptionRequest;

type QueueOwnerAcceptedMessage = {
  type: "accepted";
  requestId: string;
};

type QueueOwnerSessionUpdateMessage = {
  type: "session_update";
  requestId: string;
  notification: SessionNotification;
};

type QueueOwnerClientOperationMessage = {
  type: "client_operation";
  requestId: string;
  operation: ClientOperation;
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

type QueueOwnerCancelResultMessage = {
  type: "cancel_result";
  requestId: string;
  cancelled: boolean;
};

type QueueOwnerSetModeResultMessage = {
  type: "set_mode_result";
  requestId: string;
  modeId: string;
};

type QueueOwnerSetConfigOptionResultMessage = {
  type: "set_config_option_result";
  requestId: string;
  response: SetSessionConfigOptionResponse;
};

type QueueOwnerErrorMessage = {
  type: "error";
  requestId: string;
  message: string;
};

export type QueueOwnerMessage =
  | QueueOwnerAcceptedMessage
  | QueueOwnerSessionUpdateMessage
  | QueueOwnerClientOperationMessage
  | QueueOwnerDoneMessage
  | QueueOwnerResultMessage
  | QueueOwnerCancelResultMessage
  | QueueOwnerSetModeResultMessage
  | QueueOwnerSetConfigOptionResultMessage
  | QueueOwnerErrorMessage;

export type QueueTask = {
  requestId: string;
  message: string;
  permissionMode: PermissionMode;
  timeoutMs?: number;
  waitForCompletion: boolean;
  send: (message: QueueOwnerMessage) => void;
  close: () => void;
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

function parseQueueRequest(raw: unknown): QueueRequest | null {
  const request = asRecord(raw);
  if (!request) {
    return null;
  }

  if (typeof request.type !== "string" || typeof request.requestId !== "string") {
    return null;
  }

  const timeoutRaw = request.timeoutMs;
  const timeoutMs =
    typeof timeoutRaw === "number" && Number.isFinite(timeoutRaw) && timeoutRaw > 0
      ? Math.round(timeoutRaw)
      : undefined;

  if (request.type === "submit_prompt") {
    if (
      typeof request.message !== "string" ||
      !isPermissionMode(request.permissionMode) ||
      typeof request.waitForCompletion !== "boolean"
    ) {
      return null;
    }

    return {
      type: "submit_prompt",
      requestId: request.requestId,
      message: request.message,
      permissionMode: request.permissionMode,
      timeoutMs,
      waitForCompletion: request.waitForCompletion,
    };
  }

  if (request.type === "cancel_prompt") {
    return {
      type: "cancel_prompt",
      requestId: request.requestId,
    };
  }

  if (request.type === "set_mode") {
    if (typeof request.modeId !== "string" || request.modeId.trim().length === 0) {
      return null;
    }
    return {
      type: "set_mode",
      requestId: request.requestId,
      modeId: request.modeId,
      timeoutMs,
    };
  }

  if (request.type === "set_config_option") {
    if (
      typeof request.configId !== "string" ||
      request.configId.trim().length === 0 ||
      typeof request.value !== "string" ||
      request.value.trim().length === 0
    ) {
      return null;
    }
    return {
      type: "set_config_option",
      requestId: request.requestId,
      configId: request.configId,
      value: request.value,
      timeoutMs,
    };
  }

  return null;
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

  if (message.type === "client_operation") {
    const operation = asRecord(message.operation);
    if (
      !operation ||
      typeof operation.method !== "string" ||
      typeof operation.status !== "string" ||
      typeof operation.summary !== "string" ||
      typeof operation.timestamp !== "string"
    ) {
      return null;
    }
    if (
      operation.status !== "running" &&
      operation.status !== "completed" &&
      operation.status !== "failed"
    ) {
      return null;
    }
    return {
      type: "client_operation",
      requestId: message.requestId,
      operation: operation as ClientOperation,
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

  if (message.type === "cancel_result") {
    if (typeof message.cancelled !== "boolean") {
      return null;
    }
    return {
      type: "cancel_result",
      requestId: message.requestId,
      cancelled: message.cancelled,
    };
  }

  if (message.type === "set_mode_result") {
    if (typeof message.modeId !== "string") {
      return null;
    }
    return {
      type: "set_mode_result",
      requestId: message.requestId,
      modeId: message.modeId,
    };
  }

  if (message.type === "set_config_option_result") {
    const response = asRecord(message.response);
    if (!response || !Array.isArray(response.configOptions)) {
      return null;
    }
    return {
      type: "set_config_option_result",
      requestId: message.requestId,
      response: response as SetSessionConfigOptionResponse,
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
  return path.join(queueBaseDir(), `${queueKeyForSession(sessionId)}.lock`);
}

function queueSocketPath(sessionId: string): string {
  const key = queueKeyForSession(sessionId);
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\acpx-${key}`;
  }
  return path.join(queueBaseDir(), `${key}.sock`);
}

async function ensureQueueDir(): Promise<void> {
  await fs.mkdir(queueBaseDir(), { recursive: true });
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

export async function tryAcquireQueueOwnerLease(
  sessionId: string,
  nowIso: () => string = () => new Date().toISOString(),
): Promise<QueueOwnerLease | undefined> {
  await ensureQueueDir();
  const lockPath = queueLockFilePath(sessionId);
  const socketPath = queueSocketPath(sessionId);
  const payload = JSON.stringify(
    {
      pid: process.pid,
      sessionId,
      socketPath,
      createdAt: nowIso(),
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

export async function releaseQueueOwnerLease(lease: QueueOwnerLease): Promise<void> {
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

export async function waitMs(ms: number): Promise<void> {
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

export type QueueOwnerControlHandlers = {
  cancelPrompt: () => Promise<boolean>;
  setSessionMode: (modeId: string, timeoutMs?: number) => Promise<void>;
  setSessionConfigOption: (
    configId: string,
    value: string,
    timeoutMs?: number,
  ) => Promise<SetSessionConfigOptionResponse>;
};

export class SessionQueueOwner {
  private readonly server: net.Server;
  private readonly controlHandlers: QueueOwnerControlHandlers;
  private readonly pending: QueueTask[] = [];
  private readonly waiters: Array<(task: QueueTask | undefined) => void> = [];
  private closed = false;

  private constructor(server: net.Server, controlHandlers: QueueOwnerControlHandlers) {
    this.server = server;
    this.controlHandlers = controlHandlers;
  }

  static async start(
    lease: QueueOwnerLease,
    controlHandlers: QueueOwnerControlHandlers,
  ): Promise<SessionQueueOwner> {
    const ownerRef: { current: SessionQueueOwner | undefined } = { current: undefined };
    const server = net.createServer((socket) => {
      ownerRef.current?.handleConnection(socket);
    });
    ownerRef.current = new SessionQueueOwner(server, controlHandlers);

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

      const request = parseQueueRequest(parsed);
      if (!request) {
        fail("unknown", "Invalid queue request");
        return;
      }

      if (request.type === "cancel_prompt") {
        writeQueueMessage(socket, {
          type: "accepted",
          requestId: request.requestId,
        });
        void this.controlHandlers
          .cancelPrompt()
          .then((cancelled) => {
            writeQueueMessage(socket, {
              type: "cancel_result",
              requestId: request.requestId,
              cancelled,
            });
          })
          .catch((error) => {
            const message = formatError(error);
            writeQueueMessage(socket, {
              type: "error",
              requestId: request.requestId,
              message,
            });
          })
          .finally(() => {
            if (!socket.destroyed) {
              socket.end();
            }
          });
        return;
      }

      if (request.type === "set_mode") {
        writeQueueMessage(socket, {
          type: "accepted",
          requestId: request.requestId,
        });
        void this.controlHandlers
          .setSessionMode(request.modeId, request.timeoutMs)
          .then(() => {
            writeQueueMessage(socket, {
              type: "set_mode_result",
              requestId: request.requestId,
              modeId: request.modeId,
            });
          })
          .catch((error) => {
            const message = formatError(error);
            writeQueueMessage(socket, {
              type: "error",
              requestId: request.requestId,
              message,
            });
          })
          .finally(() => {
            if (!socket.destroyed) {
              socket.end();
            }
          });
        return;
      }

      if (request.type === "set_config_option") {
        writeQueueMessage(socket, {
          type: "accepted",
          requestId: request.requestId,
        });
        void this.controlHandlers
          .setSessionConfigOption(request.configId, request.value, request.timeoutMs)
          .then((response) => {
            writeQueueMessage(socket, {
              type: "set_config_option_result",
              requestId: request.requestId,
              response,
            });
          })
          .catch((error) => {
            const message = formatError(error);
            writeQueueMessage(socket, {
              type: "error",
              requestId: request.requestId,
              message,
            });
          })
          .finally(() => {
            if (!socket.destroyed) {
              socket.end();
            }
          });
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

export type SubmitToQueueOwnerOptions = {
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

      if (message.type === "client_operation") {
        options.outputFormatter.onClientOperation(message.operation);
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

      if (message.type === "error") {
        finishReject(new Error(message.message));
        return;
      }

      finishReject(new Error("Queue owner returned unexpected response"));
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

async function submitControlToQueueOwner<TResponse extends QueueOwnerMessage>(
  owner: QueueOwnerRecord,
  request: QueueRequest,
  isExpectedResponse: (message: QueueOwnerMessage) => message is TResponse,
): Promise<TResponse | undefined> {
  const socket = await connectToQueueOwner(owner);
  if (!socket) {
    return undefined;
  }

  socket.setEncoding("utf8");

  return await new Promise<TResponse>((resolve, reject) => {
    let settled = false;
    let acknowledged = false;
    let buffer = "";

    const finishResolve = (result: TResponse) => {
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
      if (!message || message.requestId !== request.requestId) {
        finishReject(new Error("Queue owner sent malformed message"));
        return;
      }

      if (message.type === "accepted") {
        acknowledged = true;
        return;
      }

      if (!acknowledged) {
        finishReject(new Error("Queue owner did not acknowledge request"));
        return;
      }

      if (message.type === "error") {
        finishReject(new Error(message.message));
        return;
      }

      if (!isExpectedResponse(message)) {
        finishReject(new Error("Queue owner returned unexpected response"));
        return;
      }

      finishResolve(message);
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
      finishReject(new Error("Queue owner disconnected before responding"));
    });

    socket.write(`${JSON.stringify(request)}\n`);
  });
}

async function submitCancelToQueueOwner(
  owner: QueueOwnerRecord,
): Promise<boolean | undefined> {
  const request: QueueCancelRequest = {
    type: "cancel_prompt",
    requestId: randomUUID(),
  };
  const response = await submitControlToQueueOwner(
    owner,
    request,
    (message): message is QueueOwnerCancelResultMessage =>
      message.type === "cancel_result",
  );
  if (!response) {
    return undefined;
  }
  if (response.requestId !== request.requestId) {
    throw new Error("Queue owner returned mismatched cancel response");
  }
  return response.cancelled;
}

async function submitSetModeToQueueOwner(
  owner: QueueOwnerRecord,
  modeId: string,
  timeoutMs?: number,
): Promise<boolean | undefined> {
  const request: QueueSetModeRequest = {
    type: "set_mode",
    requestId: randomUUID(),
    modeId,
    timeoutMs,
  };
  const response = await submitControlToQueueOwner(
    owner,
    request,
    (message): message is QueueOwnerSetModeResultMessage =>
      message.type === "set_mode_result",
  );
  if (!response) {
    return undefined;
  }
  if (response.requestId !== request.requestId) {
    throw new Error("Queue owner returned mismatched set_mode response");
  }
  return true;
}

async function submitSetConfigOptionToQueueOwner(
  owner: QueueOwnerRecord,
  configId: string,
  value: string,
  timeoutMs?: number,
): Promise<SetSessionConfigOptionResponse | undefined> {
  const request: QueueSetConfigOptionRequest = {
    type: "set_config_option",
    requestId: randomUUID(),
    configId,
    value,
    timeoutMs,
  };
  const response = await submitControlToQueueOwner(
    owner,
    request,
    (message): message is QueueOwnerSetConfigOptionResultMessage =>
      message.type === "set_config_option_result",
  );
  if (!response) {
    return undefined;
  }
  if (response.requestId !== request.requestId) {
    throw new Error("Queue owner returned mismatched set_config_option response");
  }
  return response.response;
}

export async function trySubmitToRunningOwner(
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

export async function tryCancelOnRunningOwner(options: {
  sessionId: string;
  verbose?: boolean;
}): Promise<boolean | undefined> {
  const owner = await readQueueOwnerRecord(options.sessionId);
  if (!owner) {
    return undefined;
  }

  if (!isProcessAlive(owner.pid)) {
    await cleanupStaleQueueOwner(options.sessionId, owner);
    return undefined;
  }

  const cancelled = await submitCancelToQueueOwner(owner);
  if (cancelled !== undefined) {
    if (options.verbose) {
      process.stderr.write(
        `[acpx] requested cancel on active owner pid ${owner.pid} for session ${options.sessionId}\n`,
      );
    }
    return cancelled;
  }

  if (!isProcessAlive(owner.pid)) {
    await cleanupStaleQueueOwner(options.sessionId, owner);
    return undefined;
  }

  throw new Error("Session queue owner is running but not accepting cancel requests");
}

export async function trySetModeOnRunningOwner(
  sessionId: string,
  modeId: string,
  timeoutMs: number | undefined,
  verbose: boolean | undefined,
): Promise<boolean | undefined> {
  const owner = await readQueueOwnerRecord(sessionId);
  if (!owner) {
    return undefined;
  }

  if (!isProcessAlive(owner.pid)) {
    await cleanupStaleQueueOwner(sessionId, owner);
    return undefined;
  }

  const submitted = await submitSetModeToQueueOwner(owner, modeId, timeoutMs);
  if (submitted) {
    if (verbose) {
      process.stderr.write(
        `[acpx] requested session/set_mode on owner pid ${owner.pid} for session ${sessionId}\n`,
      );
    }
    return true;
  }

  if (!isProcessAlive(owner.pid)) {
    await cleanupStaleQueueOwner(sessionId, owner);
    return undefined;
  }

  throw new Error("Session queue owner is running but not accepting set_mode requests");
}

export async function trySetConfigOptionOnRunningOwner(
  sessionId: string,
  configId: string,
  value: string,
  timeoutMs: number | undefined,
  verbose: boolean | undefined,
): Promise<SetSessionConfigOptionResponse | undefined> {
  const owner = await readQueueOwnerRecord(sessionId);
  if (!owner) {
    return undefined;
  }

  if (!isProcessAlive(owner.pid)) {
    await cleanupStaleQueueOwner(sessionId, owner);
    return undefined;
  }

  const response = await submitSetConfigOptionToQueueOwner(
    owner,
    configId,
    value,
    timeoutMs,
  );
  if (response) {
    if (verbose) {
      process.stderr.write(
        `[acpx] requested session/set_config_option on owner pid ${owner.pid} for session ${sessionId}\n`,
      );
    }
    return response;
  }

  if (!isProcessAlive(owner.pid)) {
    await cleanupStaleQueueOwner(sessionId, owner);
    return undefined;
  }

  throw new Error(
    "Session queue owner is running but not accepting set_config_option requests",
  );
}

export async function terminateQueueOwnerForSession(sessionId: string): Promise<void> {
  const owner = await readQueueOwnerRecord(sessionId);
  if (!owner) {
    return;
  }

  if (isProcessAlive(owner.pid)) {
    await terminateProcess(owner.pid);
  }

  await cleanupStaleQueueOwner(sessionId, owner);
}
