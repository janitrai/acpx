import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultSessionEventLog } from "../src/session-event-log.js";
import { SessionEventWriter, listSessionEvents } from "../src/session-events.js";
import {
  resolveSessionRecord,
  writeSessionRecord,
} from "../src/session-persistence.js";
import type { SessionRecord } from "../src/types.js";

async function withTempHome(run: (homeDir: string) => Promise<void>): Promise<void> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-events-home-"));
  const originalHome = process.env.HOME;
  process.env.HOME = homeDir;

  try {
    await run(homeDir);
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    await fs.rm(homeDir, { recursive: true, force: true });
  }
}

function makeSessionRecord(
  sessionId: string,
  cwd: string,
  maxSegments: number,
): SessionRecord {
  const now = "2026-02-28T00:00:00.000Z";
  return {
    schema: "acpx.session.v1",
    acpxRecordId: sessionId,
    acpSessionId: sessionId,
    agentCommand: "npx @zed-industries/codex-acp",
    cwd,
    createdAt: now,
    lastUsedAt: now,
    lastSeq: 0,
    eventLog: {
      ...defaultSessionEventLog(sessionId),
      max_segments: maxSegments,
      segment_count: 1,
    },
    closed: false,
    title: null,
    messages: [],
    updated_at: now,
    cumulative_token_usage: {},
    request_token_usage: {},
    acpx: {},
  };
}

test("listSessionEvents reads all configured stream segments", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const sessionId = "session-stream-max-window";
    const record = makeSessionRecord(sessionId, cwd, 7);
    await writeSessionRecord(record);

    const writer = await SessionEventWriter.open(record, {
      maxSegmentBytes: 1,
      maxSegments: 7,
    });

    for (let index = 0; index < 8; index += 1) {
      await writer.appendMessage({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `event-${index + 1}` },
          },
        },
      } as never);
    }
    await writer.close({ checkpoint: true });

    const events = await listSessionEvents(sessionId);
    assert.equal(events.length, 8);
    assert.equal(
      events.every((event) => event.jsonrpc === "2.0"),
      true,
    );
  });
});

test("SessionEventWriter stores actual segment_count and increments lastSeq", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const sessionId = "session-stream-segment-count";
    const record = makeSessionRecord(sessionId, cwd, 7);
    await writeSessionRecord(record);

    const writer = await SessionEventWriter.open(record, {
      maxSegmentBytes: 1,
      maxSegments: 7,
    });

    await writer.appendMessage({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "first" },
        },
      },
    } as never);
    assert.equal(writer.getRecord().eventLog.segment_count, 1);

    await writer.appendMessage({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "second" },
        },
      },
    } as never);
    assert.equal(writer.getRecord().eventLog.segment_count, 2);

    await writer.appendMessage({
      jsonrpc: "2.0",
      id: "req-3",
      result: { stopReason: "end_turn" },
    } as never);
    assert.equal(writer.getRecord().eventLog.segment_count, 3);
    assert.equal(writer.getRecord().lastSeq, 3);
    assert.equal(writer.getRecord().lastRequestId, "req-3");

    await writer.close({ checkpoint: true });

    const stored = await resolveSessionRecord(sessionId);
    assert.equal(stored.eventLog.segment_count, 3);
    assert.equal(stored.eventLog.max_segments, 7);
    assert.equal(stored.lastSeq, 3);
  });
});

test("listSessionEvents skips malformed NDJSON lines", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const sessionId = "session-stream-skip-malformed";
    const record = makeSessionRecord(sessionId, cwd, 5);
    await writeSessionRecord(record);

    await fs.mkdir(path.dirname(record.eventLog.active_path), { recursive: true });
    const validOne = JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "first" },
        },
      },
    });
    const validTwo = JSON.stringify({
      jsonrpc: "2.0",
      id: "req-2",
      result: { stopReason: "end_turn" },
    });
    await fs.writeFile(
      record.eventLog.active_path,
      `${validOne}\n{invalid-json\n${validTwo}\n`,
      "utf8",
    );

    const events = await listSessionEvents(sessionId);
    assert.equal(events.length, 2);
    assert.equal(
      events.every((event) => event.jsonrpc === "2.0"),
      true,
    );
  });
});
