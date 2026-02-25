import assert from "node:assert/strict";
import test from "node:test";
import {
  RUNTIME_SESSION_ID_META_KEYS,
  extractRuntimeSessionId,
} from "../src/runtime-session-id.js";

test("runtime session id precedence is stable", () => {
  assert.deepEqual(RUNTIME_SESSION_ID_META_KEYS, ["agentSessionId"]);
});

test("extractRuntimeSessionId reads agentSessionId when present", () => {
  const meta = {
    agentSessionId: "agent-1",
  };

  assert.equal(extractRuntimeSessionId(meta), "agent-1");
});

test("extractRuntimeSessionId ignores legacy alias keys", () => {
  assert.equal(
    extractRuntimeSessionId({
      providerSessionId: "provider-2",
      codexSessionId: "codex-2",
      claudeSessionId: "claude-2",
    }),
    undefined,
  );
});

test("extractRuntimeSessionId ignores non-string and empty values", () => {
  assert.equal(
    extractRuntimeSessionId({
      agentSessionId: 123,
      providerSessionId: null,
      codexSessionId: ["codex"],
      claudeSessionId: "",
    }),
    undefined,
  );
  assert.equal(extractRuntimeSessionId(null), undefined);
  assert.equal(extractRuntimeSessionId([]), undefined);
  assert.equal(extractRuntimeSessionId("meta"), undefined);
});
