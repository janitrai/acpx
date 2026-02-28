import fs from "node:fs/promises";
import { isAcpJsonRpcMessage } from "./acp-jsonrpc.js";
import {
  DEFAULT_EVENT_MAX_SEGMENTS,
  DEFAULT_EVENT_SEGMENT_MAX_BYTES,
  sessionBaseDir,
  sessionEventActivePath as activeEventPath,
  sessionEventLockPath as eventsLockPath,
  sessionEventSegmentPath as segmentEventPath,
} from "./session-event-log.js";
import { resolveSessionRecord, writeSessionRecord } from "./session-persistence.js";
import type { AcpJsonRpcMessage, SessionRecord } from "./types.js";

const LOCK_RETRY_MS = 15;

async function ensureSessionDir(): Promise<void> {
  await fs.mkdir(sessionBaseDir(), { recursive: true });
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function statSize(filePath: string): Promise<number> {
  try {
    const stats = await fs.stat(filePath);
    return stats.size;
  } catch {
    return 0;
  }
}

async function countExistingSegments(
  sessionId: string,
  maxSegments: number,
): Promise<number> {
  let count = 0;

  for (let segment = 1; segment <= maxSegments; segment += 1) {
    if (await pathExists(segmentEventPath(sessionId, segment))) {
      count += 1;
    }
  }

  if (await pathExists(activeEventPath(sessionId))) {
    count += 1;
  }

  return count;
}

async function resolveSessionMaxSegments(sessionId: string): Promise<number> {
  try {
    const record = await resolveSessionRecord(sessionId);
    const configured = record.eventLog.max_segments;
    if (Number.isInteger(configured) && configured > 0) {
      return configured;
    }
  } catch {
    // Fall back to defaults when metadata is unavailable.
  }

  return DEFAULT_EVENT_MAX_SEGMENTS;
}

async function rotateSegments(sessionId: string, maxSegments: number): Promise<void> {
  const active = activeEventPath(sessionId);

  const overflow = segmentEventPath(sessionId, maxSegments);
  await fs.unlink(overflow).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  });

  for (let segment = maxSegments - 1; segment >= 1; segment -= 1) {
    const from = segmentEventPath(sessionId, segment);
    const to = segmentEventPath(sessionId, segment + 1);
    if (!(await pathExists(from))) {
      continue;
    }
    await fs.rename(from, to);
  }

  if (await pathExists(active)) {
    await fs.rename(active, segmentEventPath(sessionId, 1));
  }
}

type LockHandle = {
  filePath: string;
};

