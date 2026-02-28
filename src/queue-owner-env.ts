import {
  runSessionQueueOwner,
  type QueueOwnerRuntimeOptions,
} from "./session-runtime.js";

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as UnknownRecord;
}

export function parseQueueOwnerPayload(raw: string): QueueOwnerRuntimeOptions {
  const parsed = JSON.parse(raw) as unknown;
  const record = asRecord(parsed);
  if (!record) {
    throw new Error("queue owner payload must be an object");
  }

  if (typeof record.sessionId !== "string" || record.sessionId.trim().length === 0) {
    throw new Error("queue owner payload missing sessionId");
  }
  if (
    record.permissionMode !== "approve-all" &&
    record.permissionMode !== "approve-reads" &&
    record.permissionMode !== "deny-all"
  ) {
    throw new Error("queue owner payload has invalid permissionMode");
  }

  const options: QueueOwnerRuntimeOptions = {
    sessionId: record.sessionId,
    permissionMode: record.permissionMode,
  };

  if (typeof record.nonInteractivePermissions === "string") {
    options.nonInteractivePermissions =
      record.nonInteractivePermissions === "deny" ||
      record.nonInteractivePermissions === "fail"
        ? record.nonInteractivePermissions
        : undefined;
  }

  if (record.authCredentials && typeof record.authCredentials === "object") {
    const entries = Object.entries(record.authCredentials as UnknownRecord).filter(
      ([, value]) => typeof value === "string",
    ) as Array<[string, string]>;
    options.authCredentials = Object.fromEntries(entries);
  }

  if (record.authPolicy === "skip" || record.authPolicy === "fail") {
    options.authPolicy = record.authPolicy;
  }

  if (typeof record.suppressSdkConsoleErrors === "boolean") {
    options.suppressSdkConsoleErrors = record.suppressSdkConsoleErrors;
  }

  if (typeof record.verbose === "boolean") {
    options.verbose = record.verbose;
  }

  if (typeof record.ttlMs === "number" && Number.isFinite(record.ttlMs)) {
    options.ttlMs = record.ttlMs;
  }

  return options;
}

export async function runQueueOwnerFromEnv(env: NodeJS.ProcessEnv): Promise<void> {
  const payload = env.ACPX_QUEUE_OWNER_PAYLOAD;
  if (!payload) {
    throw new Error("missing ACPX_QUEUE_OWNER_PAYLOAD");
  }
  const options = parseQueueOwnerPayload(payload);
  await runSessionQueueOwner(options);
}
