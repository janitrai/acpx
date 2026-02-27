const SNAKE_CASE_KEY = /^[a-z][a-z0-9_]*$/;

const ZED_TAG_KEYS = new Set([
  "User",
  "Agent",
  "Resume",
  "Text",
  "Mention",
  "Image",
  "Thinking",
  "RedactedThinking",
  "ToolUse",
]);

const MAP_OBJECT_PATHS = new Set([
  "thread.request_token_usage",
  "thread.messages.Agent.tool_results",
]);

const OPAQUE_VALUE_PATHS = new Set([
  "agent_capabilities",
  "thread.messages.Agent.content.ToolUse.input",
  "acpx.config_options",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function joinPath(path: string[]): string {
  return path.join(".");
}

function isAllowedKey(path: string[], key: string): boolean {
  if (ZED_TAG_KEYS.has(key)) {
    return true;
  }

  return false;
}

function shouldSkipKeyRule(path: string[]): boolean {
  return MAP_OBJECT_PATHS.has(joinPath(path));
}

function shouldSkipDescend(path: string[]): boolean {
  return OPAQUE_VALUE_PATHS.has(joinPath(path)) || isToolResultOutputPath(path);
}

function isToolResultOutputPath(path: string[]): boolean {
  if (path.length < 6 || path[path.length - 1] !== "output") {
    return false;
  }

  const toolResultsIndex = path.lastIndexOf("tool_results");
  if (toolResultsIndex === -1 || toolResultsIndex + 2 !== path.length - 1) {
    return false;
  }

  const parentPath = path.slice(0, toolResultsIndex + 1).join(".");
  return parentPath === "thread.messages.Agent.tool_results";
}

function collectViolations(value: unknown, path: string[], violations: string[]): void {
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectViolations(entry, path, violations);
    }
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  const skipKeyRule = shouldSkipKeyRule(path);
  for (const [key, child] of Object.entries(value)) {
    if (!skipKeyRule && !SNAKE_CASE_KEY.test(key) && !isAllowedKey(path, key)) {
      violations.push(`${joinPath(path)}.${key}`.replace(/^\./, ""));
    }

    const childPath = [...path, key];
    if (shouldSkipDescend(childPath)) {
      continue;
    }

    collectViolations(child, childPath, violations);
  }
}

export function findPersistedKeyPolicyViolations(value: unknown): string[] {
  const violations: string[] = [];
  collectViolations(value, [], violations);
  return violations;
}

export function assertPersistedKeyPolicy(value: unknown): void {
  const violations = findPersistedKeyPolicyViolations(value);
  if (violations.length === 0) {
    return;
  }

  throw new Error(
    `Persisted key policy violation (expected snake_case keys): ${violations.join(", ")}`,
  );
}