async function acquireEventsLock(sessionId: string): Promise<LockHandle> {
  await ensureSessionDir();
  const lockPath = eventsLockPath(sessionId);
  const payload = JSON.stringify(
    {
      pid: process.pid,
      created_at: new Date().toISOString(),
    },
    null,
    2,
  );

  for (;;) {
    try {
      await fs.writeFile(lockPath, `${payload}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
      return { filePath: lockPath };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        throw error;
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, LOCK_RETRY_MS);
      });
    }
  }
}

async function releaseEventsLock(lock: LockHandle): Promise<void> {
  await fs.unlink(lock.filePath).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  });
}

type SessionEventWriterOptions = {
  maxSegmentBytes?: number;
  maxSegments?: number;
};

type AppendOptions = {
  checkpoint?: boolean;
};

export class SessionEventWriter {
  private readonly record: SessionRecord;
  private readonly lock: LockHandle;
  private readonly maxSegmentBytes: number;
  private readonly maxSegments: number;
  private closed = false;

  private constructor(
    record: SessionRecord,
    lock: LockHandle,
    options: Required<SessionEventWriterOptions>,
  ) {
    this.record = record;
    this.lock = lock;
    this.maxSegmentBytes = options.maxSegmentBytes;
    this.maxSegments = options.maxSegments;
  }

  static async open(
    record: SessionRecord,
    options: SessionEventWriterOptions = {},
  ): Promise<SessionEventWriter> {
    const lock = await acquireEventsLock(record.acpxRecordId);
    return new SessionEventWriter(record, lock, {
      maxSegmentBytes:
        options.maxSegmentBytes ??
        record.eventLog.max_segment_bytes ??
        DEFAULT_EVENT_SEGMENT_MAX_BYTES,
      maxSegments:
        options.maxSegments ??
        record.eventLog.max_segments ??
        DEFAULT_EVENT_MAX_SEGMENTS,
    });
  }

  getRecord(): SessionRecord {
    return this.record;
  }

  async appendMessage(
    message: AcpJsonRpcMessage,
    options: AppendOptions = {},
  ): Promise<void> {
    await this.appendMessages([message], options);
  }

  async appendMessages(
    messages: AcpJsonRpcMessage[],
    options: AppendOptions = {},
  ): Promise<void> {
    if (this.closed) {
      throw new Error("SessionEventWriter is closed");
    }

    if (messages.length === 0) {
      return;
    }

    await ensureSessionDir();
    let activePath = activeEventPath(this.record.acpxRecordId);

    for (const message of messages) {
      if (!isAcpJsonRpcMessage(message)) {
        throw new Error("Attempted to persist invalid ACP JSON-RPC payload");
      }

      const line = `${JSON.stringify(message)}\n`;
      const lineBytes = Buffer.byteLength(line);
      const currentSize = await statSize(activePath);
      if (currentSize > 0 && currentSize + lineBytes > this.maxSegmentBytes) {
        await rotateSegments(this.record.acpxRecordId, this.maxSegments);
        activePath = activeEventPath(this.record.acpxRecordId);
      }

      await fs.appendFile(activePath, line, "utf8");

      this.record.lastSeq += 1;
      if (Object.hasOwn(message, "id")) {
        const id = (message as { id?: unknown }).id;
        if (typeof id === "string" || typeof id === "number") {
          this.record.lastRequestId = String(id);
        }
      }
      const writeTs = new Date().toISOString();
      this.record.lastUsedAt = writeTs;
      this.record.eventLog = {
        active_path: activePath,
        segment_count: await countExistingSegments(
          this.record.acpxRecordId,
          this.maxSegments,
        ),
        max_segment_bytes: this.maxSegmentBytes,
        max_segments: this.maxSegments,
        last_write_at: writeTs,
        last_write_error: null,
      };
    }

    if (options.checkpoint === true) {
      await writeSessionRecord(this.record);
    }
  }

  async checkpoint(): Promise<void> {
    if (this.closed) {
      throw new Error("SessionEventWriter is closed");
    }
    await writeSessionRecord(this.record);
  }

  async close(options: AppendOptions = {}): Promise<void> {
    if (this.closed) {
      return;
    }

    try {
      if (options.checkpoint !== false) {
        await writeSessionRecord(this.record);
      }
    } finally {
      this.closed = true;
      await releaseEventsLock(this.lock);
    }
  }
}

export async function listSessionEvents(
  sessionId: string,
): Promise<AcpJsonRpcMessage[]> {
  const maxSegments = await resolveSessionMaxSegments(sessionId);
  const files: string[] = [];

  for (let segment = maxSegments; segment >= 1; segment -= 1) {
    const filePath = segmentEventPath(sessionId, segment);
    if (await pathExists(filePath)) {
      files.push(filePath);
    }
  }

  const active = activeEventPath(sessionId);
  if (await pathExists(active)) {
    files.push(active);
  }

  const events: AcpJsonRpcMessage[] = [];
  for (const filePath of files) {
    const payload = await fs.readFile(filePath, "utf8");
    const lines = payload.split("\n").filter((line) => line.trim().length > 0);
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (isAcpJsonRpcMessage(parsed)) {
          events.push(parsed);
        }
      } catch {
        // Skip malformed lines to keep event listing resilient.
      }
    }
  }

  return events;
}
