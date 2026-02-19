import type {
  ContentBlock,
  SetSessionConfigOptionResponse,
  SessionNotification,
  StopReason,
} from "@agentclientprotocol/sdk";
import { createHash, randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { AcpClient, type AgentLifecycleSnapshot } from "./client.js";
import type {
  ClientOperation,
  OutputFormatter,
  PermissionMode,
  RunPromptResult,
  SessionEnqueueResult,
  SessionHistoryEntry,
  SessionRecord,
  SessionSetConfigOptionResult,
  SessionSetModeResult,
  SessionSendOutcome,
  SessionSendResult,
} from "./types.js";

const SESSION_BASE_DIR = path.join(os.homedir(), ".acpx", "sessions");
const QUEUE_BASE_DIR = path.join(os.homedir(), ".acpx", "queues");
const PROCESS_EXIT_GRACE_MS = 1_500;
const PROCESS_POLL_MS = 50;
const QUEUE_CONNECT_ATTEMPTS = 40;
const QUEUE_CONNECT_RETRY_MS = 50;
export const DEFAULT_QUEUE_OWNER_TTL_MS = 300_000;
const INTERRUPT_CANCEL_WAIT_MS = 2_500;
const SESSION_HISTORY_MAX_ENTRIES = 500;
const SESSION_HISTORY_PREVIEW_CHARS = 220;
export const DEFAULT_HISTORY_LIMIT = 20;

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
  authCredentials?: Record<string, string>;
  outputFormatter: OutputFormatter;
  verbose?: boolean;
} & TimedRunOptions;

export type SessionCreateOptions = {
  agentCommand: string;
  cwd: string;
  name?: string;
  permissionMode: PermissionMode;
  authCredentials?: Record<string, string>;
  verbose?: boolean;
} & TimedRunOptions;

export type SessionSendOptions = {
  sessionId: string;
  message: string;
  permissionMode: PermissionMode;
  authCredentials?: Record<string, string>;
  outputFormatter: OutputFormatter;
  verbose?: boolean;
  waitForCompletion?: boolean;
  ttlMs?: number;
} & TimedRunOptions;

export type SessionCancelOptions = {
  sessionId: string;
  verbose?: boolean;
};

export type SessionCancelResult = {
  sessionId: string;
  cancelled: boolean;
};

export type SessionSetModeOptions = {
  sessionId: string;
  modeId: string;
  authCredentials?: Record<string, string>;
  verbose?: boolean;
} & TimedRunOptions;

export type SessionSetConfigOptionOptions = {
  sessionId: string;
  configId: string;
  value: string;
  authCredentials?: Record<string, string>;
  verbose?: boolean;
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
  const agentStartedAt =
    record.agentStartedAt == null
      ? undefined
      : typeof record.agentStartedAt === "string"
        ? record.agentStartedAt
        : null;
  const lastPromptAt =
    record.lastPromptAt == null
      ? undefined
      : typeof record.lastPromptAt === "string"
        ? record.lastPromptAt
        : null;
  const rawLastAgentExitCode = (record as { lastAgentExitCode?: unknown })
    .lastAgentExitCode;
  const lastAgentExitCode =
    rawLastAgentExitCode === undefined
      ? undefined
      : rawLastAgentExitCode === null
        ? null
        : Number.isInteger(rawLastAgentExitCode)
          ? (rawLastAgentExitCode as number)
          : Symbol("invalid");
  const rawLastAgentExitSignal = (record as { lastAgentExitSignal?: unknown })
    .lastAgentExitSignal;
  const lastAgentExitSignal =
    rawLastAgentExitSignal === undefined
      ? undefined
      : rawLastAgentExitSignal === null
        ? null
        : typeof rawLastAgentExitSignal === "string"
          ? rawLastAgentExitSignal
          : Symbol("invalid");
  const lastAgentExitAt =
    record.lastAgentExitAt == null
      ? undefined
      : typeof record.lastAgentExitAt === "string"
        ? record.lastAgentExitAt
        : null;
  const lastAgentDisconnectReason =
    record.lastAgentDisconnectReason == null
      ? undefined
      : typeof record.lastAgentDisconnectReason === "string"
        ? record.lastAgentDisconnectReason
        : null;
  const turnHistory = parseHistoryEntries(
    (record as { turnHistory?: unknown }).turnHistory,
  );

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
    closedAt === null ||
    agentStartedAt === null ||
    lastPromptAt === null ||
    typeof lastAgentExitCode === "symbol" ||
    typeof lastAgentExitSignal === "symbol" ||
    lastAgentExitAt === null ||
    lastAgentDisconnectReason === null ||
    turnHistory === null
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
    agentStartedAt,
    lastPromptAt,
    lastAgentExitCode,
    lastAgentExitSignal:
      lastAgentExitSignal == null
        ? lastAgentExitSignal
        : (lastAgentExitSignal as NodeJS.Signals),
    lastAgentExitAt,
    lastAgentDisconnectReason,
    turnHistory,
  };
}

