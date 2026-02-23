import type {
  SetSessionConfigOptionResponse,
  SessionNotification,
  StopReason,
} from "@agentclientprotocol/sdk";
import {
  OUTPUT_ERROR_CODES,
  OUTPUT_ERROR_ORIGINS,
  type OutputErrorAcpPayload,
  type OutputErrorCode,
  type OutputErrorOrigin,
} from "./types.js";
import type {
  ClientOperation,
  NonInteractivePermissionPolicy,
  PermissionMode,
  SessionSendResult,
} from "./types.js";

export type QueueSubmitRequest = {
  type: "submit_prompt";
  requestId: string;
  message: string;
  permissionMode: PermissionMode;
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  timeoutMs?: number;
  suppressSdkConsoleErrors?: boolean;
  waitForCompletion: boolean;
};

export type QueueCancelRequest = {
  type: "cancel_prompt";
  requestId: string;
};

export type QueueSetModeRequest = {
  type: "set_mode";
  requestId: string;
  modeId: string;
  timeoutMs?: number;
};

export type QueueSetConfigOptionRequest = {
  type: "set_config_option";
  requestId: string;
  configId: string;
  value: string;
  timeoutMs?: number;
};

export type QueueRequest =
  | QueueSubmitRequest
  | QueueCancelRequest
  | QueueSetModeRequest
  | QueueSetConfigOptionRequest;

export type QueueOwnerAcceptedMessage = {
  type: "accepted";
  requestId: string;
};

export type QueueOwnerSessionUpdateMessage = {
  type: "session_update";
  requestId: string;
  notification: SessionNotification;
};

export type QueueOwnerClientOperationMessage = {
  type: "client_operation";
  requestId: string;
  operation: ClientOperation;
};

export type QueueOwnerDoneMessage = {
  type: "done";
  requestId: string;
  stopReason: StopReason;
};

export type QueueOwnerResultMessage = {
  type: "result";
  requestId: string;
  result: SessionSendResult;
};

export type QueueOwnerCancelResultMessage = {
  type: "cancel_result";
  requestId: string;
  cancelled: boolean;
};

export type QueueOwnerSetModeResultMessage = {
  type: "set_mode_result";
  requestId: string;
  modeId: string;
};

export type QueueOwnerSetConfigOptionResultMessage = {
  type: "set_config_option_result";
  requestId: string;
  response: SetSessionConfigOptionResponse;
};

export type QueueOwnerErrorMessage = {
  type: "error";
  requestId: string;
  code?: OutputErrorCode;
  detailCode?: string;
  origin?: OutputErrorOrigin;
  message: string;
  retryable?: boolean;
  acp?: OutputErrorAcpPayload;
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function isPermissionMode(value: unknown): value is PermissionMode {
  return value === "approve-all" || value === "approve-reads" || value === "deny-all";
}

function isNonInteractivePermissionPolicy(
  value: unknown,
): value is NonInteractivePermissionPolicy {
  return value === "deny" || value === "fail";
}

function isOutputErrorCode(value: unknown): value is OutputErrorCode {
  return (
    typeof value === "string" && OUTPUT_ERROR_CODES.includes(value as OutputErrorCode)
  );
}

function isOutputErrorOrigin(value: unknown): value is OutputErrorOrigin {
  return (
    typeof value === "string" &&
    OUTPUT_ERROR_ORIGINS.includes(value as OutputErrorOrigin)
  );
}

function parseAcpError(value: unknown): OutputErrorAcpPayload | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  if (typeof record.code !== "number" || !Number.isFinite(record.code)) {
    return undefined;
  }
  if (typeof record.message !== "string" || record.message.length === 0) {
    return undefined;
  }

  return {
    code: record.code,
    message: record.message,
    data: record.data,
  };
}

export function parseQueueRequest(raw: unknown): QueueRequest | null {
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
    const nonInteractivePermissions =
      request.nonInteractivePermissions == null
        ? undefined
        : isNonInteractivePermissionPolicy(request.nonInteractivePermissions)
          ? request.nonInteractivePermissions
          : null;
    const suppressSdkConsoleErrors =
      request.suppressSdkConsoleErrors == null
        ? undefined
        : typeof request.suppressSdkConsoleErrors === "boolean"
          ? request.suppressSdkConsoleErrors
          : null;

    if (
      typeof request.message !== "string" ||
      !isPermissionMode(request.permissionMode) ||
      nonInteractivePermissions === null ||
      suppressSdkConsoleErrors === null ||
      typeof request.waitForCompletion !== "boolean"
    ) {
      return null;
    }

    return {
      type: "submit_prompt",
      requestId: request.requestId,
      message: request.message,
      permissionMode: request.permissionMode,
      nonInteractivePermissions,
      timeoutMs,
      ...(suppressSdkConsoleErrors !== undefined ? { suppressSdkConsoleErrors } : {}),
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

export function parseQueueOwnerMessage(raw: unknown): QueueOwnerMessage | null {
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
    const code = isOutputErrorCode(message.code) ? message.code : undefined;
    const detailCode =
      typeof message.detailCode === "string" && message.detailCode.trim().length > 0
        ? message.detailCode
        : undefined;
    const origin = isOutputErrorOrigin(message.origin) ? message.origin : undefined;
    const retryable =
      typeof message.retryable === "boolean" ? message.retryable : undefined;
    const acp = parseAcpError(message.acp);

    return {
      type: "error",
      requestId: message.requestId,
      code,
      detailCode,
      origin,
      message: message.message,
      retryable,
      acp,
    };
  }

  return null;
}
