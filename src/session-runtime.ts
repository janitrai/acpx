import type { SessionNotification, StopReason } from "@agentclientprotocol/sdk";
import fs from "node:fs/promises";
import path from "node:path";
import { AcpClient } from "./client.js";
import { formatErrorMessage, normalizeOutputError } from "./error-normalization.js";
import { isAcpResourceNotFoundError } from "./acp-error-shapes.js";
import {
  QueueOwnerTurnController,
  type QueueOwnerActiveSessionController,
} from "./queue-owner-turn-controller.js";
import {
  type QueueOwnerMessage,
  type QueueTask,
  QUEUE_CONNECT_RETRY_MS,
  SessionQueueOwner,
  isProcessAlive,
  releaseQueueOwnerLease,
  terminateProcess,
  terminateQueueOwnerForSession,
  tryAcquireQueueOwnerLease,
  tryCancelOnRunningOwner,
  trySetConfigOptionOnRunningOwner,
  trySetModeOnRunningOwner,
  trySubmitToRunningOwner,
  waitMs,
} from "./queue-ipc.js";
import {
  DEFAULT_HISTORY_LIMIT,
  absolutePath,
  findGitRepositoryRoot,
  findSession,
  findSessionByDirectoryWalk,
  isoNow,
  listSessions,
  listSessionsForAgent,
  normalizeName,
  resolveSessionRecord,
  writeSessionRecord,
} from "./session-persistence.js";
import {
  appendHistoryEntries,
  toHistoryEntryFromUpdate,
  toPreviewText,
} from "./session-runtime-history.js";
import { applyLifecycleSnapshotToRecord } from "./session-runtime-lifecycle.js";
import { connectAndLoadSession } from "./session-runtime-reconnect.js";
import type {
  AuthPolicy,
  ClientOperation,
  NonInteractivePermissionPolicy,
  OutputErrorEmissionPolicy,
  OutputErrorAcpPayload,
  OutputErrorCode,
  OutputErrorOrigin,
  OutputFormatter,
  PermissionMode,
  RunPromptResult,
  SessionEnsureResult,
  SessionHistoryEntry,
  SessionRecord,
  SessionSetConfigOptionResult,
  SessionSetModeResult,
  SessionSendOutcome,
  SessionSendResult,
} from "./types.js";

export const DEFAULT_QUEUE_OWNER_TTL_MS = 300_000;
const INTERRUPT_CANCEL_WAIT_MS = 2_500;

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
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  authCredentials?: Record<string, string>;
  authPolicy?: AuthPolicy;
  outputFormatter: OutputFormatter;
  suppressSdkConsoleErrors?: boolean;
  verbose?: boolean;
} & TimedRunOptions;

export type SessionCreateOptions = {
  agentCommand: string;
  cwd: string;
  name?: string;
  permissionMode: PermissionMode;
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  authCredentials?: Record<string, string>;
  authPolicy?: AuthPolicy;
  verbose?: boolean;
} & TimedRunOptions;

export type SessionSendOptions = {
  sessionId: string;
  message: string;
  permissionMode: PermissionMode;
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  authCredentials?: Record<string, string>;
  authPolicy?: AuthPolicy;
  outputFormatter: OutputFormatter;
  errorEmissionPolicy?: OutputErrorEmissionPolicy;
  suppressSdkConsoleErrors?: boolean;
  verbose?: boolean;
  waitForCompletion?: boolean;
  ttlMs?: number;
} & TimedRunOptions;

export type SessionEnsureOptions = {
  agentCommand: string;
  cwd: string;
  name?: string;
  permissionMode: PermissionMode;
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  authCredentials?: Record<string, string>;
  authPolicy?: AuthPolicy;
  verbose?: boolean;
  walkBoundary?: string;
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
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  authCredentials?: Record<string, string>;
  authPolicy?: AuthPolicy;
  verbose?: boolean;
} & TimedRunOptions;

export type SessionSetConfigOptionOptions = {
  sessionId: string;
  configId: string;
  value: string;
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  authCredentials?: Record<string, string>;
  authPolicy?: AuthPolicy;
  verbose?: boolean;
} & TimedRunOptions;

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

type RunSessionPromptOptions = {
  sessionRecordId: string;
  message: string;
  permissionMode: PermissionMode;
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  authCredentials?: Record<string, string>;
  authPolicy?: AuthPolicy;
  outputFormatter: OutputFormatter;
  timeoutMs?: number;
  suppressSdkConsoleErrors?: boolean;
  verbose?: boolean;
  onClientAvailable?: (controller: ActiveSessionController) => void;
  onClientClosed?: () => void;
  onPromptActive?: () => Promise<void> | void;
};

