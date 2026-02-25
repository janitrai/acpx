import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_SESSION_ID_META_KEYS,
  extractAgentSessionId,
} from "../src/agent-session-id.js";

test("runtime session id precedence is stable", () => {
  assert.deepEqual(AGENT_SESSION_ID_META_KEYS, ["agentSessionId"]);
});

test("extractAgentSessionId reads agentSessionId when present", () => {
  const meta = {
    agentSessionId: "agent-1",
  };

  assert.equal(extractAgentSessionId(meta), "agent-1");
});

test("extractAgentSessionId ignores legacy alias keys", () => {
  assert.equal(
    extractAgentSessionId({
      providerSessionId: "provider-2",
      codexSessionId: "codex-2",
      claudeSessionId: "claude-2",
    }),
    undefined,
  );
});

test("extractAgentSessionId ignores non-string and empty values", () => {
  assert.equal(
    extractAgentSessionId({
      agentSessionId: 123,
      providerSessionId: null,
      codexSessionId: ["codex"],
      claudeSessionId: "",
    }),
    undefined,
  );
  assert.equal(extractAgentSessionId(null), undefined);
  assert.equal(extractAgentSessionId([]), undefined);
  assert.equal(extractAgentSessionId("meta"), undefined);
});
