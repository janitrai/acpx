import type { SetSessionConfigOptionResponse } from "@agentclientprotocol/sdk";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { QueueConnectionError, QueueProtocolError } from "./errors.js";
import {
  parseQueueOwnerMessage,
  type QueueCancelRequest,
  type QueueOwnerCancelResultMessage,
  type QueueOwnerMessage,
  type QueueOwnerSetConfigOptionResultMessage,
  type QueueOwnerSetModeResultMessage,
  type QueueRequest,
  type QueueSetConfigOptionRequest,
  type QueueSetModeRequest,
  type QueueSubmitRequest,
} from "./queue-messages.js";
import type {
  NonInteractivePermissionPolicy,
  OutputErrorEmissionPolicy,
  OutputFormatter,
  PermissionMode,
  SessionEnqueueResult,
  SessionSendOutcome,
} from "./types.js";

const PROCESS_EXIT_GRACE_MS = 1_500;
const PROCESS_POLL_MS = 50;
const QUEUE_CONNECT_ATTEMPTS = 40;
export const QUEUE_CONNECT_RETRY_MS = 50;

function queueBaseDir(): string {
  return path.join(os.homedir(), ".acpx", "queues");
}

const STALE_OWNER_PROTOCOL_DETAIL_CODES = new Set([
  "QUEUE_PROTOCOL_MALFORMED_MESSAGE",
  "QUEUE_PROTOCOL_UNEXPECTED_RESPONSE",
]);

async function maybeRecoverStaleOwnerAfterProtocolMismatch(params: {
  sessionId: string;
  owner: QueueOwnerRecord;
  error: unknown;
  verbose?: boolean;
}): Promise<boolean> {
  if (!(params.error instanceof QueueProtocolError)) {
    return false;
  }

  const detailCode = params.error.detailCode;
  if (!detailCode || !STALE_OWNER_PROTOCOL_DETAIL_CODES.has(detailCode)) {
    return false;
  }

  await cleanupStaleQueueOwner(params.sessionId, params.owner).catch(() => {
    // Preserve existing behavior if cleanup fails.
  });

  if (params.verbose) {
    process.stderr.write(
      `[acpx] dropped stale queue owner metadata after protocol mismatch for session ${params.sessionId} (${detailCode})\n`,
    );
  }

  return true;
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

export type QueueOwnerHealth = {
  sessionId: string;
  hasLease: boolean;
  healthy: boolean;
  socketReachable: boolean;
  pidAlive: boolean;
  pid?: number;
  socketPath?: string;
};

export type QueueOwnerLease = {
  lockPath: string;
  socketPath: string;
};

export type { QueueOwnerMessage, QueueSubmitRequest } from "./queue-messages.js";
export type { QueueOwnerControlHandlers, QueueTask } from "./queue-ipc-server.js";
export { SessionQueueOwner } from "./queue-ipc-server.js";

function parseQueueOwnerRecord(raw: unknown): QueueOwnerRecord | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;

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
  maxAttempts = QUEUE_CONNECT_ATTEMPTS,
): Promise<net.Socket | undefined> {
  let lastError: unknown;

  const attempts = Math.max(1, Math.trunc(maxAttempts));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await connectToSocket(owner.socketPath);
    } catch (error) {
      lastError = error;
      if (!shouldRetryQueueConnect(error)) {
        throw error;
      }
      await waitMs(QUEUE_CONNECT_RETRY_MS);
    }
  }

  if (lastError && !shouldRetryQueueConnect(lastError)) {
    throw lastError;
  }

  return undefined;
}

export async function probeQueueOwnerHealth(
  sessionId: string,
): Promise<QueueOwnerHealth> {
  const owner = await readQueueOwnerRecord(sessionId);
  if (!owner) {
    return {
      sessionId,
      hasLease: false,
      healthy: false,
      socketReachable: false,
      pidAlive: false,
    };
  }

  const pidAlive = isProcessAlive(owner.pid);
  let socketReachable = false;

  try {
    const socket = await connectToQueueOwner(owner, 2);
    if (socket) {
      socketReachable = true;
      if (!socket.destroyed) {
        socket.end();
      }
    }
  } catch {
    socketReachable = false;
  }

  if (!socketReachable && !pidAlive) {
    await cleanupStaleQueueOwner(sessionId, owner);
    return {
      sessionId,
      hasLease: false,
      healthy: false,
      socketReachable: false,
      pidAlive: false,
    };
  }

  return {
    sessionId,
    hasLease: true,
    healthy: socketReachable,
    socketReachable,
    pidAlive,
    pid: owner.pid,
    socketPath: owner.socketPath,
  };
}

