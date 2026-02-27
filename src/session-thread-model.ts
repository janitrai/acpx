import { randomUUID } from "node:crypto";
import type {
  ContentBlock,
  SessionNotification,
  SessionUpdate,
  ToolCall,
  ToolCallUpdate,
  UsageUpdate,
} from "@agentclientprotocol/sdk";
import type {
  ClientOperation,
  SessionAcpxState,
  SessionThread,
  SessionThreadAgentContent,
  SessionThreadAgentMessage,
  SessionThreadMessage,
  SessionThreadTokenUsage,
  SessionThreadToolResult,
  SessionThreadToolResultContent,
  SessionThreadToolUse,
  SessionThreadUserContent,
} from "./types.js";
import { SESSION_THREAD_VERSION } from "./types.js";

export type LegacyHistoryEntry = {
  role: "user" | "assistant";
  timestamp: string;
  textPreview: string;
};

function isoNow(): string {
  return new Date().toISOString();
}

function deepClone<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
}

function hasOwn(source: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(source, key);
}

function normalizeAgentName(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function extractText(content: ContentBlock): string | undefined {
  if (content.type === "text") {
    return content.text;
  }

  if (content.type === "resource_link") {
    return content.title ?? content.name ?? content.uri;
  }

  if (content.type === "resource") {
    if ("text" in content.resource && typeof content.resource.text === "string") {
      return content.resource.text;
    }
    return content.resource.uri;
  }

  return undefined;
}

function contentToUserContent(
  content: ContentBlock,
): SessionThreadUserContent | undefined {
  if (content.type === "text") {
    return {
      Text: content.text,
    };
  }

  if (content.type === "resource_link") {
    const value = content.title ?? content.name ?? content.uri;
    return {
      Mention: {
        uri: content.uri,
        content: value,
      },
    };
  }

  if (content.type === "resource") {
    if ("text" in content.resource && typeof content.resource.text === "string") {
      return {
        Text: content.resource.text,
      };
    }

    return {
      Mention: {
        uri: content.resource.uri,
        content: content.resource.uri,
      },
    };
  }

  if (content.type === "image") {
    return {
      Image: {
        source: content.data,
        size: null,
      },
    };
  }

  return undefined;
}

function nextUserMessageId(): string {
  return randomUUID();
}

function isUserMessage(message: SessionThreadMessage): message is {
  User: SessionThread["messages"][number] extends infer T
    ? T extends { User: infer U }
      ? U
      : never
    : never;
} {
  return typeof message === "object" && message !== null && hasOwn(message, "User");
}

function isAgentMessage(
  message: SessionThreadMessage,
): message is { Agent: SessionThreadAgentMessage } {
  return typeof message === "object" && message !== null && hasOwn(message, "Agent");
}

function isAgentTextContent(
  content: SessionThreadAgentContent,
): content is { Text: string } {
  return hasOwn(content, "Text");
}

function isAgentThinkingContent(
  content: SessionThreadAgentContent,
): content is { Thinking: { text: string; signature?: string | null } } {
  return hasOwn(content, "Thinking");
}

function isAgentToolUseContent(
  content: SessionThreadAgentContent,
): content is { ToolUse: SessionThreadToolUse } {
  return hasOwn(content, "ToolUse");
}

function updateThreadTimestamp(thread: SessionThread, timestamp: string): void {
  thread.updated_at = timestamp;
}

function ensureAgentMessage(thread: SessionThread): SessionThreadAgentMessage {
  const last = thread.messages.at(-1);
  if (last && isAgentMessage(last)) {
    return last.Agent;
  }

  const created: SessionThreadAgentMessage = {
    content: [],
    tool_results: {},
  };
  thread.messages.push({ Agent: created });
  return created;
}

function appendAgentText(agent: SessionThreadAgentMessage, text: string): void {
  if (!text.trim()) {
    return;
  }

  const last = agent.content.at(-1);
  if (last && isAgentTextContent(last)) {
    last.Text += text;
    return;
  }

  const next: SessionThreadAgentContent = {
    Text: text,
  };
  agent.content.push(next);
}

function appendAgentThinking(agent: SessionThreadAgentMessage, text: string): void {
  if (!text.trim()) {
    return;
  }

  const last = agent.content.at(-1);
  if (last && isAgentThinkingContent(last)) {
    last.Thinking.text += text;
    return;
  }

  const next: SessionThreadAgentContent = {
    Thinking: {
      text,
      signature: null,
    },
  };
  agent.content.push(next);
}

function statusIndicatesComplete(status: unknown): boolean {
  if (typeof status !== "string") {
    return false;
  }
  const normalized = status.toLowerCase();
  return (
    normalized.includes("complete") ||
    normalized.includes("done") ||
    normalized.includes("success") ||
    normalized.includes("failed") ||
    normalized.includes("error") ||
    normalized.includes("cancel")
  );
}

function statusIndicatesError(status: unknown): boolean {
  if (typeof status !== "string") {
    return false;
  }
  const normalized = status.toLowerCase();
  return normalized.includes("fail") || normalized.includes("error");
}

function toToolResultContent(value: unknown): SessionThreadToolResultContent {
  if (typeof value === "string") {
    return { Text: value };
  }

  if (value != null) {
    try {
      return { Text: JSON.stringify(value) };
    } catch {
      return { Text: String(value) };
    }
  }

  return { Text: "" };
}

function toRawInput(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value ?? {});
  } catch {
    return String(value ?? "");
  }
}

