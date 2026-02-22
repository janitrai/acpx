import assert from "node:assert/strict";
import test from "node:test";
import { parseQueueRequest } from "../src/queue-messages.js";

test("parseQueueRequest accepts submit_prompt with nonInteractivePermissions", () => {
  const parsed = parseQueueRequest({
    type: "submit_prompt",
    requestId: "req-1",
    message: "hello",
    permissionMode: "approve-reads",
    nonInteractivePermissions: "fail",
    timeoutMs: 1_500,
    waitForCompletion: true,
  });

  assert.deepEqual(parsed, {
    type: "submit_prompt",
    requestId: "req-1",
    message: "hello",
    permissionMode: "approve-reads",
    nonInteractivePermissions: "fail",
    timeoutMs: 1_500,
    waitForCompletion: true,
  });
});

test("parseQueueRequest rejects invalid nonInteractivePermissions value", () => {
  const parsed = parseQueueRequest({
    type: "submit_prompt",
    requestId: "req-2",
    message: "hello",
    permissionMode: "approve-reads",
    nonInteractivePermissions: "invalid",
    waitForCompletion: false,
  });

  assert.equal(parsed, null);
});
