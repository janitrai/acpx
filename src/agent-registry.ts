export const AGENT_REGISTRY: Record<string, string> = {
  codex: "npx @zed-industries/codex-acp",
  claude: "npx @zed-industries/claude-agent-acp",
  gemini: "gemini",
  opencode: "npx opencode-ai",
  pi: "npx pi-acp",
};

export const DEFAULT_AGENT_NAME = "codex";

export function normalizeAgentName(value: string): string {
  return value.trim().toLowerCase();
}

export function mergeAgentRegistry(
  overrides?: Record<string, string>,
): Record<string, string> {
  if (!overrides) {
    return { ...AGENT_REGISTRY };
  }

  const merged = { ...AGENT_REGISTRY };
  for (const [name, command] of Object.entries(overrides)) {
    const normalized = normalizeAgentName(name);
    if (!normalized || !command.trim()) {
      continue;
    }
    merged[normalized] = command.trim();
  }
  return merged;
}

export function resolveAgentCommand(
  agentName: string,
  overrides?: Record<string, string>,
): string {
  const normalized = normalizeAgentName(agentName);
  const registry = mergeAgentRegistry(overrides);
  return registry[normalized] ?? agentName;
}

export function listBuiltInAgents(overrides?: Record<string, string>): string[] {
  return Object.keys(mergeAgentRegistry(overrides));
}