function ensureToolUseContent(
  agent: SessionThreadAgentMessage,
  toolCallId: string,
): SessionThreadToolUse {
  for (const content of agent.content) {
    if (isAgentToolUseContent(content) && content.ToolUse.id === toolCallId) {
      return content.ToolUse;
    }
  }

  const created: SessionThreadToolUse = {
    id: toolCallId,
    name: "tool_call",
    raw_input: "{}",
    input: {},
    is_input_complete: false,
    thought_signature: null,
  };
  agent.content.push({ ToolUse: created });
  return created;
}

function upsertToolResult(
  agent: SessionThreadAgentMessage,
  toolCallId: string,
  patch: Partial<SessionThreadToolResult>,
): void {
  const existing = agent.tool_results[toolCallId];
  const next: SessionThreadToolResult = {
    tool_use_id: toolCallId,
    tool_name: patch.tool_name ?? existing?.tool_name ?? "tool_call",
    is_error: patch.is_error ?? existing?.is_error ?? false,
    content: patch.content ?? existing?.content ?? { Text: "" },
    output: patch.output ?? existing?.output,
  };
  agent.tool_results[toolCallId] = next;
}

function applyToolCallUpdate(
  agent: SessionThreadAgentMessage,
  update: ToolCall | ToolCallUpdate,
): void {
  const tool = ensureToolUseContent(agent, update.toolCallId);

  if (hasOwn(update, "title")) {
    tool.name =
      normalizeAgentName((update as { title?: unknown }).title) ??
      tool.name ??
      "tool_call";
  }

  if (hasOwn(update, "kind")) {
    const kindName = normalizeAgentName((update as { kind?: unknown }).kind);
    if (!tool.name || tool.name === "tool_call") {
      tool.name = kindName ?? tool.name;
    }
  }

  if (hasOwn(update, "rawInput")) {
    const rawInput = deepClone((update as { rawInput?: unknown }).rawInput);
    tool.input = rawInput ?? {};
    tool.raw_input = toRawInput(rawInput);
  }

  if (hasOwn(update, "status")) {
    tool.is_input_complete = statusIndicatesComplete(
      (update as { status?: unknown }).status,
    );
  }

  if (
    hasOwn(update, "rawOutput") ||
    hasOwn(update, "status") ||
    hasOwn(update, "title") ||
    hasOwn(update, "kind")
  ) {
    const status = (update as { status?: unknown }).status;
    const output = hasOwn(update, "rawOutput")
      ? deepClone((update as { rawOutput?: unknown }).rawOutput)
      : undefined;

    upsertToolResult(agent, update.toolCallId, {
      tool_name: tool.name,
      is_error: statusIndicatesError(status),
      content: output === undefined ? undefined : toToolResultContent(output),
      output,
    });
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function numberField(
  source: Record<string, unknown>,
  keys: readonly string[],
): number | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return value;
    }
  }
  return undefined;
}

function usageToTokenUsage(update: UsageUpdate): SessionThreadTokenUsage | undefined {
  const updateRecord = asRecord(update);
  const usageMeta = asRecord(updateRecord?._meta)?.usage;
  const source = asRecord(usageMeta) ?? updateRecord;
  if (!source) {
    return undefined;
  }

  const normalized: SessionThreadTokenUsage = {
    input_tokens: numberField(source, ["input_tokens", "inputTokens"]),
    output_tokens: numberField(source, ["output_tokens", "outputTokens"]),
    cache_creation_input_tokens: numberField(source, [
      "cache_creation_input_tokens",
      "cacheCreationInputTokens",
      "cachedWriteTokens",
    ]),
    cache_read_input_tokens: numberField(source, [
      "cache_read_input_tokens",
      "cacheReadInputTokens",
      "cachedReadTokens",
    ]),
  };

  if (
    normalized.input_tokens === undefined &&
    normalized.output_tokens === undefined &&
    normalized.cache_creation_input_tokens === undefined &&
    normalized.cache_read_input_tokens === undefined
  ) {
    return undefined;
  }

  return normalized;
}

function ensureAcpxState(state: SessionAcpxState | undefined): SessionAcpxState {
  return state ?? {};
}

