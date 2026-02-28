import assert from "node:assert/strict";
import test from "node:test";
import { buildJsonRpcErrorResponse } from "../src/jsonrpc-error.js";

test("buildJsonRpcErrorResponse preserves ACP payload when available", () => {
  const response = buildJsonRpcErrorResponse({
    outputCode: "RUNTIME",
    message: "fallback message",
    sessionId: "session-1",
    acp: {
      code: -32099,
      message: "adapter failure",
      data: {
        reason: "boom",
      },
    },
  });

  assert.equal(response.jsonrpc, "2.0");
  assert.equal(response.id, null);
  assert.equal(response.error.code, -32099);
  assert.equal(response.error.message, "adapter failure");
  assert.deepEqual(response.error.data, {
    reason: "boom",
  });
});

test("buildJsonRpcErrorResponse shapes fallback ACPX metadata", () => {
  const response = buildJsonRpcErrorResponse({
    outputCode: "NO_SESSION",
    detailCode: "MISSING",
    origin: "queue",
    message: "No session found",
    retryable: false,
    timestamp: "2026-02-28T00:00:00.000Z",
    sessionId: "session-2",
  });

  assert.equal(response.error.code, -32002);
  assert.equal(response.error.message, "No session found");
  assert.deepEqual(response.error.data, {
    acpxCode: "NO_SESSION",
    detailCode: "MISSING",
    origin: "queue",
    retryable: false,
    timestamp: "2026-02-28T00:00:00.000Z",
    sessionId: "session-2",
  });
});
