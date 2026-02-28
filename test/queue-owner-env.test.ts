import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseQueueOwnerPayload,
  runQueueOwnerFromEnv,
} from "../src/queue-owner-env.js";

describe("parseQueueOwnerPayload", () => {
  it("parses valid payload", () => {
    const parsed = parseQueueOwnerPayload(
      JSON.stringify({
        sessionId: "session-1",
        permissionMode: "approve-reads",
        ttlMs: 1234,
      }),
    );
    assert.equal(parsed.sessionId, "session-1");
    assert.equal(parsed.permissionMode, "approve-reads");
    assert.equal(parsed.ttlMs, 1234);
  });

  it("rejects invalid payloads", () => {
    assert.throws(() => parseQueueOwnerPayload("{}"), {
      message: "queue owner payload missing sessionId",
    });
    assert.throws(
      () =>
        parseQueueOwnerPayload(
          JSON.stringify({
            sessionId: "session-1",
            permissionMode: "invalid",
          }),
        ),
      {
        message: "queue owner payload has invalid permissionMode",
      },
    );
  });
});

describe("runQueueOwnerFromEnv", () => {
  it("fails when payload env is missing", async () => {
    await assert.rejects(async () => await runQueueOwnerFromEnv({}), {
      message: "missing ACPX_QUEUE_OWNER_PAYLOAD",
    });
  });
});
