import type {
  AnyMessage,
  ContentBlock,
  SessionNotification,
  ToolCall,
  ToolCallContent,
  ToolCallLocation,
  ToolCallStatus,
  ToolCallUpdate,
} from "@agentclientprotocol/sdk";
import { parseJsonRpcErrorMessage, parsePromptStopReason } from "./acp-jsonrpc.js";
import { createJsonOutputFormatter } from "./output-json-formatter.js";
import type {
  AcpJsonRpcMessage,
  ClientOperation,
  OutputErrorAcpPayload,
  OutputErrorCode,
  OutputFormatterContext,
  OutputFormat,
  OutputFormatter,
  OutputErrorOrigin,
} from "./types.js";

type WritableLike = {
  write(chunk: string): void;
  isTTY?: boolean;
};

type OutputFormatterOptions = {
  stdout?: WritableLike;
  jsonContext?: OutputFormatterContext;
};

type NormalizedToolStatus = ToolCallStatus | "unknown";

type FormatterSection = "assistant" | "thought" | "tool" | "plan" | "client" | "done";

type ToolRenderState = {
  id: string;
  title?: string;
  status?: ToolCallStatus | null;
  kind?: string | null;
  locations?: Array<ToolCallLocation> | null;
  rawInput?: unknown;
  rawOutput?: unknown;
  content?: Array<ToolCallContent> | null;
  startedPrinted: boolean;
  finalSignature?: string;
};

const MAX_THOUGHT_CHARS = 900;
const MAX_INLINE_CHARS = 220;
const MAX_OUTPUT_CHARS = 2_000;
const MAX_OUTPUT_LINES = 28;
const MAX_LOCATION_ITEMS = 5;
const OUTPUT_PRIORITY_KEYS = [
  "stdout",
  "stderr",
  "output",
  "content",
  "text",
  "message",
  "result",
  "response",
  "value",
] as const;

function asStatus(status: ToolCallStatus | null | undefined): NormalizedToolStatus {
  return status ?? "unknown";
}

function isFinalStatus(status: NormalizedToolStatus): status is "completed" | "failed" {
  return status === "completed" || status === "failed";
}

