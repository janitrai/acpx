import type { SetSessionConfigOptionResponse } from "@agentclientprotocol/sdk";
import { formatErrorMessage } from "./error-normalization.js";
import {
  QueueOwnerTurnController,
  type QueueOwnerActiveSessionController,
} from "./queue-owner-turn-controller.js";
import {
  SessionQueueOwner,
  refreshQueueOwnerLease,
  releaseQueueOwnerLease,
  tryAcquireQueueOwnerLease,
  type QueueTask,
} from "./queue-ipc.js";
import type {
  AuthPolicy,
  NonInteractivePermissionPolicy,
  PermissionMode,
} from "./types.js";

export const DEFAULT_QUEUE_OWNER_TTL_MS = 300_000;
const QUEUE_OWNER_HEARTBEAT_INTERVAL_MS = 2_000;

export type QueueOwnerRunOptions = {
  sessionId: string;
  ttlMs?: number;
  permissionMode: PermissionMode;
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  authCredentials?: Record<string, string>;
  authPolicy?: AuthPolicy;
  timeoutMs?: number;
  suppressSdkConsoleErrors?: boolean;
  verbose?: boolean;
};

type RunQueuedTaskOptions = {
  verbose?: boolean;
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  authCredentials?: Record<string, string>;
  authPolicy?: AuthPolicy;
  suppressSdkConsoleErrors?: boolean;
  onClientAvailable?: (controller: QueueOwnerActiveSessionController) => void;
  onClientClosed?: () => void;
  onPromptActive?: () => Promise<void> | void;
};

type QueueOwnerRuntimeDeps = {
  runQueuedTask: (
    sessionRecordId: string,
    task: QueueTask,
    options: RunQueuedTaskOptions,
  ) => Promise<void>;
  withTimeout: <T>(run: () => Promise<T>, timeoutMs?: number) => Promise<T>;
  setSessionModeFallback: (modeId: string, timeoutMs?: number) => Promise<void>;
  setSessionConfigOptionFallback: (
    configId: string,
    value: string,
    timeoutMs?: number,
  ) => Promise<SetSessionConfigOptionResponse>;
};

type QueueOwnerTurnRuntime = {
  beginClosing: () => void;
  onClientAvailable: (controller: QueueOwnerActiveSessionController) => void;
  onClientClosed: () => void;
  onPromptActive: () => Promise<void>;
  runPromptTurn: <T>(run: () => Promise<T>) => Promise<T>;
  controlHandlers: {
    cancelPrompt: () => Promise<boolean>;
    setSessionMode: (modeId: string, timeoutMs?: number) => Promise<void>;
    setSessionConfigOption: (
      configId: string,
      value: string,
      timeoutMs?: number,
    ) => Promise<SetSessionConfigOptionResponse>;
  };
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

function createQueueOwnerTurnRuntime(
  options: QueueOwnerRunOptions,
  deps: QueueOwnerRuntimeDeps,
): QueueOwnerTurnRuntime {
  const turnController = new QueueOwnerTurnController({
    withTimeout: async (run, timeoutMs) => await deps.withTimeout(run, timeoutMs),
    setSessionModeFallback: deps.setSessionModeFallback,
    setSessionConfigOptionFallback: deps.setSessionConfigOptionFallback,
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

  return {
    beginClosing: () => {
      turnController.beginClosing();
    },
    onClientAvailable: (controller: QueueOwnerActiveSessionController) => {
      turnController.setActiveController(controller);
      scheduleApplyPendingCancel();
    },
    onClientClosed: () => {
      turnController.clearActiveController();
    },
    onPromptActive: async () => {
      turnController.markPromptActive();
      await applyPendingCancel();
    },
    runPromptTurn: async <T>(run: () => Promise<T>): Promise<T> => {
      turnController.beginTurn();
      try {
        return await run();
      } finally {
        turnController.endTurn();
      }
    },
    controlHandlers: {
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
        return await turnController.setSessionConfigOption(configId, value, timeoutMs);
      },
    },
  };
}

export async function runQueueOwnerProcess(
  options: QueueOwnerRunOptions,
  deps: QueueOwnerRuntimeDeps,
): Promise<void> {
  const queueOwnerTtlMs = normalizeQueueOwnerTtlMs(options.ttlMs);
  const lease = await tryAcquireQueueOwnerLease(options.sessionId);
  if (!lease) {
    if (options.verbose) {
      process.stderr.write(
        `[acpx] queue owner already active for session ${options.sessionId}; skipping spawn\n`,
      );
    }
    return;
  }

  const runtime = createQueueOwnerTurnRuntime(options, deps);
  let owner: SessionQueueOwner | undefined;
  let heartbeatTimer: NodeJS.Timeout | undefined;
  const refreshHeartbeat = async () => {
    if (!owner) {
      return;
    }
    await refreshQueueOwnerLease(lease, {
      queueDepth: owner.queueDepth(),
    }).catch((error) => {
      if (options.verbose) {
        process.stderr.write(
          `[acpx] queue owner heartbeat update failed: ${formatErrorMessage(error)}\n`,
        );
      }
    });
  };

  try {
    owner = await SessionQueueOwner.start(lease, runtime.controlHandlers);
    await refreshHeartbeat();
    heartbeatTimer = setInterval(() => {
      void refreshHeartbeat();
    }, QUEUE_OWNER_HEARTBEAT_INTERVAL_MS);
    heartbeatTimer.unref();
    const idleWaitMs = queueOwnerTtlMs === 0 ? undefined : Math.max(0, queueOwnerTtlMs);

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

      await runtime.runPromptTurn(async () => {
        await deps.runQueuedTask(options.sessionId, task, {
          verbose: options.verbose,
          nonInteractivePermissions: options.nonInteractivePermissions,
          authCredentials: options.authCredentials,
          authPolicy: options.authPolicy,
          suppressSdkConsoleErrors: options.suppressSdkConsoleErrors,
          onClientAvailable: runtime.onClientAvailable,
          onClientClosed: runtime.onClientClosed,
          onPromptActive: runtime.onPromptActive,
        });
      });
      await refreshHeartbeat();
    }
  } finally {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
    }
    runtime.beginClosing();
    if (owner) {
      await owner.close();
    }
    await releaseQueueOwnerLease(lease);
  }
}
