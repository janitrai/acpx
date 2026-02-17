export const AGENT_REGISTRY: Record<string, string> = {
  codex: "npx @zed-industries/codex-acp",
  claude: "npx @zed-industries/claude-agent-acp",
  gemini: "gemini",
};

export const DEFAULT_AGENT_NAME = "codex";

export function normalizeAgentName(value: string): string {
  return value.trim().toLowerCase();
}

export function resolveAgentCommand(agentName: string): string {
  const normalized = normalizeAgentName(agentName);
  return AGENT_REGISTRY[normalized] ?? agentName;
}

export function listBuiltInAgents(): string[] {
  return Object.keys(AGENT_REGISTRY);
}
