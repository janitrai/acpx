import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { serializeSessionRecordForDisk } from "../src/session-persistence.js";
import type { SessionRecord } from "../src/types.js";

type SessionModule = typeof import("../src/session.js");

const SESSION_MODULE_URL = new URL("../src/session.js", import.meta.url);

test("SessionRecord allows optional closed and closedAt fields", () => {
  const record = makeSessionRecord({
    acpxRecordId: "type-check",
    acpSessionId: "type-check",
    agentCommand: "agent",
    cwd: "/tmp/type-check",
  });

  assert.equal(record.closed, false);
  assert.equal(record.closedAt, undefined);
});

test("listSessions ignores unsupported conversation message shapes", async () => {
  await withTempHome(async (homeDir) => {
    const sessionDir = path.join(homeDir, ".acpx", "sessions");
    await fs.mkdir(sessionDir, { recursive: true });

    const malformed = makeSessionRecord({
      acpxRecordId: "malformed-shape",
      acpSessionId: "malformed-shape",
      agentCommand: "agent",
      cwd: path.join(homeDir, "workspace"),
    });

    (malformed as unknown as Record<string, unknown>).messages = [
      {
        kind: "user",
        id: "user_1",
        content: [{ type: "text", text: "invalid" }],
      },
    ];

    await fs.writeFile(
      path.join(sessionDir, "malformed-shape.json"),
      JSON.stringify(serializeSessionRecordForDisk(malformed), null, 2) + "\n",
      "utf8",
    );

    const session = await loadSessionModule();
    const sessions = await session.listSessions();
    assert.equal(
      sessions.some((entry) => entry.acpxRecordId === "malformed-shape"),
      false,
    );
  });
});

test("listSessions preserves lifecycle and conversation metadata", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();
    const cwd = path.join(homeDir, "workspace");

    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "session-a",
        acpSessionId: "session-a",
        agentCommand: "agent-a",
        cwd,
        pid: 12345,
        agentStartedAt: "2026-01-01T00:00:00.000Z",
        lastPromptAt: "2026-01-01T00:01:00.000Z",
        lastAgentExitCode: null,
        lastAgentExitSignal: "SIGTERM",
        lastAgentExitAt: "2026-01-01T00:02:00.000Z",
        lastAgentDisconnectReason: "process_exit",
        title: "My Thread",
        messages: [
          {
            User: {
              id: "7c7615ad-5ba0-4cd3-a5f7-6ad9346dcfd5",
              content: [{ Text: "hello" }],
            },
          },
          {
            Agent: {
              content: [{ Text: "world" }],
              tool_results: {},
            },
          },
        ],
        updated_at: "2026-01-01T00:02:00.000Z",
        cumulative_token_usage: {},
        request_token_usage: {},
      }),
    );

    const sessions = await session.listSessions();
    const record = sessions.find((entry) => entry.acpxRecordId === "session-a");
    assert.ok(record);
    assert.equal(record.agentStartedAt, "2026-01-01T00:00:00.000Z");
    assert.equal(record.lastPromptAt, "2026-01-01T00:01:00.000Z");
    assert.equal(record.lastAgentExitCode, null);
    assert.equal(record.lastAgentExitSignal, "SIGTERM");
    assert.equal(record.lastAgentExitAt, "2026-01-01T00:02:00.000Z");
    assert.equal(record.lastAgentDisconnectReason, "process_exit");
    assert.equal(record.messages.length, 2);
    assert.equal(record.title, "My Thread");
  });
});

test("listSessions preserves optional agentSessionId", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();
    const cwd = path.join(homeDir, "workspace");

    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "session-runtime",
        acpSessionId: "session-runtime",
        agentSessionId: "provider-runtime-123",
        agentCommand: "agent-a",
        cwd,
      }),
    );

    const sessions = await session.listSessions();
    const record = sessions.find((entry) => entry.acpxRecordId === "session-runtime");
    assert.ok(record);
    assert.equal(record.agentSessionId, "provider-runtime-123");
  });
});

test("findSession and findSessionByDirectoryWalk resolve expected records", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();

    const repoRoot = path.join(homeDir, "repo");
    const packagesDir = path.join(repoRoot, "packages");
    const nestedDir = path.join(packagesDir, "app");

    await fs.mkdir(path.join(repoRoot, ".git"), { recursive: true });
    await fs.mkdir(nestedDir, { recursive: true });

    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "session-root",
        acpSessionId: "session-root",
        agentCommand: "agent-a",
        cwd: repoRoot,
      }),
    );
    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "session-packages",
        acpSessionId: "session-packages",
        agentCommand: "agent-a",
        cwd: packagesDir,
      }),
    );

    const foundDefault = await session.findSession({
      agentCommand: "agent-a",
      cwd: packagesDir,
    });
    assert.equal(foundDefault?.acpxRecordId, "session-packages");

    const boundary = session.findGitRepositoryRoot(nestedDir);
    const walked = await session.findSessionByDirectoryWalk({
      agentCommand: "agent-a",
      cwd: nestedDir,
      boundary,
    });
    assert.equal(walked?.acpxRecordId, "session-packages");
  });
});

