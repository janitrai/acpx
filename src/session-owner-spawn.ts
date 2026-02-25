import { spawn } from "node:child_process";
import { QueueConnectionError } from "./errors.js";
import {
  QUEUE_CONNECT_RETRY_MS,
  trySubmitToRunningOwner,
  waitMs,
} from "./queue-ipc.js";
import { absolutePath, resolveSessionRecord } from "./session-persistence.js";
import { normalizeQueueOwnerTtlMs } from "./session-owner-runtime.js";
import type {
  AuthPolicy,
  NonInteractivePermissionPolicy,
  OutputErrorEmissionPolicy,
  OutputFormatter,
  PermissionMode,
  SessionSendOutcome,
} from "./types.js";

const QUEUE_OWNER_STARTUP_TIMEOUT_MS = 10_000;
const QUEUE_OWNER_RESPAWN_BACKOFF_MS = 250;

export type QueueOwnerSpawnConfig = {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

export type SendViaDetachedQueueOwnerOptions = {
  sessionId: string;
  message: string;
  permissionMode: PermissionMode;
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  outputFormatter: OutputFormatter;
  errorEmissionPolicy?: OutputErrorEmissionPolicy;
  timeoutMs?: number;
  suppressSdkConsoleErrors?: boolean;
  verbose?: boolean;
  waitForCompletion?: boolean;
  ttlMs?: number;
  queueOwnerSpawn?: QueueOwnerSpawnConfig;
  authPolicy?: AuthPolicy;
};

function isQueueNotAcceptingError(error: unknown): boolean {
  return (
    error instanceof QueueConnectionError &&
    error.detailCode === "QUEUE_NOT_ACCEPTING_REQUESTS"
  );
}

function spawnDetachedQueueOwner(ownerSpawn: QueueOwnerSpawnConfig): void {
  const child = spawn(ownerSpawn.command, ownerSpawn.args, {
    cwd: ownerSpawn.cwd,
    env: ownerSpawn.env,
    stdio: "ignore",
    detached: true,
  });
  child.unref();
}

export async function buildDefaultQueueOwnerSpawn(
  options: SendViaDetachedQueueOwnerOptions,
  queueOwnerTtlMs: number,
): Promise<QueueOwnerSpawnConfig> {
  const entrypoint = process.argv[1];
  if (!entrypoint) {
    throw new Error("Cannot spawn queue owner process: CLI entrypoint is missing");
  }

  const record = await resolveSessionRecord(options.sessionId);
  const args = [
    entrypoint,
    "__queue-owner",
    "--session-id",
    options.sessionId,
    "--ttl-ms",
    String(queueOwnerTtlMs),
    "--permission-mode",
    options.permissionMode,
  ];

  if (options.nonInteractivePermissions) {
    args.push("--non-interactive-permissions", options.nonInteractivePermissions);
  }
  if (options.authPolicy) {
    args.push("--auth-policy", options.authPolicy);
  }
  if (
    options.timeoutMs != null &&
    Number.isFinite(options.timeoutMs) &&
    options.timeoutMs > 0
  ) {
    args.push("--timeout-ms", String(Math.round(options.timeoutMs)));
  }
  if (options.verbose) {
    args.push("--verbose");
  }
  if (options.suppressSdkConsoleErrors) {
    args.push("--suppress-sdk-console-errors");
  }

  return {
    command: process.execPath,
    args,
    cwd: absolutePath(record.cwd),
  };
}

export async function sendViaDetachedQueueOwner(
  options: SendViaDetachedQueueOwnerOptions,
): Promise<SessionSendOutcome> {
  const waitForCompletion = options.waitForCompletion !== false;
  const queueOwnerTtlMs = normalizeQueueOwnerTtlMs(options.ttlMs);
  const ownerSpawn =
    options.queueOwnerSpawn ??
    (await buildDefaultQueueOwnerSpawn(options, queueOwnerTtlMs));
  const startupDeadline = Date.now() + QUEUE_OWNER_STARTUP_TIMEOUT_MS;
  let lastSpawnAttemptAt = 0;

  for (;;) {
    try {
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
    } catch (error) {
      if (!isQueueNotAcceptingError(error)) {
        throw error;
      }

      if (Date.now() >= startupDeadline) {
        throw new QueueConnectionError(
          "Timed out waiting for detached queue owner to accept prompt requests",
          {
            detailCode: "QUEUE_NOT_ACCEPTING_REQUESTS",
            origin: "queue",
            retryable: true,
            cause: error instanceof Error ? error : undefined,
          },
        );
      }
      await waitMs(QUEUE_CONNECT_RETRY_MS);
      continue;
    }

    const now = Date.now();
    if (now >= startupDeadline) {
      throw new QueueConnectionError(
        "Timed out waiting for detached queue owner to start",
        {
          detailCode: "QUEUE_NOT_ACCEPTING_REQUESTS",
          origin: "queue",
          retryable: true,
        },
      );
    }

    if (now - lastSpawnAttemptAt >= QUEUE_OWNER_RESPAWN_BACKOFF_MS) {
      spawnDetachedQueueOwner(ownerSpawn);
      lastSpawnAttemptAt = now;
      if (options.verbose) {
        process.stderr.write(
          `[acpx] starting detached queue owner for session ${options.sessionId}\n`,
        );
      }
    }

    await waitMs(QUEUE_CONNECT_RETRY_MS);
  }
}
