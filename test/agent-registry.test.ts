import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_AGENT_NAME,
  listBuiltInAgents,
  resolveAgentCommand,
} from "../src/agent-registry.js";

test("resolveAgentCommand maps known agents to commands", () => {
  const expected = new Map<string, string>([
    ["codex", "npx @zed-industries/codex-acp"],
    ["claude", "npx -y @zed-industries/claude-agent-acp"],
    ["gemini", "gemini"],
    ["opencode", "npx opencode-ai"],
    ["pi", "npx pi-acp"],
  ]);

  for (const [name, command] of expected) {
    assert.equal(resolveAgentCommand(name), command);
  }
});

test("resolveAgentCommand returns raw value for unknown agents", () => {
  assert.equal(resolveAgentCommand("custom-acp-server"), "custom-acp-server");
});

test("listBuiltInAgents returns exactly all 5 registered agent names", () => {
  const agents = listBuiltInAgents();
  assert.equal(agents.length, 5);
  assert.deepEqual(
    new Set(agents),
    new Set(["codex", "claude", "gemini", "opencode", "pi"]),
  );
});

test("default agent is codex", () => {
  assert.equal(DEFAULT_AGENT_NAME, "codex");
});