test("closeSession soft-closes and terminates matching process", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();

    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
      stdio: "ignore",
    });
    await once(child, "spawn");

    const sessionId = "live-session";
    const cwd = path.join(homeDir, "repo");
    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: sessionId,
        acpSessionId: sessionId,
        agentCommand: process.execPath,
        cwd,
        pid: child.pid,
      }),
    );

    const filePath = sessionFilePath(homeDir, sessionId);

    try {
      const closed = await session.closeSession(sessionId);
      assert.equal(closed.closed, true);
      assert.equal(typeof closed.closedAt, "string");
      assert.equal(closed.pid, undefined);
      assert.equal(await fileExists(filePath), true);

      const stored = JSON.parse(await fs.readFile(filePath, "utf8")) as Record<
        string,
        unknown
      >;
      assert.equal(stored.closed, true);
      assert.equal(typeof stored.closed_at, "string");

      const exited = await waitForExit(child.pid);
      assert.equal(exited, true);
    } finally {
      if (child.exitCode == null && child.signalCode == null) {
        child.kill("SIGKILL");
      }
    }
  });
});

test("normalizeQueueOwnerTtlMs applies default and edge-case normalization", async () => {
  await withTempHome(async () => {
    const session = await loadSessionModule();
    assert.equal(
      session.normalizeQueueOwnerTtlMs(undefined),
      session.DEFAULT_QUEUE_OWNER_TTL_MS,
    );
    assert.equal(session.normalizeQueueOwnerTtlMs(0), 0);
    assert.equal(
      session.normalizeQueueOwnerTtlMs(-1),
      session.DEFAULT_QUEUE_OWNER_TTL_MS,
    );
    assert.equal(
      session.normalizeQueueOwnerTtlMs(Number.NaN),
      session.DEFAULT_QUEUE_OWNER_TTL_MS,
    );
    assert.equal(
      session.normalizeQueueOwnerTtlMs(Number.POSITIVE_INFINITY),
      session.DEFAULT_QUEUE_OWNER_TTL_MS,
    );
    assert.equal(
      session.normalizeQueueOwnerTtlMs(Number.NEGATIVE_INFINITY),
      session.DEFAULT_QUEUE_OWNER_TTL_MS,
    );
    assert.equal(session.normalizeQueueOwnerTtlMs(1.6), 2);
    assert.equal(session.normalizeQueueOwnerTtlMs(15_000), 15_000);
  });
});

async function loadSessionModule(): Promise<SessionModule> {
  const cacheBuster = `${Date.now()}-${Math.random()}`;
  return (await import(
    `${SESSION_MODULE_URL.href}?session_test=${cacheBuster}`
  )) as SessionModule;
}

async function withTempHome(run: (homeDir: string) => Promise<void>): Promise<void> {
  const originalHome = process.env.HOME;
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-test-home-"));
  process.env.HOME = tempHome;

  try {
    await run(tempHome);
  } finally {
    if (originalHome == null) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    await fs.rm(tempHome, { recursive: true, force: true });
  }
}

function makeSessionRecord(
  overrides: Partial<SessionRecord> & {
    acpxRecordId: string;
    acpSessionId: string;
    agentCommand: string;
    cwd: string;
  },
): SessionRecord {
  const timestamp = "2026-01-01T00:00:00.000Z";
  return {
    schema: "acpx.session.v1",
    acpxRecordId: overrides.acpxRecordId,
    acpSessionId: overrides.acpSessionId,
    agentSessionId: overrides.agentSessionId,
    agentCommand: overrides.agentCommand,
    cwd: path.resolve(overrides.cwd),
    name: overrides.name,
    createdAt: overrides.createdAt ?? timestamp,
    lastUsedAt: overrides.lastUsedAt ?? timestamp,
    lastSeq: overrides.lastSeq ?? 0,
    lastRequestId: overrides.lastRequestId,
    eventLog: overrides.eventLog ?? {
      active_path: `.stream.ndjson`,
      segment_count: 1,
      max_segment_bytes: 1024,
      max_segments: 1,
      last_write_at: overrides.lastUsedAt ?? timestamp,
      last_write_error: null,
    },
    closed: overrides.closed ?? false,
    closedAt: overrides.closedAt,
    pid: overrides.pid,
    agentStartedAt: overrides.agentStartedAt,
    lastPromptAt: overrides.lastPromptAt,
    lastAgentExitCode: overrides.lastAgentExitCode,
    lastAgentExitSignal: overrides.lastAgentExitSignal,
    lastAgentExitAt: overrides.lastAgentExitAt,
    lastAgentDisconnectReason: overrides.lastAgentDisconnectReason,
    protocolVersion: overrides.protocolVersion,
    agentCapabilities: overrides.agentCapabilities,
    title: overrides.title ?? null,
    messages: overrides.messages ?? [],
    updated_at: overrides.updated_at ?? overrides.lastUsedAt ?? timestamp,
    cumulative_token_usage: overrides.cumulative_token_usage ?? {},
    request_token_usage: overrides.request_token_usage ?? {},
    acpx: overrides.acpx,
  };
}

function sessionFilePath(homeDir: string, acpxRecordId: string): string {
  return path.join(
    homeDir,
    ".acpx",
    "sessions",
    `${encodeURIComponent(acpxRecordId)}.json`,
  );
}

async function writeSessionRecord(
  homeDir: string,
  record: SessionRecord,
): Promise<void> {
  const filePath = sessionFilePath(homeDir, record.acpxRecordId);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    `${JSON.stringify(serializeSessionRecordForDisk(record), null, 2)}\n`,
    "utf8",
  );
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid: number | undefined): Promise<boolean> {
  if (pid == null) {
    return true;
  }

  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
  }

  return false;
}
