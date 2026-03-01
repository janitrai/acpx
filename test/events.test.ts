import assert from "node:assert/strict";
import test from "node:test";
import {
  isAcpJsonRpcMessage,
  isSessionUpdateNotification,
} from "../src/acp-jsonrpc.js";

test("isAcpJsonRpcMessage accepts JSON-RPC request", () => {
  assert.equal(
    isAcpJsonRpcMessage({
      jsonrpc: "2.0",
      id: "req-1",
      method: "session/prompt",
      params: {
        sessionId: "session-1",
        prompt: [{ type: "text", text: "hi" }],
      },
    }),
    true,
  );
});

test("isAcpJsonRpcMessage accepts JSON-RPC notification", () => {
  assert.equal(
    isAcpJsonRpcMessage({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "session-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "hello" },
        },
      },
    }),
    true,
  );
});

test("isAcpJsonRpcMessage accepts JSON-RPC success response", () => {
  assert.equal(
    isAcpJsonRpcMessage({
      jsonrpc: "2.0",
      id: "req-1",
      result: { stopReason: "end_turn" },
    }),
    true,
  );
});

test("isAcpJsonRpcMessage accepts JSON-RPC error response", () => {
  assert.equal(
    isAcpJsonRpcMessage({
      jsonrpc: "2.0",
      id: "req-1",
      error: {
        code: -32000,
        message: "runtime error",
      },
    }),
    true,
  );
});

test("isAcpJsonRpcMessage rejects non-JSON-RPC payload", () => {
  assert.equal(
    isAcpJsonRpcMessage({
      type: "custom_event",
      content: "hello",
    }),
    false,
  );
});

test("isAcpJsonRpcMessage accepts request/notification/response fixtures after roundtrip", () => {
  const fixtures: unknown[] = [
    {
      jsonrpc: "2.0",
      id: "req-1",
      method: "session/prompt",
      params: {
        sessionId: "session-1",
        prompt: [{ type: "text", text: "hi" }],
      },
    },
    {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "session-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "hello" },
        },
      },
    },
    {
      jsonrpc: "2.0",
      id: "req-2",
      result: { stopReason: "end_turn" },
    },
    {
      jsonrpc: "2.0",
      id: "req-3",
      error: {
        code: -32000,
        message: "runtime error",
      },
    },
  ];

  for (const fixture of fixtures) {
    const roundTripped = JSON.parse(JSON.stringify(fixture));
    assert.equal(isAcpJsonRpcMessage(roundTripped), true);
  }
});

test("isSessionUpdateNotification matches session/update notifications only", () => {
  assert.equal(
    isSessionUpdateNotification({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "session-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "hello" },
        },
      },
    }),
    true,
  );

  assert.equal(
    isSessionUpdateNotification({
      jsonrpc: "2.0",
      id: "req-1",
      method: "session/prompt",
      params: {
        sessionId: "session-1",
        prompt: [{ type: "text", text: "hello" }],
      },
    }),
    false,
  );

  assert.equal(
    isSessionUpdateNotification({
      jsonrpc: "2.0",
      id: "req-2",
      result: { stopReason: "end_turn" },
    }),
    false,
  );
});
