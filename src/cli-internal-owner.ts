import { InvalidArgumentError } from "commander";
import {
  AUTH_POLICIES,
  NON_INTERACTIVE_PERMISSION_POLICIES,
  PERMISSION_MODES,
  type AuthPolicy,
  type NonInteractivePermissionPolicy,
  type PermissionMode,
} from "./types.js";

export type QueueOwnerFlags = {
  sessionId: string;
  ttlMs: number;
  permissionMode: PermissionMode;
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  authPolicy?: AuthPolicy;
  timeoutMs?: number;
  verbose?: boolean;
  suppressSdkConsoleErrors?: boolean;
};

function parseNonEmptyValue(label: string, value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new InvalidArgumentError(`${label} must not be empty`);
  }
  return trimmed;
}

function parseNonNegativeMilliseconds(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new InvalidArgumentError("TTL must be a non-negative number of milliseconds");
  }
  return Math.round(parsed);
}

function parseTimeoutMilliseconds(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new InvalidArgumentError("Timeout must be a positive number of milliseconds");
  }
  return Math.round(parsed);
}

function parsePermissionMode(value: string): PermissionMode {
  if (!PERMISSION_MODES.includes(value as PermissionMode)) {
    throw new InvalidArgumentError(
      `Invalid permission mode "${value}". Expected one of: ${PERMISSION_MODES.join(", ")}`,
    );
  }
  return value as PermissionMode;
}

function parseAuthPolicy(value: string): AuthPolicy {
  if (!AUTH_POLICIES.includes(value as AuthPolicy)) {
    throw new InvalidArgumentError(
      `Invalid auth policy "${value}". Expected one of: ${AUTH_POLICIES.join(", ")}`,
    );
  }
  return value as AuthPolicy;
}

function parseNonInteractivePermissionPolicy(
  value: string,
): NonInteractivePermissionPolicy {
  if (
    !NON_INTERACTIVE_PERMISSION_POLICIES.includes(
      value as NonInteractivePermissionPolicy,
    )
  ) {
    throw new InvalidArgumentError(
      `Invalid non-interactive permission policy "${value}". Expected one of: ${NON_INTERACTIVE_PERMISSION_POLICIES.join(", ")}`,
    );
  }
  return value as NonInteractivePermissionPolicy;
}

export function parseQueueOwnerFlags(
  argv: string[],
  defaultTtlMs: number,
): QueueOwnerFlags | undefined {
  if (argv[0] !== "__queue-owner") {
    return undefined;
  }

  const flags: Partial<QueueOwnerFlags> = {
    ttlMs: defaultTtlMs,
  };

  const consumeValue = (
    index: number,
    token: string,
  ): { value: string; next: number } => {
    if (token.includes("=")) {
      return {
        value: token.slice(token.indexOf("=") + 1),
        next: index,
      };
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("-")) {
      throw new InvalidArgumentError(`${token} requires a value`);
    }
    return {
      value,
      next: index + 1,
    };
  };

  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--session-id" || token.startsWith("--session-id=")) {
      const consumed = consumeValue(index, token);
      flags.sessionId = parseNonEmptyValue("Session id", consumed.value);
      index = consumed.next;
      continue;
    }
    if (token === "--ttl-ms" || token.startsWith("--ttl-ms=")) {
      const consumed = consumeValue(index, token);
      flags.ttlMs = parseNonNegativeMilliseconds(consumed.value);
      index = consumed.next;
      continue;
    }
    if (token === "--permission-mode" || token.startsWith("--permission-mode=")) {
      const consumed = consumeValue(index, token);
      flags.permissionMode = parsePermissionMode(consumed.value);
      index = consumed.next;
      continue;
    }
    if (
      token === "--non-interactive-permissions" ||
      token.startsWith("--non-interactive-permissions=")
    ) {
      const consumed = consumeValue(index, token);
      flags.nonInteractivePermissions = parseNonInteractivePermissionPolicy(
        consumed.value,
      );
      index = consumed.next;
      continue;
    }
    if (token === "--auth-policy" || token.startsWith("--auth-policy=")) {
      const consumed = consumeValue(index, token);
      flags.authPolicy = parseAuthPolicy(consumed.value);
      index = consumed.next;
      continue;
    }
    if (token === "--timeout-ms" || token.startsWith("--timeout-ms=")) {
      const consumed = consumeValue(index, token);
      flags.timeoutMs = parseTimeoutMilliseconds(consumed.value);
      index = consumed.next;
      continue;
    }
    if (token === "--verbose") {
      flags.verbose = true;
      continue;
    }
    if (token === "--suppress-sdk-console-errors") {
      flags.suppressSdkConsoleErrors = true;
      continue;
    }
    throw new InvalidArgumentError(`Unknown __queue-owner option: ${token}`);
  }

  if (!flags.sessionId) {
    throw new InvalidArgumentError("__queue-owner requires --session-id");
  }
  if (!flags.permissionMode) {
    throw new InvalidArgumentError("__queue-owner requires --permission-mode");
  }

  return {
    sessionId: flags.sessionId,
    ttlMs: flags.ttlMs ?? defaultTtlMs,
    permissionMode: flags.permissionMode,
    nonInteractivePermissions: flags.nonInteractivePermissions,
    authPolicy: flags.authPolicy,
    timeoutMs: flags.timeoutMs,
    verbose: flags.verbose,
    suppressSdkConsoleErrors: flags.suppressSdkConsoleErrors,
  };
}
