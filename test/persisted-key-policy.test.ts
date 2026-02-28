import assert from "node:assert/strict";
import test from "node:test";
import {
  assertPersistedKeyPolicy,
  findPersistedKeyPolicyViolations,
} from "../src/persisted-key-policy.js";
import { serializeSessionRecordForDisk } from "../src/session-persistence.js";
import type { SessionRecord } from "../src/types.js";

function makeRecord(): SessionRecord {
  return {
    schema: "acpx.session.v1",
    acpxRecordId: "record-1",
    acpSessionId: "session-1",
    agentSessionId: "agent-1",
    agentCommand: "npx @zed-industries/codex-acp",
    cwd: "/tmp/project",
    createdAt: "2026-02-27T00:00:00.000Z",
    lastUsedAt: "2026-02-27T00:00:00.000Z",
    lastSeq: 4,
    lastRequestId: "req-1",
    eventLog: {
      active_path: "/tmp/record-1.stream.ndjson",
      segment_count: 2,
      max_segment_bytes: 1024,
      max_segments: 2,
      last_write_at: "2026-02-27T00:00:00.000Z",
      last_write_error: null,
    },
    closed: false,
    title: null,
    messages: [
      {
        User: {
          id: "user-1",
          content: [{ Text: "hello" }],
        },
      },
      {
        Agent: {
          content: [
            { Text: "world" },
            {
              ToolUse: {
                id: "call_1",
                name: "run_command",
                raw_input: '{"command":"ls"}',
                input: {
                  command: "ls",
                },
                is_input_complete: true,
                thought_signature: null,
              },
            },
          ],
          tool_results: {
            call_1: {
              tool_use_id: "call_1",
              tool_name: "run_command",
              is_error: false,
              content: {
                Text: "ok",
              },
              output: {
                exitCode: 0,
              },
            },
          },
        },
      },
    ],
    updated_at: "2026-02-27T00:00:00.000Z",
    cumulative_token_usage: {},
    request_token_usage: {
      "5cf39f6d-9c4f-4d20-9e4b-739abc4b2554": {
        input_tokens: 1,
      },
    },
    acpx: {
      current_mode_id: "code",
      available_commands: ["run"],
    },
  };
}

test("serialized session record satisfies persisted key policy", () => {
  const persisted = serializeSessionRecordForDisk(makeRecord());
  assert.deepEqual(findPersistedKeyPolicyViolations(persisted), []);
  assertPersistedKeyPolicy(persisted);
});

test("persisted key policy rejects camelCase acpx-owned keys", () => {
  const persisted = serializeSessionRecordForDisk(makeRecord()) as Record<
    string,
    unknown
  >;
  persisted.requestId = "bad";

  const violations = findPersistedKeyPolicyViolations(persisted);
  assert.equal(violations.includes("requestId"), true);
  assert.throws(() => {
    assertPersistedKeyPolicy(persisted);
  }, /snake_case/);
});