export type SubmitToQueueOwnerOptions = {
  sessionId: string;
  message: string;
  permissionMode: PermissionMode;
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  outputFormatter: OutputFormatter;
  errorEmissionPolicy?: OutputErrorEmissionPolicy;
  timeoutMs?: number;
  suppressSdkConsoleErrors?: boolean;
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
    nonInteractivePermissions: options.nonInteractivePermissions,
    timeoutMs: options.timeoutMs,
    suppressSdkConsoleErrors: options.suppressSdkConsoleErrors,
    waitForCompletion: options.waitForCompletion,
  };

  options.outputFormatter.setContext({
    sessionId: options.sessionId,
  });

  return await new Promise<SessionSendOutcome>((resolve, reject) => {
    let settled = false;
    let acknowledged = false;
    let buffer = "";

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
        finishReject(
          new QueueProtocolError("Queue owner sent invalid JSON payload", {
            detailCode: "QUEUE_PROTOCOL_INVALID_JSON",
            origin: "queue",
            retryable: true,
          }),
        );
        return;
      }

      const message = parseQueueOwnerMessage(parsed);
      if (!message || message.requestId !== requestId) {
        finishReject(
          new QueueProtocolError("Queue owner sent malformed message", {
            detailCode: "QUEUE_PROTOCOL_MALFORMED_MESSAGE",
            origin: "queue",
            retryable: true,
          }),
        );
        return;
      }

      if (message.type === "accepted") {
        acknowledged = true;
        options.outputFormatter.setContext({
          sessionId: options.sessionId,
        });
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

      if (message.type === "error") {
        options.outputFormatter.setContext({
          sessionId: options.sessionId,
        });

        const queueErrorAlreadyEmitted =
          options.errorEmissionPolicy?.queueErrorAlreadyEmitted ?? true;
        const outputAlreadyEmitted = message.outputAlreadyEmitted === true;
        const shouldEmitInFormatter =
          !outputAlreadyEmitted || !queueErrorAlreadyEmitted;
        if (shouldEmitInFormatter) {
          options.outputFormatter.onError({
            code: message.code ?? "RUNTIME",
            detailCode: message.detailCode,
            origin: message.origin ?? "queue",
            message: message.message,
            retryable: message.retryable,
            acp: message.acp,
          });
          options.outputFormatter.flush();
        }
        finishReject(
          new QueueConnectionError(message.message, {
            outputCode: message.code,
            detailCode: message.detailCode,
            origin: message.origin ?? "queue",
            retryable: message.retryable,
            acp: message.acp,
            ...(queueErrorAlreadyEmitted ? { outputAlreadyEmitted: true } : {}),
          }),
        );
        return;
      }

      if (!acknowledged) {
        finishReject(
          new QueueConnectionError("Queue owner did not acknowledge request", {
            detailCode: "QUEUE_ACK_MISSING",
            origin: "queue",
            retryable: true,
          }),
        );
        return;
      }

      if (message.type === "event") {
        options.outputFormatter.onAcpMessage(message.message);
        return;
      }

      if (message.type === "result") {
        options.outputFormatter.flush();
        finishResolve(message.result);
        return;
      }

      finishReject(
        new QueueProtocolError("Queue owner returned unexpected response", {
          detailCode: "QUEUE_PROTOCOL_UNEXPECTED_RESPONSE",
          origin: "queue",
          retryable: true,
        }),
      );
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

    socket.once("error", (error: Error) => {
      finishReject(error);
    });

    socket.once("close", () => {
      if (settled) {
        return;
      }

      if (!acknowledged) {
        finishReject(
          new QueueConnectionError(
            "Queue owner disconnected before acknowledging request",
            {
              detailCode: "QUEUE_DISCONNECTED_BEFORE_ACK",
              origin: "queue",
              retryable: true,
            },
          ),
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

      finishReject(
        new QueueConnectionError("Queue owner disconnected before prompt completion", {
          detailCode: "QUEUE_DISCONNECTED_BEFORE_COMPLETION",
          origin: "queue",
          retryable: true,
        }),
      );
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
        finishReject(
          new QueueProtocolError("Queue owner sent invalid JSON payload", {
            detailCode: "QUEUE_PROTOCOL_INVALID_JSON",
            origin: "queue",
            retryable: true,
          }),
        );
        return;
      }

      const message = parseQueueOwnerMessage(parsed);
      if (!message || message.requestId !== request.requestId) {
        finishReject(
          new QueueProtocolError("Queue owner sent malformed message", {
            detailCode: "QUEUE_PROTOCOL_MALFORMED_MESSAGE",
            origin: "queue",
            retryable: true,
          }),
        );
        return;
      }

      if (message.type === "accepted") {
        acknowledged = true;
        return;
      }

      if (message.type === "error") {
        finishReject(
          new QueueConnectionError(message.message, {
            outputCode: message.code,
            detailCode: message.detailCode,
            origin: message.origin ?? "queue",
            retryable: message.retryable,
            acp: message.acp,
          }),
        );
        return;
      }

      if (!acknowledged) {
        finishReject(
          new QueueConnectionError("Queue owner did not acknowledge request", {
            detailCode: "QUEUE_ACK_MISSING",
            origin: "queue",
            retryable: true,
          }),
        );
        return;
      }

      if (!isExpectedResponse(message)) {
        finishReject(
          new QueueProtocolError("Queue owner returned unexpected response", {
            detailCode: "QUEUE_PROTOCOL_UNEXPECTED_RESPONSE",
            origin: "queue",
            retryable: true,
          }),
        );
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

    socket.once("error", (error: Error) => {
      finishReject(error);
    });

    socket.once("close", () => {
      if (settled) {
        return;
      }
      if (!acknowledged) {
        finishReject(
          new QueueConnectionError(
            "Queue owner disconnected before acknowledging request",
            {
              detailCode: "QUEUE_DISCONNECTED_BEFORE_ACK",
              origin: "queue",
              retryable: true,
            },
          ),
        );
        return;
      }
      finishReject(
        new QueueConnectionError("Queue owner disconnected before responding", {
          detailCode: "QUEUE_DISCONNECTED_BEFORE_COMPLETION",
          origin: "queue",
          retryable: true,
        }),
      );
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
    throw new QueueProtocolError("Queue owner returned mismatched cancel response", {
      detailCode: "QUEUE_PROTOCOL_MALFORMED_MESSAGE",
      origin: "queue",
      retryable: true,
    });
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
    throw new QueueProtocolError("Queue owner returned mismatched set_mode response", {
      detailCode: "QUEUE_PROTOCOL_MALFORMED_MESSAGE",
      origin: "queue",
      retryable: true,
    });
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
    throw new QueueProtocolError(
      "Queue owner returned mismatched set_config_option response",
      {
        detailCode: "QUEUE_PROTOCOL_MALFORMED_MESSAGE",
        origin: "queue",
        retryable: true,
      },
    );
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

  let submitted: SessionSendOutcome | undefined;
  try {
    submitted = await submitToQueueOwner(owner, options);
  } catch (error) {
    const recovered = await maybeRecoverStaleOwnerAfterProtocolMismatch({
      sessionId: options.sessionId,
      owner,
      error,
      verbose: options.verbose,
    });
    if (recovered) {
      return undefined;
    }
    throw error;
  }
  if (submitted) {
    if (options.verbose) {
      process.stderr.write(
        `[acpx] queued prompt on active owner pid ${owner.pid} for session ${options.sessionId}\n`,
      );
    }
    return submitted;
  }

  const health = await probeQueueOwnerHealth(options.sessionId);
  if (!health.hasLease) {
    return undefined;
  }

  throw new QueueConnectionError(
    "Session queue owner is running but not accepting queue requests",
    {
      detailCode: "QUEUE_NOT_ACCEPTING_REQUESTS",
      origin: "queue",
      retryable: true,
    },
  );
}

export async function tryCancelOnRunningOwner(options: {
  sessionId: string;
  verbose?: boolean;
}): Promise<boolean | undefined> {
  const owner = await readQueueOwnerRecord(options.sessionId);
  if (!owner) {
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

  const health = await probeQueueOwnerHealth(options.sessionId);
  if (!health.hasLease) {
    return undefined;
  }

  throw new QueueConnectionError(
    "Session queue owner is running but not accepting cancel requests",
    {
      detailCode: "QUEUE_NOT_ACCEPTING_REQUESTS",
      origin: "queue",
      retryable: true,
    },
  );
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

  const submitted = await submitSetModeToQueueOwner(owner, modeId, timeoutMs);
  if (submitted) {
    if (verbose) {
      process.stderr.write(
        `[acpx] requested session/set_mode on owner pid ${owner.pid} for session ${sessionId}\n`,
      );
    }
    return true;
  }

  const health = await probeQueueOwnerHealth(sessionId);
  if (!health.hasLease) {
    return undefined;
  }

  throw new QueueConnectionError(
    "Session queue owner is running but not accepting set_mode requests",
    {
      detailCode: "QUEUE_NOT_ACCEPTING_REQUESTS",
      origin: "queue",
      retryable: true,
    },
  );
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

  const health = await probeQueueOwnerHealth(sessionId);
  if (!health.hasLease) {
    return undefined;
  }

  throw new QueueConnectionError(
    "Session queue owner is running but not accepting set_config_option requests",
    {
      detailCode: "QUEUE_NOT_ACCEPTING_REQUESTS",
      origin: "queue",
      retryable: true,
    },
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
