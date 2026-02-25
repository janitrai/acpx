const RUNTIME_SESSION_ID_META_KEYS = ["agentSessionId"] as const;

export function normalizeRuntimeSessionId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asMetaRecord(meta: unknown): Record<string, unknown> | undefined {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    return undefined;
  }
  return meta as Record<string, unknown>;
}

export function extractRuntimeSessionId(meta: unknown): string | undefined {
  const record = asMetaRecord(meta);
  if (!record) {
    return undefined;
  }

  for (const key of RUNTIME_SESSION_ID_META_KEYS) {
    const normalized = normalizeRuntimeSessionId(record[key]);
    if (normalized) {
      return normalized;
    }
  }

  return undefined;
}

export { RUNTIME_SESSION_ID_META_KEYS };
