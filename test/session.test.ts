import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
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

test("listSessions preserves stored turn history and lifecycle metadata", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();
    const cwd = path.join(homeDir, "workspace");

    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        id: "history-meta",
        sessionId: "history-meta",
        agentCommand: "agent-a",
        cwd,
        pid: 12345,
        agentStartedAt: "2026-01-01T00:00:00.000Z",
        lastPromptAt: "2026-01-01T00:01:00.000Z",
        lastAgentExitCode: null,
        lastAgentExitSignal: "SIGTERM",
        lastAgentExitAt: "2026-01-01T00:02:00.000Z",
        lastAgentDisconnectReason: "process_exit",
        turnHistory: [
          {
            role: "user",
            timestamp: "2026-01-01T00:01:00.000Z",
            textPreview: "hello",
          },
          {
            role: "assistant",
            timestamp: "2026-01-01T00:01:30.000Z",
            textPreview: "world",
          },
        ],
      }),
    );

    const sessions = await session.listSessions();
    const record = sessions.find((entry) => entry.id === "history-meta");
    assert.ok(record);
    assert.equal(record.agentStartedAt, "2026-01-01T00:00:00.000Z");
    assert.equal(record.lastPromptAt, "2026-01-01T00:01:00.000Z");
    assert.equal(record.lastAgentExitCode, null);
    assert.equal(record.lastAgentExitSignal, "SIGTERM");
    assert.equal(record.lastAgentExitAt, "2026-01-01T00:02:00.000Z");
    assert.equal(record.lastAgentDisconnectReason, "process_exit");
    assert.deepEqual(
      record.turnHistory?.map((entry) => entry.textPreview),
      ["hello", "world"],
    );
  });
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

test("findSessionByDirectoryWalk returns the nearest active session within git root boundary", async () => {
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
    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        id: "session-home",
        sessionId: "session-home",
        agentCommand: "agent-a",
        cwd: homeDir,
      }),
    );

    const boundary = session.findGitRepositoryRoot(nestedDir);
    assert.equal(boundary, repoRoot);

    const found = await session.findSessionByDirectoryWalk({
      agentCommand: "agent-a",
      cwd: nestedDir,
      boundary,
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

    await fs.mkdir(path.join(repoRoot, ".git"), { recursive: true });
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

    const boundary = session.findGitRepositoryRoot(nestedDir);
    assert.equal(boundary, repoRoot);

    const foundDefault = await session.findSessionByDirectoryWalk({
      agentCommand: "agent-a",
      cwd: nestedDir,
      boundary,
    });
    const foundNamed = await session.findSessionByDirectoryWalk({
      agentCommand: "agent-a",
      cwd: nestedDir,
      name: "frontend",
      boundary,
    });

    assert.equal(foundDefault?.id, "session-default");
    assert.equal(foundNamed?.id, "session-named");
  });
});

test("findSessionByDirectoryWalk falls back to exact cwd matching when no git root exists", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();

    const parentDir = path.join(homeDir, "outside-git");
    const nestedDir = path.join(parentDir, "project");

    await fs.mkdir(nestedDir, { recursive: true });

    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        id: "session-parent",
        sessionId: "session-parent",
        agentCommand: "agent-a",
        cwd: parentDir,
      }),
    );

    const gitRoot = session.findGitRepositoryRoot(nestedDir);
    assert.equal(gitRoot, undefined);

    const missed = await session.findSessionByDirectoryWalk({
      agentCommand: "agent-a",
      cwd: nestedDir,
      boundary: gitRoot ?? nestedDir,
    });
    assert.equal(missed, undefined);

    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        id: "session-nested",
        sessionId: "session-nested",
        agentCommand: "agent-a",
        cwd: nestedDir,
      }),
    );

    const found = await session.findSessionByDirectoryWalk({
      agentCommand: "agent-a",
      cwd: nestedDir,
      boundary: gitRoot ?? nestedDir,
    });
    assert.equal(found?.id, "session-nested");
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

