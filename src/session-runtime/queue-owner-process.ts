import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import type {
  AuthPolicy,
  NonInteractivePermissionPolicy,
  PermissionMode,
} from "../types.js";

export type QueueOwnerRuntimeOptions = {
  sessionId: string;
  permissionMode: PermissionMode;
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  authCredentials?: Record<string, string>;
  authPolicy?: AuthPolicy;
  suppressSdkConsoleErrors?: boolean;
  verbose?: boolean;
  ttlMs?: number;
};

type SessionSendLike = {
  sessionId: string;
  permissionMode: PermissionMode;
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  authCredentials?: Record<string, string>;
  authPolicy?: AuthPolicy;
  suppressSdkConsoleErrors?: boolean;
  verbose?: boolean;
  ttlMs?: number;
};

export function resolveQueueOwnerSpawnArgs(
  argv: readonly string[] = process.argv,
): string[] {
  const entry = argv[1];
  if (!entry || entry.trim().length === 0) {
    throw new Error("acpx self-spawn failed: missing CLI entry path");
  }
  const resolvedEntry = realpathSync(entry);
  return [resolvedEntry, "__queue-owner"];
}

export function queueOwnerRuntimeOptionsFromSend(
  options: SessionSendLike,
): QueueOwnerRuntimeOptions {
  return {
    sessionId: options.sessionId,
    permissionMode: options.permissionMode,
    nonInteractivePermissions: options.nonInteractivePermissions,
    authCredentials: options.authCredentials,
    authPolicy: options.authPolicy,
    suppressSdkConsoleErrors: options.suppressSdkConsoleErrors,
    verbose: options.verbose,
    ttlMs: options.ttlMs,
  };
}

export function spawnQueueOwnerProcess(options: QueueOwnerRuntimeOptions): void {
  const payload = JSON.stringify(options);
  const child = spawn(process.execPath, resolveQueueOwnerSpawnArgs(), {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      ACPX_QUEUE_OWNER_PAYLOAD: payload,
    },
  });
  child.unref();
}
