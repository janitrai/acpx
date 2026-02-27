import { randomUUID } from "node:crypto";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import {
  ACPX_EVENT_OUTPUT_STREAMS,
  ACPX_EVENT_SCHEMA,
  ACPX_EVENT_STATUS_SNAPSHOT_STATUSES,
  ACPX_EVENT_TOOL_CALL_STATUSES,
  ACPX_EVENT_TURN_MODES,
  ACPX_EVENT_TYPES,
  OUTPUT_ERROR_CODES,
  OUTPUT_ERROR_ORIGINS,
  type AcpxEvent,
  type AcpxEventDraft,
  type AcpxEventOutputStream,
  type ClientOperation,
  type OutputErrorAcpPayload,
  type OutputErrorCode,
  type OutputErrorOrigin,
} from "./types.js";

type EventIdentity = {
  sessionId: string;
  acpSessionId?: string;
  agentSessionId?: string;
  requestId?: string;
  seq: number;
  ts?: string;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function isoNow(): string {
  return new Date().toISOString();
}

function trimNonEmpty(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function truncateInputPreview(message: string, maxChars = 200): string {
  const trimmed = message.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  if (maxChars <= 3) {
    return trimmed.slice(0, maxChars);
  }
  return `${trimmed.slice(0, maxChars - 3)}...`;
}

export function createAcpxEvent(
  identity: EventIdentity,
  draft: AcpxEventDraft,
): AcpxEvent {
  return {
    schema: ACPX_EVENT_SCHEMA,
    event_id: randomUUID(),
    session_id: identity.sessionId,
    acp_session_id: trimNonEmpty(identity.acpSessionId),
    agent_session_id: trimNonEmpty(identity.agentSessionId),
    request_id: trimNonEmpty(draft.request_id ?? identity.requestId),
    seq: identity.seq,
    ts: identity.ts ?? isoNow(),
    type: draft.type,
    data: draft.data,
  } as AcpxEvent;
}

export function sessionUpdateToEventDrafts(
  notification: SessionNotification,
): AcpxEventDraft[] {
  const update = notification.update;

  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      if (update.content.type !== "text") {
        return [];
      }
      return [
        {
          type: ACPX_EVENT_TYPES.OUTPUT_DELTA,
          data: {
            stream: "output",
            text: update.content.text,
          },
        },
      ];
    }
    case "agent_thought_chunk": {
      if (update.content.type !== "text") {
        return [];
      }
      return [
        {
          type: ACPX_EVENT_TYPES.OUTPUT_DELTA,
          data: {
            stream: "thought",
            text: update.content.text,
          },
        },
      ];
    }
    case "tool_call":
    case "tool_call_update": {
      return [
        {
          type: ACPX_EVENT_TYPES.TOOL_CALL,
          data: {
            tool_call_id: update.toolCallId,
            title: update.title ?? undefined,
            status: update.status ?? undefined,
          },
        },
      ];
    }
    case "plan": {
      return [
        {
          type: ACPX_EVENT_TYPES.PLAN,
          data: {
            entries: update.entries.map((entry) => ({
              content: entry.content,
              status: entry.status,
              priority: entry.priority,
            })),
          },
        },
      ];
    }
    default: {
      return [
        {
          type: ACPX_EVENT_TYPES.UPDATE,
          data: {
            update: update.sessionUpdate,
          },
        },
      ];
    }
  }
}

export function clientOperationToEventDraft(
  operation: ClientOperation,
): AcpxEventDraft {
  return {
    type: ACPX_EVENT_TYPES.CLIENT_OPERATION,
    data: {
      method: operation.method,
      status: operation.status,
      summary: operation.summary,
      details: operation.details,
    },
  };
}

export function errorToEventDraft(params: {
  code: OutputErrorCode;
  detailCode?: string;
  origin?: OutputErrorOrigin;
  message: string;
  retryable?: boolean;
  acp?: OutputErrorAcpPayload;
}): AcpxEventDraft {
  return {
    type: ACPX_EVENT_TYPES.ERROR,
    data: {
      code: params.code,
      detail_code: params.detailCode,
      origin: params.origin,
      message: params.message,
      retryable: params.retryable,
      acp_error: params.acp,
    },
  };
}