type ActiveSessionController = QueueOwnerActiveSessionController;

class QueueTaskOutputFormatter implements OutputFormatter {
  private readonly requestId: string;
  private readonly send: (message: QueueOwnerMessage) => void;

  constructor(task: QueueTask) {
    this.requestId = task.requestId;
    this.send = task.send;
  }

  setContext(): void {
    // queue formatter context is fixed by task request id
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

  onError(params: {
    code: OutputErrorCode;
    detailCode?: string;
    origin?: OutputErrorOrigin;
    message: string;
    retryable?: boolean;
    acp?: OutputErrorAcpPayload;
    timestamp?: string;
  }): void {
    this.send({
      type: "error",
      requestId: this.requestId,
      code: params.code,
      detailCode: params.detailCode,
      origin: params.origin,
      message: params.message,
      retryable: params.retryable,
      acp: params.acp,
    });
  }

  flush(): void {
    // no-op for stream forwarding
  }
}

const DISCARD_OUTPUT_FORMATTER: OutputFormatter = {
  setContext() {
    // no-op
  },
  onSessionUpdate() {
    // no-op
  },
  onClientOperation() {
    // no-op
  },
  onDone() {
    // no-op
  },
  onError() {
    // no-op
  },
  flush() {
    // no-op
  },
};
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

function shouldFallbackToNewSession(error: unknown): boolean {
  if (error instanceof TimeoutError || error instanceof InterruptedError) {
    return false;
  }
  return isAcpResourceNotFoundError(error);
}

async function runQueuedTask(
  sessionRecordId: string,
  task: QueueTask,
  options: {
    verbose?: boolean;
    nonInteractivePermissions?: NonInteractivePermissionPolicy;
    authCredentials?: Record<string, string>;
    authPolicy?: AuthPolicy;
    suppressSdkConsoleErrors?: boolean;
    onClientAvailable?: (controller: ActiveSessionController) => void;
    onClientClosed?: () => void;
    onPromptActive?: () => Promise<void> | void;
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
      nonInteractivePermissions:
        task.nonInteractivePermissions ?? options.nonInteractivePermissions,
      authCredentials: options.authCredentials,
      authPolicy: options.authPolicy,
      outputFormatter,
      timeoutMs: task.timeoutMs,
      suppressSdkConsoleErrors:
        task.suppressSdkConsoleErrors ?? options.suppressSdkConsoleErrors,
      verbose: options.verbose,
      onClientAvailable: options.onClientAvailable,
      onClientClosed: options.onClientClosed,
      onPromptActive: options.onPromptActive,
    });

