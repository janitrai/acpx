import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import { probeQueueOwnerHealth } from "../src/queue-ipc.js";
import {
  cleanupOwnerArtifacts,
  closeServer,
  listenServer,
  queuePaths,
  startKeeperProcess,
  stopProcess,
  withTempHome,
  writeQueueOwnerLock,
} from "./queue-test-helpers.js";

test("probeQueueOwnerHealth reports healthy when socket is reachable despite stale pid", async () => {
  await withTempHome(async (homeDir) => {
    const sessionId = "probe-stale-pid-healthy-socket";
    const { lockPath, socketPath } = queuePaths(homeDir, sessionId);

    await writeQueueOwnerLock({
      lockPath,
      pid: 999_999,
      sessionId,
      socketPath,
    });

    const server = net.createServer((socket) => {
      socket.end();
    });

    await listenServer(server, socketPath);

    try {
      const health = await probeQueueOwnerHealth(sessionId);
      assert.equal(health.hasLease, true);
      assert.equal(health.healthy, true);
      assert.equal(health.socketReachable, true);
      assert.equal(health.pidAlive, false);
    } finally {
      await closeServer(server);
      await cleanupOwnerArtifacts({ socketPath, lockPath });
    }
  });
});

test("probeQueueOwnerHealth reports unavailable socket when pid is alive", async () => {
  await withTempHome(async (homeDir) => {
    const sessionId = "probe-live-pid-missing-socket";
    const { lockPath, socketPath } = queuePaths(homeDir, sessionId);
    const keeper = await startKeeperProcess();

    try {
      await writeQueueOwnerLock({
        lockPath,
        pid: keeper.pid,
        sessionId,
        socketPath,
      });

      const health = await probeQueueOwnerHealth(sessionId);
      assert.equal(health.hasLease, true);
      assert.equal(health.healthy, false);
      assert.equal(health.socketReachable, false);
      assert.equal(health.pidAlive, true);
    } finally {
      await cleanupOwnerArtifacts({ socketPath, lockPath });
      stopProcess(keeper);
    }
  });
});

test("probeQueueOwnerHealth clears stale dead owner lock", async () => {
  await withTempHome(async (homeDir) => {
    const sessionId = "probe-dead-owner-cleanup";
    const { lockPath, socketPath } = queuePaths(homeDir, sessionId);

    await writeQueueOwnerLock({
      lockPath,
      pid: 999_999,
      sessionId,
      socketPath,
    });

    const health = await probeQueueOwnerHealth(sessionId);
    assert.equal(health.hasLease, false);
    assert.equal(health.healthy, false);
  });
});