function isAcpxEventOutputStream(value: unknown): value is AcpxEventOutputStream {
  return (
    typeof value === "string" &&
    ACPX_EVENT_OUTPUT_STREAMS.includes(value as AcpxEventOutputStream)
  );
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

function isAcpError(value: unknown): value is OutputErrorAcpPayload {
  const record = asRecord(value);
  return (
    !!record &&
    typeof record.code === "number" &&
    Number.isFinite(record.code) &&
    typeof record.message === "string"
  );
}

function isToolCallStatus(value: unknown): boolean {
  return (
    typeof value === "string" &&
    ACPX_EVENT_TOOL_CALL_STATUSES.includes(
      value as (typeof ACPX_EVENT_TOOL_CALL_STATUSES)[number],
    )
  );
}

function isFiniteInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function hasOnlyKeys(data: Record<string, unknown>, allowed: string[]): boolean {
  const allowedSet = new Set<string>(allowed);
  return Object.keys(data).every((key) => allowedSet.has(key));
}

export function isAcpxEvent(value: unknown): value is AcpxEvent {
  const event = asRecord(value);
  if (!event) {
    return false;
  }

  if (
    event.schema !== ACPX_EVENT_SCHEMA ||
    typeof event.event_id !== "string" ||
    typeof event.session_id !== "string" ||
    typeof event.seq !== "number" ||
    !Number.isInteger(event.seq) ||
    event.seq < 0 ||
    typeof event.ts !== "string" ||
    typeof event.type !== "string"
  ) {
    return false;
  }

  if (event.request_id !== undefined && typeof event.request_id !== "string") {
    return false;
  }

  if (event.acp_session_id !== undefined && typeof event.acp_session_id !== "string") {
    return false;
  }

  if (
    event.agent_session_id !== undefined &&
    typeof event.agent_session_id !== "string"
  ) {
    return false;
  }

  const data = asRecord(event.data);
  if (!data) {
    return false;
  }

  switch (event.type) {
    case ACPX_EVENT_TYPES.TURN_STARTED:
      return (
        hasOnlyKeys(data, ["mode", "resumed", "input_preview"]) &&
        typeof data.mode === "string" &&
        ACPX_EVENT_TURN_MODES.includes(
          data.mode as (typeof ACPX_EVENT_TURN_MODES)[number],
        ) &&
        typeof data.resumed === "boolean" &&
        (data.input_preview === undefined || typeof data.input_preview === "string")
      );
    case ACPX_EVENT_TYPES.OUTPUT_DELTA:
      return (
        hasOnlyKeys(data, ["stream", "text"]) &&
        isAcpxEventOutputStream(data.stream) &&
        typeof data.text === "string"
      );
    case ACPX_EVENT_TYPES.TOOL_CALL:
      return (
        hasOnlyKeys(data, ["tool_call_id", "title", "status"]) &&
        typeof data.tool_call_id === "string" &&
        data.tool_call_id.trim().length > 0 &&
        (data.title === undefined ||
          (typeof data.title === "string" && data.title.trim().length > 0)) &&
        (data.status === undefined || isToolCallStatus(data.status))
      );
    case ACPX_EVENT_TYPES.PLAN:
      return (
        hasOnlyKeys(data, ["entries"]) &&
        Array.isArray(data.entries) &&
        data.entries.every((entry) => {
          const parsed = asRecord(entry);
          return (
            !!parsed &&
            hasOnlyKeys(parsed, ["content", "status", "priority"]) &&
            typeof parsed.content === "string" &&
            typeof parsed.status === "string" &&
            typeof parsed.priority === "string"
          );
        })
      );
    case ACPX_EVENT_TYPES.UPDATE:
      return hasOnlyKeys(data, ["update"]) && typeof data.update === "string";
    case ACPX_EVENT_TYPES.CLIENT_OPERATION:
      return (
        hasOnlyKeys(data, ["method", "status", "summary", "details"]) &&
        typeof data.method === "string" &&
        typeof data.status === "string" &&
        typeof data.summary === "string" &&
        (data.details === undefined || typeof data.details === "string")
      );
    case ACPX_EVENT_TYPES.TURN_DONE:
      return (
        hasOnlyKeys(data, ["stop_reason", "permission_stats"]) &&
        typeof data.stop_reason === "string" &&
        (data.permission_stats === undefined ||
          (() => {
            const stats = asRecord(data.permission_stats);
            return (
              !!stats &&
              hasOnlyKeys(stats, ["requested", "approved", "denied", "cancelled"]) &&
              isFiniteInteger(stats.requested) &&
              isFiniteInteger(stats.approved) &&
              isFiniteInteger(stats.denied) &&
              isFiniteInteger(stats.cancelled)
            );
          })())
      );
    case ACPX_EVENT_TYPES.ERROR:
      return (
        hasOnlyKeys(data, [
          "code",
          "detail_code",
          "origin",
          "message",
          "retryable",
          "acp_error",
        ]) &&
        isOutputErrorCode(data.code) &&
        (data.detail_code === undefined || typeof data.detail_code === "string") &&
        (data.origin === undefined || isOutputErrorOrigin(data.origin)) &&
        typeof data.message === "string" &&
        (data.retryable === undefined || typeof data.retryable === "boolean") &&
        (data.acp_error === undefined || isAcpError(data.acp_error))
      );
    case ACPX_EVENT_TYPES.PROMPT_QUEUED:
      return (
        hasOnlyKeys(data, ["request_id"]) &&
        typeof data.request_id === "string" &&
        data.request_id.trim().length > 0
      );
    case ACPX_EVENT_TYPES.SESSION_ENSURED:
      return (
        hasOnlyKeys(data, ["created", "name", "replaced_session_id"]) &&
        typeof data.created === "boolean" &&
        (data.name === undefined || typeof data.name === "string") &&
        (data.replaced_session_id === undefined ||
          typeof data.replaced_session_id === "string")
      );
    case ACPX_EVENT_TYPES.CANCEL_REQUESTED:
      return hasOnlyKeys(data, []);
    case ACPX_EVENT_TYPES.CANCEL_RESULT:
      return hasOnlyKeys(data, ["cancelled"]) && typeof data.cancelled === "boolean";
    case ACPX_EVENT_TYPES.MODE_SET:
      return (
        hasOnlyKeys(data, ["mode_id", "resumed"]) &&
        typeof data.mode_id === "string" &&
        data.mode_id.trim().length > 0 &&
        (data.resumed === undefined || typeof data.resumed === "boolean")
      );
    case ACPX_EVENT_TYPES.CONFIG_SET:
      return (
        hasOnlyKeys(data, ["config_id", "value", "resumed", "config_options"]) &&
        typeof data.config_id === "string" &&
        data.config_id.trim().length > 0 &&
        typeof data.value === "string" &&
        (data.resumed === undefined || typeof data.resumed === "boolean") &&
        (data.config_options === undefined || Array.isArray(data.config_options))
      );
    case ACPX_EVENT_TYPES.STATUS_SNAPSHOT:
      return (
        hasOnlyKeys(data, [
          "status",
          "pid",
          "summary",
          "uptime",
          "last_prompt_time",
          "exit_code",
          "signal",
        ]) &&
        typeof data.status === "string" &&
        ACPX_EVENT_STATUS_SNAPSHOT_STATUSES.includes(
          data.status as (typeof ACPX_EVENT_STATUS_SNAPSHOT_STATUSES)[number],
        ) &&
        (data.pid === undefined || (isFiniteInteger(data.pid) && data.pid > 0)) &&
        (data.summary === undefined || typeof data.summary === "string") &&
        (data.uptime === undefined || typeof data.uptime === "string") &&
        (data.last_prompt_time === undefined ||
          typeof data.last_prompt_time === "string") &&
        (data.exit_code === undefined || isFiniteInteger(data.exit_code)) &&
        (data.signal === undefined || typeof data.signal === "string")
      );
    case ACPX_EVENT_TYPES.SESSION_CLOSED:
      return hasOnlyKeys(data, ["reason"]) && data.reason === "close";
    default:
      return false;
  }
}
