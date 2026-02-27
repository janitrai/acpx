import assert from "node:assert/strict";
import test from "node:test";
import { isAcpxEvent } from "../src/events.js";
import { ACPX_EVENT_TYPES } from "../src/types.js";

function makeEvent(type: string, data: Record<string, unknown>): unknown {
  return {
    schema: "acpx.event.v1",
    event_id: "evt-1",
    session_id: "session-1",
    seq: 0,
    ts: "2026-01-01T00:00:00.000Z",
    type,
    data,
  };
}

test("isAcpxEvent accepts structured tool_call payload", () => {
  const event = makeEvent(ACPX_EVENT_TYPES.TOOL_CALL, {
    tool_call_id: "call_123",
    title: "read_file",
    status: "in_progress",
  });

  assert.equal(isAcpxEvent(event), true);
});

test("isAcpxEvent rejects tool_call payload without tool_call_id", () => {
  const event = makeEvent(ACPX_EVENT_TYPES.TOOL_CALL, {
    title: "read_file",
    status: "in_progress",
  });

  assert.equal(isAcpxEvent(event), false);
});

test("isAcpxEvent accepts structured plan payload", () => {
  const event = makeEvent(ACPX_EVENT_TYPES.PLAN, {
    entries: [
      {
        content: "Implement health probe",
        status: "in_progress",
        priority: "high",
      },
    ],
  });

  assert.equal(isAcpxEvent(event), true);
});

test("isAcpxEvent rejects malformed plan entries", () => {
  const event = makeEvent(ACPX_EVENT_TYPES.PLAN, {
    entries: [
      {
        content: "Missing priority",
        status: "pending",
      },
    ],
  });

  assert.equal(isAcpxEvent(event), false);
});

test("isAcpxEvent validates new prompt_queued control event", () => {
  const valid = makeEvent(ACPX_EVENT_TYPES.PROMPT_QUEUED, {
    request_id: "req-1",
  });
  const invalid = makeEvent(ACPX_EVENT_TYPES.PROMPT_QUEUED, {
    request_id: 1,
  });

  assert.equal(isAcpxEvent(valid), true);
  assert.equal(isAcpxEvent(invalid), false);
});

test("isAcpxEvent validates status_snapshot optional fields", () => {
  const valid = makeEvent(ACPX_EVENT_TYPES.STATUS_SNAPSHOT, {
    status: "dead",
    pid: 123,
    summary: "queue owner unavailable",
    uptime: "00:00:03",
    last_prompt_time: "2026-01-01T00:00:00.000Z",
    exit_code: 1,
    signal: "SIGTERM",
  });

  const invalid = makeEvent(ACPX_EVENT_TYPES.STATUS_SNAPSHOT, {
    status: "dead",
    pid: -1,
  });

  assert.equal(isAcpxEvent(valid), true);
  assert.equal(isAcpxEvent(invalid), false);
});
