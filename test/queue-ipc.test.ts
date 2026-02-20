import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

type SessionModule = typeof import("../src/session.js");

const SESSION_MODULE_URL = new URL("../src/session.js", import.meta.url);

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
