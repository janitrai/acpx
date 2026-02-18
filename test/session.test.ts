import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { SessionRecord } from "../src/types.js";

type SessionModule = typeof import("../src/session.js");

const SESSION_MODULE_URL = new URL("../src/session.js", import.meta.url);

test("SessionRecord allows optional closed and closedAt fields", () => {
  const record: SessionRecord = {
    id: "type-check",
    sessionId: "type-check",
    agentCommand: "agent",
    cwd: "/tmp/type-check",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastUsedAt: "2026-01-01T00:00:00.000Z",
  };

  assert.equal(record.closed, undefined);
  assert.equal(record.closedAt, undefined);
});

test("findSession matches by agent/cwd and by agent/cwd/name", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();
    const cwd = path.join(homeDir, "workspace");

    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        id: "session-default",
        sessionId: "session-default",
        agentCommand: "agent-a",
        cwd,
        name: undefined,
      }),
    );
    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        id: "session-named",
        sessionId: "session-named",
        agentCommand: "agent-a",
        cwd,
        name: "backend",
      }),
    );

    const foundDefault = await session.findSession({
      agentCommand: "agent-a",
      cwd,
    });
    const foundNamed = await session.findSession({
      agentCommand: "agent-a",
      cwd,
      name: "backend",
    });

    assert.equal(foundDefault?.id, "session-default");
    assert.equal(foundNamed?.id, "session-named");
  });
});

test("findSession skips closed sessions by default and includes them when requested", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();
    const cwd = path.join(homeDir, "workspace");

    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        id: "closed-session",
        sessionId: "closed-session",
        agentCommand: "agent-a",
        cwd,
        closed: true,
        closedAt: "2026-01-01T00:01:00.000Z",
      }),
    );

    const skipped = await session.findSession({
      agentCommand: "agent-a",
      cwd,
    });
    const included = await session.findSession({
      agentCommand: "agent-a",
      cwd,
      includeClosed: true,
    });

    assert.equal(skipped, undefined);
    assert.equal(included?.id, "closed-session");
  });
});

test("findSessionByDirectoryWalk returns the nearest active session by walking up directories", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();

    const repoRoot = path.join(homeDir, "repo");
    const packagesDir = path.join(repoRoot, "packages");
    const nestedDir = path.join(packagesDir, "app");

    await fs.mkdir(nestedDir, { recursive: true });

    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        id: "session-root",
        sessionId: "session-root",
        agentCommand: "agent-a",
        cwd: repoRoot,
      }),
    );
    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        id: "session-packages",
        sessionId: "session-packages",
        agentCommand: "agent-a",
        cwd: packagesDir,
      }),
    );

    const found = await session.findSessionByDirectoryWalk({
      agentCommand: "agent-a",
      cwd: nestedDir,
    });

    assert.equal(found?.id, "session-packages");
  });
});

test("findSessionByDirectoryWalk matches named sessions and skips closed sessions", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();

    const repoRoot = path.join(homeDir, "repo");
    const packagesDir = path.join(repoRoot, "packages");
    const nestedDir = path.join(packagesDir, "app");

    await fs.mkdir(nestedDir, { recursive: true });

    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        id: "session-closed",
        sessionId: "session-closed",
        agentCommand: "agent-a",
        cwd: packagesDir,
        closed: true,
        closedAt: "2026-01-01T00:01:00.000Z",
      }),
    );
    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        id: "session-default",
        sessionId: "session-default",
        agentCommand: "agent-a",
        cwd: repoRoot,
      }),
    );
    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        id: "session-named",
        sessionId: "session-named",
        agentCommand: "agent-a",
        cwd: repoRoot,
        name: "frontend",
      }),
    );

    const foundDefault = await session.findSessionByDirectoryWalk({
      agentCommand: "agent-a",
      cwd: nestedDir,
    });
    const foundNamed = await session.findSessionByDirectoryWalk({
      agentCommand: "agent-a",
      cwd: nestedDir,
      name: "frontend",
    });

    assert.equal(foundDefault?.id, "session-default");
    assert.equal(foundNamed?.id, "session-named");
  });
});

test("listSessionsForAgent returns every session for the agent command", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();

    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        id: "agent-a-1",
        sessionId: "agent-a-1",
        agentCommand: "agent-a",
      }),
    );
    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        id: "agent-a-2",
        sessionId: "agent-a-2",
        agentCommand: "agent-a",
        closed: true,
        closedAt: "2026-01-01T00:01:00.000Z",
      }),
    );
    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        id: "agent-b-1",
        sessionId: "agent-b-1",
        agentCommand: "agent-b",
      }),
    );

    const sessions = await session.listSessionsForAgent("agent-a");
    assert.deepEqual(
      new Set(sessions.map((record) => record.id)),
      new Set(["agent-a-1", "agent-a-2"]),
    );
  });
});

test("closeSession soft-closes, keeps file on disk, and terminates matching process", async () => {
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
        id: sessionId,
        sessionId,
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

      const stored = JSON.parse(await fs.readFile(filePath, "utf8")) as SessionRecord;
      assert.equal(stored.closed, true);
      assert.equal(typeof stored.closedAt, "string");

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
    assert.equal(
      session.normalizeQueueOwnerTtlMs(0),
      0, // 0 means keep alive forever
    );
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

function makeSessionRecord(overrides: Partial<SessionRecord>): SessionRecord {
  const timestamp = "2026-01-01T00:00:00.000Z";
  return {
    id: overrides.id ?? "session-id",
    sessionId: overrides.sessionId ?? overrides.id ?? "session-id",
    agentCommand: overrides.agentCommand ?? "agent-command",
    cwd: path.resolve(overrides.cwd ?? "/tmp/acpx"),
    name: overrides.name,
    createdAt: overrides.createdAt ?? timestamp,
    lastUsedAt: overrides.lastUsedAt ?? timestamp,
    closed: overrides.closed ?? false,
    closedAt: overrides.closedAt,
    pid: overrides.pid,
  };
}

function sessionFilePath(homeDir: string, sessionId: string): string {
  return path.join(
    homeDir,
    ".acpx",
    "sessions",
    `${encodeURIComponent(sessionId)}.json`,
  );
}

async function writeSessionRecord(
  homeDir: string,
  record: SessionRecord,
): Promise<void> {
  const filePath = sessionFilePath(homeDir, record.id);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
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
