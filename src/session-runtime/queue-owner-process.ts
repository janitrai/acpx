import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
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

const QUEUE_OWNER_MAIN_PATH = fileURLToPath(
  new URL("../queue-owner-main.js", import.meta.url),
);

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
  const child = spawn(process.execPath, [QUEUE_OWNER_MAIN_PATH], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      ACPX_QUEUE_OWNER_PAYLOAD: payload,
    },
  });
  child.unref();
}