test("cancelSessionPrompt sends cancel request to active queue owner", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();
    const sessionId = "cancel-session";
    const keeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
      stdio: "ignore",
    });
    await once(keeper, "spawn");
    const queueDir = path.join(homeDir, ".acpx", "queues");
    await fs.mkdir(queueDir, { recursive: true });

    const queueKey = createHash("sha256").update(sessionId).digest("hex").slice(0, 24);
    const socketPath =
      process.platform === "win32"
        ? `\\\\.\\pipe\\acpx-${queueKey}`
        : path.join(queueDir, `${queueKey}.sock`);
    const lockPath = path.join(queueDir, `${queueKey}.lock`);

    await fs.writeFile(
      lockPath,
      `${JSON.stringify({
        pid: keeper.pid,
        sessionId,
        socketPath,
      })}\n`,
      "utf8",
    );

    const server = net.createServer((socket) => {
      socket.setEncoding("utf8");
      let buffer = "";
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex < 0) {
          return;
        }
        const line = buffer.slice(0, newlineIndex).trim();
        if (!line) {
          return;
        }

        const request = JSON.parse(line) as { requestId: string; type: string };
        assert.equal(request.type, "cancel_prompt");
        socket.write(
          `${JSON.stringify({
            type: "accepted",
            requestId: request.requestId,
          })}\n`,
        );
        socket.write(
          `${JSON.stringify({
            type: "cancel_result",
            requestId: request.requestId,
            cancelled: true,
          })}\n`,
        );
        socket.end();
      });
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        reject(error);
      };
      server.once("error", onError);
      server.listen(socketPath, () => {
        server.off("error", onError);
        resolve();
      });
    });

    try {
      const result = await session.cancelSessionPrompt({ sessionId });
      assert.equal(result.cancelled, true);
      assert.equal(result.sessionId, sessionId);
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      if (process.platform !== "win32") {
        await fs.rm(socketPath, { force: true });
      }
      if (keeper.pid && keeper.exitCode == null && keeper.signalCode == null) {
        keeper.kill("SIGKILL");
      }
    }
  });
});

test("QueueOwnerCancelCoordinator cancels immediately for active prompts", async () => {
  await withTempHome(async () => {
    const session = await loadSessionModule();
    const coordinator = new session.QueueOwnerCancelCoordinator();
    let cancelCalls = 0;

    coordinator.beginTurn();
    const cancelled = await coordinator.requestCancel({
      hasActivePrompt: () => true,
      requestCancelActivePrompt: async () => {
        cancelCalls += 1;
        return true;
      },
    });

    assert.equal(cancelled, true);
    assert.equal(cancelCalls, 1);
    assert.equal(coordinator.hasPendingCancel, false);
    coordinator.endTurn();
  });
});

test("QueueOwnerCancelCoordinator defers cancel while turn is starting", async () => {
  await withTempHome(async () => {
    const session = await loadSessionModule();
    const coordinator = new session.QueueOwnerCancelCoordinator();
    let promptActive = false;
    let cancelCalls = 0;

    const controller = {
      hasActivePrompt: () => promptActive,
      requestCancelActivePrompt: async () => {
        cancelCalls += 1;
        return promptActive;
      },
    };

    coordinator.beginTurn();
    const accepted = await coordinator.requestCancel(controller);
    assert.equal(accepted, true);
    assert.equal(cancelCalls, 0);
    assert.equal(coordinator.hasPendingCancel, true);

    const beforeActive = await coordinator.applyPendingCancel(controller);
    assert.equal(beforeActive, false);
    assert.equal(cancelCalls, 0);
    assert.equal(coordinator.hasPendingCancel, true);

    promptActive = true;
    const afterActive = await coordinator.applyPendingCancel(controller);
    assert.equal(afterActive, true);
    assert.equal(cancelCalls, 1);
    assert.equal(coordinator.hasPendingCancel, false);
    coordinator.endTurn();
  });
});

test("QueueOwnerCancelCoordinator returns false when idle", async () => {
  await withTempHome(async () => {
    const session = await loadSessionModule();
    const coordinator = new session.QueueOwnerCancelCoordinator();
    const cancelled = await coordinator.requestCancel(undefined);
    assert.equal(cancelled, false);
    assert.equal(coordinator.hasPendingCancel, false);
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
    agentStartedAt: overrides.agentStartedAt,
    lastPromptAt: overrides.lastPromptAt,
    lastAgentExitCode: overrides.lastAgentExitCode,
    lastAgentExitSignal: overrides.lastAgentExitSignal,
    lastAgentExitAt: overrides.lastAgentExitAt,
    lastAgentDisconnectReason: overrides.lastAgentDisconnectReason,
    turnHistory: overrides.turnHistory,
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