    if (task.waitForCompletion) {
      task.send({
        type: "result",
        requestId: task.requestId,
        result,
      });
    }
  } catch (error) {
    const normalizedError = normalizeOutputError(error, {
      origin: "runtime",
      detailCode: "QUEUE_RUNTIME_PROMPT_FAILED",
    });
    if (task.waitForCompletion) {
      task.send({
        type: "error",
        requestId: task.requestId,
        code: normalizedError.code,
        detailCode: normalizedError.detailCode,
        origin: normalizedError.origin,
        message: normalizedError.message,
        retryable: normalizedError.retryable,
        acp: normalizedError.acp,
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
  output.setContext({
    sessionId: record.id,
    stream: "prompt",
  });
  const assistantSnippets: string[] = [];

  const client = new AcpClient({
    agentCommand: record.agentCommand,
    cwd: absolutePath(record.cwd),
    permissionMode: options.permissionMode,
    nonInteractivePermissions: options.nonInteractivePermissions,
    authCredentials: options.authCredentials,
    authPolicy: options.authPolicy,
    suppressSdkConsoleErrors: options.suppressSdkConsoleErrors,
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
        const {
          sessionId: activeSessionId,
          resumed,
          loadError,
        } = await connectAndLoadSession({
          client,
          record,
          timeoutMs: options.timeoutMs,
          verbose: options.verbose,
          activeController,
          withTimeout,
          shouldFallbackToNewSession,
          onClientAvailable: (controller) => {
            options.onClientAvailable?.(controller);
            notifiedClientAvailable = true;
          },
          onConnectedRecord: (connectedRecord) => {
            connectedRecord.lastPromptAt = isoNow();
          },
          onSessionIdResolved: (sessionId) => {
            activeSessionIdForControl = sessionId;
          },
        });

        let response;
        try {
          const promptPromise = client.prompt(activeSessionId, options.message);
          if (options.onPromptActive) {
            try {
              await options.onPromptActive();
            } catch (error) {
              if (options.verbose) {
                process.stderr.write(
                  `[acpx] onPromptActive hook failed: ${formatErrorMessage(error)}\n`,
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
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  authCredentials?: Record<string, string>;
  authPolicy?: AuthPolicy;
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
  const client = new AcpClient({
    agentCommand: record.agentCommand,
    cwd: absolutePath(record.cwd),
    permissionMode: options.permissionMode ?? "approve-reads",
    nonInteractivePermissions: options.nonInteractivePermissions,
    authCredentials: options.authCredentials,
    authPolicy: options.authPolicy,
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
        const {
          sessionId: activeSessionId,
          resumed,
          loadError,
        } = await connectAndLoadSession({
          client,
          record,
          timeoutMs: options.timeoutMs,
          verbose: options.verbose,
          activeController,
          withTimeout,
          shouldFallbackToNewSession,
          onClientAvailable: (controller) => {
            options.onClientAvailable?.(controller);
            notifiedClientAvailable = true;
          },
          onSessionIdResolved: (sessionId) => {
            activeSessionIdForControl = sessionId;
          },
        });

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
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  authCredentials?: Record<string, string>;
  authPolicy?: AuthPolicy;
  timeoutMs?: number;
  verbose?: boolean;
  onClientAvailable?: (controller: ActiveSessionController) => void;
  onClientClosed?: () => void;
};

type RunSessionSetConfigOptionDirectOptions = {
  sessionRecordId: string;
  configId: string;
  value: string;
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  authCredentials?: Record<string, string>;
  authPolicy?: AuthPolicy;
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
    nonInteractivePermissions: options.nonInteractivePermissions,
    authCredentials: options.authCredentials,
    authPolicy: options.authPolicy,
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
    nonInteractivePermissions: options.nonInteractivePermissions,
    authCredentials: options.authCredentials,
    authPolicy: options.authPolicy,
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
    nonInteractivePermissions: options.nonInteractivePermissions,
    authCredentials: options.authCredentials,
    authPolicy: options.authPolicy,
    suppressSdkConsoleErrors: options.suppressSdkConsoleErrors,
    verbose: options.verbose,
    onSessionUpdate: (notification) => output.onSessionUpdate(notification),
    onClientOperation: (operation) => output.onClientOperation(operation),
  });

  try {
    return await withInterrupt(
      async () => {
        await withTimeout(client.start(), options.timeoutMs);
        const createdSession = await withTimeout(
          client.createSession(absolutePath(options.cwd)),
          options.timeoutMs,
        );
        const sessionId = createdSession.sessionId;
        output.setContext({
          sessionId,
          stream: "prompt",
        });
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
    nonInteractivePermissions: options.nonInteractivePermissions,
    authCredentials: options.authCredentials,
    authPolicy: options.authPolicy,
    verbose: options.verbose,
  });

  try {
    return await withInterrupt(
      async () => {
        await withTimeout(client.start(), options.timeoutMs);
        const createdSession = await withTimeout(
          client.createSession(absolutePath(options.cwd)),
          options.timeoutMs,
        );
        const sessionId = createdSession.sessionId;
        const lifecycle = client.getAgentLifecycleSnapshot();

        const now = isoNow();
        const record: SessionRecord = {
          id: sessionId,
          sessionId,
          agentSessionId: createdSession.agentSessionId,
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

export async function ensureSession(
  options: SessionEnsureOptions,
): Promise<SessionEnsureResult> {
  const cwd = absolutePath(options.cwd);
  const gitRoot = findGitRepositoryRoot(cwd);
  const walkBoundary = options.walkBoundary ?? gitRoot ?? cwd;
  const existing = await findSessionByDirectoryWalk({
    agentCommand: options.agentCommand,
    cwd,
    name: options.name,
    boundary: walkBoundary,
  });
  if (existing) {
    return {
      record: existing,
      created: false,
    };
  }

  const record = await createSession({
    agentCommand: options.agentCommand,
    cwd,
    name: options.name,
    permissionMode: options.permissionMode,
    nonInteractivePermissions: options.nonInteractivePermissions,
    authCredentials: options.authCredentials,
    authPolicy: options.authPolicy,
    timeoutMs: options.timeoutMs,
    verbose: options.verbose,
  });

  return {
    record,
    created: true,
  };
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
    nonInteractivePermissions: options.nonInteractivePermissions,
    outputFormatter: options.outputFormatter,
    errorEmissionPolicy: options.errorEmissionPolicy,
    timeoutMs: options.timeoutMs,
    suppressSdkConsoleErrors: options.suppressSdkConsoleErrors,
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
        nonInteractivePermissions: options.nonInteractivePermissions,
        outputFormatter: options.outputFormatter,
        errorEmissionPolicy: options.errorEmissionPolicy,
        timeoutMs: options.timeoutMs,
        suppressSdkConsoleErrors: options.suppressSdkConsoleErrors,
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
    const turnController = new QueueOwnerTurnController({
      withTimeout: async (run, timeoutMs) => await withTimeout(run(), timeoutMs),
      setSessionModeFallback: async (modeId: string, timeoutMs?: number) => {
        await runSessionSetModeDirect({
          sessionRecordId: options.sessionId,
          modeId,
          nonInteractivePermissions: options.nonInteractivePermissions,
          authCredentials: options.authCredentials,
          authPolicy: options.authPolicy,
          timeoutMs,
          verbose: options.verbose,
        });
      },
      setSessionConfigOptionFallback: async (
        configId: string,
        value: string,
        timeoutMs?: number,
      ) => {
        const result = await runSessionSetConfigOptionDirect({
          sessionRecordId: options.sessionId,
          configId,
          value,
          nonInteractivePermissions: options.nonInteractivePermissions,
          authCredentials: options.authCredentials,
          authPolicy: options.authPolicy,
          timeoutMs,
          verbose: options.verbose,
        });
        return result.response;
      },
    });

    const applyPendingCancel = async (): Promise<boolean> => {
      return await turnController.applyPendingCancel();
    };

    const scheduleApplyPendingCancel = (): void => {
      void applyPendingCancel().catch((error) => {
        if (options.verbose) {
          process.stderr.write(
            `[acpx] failed to apply deferred cancel: ${formatErrorMessage(error)}\n`,
          );
        }
      });
    };

    const setActiveController = (controller: ActiveSessionController) => {
      turnController.setActiveController(controller);
      scheduleApplyPendingCancel();
    };
    const clearActiveController = () => {
      turnController.clearActiveController();
    };

    const runPromptTurn = async <T>(run: () => Promise<T>): Promise<T> => {
      turnController.beginTurn();
      try {
        return await run();
      } finally {
        turnController.endTurn();
      }
    };

    try {
      owner = await SessionQueueOwner.start(lease, {
        cancelPrompt: async () => {
          const accepted = await turnController.requestCancel();
          if (!accepted) {
            return false;
          }
          await applyPendingCancel();
          return true;
        },
        setSessionMode: async (modeId: string, timeoutMs?: number) => {
          await turnController.setSessionMode(modeId, timeoutMs);
        },
        setSessionConfigOption: async (
          configId: string,
          value: string,
          timeoutMs?: number,
        ) => {
          return await turnController.setSessionConfigOption(
            configId,
            value,
            timeoutMs,
          );
        },
      });

      const localResult = await runPromptTurn(async () => {
        return await runSessionPrompt({
          sessionRecordId: options.sessionId,
          message: options.message,
          permissionMode: options.permissionMode,
          nonInteractivePermissions: options.nonInteractivePermissions,
          authCredentials: options.authCredentials,
          authPolicy: options.authPolicy,
          outputFormatter: options.outputFormatter,
          timeoutMs: options.timeoutMs,
          suppressSdkConsoleErrors: options.suppressSdkConsoleErrors,
          verbose: options.verbose,
          onClientAvailable: setActiveController,
          onClientClosed: clearActiveController,
          onPromptActive: async () => {
            turnController.markPromptActive();
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
            nonInteractivePermissions: options.nonInteractivePermissions,
            authCredentials: options.authCredentials,
            authPolicy: options.authPolicy,
            suppressSdkConsoleErrors: options.suppressSdkConsoleErrors,
            onClientAvailable: setActiveController,
            onClientClosed: clearActiveController,
            onPromptActive: async () => {
              turnController.markPromptActive();
              await applyPendingCancel();
            },
          });
        });
      }

      return localResult;
    } finally {
      turnController.beginClosing();
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
    nonInteractivePermissions: options.nonInteractivePermissions,
    authCredentials: options.authCredentials,
    authPolicy: options.authPolicy,
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
    nonInteractivePermissions: options.nonInteractivePermissions,
    authCredentials: options.authCredentials,
    authPolicy: options.authPolicy,
    timeoutMs: options.timeoutMs,
    verbose: options.verbose,
  });
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

export {
  DEFAULT_HISTORY_LIMIT,
  findGitRepositoryRoot,
  findSession,
  findSessionByDirectoryWalk,
  isProcessAlive,
  listSessions,
  listSessionsForAgent,
};