function lastUserMessageId(thread: SessionThread): string | undefined {
  for (let index = thread.messages.length - 1; index >= 0; index -= 1) {
    const message = thread.messages[index];
    if (message && isUserMessage(message)) {
      return message.User.id;
    }
  }
  return undefined;
}

export function createSessionThread(timestamp = isoNow()): SessionThread {
  return {
    version: SESSION_THREAD_VERSION,
    title: null,
    messages: [],
    updated_at: timestamp,
    cumulative_token_usage: {},
    request_token_usage: {},
  };
}

export function cloneSessionThread(thread: SessionThread | undefined): SessionThread {
  if (!thread) {
    return createSessionThread();
  }

  return {
    version: SESSION_THREAD_VERSION,
    title: thread.title,
    messages: deepClone(thread.messages ?? []),
    updated_at: thread.updated_at,
    cumulative_token_usage: deepClone(thread.cumulative_token_usage ?? {}),
    request_token_usage: deepClone(thread.request_token_usage ?? {}),
  };
}

export function cloneSessionAcpxState(
  state: SessionAcpxState | undefined,
): SessionAcpxState | undefined {
  if (!state) {
    return undefined;
  }

  return {
    current_mode_id: state.current_mode_id,
    available_commands: state.available_commands
      ? [...state.available_commands]
      : undefined,
    config_options: state.config_options ? deepClone(state.config_options) : undefined,
  };
}

export function appendLegacyHistory(
  thread: SessionThread,
  entries: LegacyHistoryEntry[],
): void {
  for (const entry of entries) {
    const text = entry.textPreview?.trim();
    if (!text) {
      continue;
    }

    if (entry.role === "user") {
      thread.messages.push({
        User: {
          id: nextUserMessageId(),
          content: [{ Text: text }],
        },
      });
    } else {
      thread.messages.push({
        Agent: {
          content: [{ Text: text }],
          tool_results: {},
        },
      });
    }

    updateThreadTimestamp(thread, entry.timestamp || thread.updated_at);
  }
}

export function recordPromptSubmission(
  thread: SessionThread,
  prompt: string,
  timestamp = isoNow(),
): void {
  const text = prompt.trim();
  if (!text) {
    return;
  }

  thread.messages.push({
    User: {
      id: nextUserMessageId(),
      content: [{ Text: text }],
    },
  });
  updateThreadTimestamp(thread, timestamp);
}

export function recordSessionUpdate(
  thread: SessionThread,
  state: SessionAcpxState | undefined,
  notification: SessionNotification,
  timestamp = isoNow(),
): SessionAcpxState {
  const acpx = ensureAcpxState(state);

  const update: SessionUpdate = notification.update;
  switch (update.sessionUpdate) {
    case "user_message_chunk": {
      const userContent = contentToUserContent(update.content);
      if (userContent) {
        thread.messages.push({
          User: {
            id: nextUserMessageId(),
            content: [userContent],
          },
        });
      }
      break;
    }
    case "agent_message_chunk": {
      const text = extractText(update.content);
      if (text) {
        const agent = ensureAgentMessage(thread);
        appendAgentText(agent, text);
      }
      break;
    }
    case "agent_thought_chunk": {
      const text = extractText(update.content);
      if (text) {
        const agent = ensureAgentMessage(thread);
        appendAgentThinking(agent, text);
      }
      break;
    }
    case "tool_call":
    case "tool_call_update": {
      const agent = ensureAgentMessage(thread);
      applyToolCallUpdate(agent, update);
      break;
    }
    case "usage_update": {
      const usage = usageToTokenUsage(update);
      if (usage) {
        thread.cumulative_token_usage = usage;
        const userId = lastUserMessageId(thread);
        if (userId) {
          thread.request_token_usage[userId] = usage;
        }
      }
      break;
    }
    case "session_info_update": {
      if (hasOwn(update, "title")) {
        thread.title = update.title ?? null;
      }
      if (hasOwn(update, "updatedAt")) {
        thread.updated_at = update.updatedAt ?? thread.updated_at;
      }
      break;
    }
    case "available_commands_update": {
      acpx.available_commands = update.availableCommands
        .map((entry) => entry.name)
        .filter((entry) => typeof entry === "string" && entry.trim().length > 0);
      break;
    }
    case "current_mode_update": {
      acpx.current_mode_id = update.currentModeId;
      break;
    }
    case "config_option_update": {
      acpx.config_options = deepClone(update.configOptions);
      break;
    }
    default:
      break;
  }

  updateThreadTimestamp(thread, timestamp);
  return acpx;
}

export function recordClientOperation(
  thread: SessionThread,
  state: SessionAcpxState | undefined,
  operation: ClientOperation,
  timestamp = isoNow(),
): SessionAcpxState {
  const acpx = ensureAcpxState(state);
  updateThreadTimestamp(thread, timestamp);
  return acpx;
}
