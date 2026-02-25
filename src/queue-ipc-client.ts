import type { SetSessionConfigOptionResponse } from "@agentclientprotocol/sdk";
import { randomUUID } from "node:crypto";
import net from "node:net";
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
import {
  ensureOwnerIsUsable,
  isProcessAlive,
  readQueueOwnerRecord,
  type QueueOwnerRecord,
  waitMs,
} from "./queue-lease-store.js";
import type {
  NonInteractivePermissionPolicy,
  OutputErrorEmissionPolicy,
  OutputFormatter,
  PermissionMode,
  SessionEnqueueResult,
  SessionSendOutcome,
} from "./types.js";

const QUEUE_CONNECT_ATTEMPTS = 40;
export const QUEUE_CONNECT_RETRY_MS = 50;

function shouldRetryQueueConnect(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ECONNREFUSED";
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
    requestId,
    stream: "prompt",
  });

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
          requestId: message.requestId,
          stream: "prompt",
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
          requestId: message.requestId,
          stream: "prompt",
        });
        options.outputFormatter.onError({
          code: message.code ?? "RUNTIME",
          detailCode: message.detailCode,
          origin: message.origin ?? "queue",
          message: message.message,
          retryable: message.retryable,
          acp: message.acp,
        });
        options.outputFormatter.flush();
        const queueErrorAlreadyEmitted =
          options.errorEmissionPolicy?.queueErrorAlreadyEmitted ?? true;
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

    socket.once("error", (error) => {
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

    socket.once("error", (error) => {
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

  if (!(await ensureOwnerIsUsable(options.sessionId, owner))) {
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

  if (!(await ensureOwnerIsUsable(options.sessionId, owner))) {
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

  if (!(await ensureOwnerIsUsable(options.sessionId, owner))) {
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

  if (!(await ensureOwnerIsUsable(options.sessionId, owner))) {
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

  if (!(await ensureOwnerIsUsable(sessionId, owner))) {
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

  if (!(await ensureOwnerIsUsable(sessionId, owner))) {
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

  if (!(await ensureOwnerIsUsable(sessionId, owner))) {
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

  if (!(await ensureOwnerIsUsable(sessionId, owner))) {
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