function parseHistoryEntries(raw: unknown): SessionHistoryEntry[] | undefined | null {
  if (raw == null) {
    return undefined;
  }

  if (!Array.isArray(raw)) {
    return null;
  }

  const entries: SessionHistoryEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      return null;
    }

    const role = (item as { role?: unknown }).role;
    const timestamp = (item as { timestamp?: unknown }).timestamp;
    const textPreview = (item as { textPreview?: unknown }).textPreview;

    if (
      (role !== "user" && role !== "assistant") ||
      typeof timestamp !== "string" ||
      typeof textPreview !== "string"
    ) {
      return null;
    }

    entries.push({
      role,
      timestamp,
      textPreview,
    });
  }

  return entries;
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

function hasGitDirectory(dir: string): boolean {
  const gitPath = path.join(dir, ".git");
  try {
    return statSync(gitPath).isDirectory();
  } catch {
    return false;
  }
}

function isWithinBoundary(boundary: string, target: string): boolean {
  const relative = path.relative(boundary, target);
  return (
    relative.length === 0 || (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

export function findGitRepositoryRoot(startDir: string): string | undefined {
  let current = absolutePath(startDir);
  const root = path.parse(current).root;

  for (;;) {
    if (hasGitDirectory(current)) {
      return current;
    }

    if (current === root) {
      return undefined;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
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

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function toPreviewText(value: string): string {
  const collapsed = collapseWhitespace(value);
  if (collapsed.length <= SESSION_HISTORY_PREVIEW_CHARS) {
    return collapsed;
  }
  if (SESSION_HISTORY_PREVIEW_CHARS <= 3) {
    return collapsed.slice(0, SESSION_HISTORY_PREVIEW_CHARS);
  }
  return `${collapsed.slice(0, SESSION_HISTORY_PREVIEW_CHARS - 3)}...`;
}

function textFromContent(content: ContentBlock): string | undefined {
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

function toHistoryEntryFromUpdate(
  notification: SessionNotification,
): SessionHistoryEntry | undefined {
  const update = notification.update;
  if (
    update.sessionUpdate !== "user_message_chunk" &&
    update.sessionUpdate !== "agent_message_chunk"
  ) {
    return undefined;
  }

  const text = textFromContent(update.content);
  if (!text) {
    return undefined;
  }

  const textPreview = toPreviewText(text);
  if (!textPreview) {
    return undefined;
  }

  return {
    role: update.sessionUpdate === "user_message_chunk" ? "user" : "assistant",
    timestamp: isoNow(),
    textPreview,
  };
}

function appendHistoryEntries(
  current: SessionHistoryEntry[] | undefined,
  entries: SessionHistoryEntry[],
): SessionHistoryEntry[] {
  const base = current ? [...current] : [];
  for (const entry of entries) {
    if (!entry.textPreview.trim()) {
      continue;
    }
    base.push(entry);
  }

  if (base.length <= SESSION_HISTORY_MAX_ENTRIES) {
    return base;
  }

  return base.slice(base.length - SESSION_HISTORY_MAX_ENTRIES);
}

function applyLifecycleSnapshotToRecord(
  record: SessionRecord,
  snapshot: AgentLifecycleSnapshot,
): void {
  record.pid = snapshot.pid;
  record.agentStartedAt = snapshot.startedAt;

  if (snapshot.lastExit) {
    record.lastAgentExitCode = snapshot.lastExit.exitCode;
    record.lastAgentExitSignal = snapshot.lastExit.signal;
    record.lastAgentExitAt = snapshot.lastExit.exitedAt;
    record.lastAgentDisconnectReason = snapshot.lastExit.reason;
    return;
  }

  record.lastAgentExitCode = undefined;
  record.lastAgentExitSignal = undefined;
  record.lastAgentExitAt = undefined;
  record.lastAgentDisconnectReason = undefined;
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

type QueueOwnerMessage =
  | QueueOwnerAcceptedMessage
  | QueueOwnerSessionUpdateMessage
  | QueueOwnerClientOperationMessage
  | QueueOwnerDoneMessage
  | QueueOwnerResultMessage
  | QueueOwnerCancelResultMessage
  | QueueOwnerSetModeResultMessage
  | QueueOwnerSetConfigOptionResultMessage
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
  authCredentials?: Record<string, string>;
  outputFormatter: OutputFormatter;
  timeoutMs?: number;
  verbose?: boolean;
  onClientAvailable?: (controller: ActiveSessionController) => void;
  onClientClosed?: () => void;
  onPromptIssued?: () => Promise<void> | void;
};

type ActiveSessionController = {
  hasActivePrompt: () => boolean;
  requestCancelActivePrompt: () => Promise<boolean>;
  setSessionMode: (modeId: string) => Promise<void>;
  setSessionConfigOption: (
    configId: string,
    value: string,
  ) => Promise<SetSessionConfigOptionResponse>;
};

type CancelCapableController = Pick<
  ActiveSessionController,
  "hasActivePrompt" | "requestCancelActivePrompt"
>;

export class QueueOwnerCancelCoordinator {
  private turnInFlight = false;
  private pendingCancel = false;

  beginTurn(): void {
    this.turnInFlight = true;
  }

  endTurn(): void {
    this.turnInFlight = false;
    this.pendingCancel = false;
  }

  async requestCancel(
    controller: CancelCapableController | undefined,
  ): Promise<boolean> {
    if (controller?.hasActivePrompt()) {
      const cancelled = await controller.requestCancelActivePrompt();
      if (cancelled) {
        this.pendingCancel = false;
      }
      return cancelled;
    }

    if (this.turnInFlight) {
      this.pendingCancel = true;
      return true;
    }

    return false;
  }

  async applyPendingCancel(
    controller: CancelCapableController | undefined,
  ): Promise<boolean> {
    if (!this.pendingCancel || !controller || !controller.hasActivePrompt()) {
      return false;
    }

    const cancelled = await controller.requestCancelActivePrompt();
    if (cancelled) {
      this.pendingCancel = false;
    }
    return cancelled;
  }

  get hasPendingCancel(): boolean {
    return this.pendingCancel;
  }
}

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

  onClientOperation(operation: ClientOperation): void {
    this.send({
      type: "client_operation",
      requestId: this.requestId,
      operation,
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
  onClientOperation() {
    // no-op
  },
  onDone() {
    // no-op
  },
  flush() {
    // no-op
  },
};

type QueueOwnerControlHandlers = {
  cancelPrompt: () => Promise<boolean>;
  setSessionMode: (modeId: string, timeoutMs?: number) => Promise<void>;
  setSessionConfigOption: (
    configId: string,
    value: string,
    timeoutMs?: number,
  ) => Promise<SetSessionConfigOptionResponse>;
};

class SessionQueueOwner {
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

async function tryCancelOnRunningOwner(
  options: SessionCancelOptions,
): Promise<boolean | undefined> {
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

async function trySetModeOnRunningOwner(
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

async function trySetConfigOptionOnRunningOwner(
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

async function runQueuedTask(
  sessionRecordId: string,
  task: QueueTask,
  options: {
    verbose?: boolean;
    authCredentials?: Record<string, string>;
    onClientAvailable?: (controller: ActiveSessionController) => void;
    onClientClosed?: () => void;
    onPromptIssued?: () => Promise<void> | void;
  },
): Promise<void> {
  const outputFormatter = task.waitForCompletion
    ? new QueueTaskOutputFormatter(task)
    : DISCARD_OUTPUT_FORMATTER;

  try {
    const result = await runSessionPrompt({
      sessionRecordId,
      message: task.message,
      permissionMode: task.permissionMode,
      authCredentials: options.authCredentials,
      outputFormatter,
      timeoutMs: task.timeoutMs,
      verbose: options.verbose,
      onClientAvailable: options.onClientAvailable,
      onClientClosed: options.onClientClosed,
      onPromptIssued: options.onPromptIssued,
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
  const shouldReconnect = Boolean(record.pid) && !storedProcessAlive;

  if (options.verbose) {
    if (storedProcessAlive) {
      process.stderr.write(
        `[acpx] saved session pid ${record.pid} is running; reconnecting with loadSession\n`,
      );
    } else if (shouldReconnect) {
      process.stderr.write(
        `[acpx] saved session pid ${record.pid} is dead; respawning agent and attempting session/load\n`,
      );
    }
  }

  const assistantSnippets: string[] = [];

  const client = new AcpClient({
    agentCommand: record.agentCommand,
    cwd: absolutePath(record.cwd),
    permissionMode: options.permissionMode,
    authCredentials: options.authCredentials,
    verbose: options.verbose,
    onSessionUpdate: (notification) => {
      output.onSessionUpdate(notification);
      const entry = toHistoryEntryFromUpdate(notification);
      if (entry && entry.role === "assistant") {
        assistantSnippets.push(entry.textPreview);
      }
    },
    onClientOperation: (operation) => {
      output.onClientOperation(operation);
    },
  });
  let activeSessionIdForControl = record.sessionId;
  let notifiedClientAvailable = false;
  const activeController: ActiveSessionController = {
    hasActivePrompt: () => client.hasActivePrompt(),
    requestCancelActivePrompt: async () => await client.requestCancelActivePrompt(),
    setSessionMode: async (modeId: string) => {
      await client.setSessionMode(activeSessionIdForControl, modeId);
    },
    setSessionConfigOption: async (configId: string, value: string) => {
      return await client.setSessionConfigOption(
        activeSessionIdForControl,
        configId,
        value,
      );
    },
  };

  try {
    return await withInterrupt(
      async () => {
        await withTimeout(client.start(), options.timeoutMs);
        options.onClientAvailable?.(activeController);
        notifiedClientAvailable = true;
        applyLifecycleSnapshotToRecord(record, client.getAgentLifecycleSnapshot());
        record.closed = false;
        record.closedAt = undefined;
        record.lastPromptAt = isoNow();
        await writeSessionRecord(record);

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
            activeSessionIdForControl = activeSessionId;
          }
        } else {
          activeSessionId = await withTimeout(
            client.createSession(record.cwd),
            options.timeoutMs,
          );
          record.sessionId = activeSessionId;
          activeSessionIdForControl = activeSessionId;
        }

        activeSessionIdForControl = activeSessionId;
        let response;
        try {
          const promptPromise = client.prompt(activeSessionId, options.message);
          if (options.onPromptIssued) {
            try {
              await options.onPromptIssued();
            } catch (error) {
              if (options.verbose) {
                process.stderr.write(
                  `[acpx] onPromptIssued hook failed: ${formatError(error)}\n`,
                );
              }
            }
          }
          response = await withTimeout(promptPromise, options.timeoutMs);
        } catch (error) {
          const snapshot = client.getAgentLifecycleSnapshot();
          applyLifecycleSnapshotToRecord(record, snapshot);
          if (snapshot.lastExit?.unexpectedDuringPrompt && options.verbose) {
            process.stderr.write(
              `[acpx] agent disconnected during prompt (${snapshot.lastExit.reason}, exit=${snapshot.lastExit.exitCode}, signal=${snapshot.lastExit.signal ?? "none"})\n`,
            );
          }
          record.lastUsedAt = isoNow();
          await writeSessionRecord(record);
          throw error;
        }

        output.onDone(response.stopReason);
        output.flush();

        const now = isoNow();
        const turnEntries: SessionHistoryEntry[] = [];
        const userPreview = toPreviewText(options.message);
        if (userPreview) {
          turnEntries.push({
            role: "user",
            timestamp: record.lastPromptAt ?? now,
            textPreview: userPreview,
          });
        }

        const assistantPreview = toPreviewText(assistantSnippets.join(" "));
        if (assistantPreview) {
          turnEntries.push({
            role: "assistant",
            timestamp: now,
            textPreview: assistantPreview,
          });
        }

        record.turnHistory = appendHistoryEntries(record.turnHistory, turnEntries);
        record.lastUsedAt = now;
        record.closed = false;
        record.closedAt = undefined;
        record.protocolVersion = client.initializeResult?.protocolVersion;
        record.agentCapabilities = client.initializeResult?.agentCapabilities;
        applyLifecycleSnapshotToRecord(record, client.getAgentLifecycleSnapshot());
        await writeSessionRecord(record);

        return {
          ...toPromptResult(response.stopReason, record.id, client),
          record,
          resumed,
          loadError,
        };
      },
      async () => {
        await client.cancelActivePrompt(INTERRUPT_CANCEL_WAIT_MS);
        applyLifecycleSnapshotToRecord(record, client.getAgentLifecycleSnapshot());
        record.lastUsedAt = isoNow();
        await writeSessionRecord(record).catch(() => {
          // best effort while process is being interrupted
        });
        await client.close();
      },
    );
  } finally {
    if (notifiedClientAvailable) {
      options.onClientClosed?.();
    }
    await client.close();
    applyLifecycleSnapshotToRecord(record, client.getAgentLifecycleSnapshot());
    await writeSessionRecord(record).catch(() => {
      // best effort on close
    });
  }
}

type WithConnectedSessionOptions<T> = {
  sessionRecordId: string;
  permissionMode?: PermissionMode;
  authCredentials?: Record<string, string>;
  timeoutMs?: number;
  verbose?: boolean;
  onClientAvailable?: (controller: ActiveSessionController) => void;
  onClientClosed?: () => void;
  run: (client: AcpClient, sessionId: string, record: SessionRecord) => Promise<T>;
};

type WithConnectedSessionResult<T> = {
  value: T;
  record: SessionRecord;
  resumed: boolean;
  loadError?: string;
};

async function withConnectedSession<T>(
  options: WithConnectedSessionOptions<T>,
): Promise<WithConnectedSessionResult<T>> {
  const record = await resolveSessionRecord(options.sessionRecordId);
  const storedProcessAlive = isProcessAlive(record.pid);
  const shouldReconnect = Boolean(record.pid) && !storedProcessAlive;

  if (options.verbose) {
    if (storedProcessAlive) {
      process.stderr.write(
        `[acpx] saved session pid ${record.pid} is running; reconnecting with loadSession\n`,
      );
    } else if (shouldReconnect) {
      process.stderr.write(
        `[acpx] saved session pid ${record.pid} is dead; respawning agent and attempting session/load\n`,
      );
    }
  }

  const client = new AcpClient({
    agentCommand: record.agentCommand,
    cwd: absolutePath(record.cwd),
    permissionMode: options.permissionMode ?? "approve-reads",
    authCredentials: options.authCredentials,
    verbose: options.verbose,
  });
  let activeSessionIdForControl = record.sessionId;
  let notifiedClientAvailable = false;
  const activeController: ActiveSessionController = {
    hasActivePrompt: () => client.hasActivePrompt(),
    requestCancelActivePrompt: async () => await client.requestCancelActivePrompt(),
    setSessionMode: async (modeId: string) => {
      await client.setSessionMode(activeSessionIdForControl, modeId);
    },
    setSessionConfigOption: async (configId: string, value: string) => {
      return await client.setSessionConfigOption(
        activeSessionIdForControl,
        configId,
        value,
      );
    },
  };

  try {
    return await withInterrupt(
      async () => {
        await withTimeout(client.start(), options.timeoutMs);
        options.onClientAvailable?.(activeController);
        notifiedClientAvailable = true;
        applyLifecycleSnapshotToRecord(record, client.getAgentLifecycleSnapshot());
        record.closed = false;
        record.closedAt = undefined;
        await writeSessionRecord(record);

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
            activeSessionIdForControl = activeSessionId;
          }
        } else {
          activeSessionId = await withTimeout(
            client.createSession(record.cwd),
            options.timeoutMs,
          );
          record.sessionId = activeSessionId;
          activeSessionIdForControl = activeSessionId;
        }

        activeSessionIdForControl = activeSessionId;
        const value = await options.run(client, activeSessionId, record);

        const now = isoNow();
        record.lastUsedAt = now;
        record.closed = false;
        record.closedAt = undefined;
        record.protocolVersion = client.initializeResult?.protocolVersion;
        record.agentCapabilities = client.initializeResult?.agentCapabilities;
        applyLifecycleSnapshotToRecord(record, client.getAgentLifecycleSnapshot());
        await writeSessionRecord(record);

        return {
          value,
          record,
          resumed,
          loadError,
        };
      },
      async () => {
        await client.cancelActivePrompt(INTERRUPT_CANCEL_WAIT_MS);
        applyLifecycleSnapshotToRecord(record, client.getAgentLifecycleSnapshot());
        record.lastUsedAt = isoNow();
        await writeSessionRecord(record).catch(() => {
          // best effort while process is being interrupted
        });
        await client.close();
      },
    );
  } finally {
    if (notifiedClientAvailable) {
      options.onClientClosed?.();
    }
    await client.close();
    applyLifecycleSnapshotToRecord(record, client.getAgentLifecycleSnapshot());
    await writeSessionRecord(record).catch(() => {
      // best effort on close
    });
  }
}

type RunSessionSetModeDirectOptions = {
  sessionRecordId: string;
  modeId: string;
  authCredentials?: Record<string, string>;
  timeoutMs?: number;
  verbose?: boolean;
  onClientAvailable?: (controller: ActiveSessionController) => void;
  onClientClosed?: () => void;
};

type RunSessionSetConfigOptionDirectOptions = {
  sessionRecordId: string;
  configId: string;
  value: string;
  authCredentials?: Record<string, string>;
  timeoutMs?: number;
  verbose?: boolean;
  onClientAvailable?: (controller: ActiveSessionController) => void;
  onClientClosed?: () => void;
};

async function runSessionSetModeDirect(
  options: RunSessionSetModeDirectOptions,
): Promise<SessionSetModeResult> {
  const result = await withConnectedSession({
    sessionRecordId: options.sessionRecordId,
    authCredentials: options.authCredentials,
    timeoutMs: options.timeoutMs,
    verbose: options.verbose,
    onClientAvailable: options.onClientAvailable,
    onClientClosed: options.onClientClosed,
    run: async (client, sessionId) => {
      await withTimeout(
        client.setSessionMode(sessionId, options.modeId),
        options.timeoutMs,
      );
    },
  });

  return {
    record: result.record,
    resumed: result.resumed,
    loadError: result.loadError,
  };
}

async function runSessionSetConfigOptionDirect(
  options: RunSessionSetConfigOptionDirectOptions,
): Promise<SessionSetConfigOptionResult> {
  const result = await withConnectedSession({
    sessionRecordId: options.sessionRecordId,
    authCredentials: options.authCredentials,
    timeoutMs: options.timeoutMs,
    verbose: options.verbose,
    onClientAvailable: options.onClientAvailable,
    onClientClosed: options.onClientClosed,
    run: async (client, sessionId) => {
      return await withTimeout(
        client.setSessionConfigOption(sessionId, options.configId, options.value),
        options.timeoutMs,
      );
    },
  });

  return {
    record: result.record,
    response: result.value,
    resumed: result.resumed,
    loadError: result.loadError,
  };
}

export async function runOnce(options: RunOnceOptions): Promise<RunPromptResult> {
  const output = options.outputFormatter;
  const client = new AcpClient({
    agentCommand: options.agentCommand,
    cwd: absolutePath(options.cwd),
    permissionMode: options.permissionMode,
    authCredentials: options.authCredentials,
    verbose: options.verbose,
    onSessionUpdate: (notification) => output.onSessionUpdate(notification),
    onClientOperation: (operation) => output.onClientOperation(operation),
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
        await client.cancelActivePrompt(INTERRUPT_CANCEL_WAIT_MS);
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
    authCredentials: options.authCredentials,
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
        const lifecycle = client.getAgentLifecycleSnapshot();

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
          pid: lifecycle.pid,
          agentStartedAt: lifecycle.startedAt,
          protocolVersion: client.initializeResult?.protocolVersion,
          agentCapabilities: client.initializeResult?.agentCapabilities,
          turnHistory: [],
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
    let activeController: ActiveSessionController | undefined;
    const cancelCoordinator = new QueueOwnerCancelCoordinator();

    const applyPendingCancel = async (): Promise<boolean> => {
      return await cancelCoordinator.applyPendingCancel(activeController);
    };

    const scheduleApplyPendingCancel = (): void => {
      void applyPendingCancel().catch((error) => {
        if (options.verbose) {
          process.stderr.write(
            `[acpx] failed to apply deferred cancel: ${formatError(error)}\n`,
          );
        }
      });
    };

    const setActiveController = (controller: ActiveSessionController) => {
      activeController = controller;
      scheduleApplyPendingCancel();
    };
    const clearActiveController = () => {
      activeController = undefined;
    };

    const runPromptTurn = async <T>(run: () => Promise<T>): Promise<T> => {
      cancelCoordinator.beginTurn();
      try {
        return await run();
      } finally {
        cancelCoordinator.endTurn();
      }
    };

    try {
      owner = await SessionQueueOwner.start(lease, {
        cancelPrompt: async () => {
          const accepted = await cancelCoordinator.requestCancel(activeController);
          if (!accepted) {
            return false;
          }
          await applyPendingCancel();
          return true;
        },
        setSessionMode: async (modeId: string, timeoutMs?: number) => {
          if (activeController) {
            await withTimeout(activeController.setSessionMode(modeId), timeoutMs);
            return;
          }
          await runSessionSetModeDirect({
            sessionRecordId: options.sessionId,
            modeId,
            authCredentials: options.authCredentials,
            timeoutMs,
            verbose: options.verbose,
          });
        },
        setSessionConfigOption: async (
          configId: string,
          value: string,
          timeoutMs?: number,
        ) => {
          if (activeController) {
            return await withTimeout(
              activeController.setSessionConfigOption(configId, value),
              timeoutMs,
            );
          }
          const result = await runSessionSetConfigOptionDirect({
            sessionRecordId: options.sessionId,
            configId,
            value,
            authCredentials: options.authCredentials,
            timeoutMs,
            verbose: options.verbose,
          });
          return result.response;
        },
      });

      const localResult = await runPromptTurn(async () => {
        return await runSessionPrompt({
          sessionRecordId: options.sessionId,
          message: options.message,
          permissionMode: options.permissionMode,
          authCredentials: options.authCredentials,
          outputFormatter: options.outputFormatter,
          timeoutMs: options.timeoutMs,
          verbose: options.verbose,
          onClientAvailable: setActiveController,
          onClientClosed: clearActiveController,
          onPromptIssued: async () => {
            await applyPendingCancel();
          },
        });
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
        await runPromptTurn(async () => {
          await runQueuedTask(options.sessionId, task, {
            verbose: options.verbose,
            authCredentials: options.authCredentials,
            onClientAvailable: setActiveController,
            onClientClosed: clearActiveController,
            onPromptIssued: async () => {
              await applyPendingCancel();
            },
          });
        });
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

export async function cancelSessionPrompt(
  options: SessionCancelOptions,
): Promise<SessionCancelResult> {
  const cancelled = await tryCancelOnRunningOwner(options);
  return {
    sessionId: options.sessionId,
    cancelled: cancelled === true,
  };
}

export async function setSessionMode(
  options: SessionSetModeOptions,
): Promise<SessionSetModeResult> {
  const submittedToOwner = await trySetModeOnRunningOwner(
    options.sessionId,
    options.modeId,
    options.timeoutMs,
    options.verbose,
  );
  if (submittedToOwner) {
    return {
      record: await resolveSessionRecord(options.sessionId),
      resumed: false,
    };
  }

  return await runSessionSetModeDirect({
    sessionRecordId: options.sessionId,
    modeId: options.modeId,
    authCredentials: options.authCredentials,
    timeoutMs: options.timeoutMs,
    verbose: options.verbose,
  });
}

export async function setSessionConfigOption(
  options: SessionSetConfigOptionOptions,
): Promise<SessionSetConfigOptionResult> {
  const ownerResponse = await trySetConfigOptionOnRunningOwner(
    options.sessionId,
    options.configId,
    options.value,
    options.timeoutMs,
    options.verbose,
  );
  if (ownerResponse) {
    return {
      record: await resolveSessionRecord(options.sessionId),
      response: ownerResponse,
      resumed: false,
    };
  }

  return await runSessionSetConfigOptionDirect({
    sessionRecordId: options.sessionId,
    configId: options.configId,
    value: options.value,
    authCredentials: options.authCredentials,
    timeoutMs: options.timeoutMs,
    verbose: options.verbose,
  });
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
  boundary?: string;
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
  const normalizedBoundary = absolutePath(options.boundary ?? normalizedStart);
  const walkBoundary = isWithinBoundary(normalizedBoundary, normalizedStart)
    ? normalizedBoundary
    : normalizedStart;
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

  for (;;) {
    const match = sessions.find((session) => matchesScope(session, dir));
    if (match) {
      return match;
    }

    if (dir === walkBoundary) {
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