function toStatusLabel(status: NormalizedToolStatus): string {
  switch (status) {
    case "in_progress":
      return "running";
    case "pending":
      return "pending";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    default:
      return "running";
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function extractSessionUpdate(message: AnyMessage): SessionNotification | undefined {
  if (!Object.hasOwn(message, "method")) {
    return undefined;
  }
  const method = (message as { method?: unknown }).method;
  if (method !== "session/update") {
    return undefined;
  }
  const params = asRecord((message as { params?: unknown }).params);
  if (!params) {
    return undefined;
  }
  const sessionId = typeof params.sessionId === "string" ? params.sessionId : null;
  if (!sessionId) {
    return undefined;
  }
  const update = asRecord(params.update);
  if (!update || typeof update.sessionUpdate !== "string") {
    return undefined;
  }
  return {
    sessionId,
    update: update as SessionNotification["update"],
  };
}

function extractJsonRpcMethod(message: AnyMessage): string | undefined {
  return Object.hasOwn(message, "method")
    ? (message as { method?: unknown }).method?.toString()
    : undefined;
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  if (maxChars <= 3) {
    return value.slice(0, maxChars);
  }
  return `${value.slice(0, maxChars - 3)}...`;
}

function toInline(value: string, maxChars = MAX_INLINE_CHARS): string {
  return truncate(collapseWhitespace(value), maxChars);
}

function indentBlock(value: string, prefix: string): string {
  return value
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
  }

  return result;
}

function safeJson(value: unknown, spacing: number): string | undefined {
  const seen = new WeakSet<object>();

  try {
    return JSON.stringify(
      value,
      (_key, entry: unknown) => {
        if (typeof entry === "bigint") {
          return `${entry}n`;
        }
        if (typeof entry === "function") {
          return `[Function ${entry.name || "anonymous"}]`;
        }
        if (typeof entry === "symbol") {
          return entry.toString();
        }
        if (entry && typeof entry === "object") {
          if (seen.has(entry as object)) {
            return "[Circular]";
          }
          seen.add(entry as object);
        }
        return entry;
      },
      spacing,
    );
  } catch {
    return undefined;
  }
}

function readFirstString(
  source: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function readFirstStringArray(
  source: Record<string, unknown>,
  keys: string[],
): string[] | undefined {
  for (const key of keys) {
    const value = source[key];
    if (!Array.isArray(value)) {
      continue;
    }
    const entries = value
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter((entry) => entry.length > 0);
    if (entries.length > 0) {
      return entries;
    }
  }
  return undefined;
}

function summarizeToolInput(rawInput: unknown): string | undefined {
  if (rawInput == null) {
    return undefined;
  }

  if (
    typeof rawInput === "string" ||
    typeof rawInput === "number" ||
    typeof rawInput === "boolean"
  ) {
    return toInline(String(rawInput));
  }

  const record = asRecord(rawInput);
  if (record) {
    const command = readFirstString(record, ["command", "cmd", "program"]);
    const args = readFirstStringArray(record, ["args", "arguments"]);
    if (command) {
      const invocation = [command, ...(args ?? [])].join(" ");
      return toInline(invocation);
    }

    const location = readFirstString(record, [
      "path",
      "file",
      "filePath",
      "filepath",
      "target",
      "uri",
      "url",
    ]);
    if (location) {
      return toInline(location);
    }

    const query = readFirstString(record, ["query", "pattern", "text", "search"]);
    if (query) {
      return toInline(query);
    }
  }

  const json = safeJson(rawInput, 0);
  return json ? toInline(json) : undefined;
}

function formatLocations(
  locations: Array<ToolCallLocation> | null | undefined,
): string | undefined {
  if (!locations || locations.length === 0) {
    return undefined;
  }

  const unique = new Set<string>();
  for (const location of locations) {
    const path = location.path?.trim();
    if (!path) {
      continue;
    }

    const line =
      typeof location.line === "number" && Number.isFinite(location.line)
        ? `:${Math.max(1, Math.trunc(location.line))}`
        : "";
    unique.add(`${path}${line}`);
  }

  const items = [...unique];
  if (items.length === 0) {
    return undefined;
  }

  const visible = items.slice(0, MAX_LOCATION_ITEMS);
  const hidden = items.length - visible.length;
  if (hidden <= 0) {
    return visible.join(", ");
  }

  return `${visible.join(", ")}, +${hidden} more`;
}

function summarizeDiff(
  path: string,
  oldText: string | null | undefined,
  newText: string,
): string {
  const oldLines = oldText ? oldText.split("\n").length : 0;
  const newLines = newText.split("\n").length;
  const delta = newLines - oldLines;

  if (delta === 0) {
    return `diff ${path} (line count unchanged)`;
  }

  const signedDelta = `${delta > 0 ? "+" : ""}${delta}`;
  return `diff ${path} (${signedDelta} lines)`;
}

function textFromContentBlock(content: ContentBlock): string | undefined {
  switch (content.type) {
    case "text":
      return content.text;
    case "resource_link":
      return content.title ?? content.name ?? content.uri;
    case "resource": {
      if ("text" in content.resource && typeof content.resource.text === "string") {
        return content.resource.text;
      }
      const uri = content.resource.uri;
      const mimeType = content.resource.mimeType;
      return `[resource] ${uri}${mimeType ? ` (${mimeType})` : ""}`;
    }
    case "image":
      return `[image] ${content.mimeType}`;
    case "audio":
      return `[audio] ${content.mimeType}`;
    default:
      return undefined;
  }
}

function summarizeToolContent(
  content: Array<ToolCallContent> | null | undefined,
): string | undefined {
  if (!content || content.length === 0) {
    return undefined;
  }

  const fragments: string[] = [];

  for (const entry of content) {
    if (entry.type === "content") {
      const text = textFromContentBlock(entry.content);
      if (text && text.trim()) {
        fragments.push(text.trimEnd());
      }
      continue;
    }

    if (entry.type === "diff") {
      fragments.push(summarizeDiff(entry.path, entry.oldText, entry.newText));
      continue;
    }

    if (entry.type === "terminal") {
      fragments.push(`[terminal] ${entry.terminalId}`);
    }
  }

  const unique = dedupeStrings(
    fragments
      .map((fragment) => fragment.trim())
      .filter((fragment) => fragment.length > 0),
  );
  if (unique.length === 0) {
    return undefined;
  }

  return unique.join("\n\n");
}

function extractOutputText(
  value: unknown,
  depth = 0,
  seen = new Set<unknown>(),
): string | undefined {
  if (value == null) {
    return undefined;
  }

  if (typeof value === "string") {
    const trimmed = value.trimEnd();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (depth >= 4) {
    return undefined;
  }

  if (Array.isArray(value)) {
    const parts = value
      .map((entry) => extractOutputText(entry, depth + 1, seen))
      .filter((entry): entry is string => Boolean(entry));
    if (parts.length === 0) {
      return undefined;
    }
    return dedupeStrings(parts).join("\n");
  }

  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  if (seen.has(record)) {
    return undefined;
  }
  seen.add(record);

  const preferred: string[] = [];
  for (const key of OUTPUT_PRIORITY_KEYS) {
    if (!(key in record)) {
      continue;
    }
    const extracted = extractOutputText(record[key], depth + 1, seen);
    if (extracted) {
      preferred.push(extracted);
    }
  }

  const uniquePreferred = dedupeStrings(preferred);
  if (uniquePreferred.length > 0) {
    return uniquePreferred.join("\n");
  }

  const json = safeJson(record, 2);
  if (!json || json === "{}") {
    return undefined;
  }
  return json;
}

function summarizeToolOutput(
  rawOutput: unknown,
  content: Array<ToolCallContent> | null | undefined,
): string | undefined {
  const outputFromRaw = extractOutputText(rawOutput);
  const outputFromContent = summarizeToolContent(content);

  const fragments = dedupeStrings(
    [outputFromRaw, outputFromContent]
      .map((fragment) => fragment?.trim())
      .filter((fragment): fragment is string => Boolean(fragment)),
  );

  if (fragments.length === 0) {
    return undefined;
  }

  return fragments.join("\n\n");
}

function limitOutputBlock(value: string): string {
  const normalized = value.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return "";
  }

  const lines = normalized.split("\n");
  const visible = lines.slice(0, MAX_OUTPUT_LINES);
  let result = visible.join("\n");

  if (lines.length > visible.length) {
    const hidden = lines.length - visible.length;
    result += `\n... (${hidden} more lines)`;
  }

  if (result.length > MAX_OUTPUT_CHARS) {
    result = `${result.slice(0, MAX_OUTPUT_CHARS - 3)}...`;
  }

  return result;
}

class TextOutputFormatter implements OutputFormatter {
  private readonly stdout: WritableLike;
  private readonly useColor: boolean;
  private readonly toolStates = new Map<string, ToolRenderState>();
  private thoughtBuffer = "";
  private wroteAny = false;
  private atLineStart = true;
  private section: FormatterSection | null = null;

  constructor(stdout: WritableLike) {
    this.stdout = stdout;
    this.useColor = Boolean(stdout.isTTY);
  }

  setContext(_context: OutputFormatterContext): void {
    // no-op for text mode
  }

  onAcpMessage(message: AcpJsonRpcMessage): void {
    const notification = extractSessionUpdate(message);
    if (notification) {
      this.renderSessionUpdate(notification);
      return;
    }

    const method = extractJsonRpcMethod(message);
    if (method && method !== "session/prompt" && method !== "session/cancel") {
      this.onClientOperation({
        method: method as ClientOperation["method"],
        status: "running",
        summary: method,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const stopReason = parsePromptStopReason(message);
    if (stopReason) {
      this.renderDone(stopReason);
      return;
    }

    const errorMessage = parseJsonRpcErrorMessage(message);
    if (errorMessage) {
      this.onError({
        code: "RUNTIME",
        origin: "acp",
        message: errorMessage,
      });
    }
  }

  private renderSessionUpdate(notification: SessionNotification): void {
    const update = notification.update;
    if (update.sessionUpdate !== "agent_thought_chunk") {
      this.flushThoughtBuffer();
    }

    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        if (update.content.type === "text") {
          this.writeAssistantChunk(update.content.text);
        }
        return;
      }
      case "agent_thought_chunk": {
        if (update.content.type === "text") {
          this.thoughtBuffer += update.content.text;
        }
        return;
      }
      case "tool_call": {
        this.renderToolUpdate(update);
        return;
      }
      case "tool_call_update": {
        this.renderToolUpdate(update);
        return;
      }
      case "plan": {
        this.beginSection("plan");
        this.writeLine(this.bold("[plan]"));
        for (const entry of update.entries) {
          this.writeLine(`  - [${entry.status}] ${entry.content}`);
        }
        return;
      }
      default:
        return;
    }
  }

  private renderDone(stopReason: string): void {
    this.flushThoughtBuffer();
    this.beginSection("done");
    this.writeLine(this.dim(`[done] ${stopReason}`));
  }

  onError(params: {
    code: OutputErrorCode;
    detailCode?: string;
    origin?: OutputErrorOrigin;
    message: string;
    retryable?: boolean;
    acp?: OutputErrorAcpPayload;
    timestamp?: string;
  }): void {
    this.flushThoughtBuffer();
    this.beginSection("done");
    this.writeLine(this.formatAnsi(`[error] ${params.code}: ${params.message}`, "31"));
  }

  onClientOperation(operation: ClientOperation): void {
    this.flushThoughtBuffer();
    this.beginSection("client");

    const normalizedStatus: NormalizedToolStatus =
      operation.status === "completed"
        ? "completed"
        : operation.status === "failed"
          ? "failed"
          : "in_progress";
    const statusText = this.colorStatus(operation.status, normalizedStatus);
    this.writeLine(`${this.bold("[client]")} ${operation.summary} (${statusText})`);
    if (operation.details && operation.details.trim().length > 0) {
      this.writeLine("  details:");
      this.writeLine(indentBlock(operation.details, "    "));
    }
  }

  flush(): void {
    this.flushThoughtBuffer();
    if (!this.atLineStart) {
      this.write("\n");
    }
  }

  private write(chunk: string): void {
    if (!chunk) {
      return;
    }
    this.stdout.write(chunk);
    this.wroteAny = true;
    this.atLineStart = chunk.endsWith("\n");
  }

  private writeLine(line: string): void {
    this.write(`${line}\n`);
  }

  private beginSection(next: Exclude<FormatterSection, "assistant">): void {
    if (!this.atLineStart) {
      this.write("\n");
    }
    if (this.wroteAny) {
      this.write("\n");
    }
    this.section = next;
  }

  private writeAssistantChunk(text: string): void {
    if (!text) {
      return;
    }
    this.section = "assistant";
    this.write(text);
  }

  private flushThoughtBuffer(): void {
    const thought = truncate(collapseWhitespace(this.thoughtBuffer), MAX_THOUGHT_CHARS);
    this.thoughtBuffer = "";
    if (!thought) {
      return;
    }

    this.beginSection("thought");
    this.writeLine(this.dim(`[thinking] ${thought}`));
  }

  private renderToolUpdate(update: ToolCall | ToolCallUpdate): void {
    const state = this.getOrCreateToolState(update.toolCallId);
    this.mergeToolState(state, update);

    const status = asStatus(state.status);
    if (isFinalStatus(status)) {
      const signature = this.toolSignature(state);
      if (signature !== state.finalSignature) {
        state.finalSignature = signature;
        this.renderFinalToolState(state, status);
      }
      return;
    }

    if (state.startedPrinted) {
      return;
    }

    state.startedPrinted = true;
    this.renderStartingToolState(state, status);
  }

  private getOrCreateToolState(toolCallId: string): ToolRenderState {
    const existing = this.toolStates.get(toolCallId);
    if (existing) {
      return existing;
    }

    const created: ToolRenderState = {
      id: toolCallId,
      startedPrinted: false,
    };
    this.toolStates.set(toolCallId, created);
    return created;
  }

  private mergeToolState(
    state: ToolRenderState,
    update: ToolCall | ToolCallUpdate,
  ): void {
    if (typeof update.title === "string" && update.title.trim().length > 0) {
      state.title = update.title;
    }

    if (update.status !== undefined) {
      state.status = update.status;
    }
    if (update.kind !== undefined) {
      state.kind = update.kind;
    }
    if (update.locations !== undefined) {
      state.locations = update.locations;
    }
    if (update.rawInput !== undefined) {
      state.rawInput = update.rawInput;
    }
    if (update.rawOutput !== undefined) {
      state.rawOutput = update.rawOutput;
    }
    if (update.content !== undefined) {
      state.content = update.content;
    }
  }

  private toolSignature(state: ToolRenderState): string {
    const signaturePayload = {
      title: state.title,
      status: state.status,
      kind: state.kind,
      input: summarizeToolInput(state.rawInput),
      files: formatLocations(state.locations),
      output: summarizeToolOutput(state.rawOutput, state.content),
    };

    return safeJson(signaturePayload, 0) ?? JSON.stringify(signaturePayload);
  }

  private renderStartingToolState(
    state: ToolRenderState,
    status: Exclude<NormalizedToolStatus, "completed" | "failed">,
  ): void {
    this.beginSection("tool");

    const title = state.title ?? state.id;
    const label = status === "pending" ? "pending" : "running";
    const statusText = this.colorStatus(label, status);
    this.writeLine(`${this.bold("[tool]")} ${title} (${statusText})`);

    const input = summarizeToolInput(state.rawInput);
    if (input) {
      this.writeLine(`  input: ${input}`);
    }

    const files = formatLocations(state.locations);
    if (files) {
      this.writeLine(`  files: ${files}`);
    }
  }

  private renderFinalToolState(
    state: ToolRenderState,
    status: "completed" | "failed",
  ): void {
    this.beginSection("tool");

    const title = state.title ?? state.id;
    const statusText = this.colorStatus(toStatusLabel(status), status);
    this.writeLine(`${this.bold("[tool]")} ${title} (${statusText})`);

    if (state.kind) {
      this.writeLine(`  kind: ${state.kind}`);
    }

    const input = summarizeToolInput(state.rawInput);
    if (input) {
      this.writeLine(`  input: ${input}`);
    }

    const files = formatLocations(state.locations);
    if (files) {
      this.writeLine(`  files: ${files}`);
    }

    const output = summarizeToolOutput(state.rawOutput, state.content);
    if (output) {
      this.writeLine("  output:");
      this.writeLine(indentBlock(limitOutputBlock(output), "    "));
    }
  }

  private formatAnsi(text: string, code: string): string {
    if (!this.useColor) {
      return text;
    }
    return `\u001b[${code}m${text}\u001b[0m`;
  }

  private bold(text: string): string {
    return this.formatAnsi(text, "1");
  }

  private dim(text: string): string {
    return this.formatAnsi(text, "2");
  }

  private colorStatus(text: string, status: NormalizedToolStatus): string {
    if (!this.useColor) {
      return text;
    }

    switch (status) {
      case "completed":
        return this.formatAnsi(text, "32");
      case "failed":
        return this.formatAnsi(text, "31");
      case "pending":
      case "in_progress":
      case "unknown":
      default:
        return this.formatAnsi(text, "33");
    }
  }
}

class QuietOutputFormatter implements OutputFormatter {
  private readonly stdout: WritableLike;
  private chunks: string[] = [];
  private flushed = false;

  constructor(stdout: WritableLike) {
    this.stdout = stdout;
  }

  setContext(_context: OutputFormatterContext): void {
    // no-op for quiet mode
  }

  onAcpMessage(message: AcpJsonRpcMessage): void {
    const update = extractSessionUpdate(message);
    if (
      update?.update.sessionUpdate === "agent_message_chunk" &&
      update.update.content.type === "text"
    ) {
      this.chunks.push(update.update.content.text);
      return;
    }

    if (parsePromptStopReason(message)) {
      this.flushBufferedOutput();
    }
  }

  onError(_params: {
    code: OutputErrorCode;
    detailCode?: string;
    origin?: OutputErrorOrigin;
    message: string;
    retryable?: boolean;
    acp?: OutputErrorAcpPayload;
    timestamp?: string;
  }): void {
    // no-op in quiet mode
  }

  flush(): void {
    // no-op for streaming output
  }

  private flushBufferedOutput(): void {
    if (this.flushed) {
      return;
    }

    this.flushed = true;
    const text = this.chunks.join("");
    this.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
  }
}

export function createOutputFormatter(
  format: OutputFormat,
  options: OutputFormatterOptions = {},
): OutputFormatter {
  const stdout = options.stdout ?? process.stdout;

  switch (format) {
    case "text":
      return new TextOutputFormatter(stdout);
    case "json":
      return createJsonOutputFormatter(stdout, options.jsonContext);
    case "quiet":
      return new QuietOutputFormatter(stdout);
    default: {
      const exhaustive: never = format;
      throw new Error(`Unsupported output format: ${exhaustive}`);
    }
  }
}
