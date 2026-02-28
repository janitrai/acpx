import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { queuePaths } from "./queue-test-helpers.js";

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));
const MOCK_AGENT_COMMAND = `node ${JSON.stringify(MOCK_AGENT_PATH)}`;

type CliRunResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

function parseJsonRpcOutputLines(stdout: string): Array<Record<string, unknown>> {
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  assert(lines.length > 0, "expected at least one JSON-RPC line");
  return lines.map((line) => {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    assert.equal(parsed.jsonrpc, "2.0");
    return parsed;
  });
}

test("integration: exec echo baseline", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));

    try {
      const result = await runCli([...baseExecArgs(cwd), "echo hello"], homeDir);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /hello/);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: timeout emits structured TIMEOUT json error", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));

    try {
      const result = await runCli(
        [
          ...baseAgentArgs(cwd),
          "--format",
          "json",
          "--timeout",
          "0.05",
          "exec",
          "sleep 500",
        ],
        homeDir,
      );
      assert.equal(result.code, 3, result.stderr);
      const payloads = result.stdout
        .trim()
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map(
          (line) =>
            JSON.parse(line) as {
              jsonrpc?: string;
              error?: { code?: number; data?: { acpxCode?: string } };
            },
        );
      assert(payloads.length > 0, "expected at least one JSON payload");
      const timeoutError = payloads.find(
        (payload) =>
          payload.jsonrpc === "2.0" && payload.error?.data?.acpxCode === "TIMEOUT",
      );
      assert(
        timeoutError,
        `expected timeout error payload in output:\n${result.stdout}`,
      );
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: non-interactive fail emits structured permission error", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const writePath = path.join(cwd, "blocked.txt");

    try {
      const result = await runCli(
        [
          "--agent",
          MOCK_AGENT_COMMAND,
          "--approve-reads",
          "--non-interactive-permissions",
          "fail",
          "--cwd",
          cwd,
          "--format",
          "json",
          "exec",
          `write ${writePath} hello`,
        ],
        homeDir,
      );

      assert.equal(result.code, 5, result.stderr);
      const payloads = result.stdout
        .trim()
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map(
          (line) =>
            JSON.parse(line) as { jsonrpc?: string; error?: { code?: unknown } },
        );
      assert(payloads.length > 0, "expected at least one JSON payload");
      const permissionError = payloads.find(
        (payload) =>
          payload.jsonrpc === "2.0" && typeof payload.error?.code === "number",
      );
      assert(
        permissionError,
        `expected ACP error response in output:\n${result.stdout}`,
      );
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: json-strict suppresses runtime stderr diagnostics", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const writePath = path.join(cwd, "blocked.txt");

    try {
      const result = await runCli(
        [
          "--agent",
          MOCK_AGENT_COMMAND,
          "--approve-reads",
          "--non-interactive-permissions",
          "fail",
          "--cwd",
          cwd,
          "--format",
          "json",
          "--json-strict",
          "exec",
          `write ${writePath} hello`,
        ],
        homeDir,
      );

      assert.equal(result.code, 5);
      assert.equal(result.stderr.trim(), "");

      const payloads = result.stdout
        .trim()
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map(
          (line) =>
            JSON.parse(line) as { jsonrpc?: string; error?: { code?: unknown } },
        );
      assert(payloads.length > 0, "expected at least one JSON payload");
      const permissionError = payloads.find(
        (payload) =>
          payload.jsonrpc === "2.0" && typeof payload.error?.code === "number",
      );
      assert(
        permissionError,
        `expected ACP error response in output:\n${result.stdout}`,
      );
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: json-strict exec success emits JSON-RPC lines only", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));

    try {
      const result = await runCli(
        [
          ...baseAgentArgs(cwd),
          "--format",
          "json",
          "--json-strict",
          "exec",
          "echo strict-success",
        ],
        homeDir,
      );

      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stderr.trim(), "");
      const payloads = parseJsonRpcOutputLines(result.stdout);
      assert(
        payloads.some((payload) => Object.hasOwn(payload, "result")),
        "expected at least one JSON-RPC result payload",
      );
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: fs/read_text_file through mock agent", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const readPath = path.join(cwd, "acpx-test-read.txt");
    await fs.writeFile(readPath, "mock read content", "utf8");

    try {
      const result = await runCli([...baseExecArgs(cwd), `read ${readPath}`], homeDir);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /mock read content/);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: fs/write_text_file through mock agent", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const writePath = path.join(cwd, "acpx-test-write.txt");

    try {
      const result = await runCli(
        [...baseExecArgs(cwd), `write ${writePath} hello`],
        homeDir,
      );
      assert.equal(result.code, 0, result.stderr);
      const content = await fs.readFile(writePath, "utf8");
      assert.equal(content, "hello");
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: fs/read_text_file outside cwd is denied", async () => {
  await withTempHome(async (homeDir) => {
    const result = await runCli(
      [...baseExecArgs("/tmp"), "read /etc/hostname"],
      homeDir,
    );
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout.toLowerCase(), /error:/);
  });
});

test("integration: terminal lifecycle create/output/wait/release", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));

    try {
      const result = await runCli(
        [...baseExecArgs(cwd), "terminal echo hello"],
        homeDir,
      );
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /hello/);
      assert.match(result.stdout, /exit: 0/);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: terminal kill leaves no orphan sleep process", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const before = await listSleep60Pids();

    try {
      const result = await runCli(
        [...baseExecArgs(cwd), "kill-terminal sleep 60"],
        homeDir,
        { timeoutMs: 25_000 },
      );
      assert.equal(result.code, 0, result.stderr);
      await assertNoNewSleep60Processes(before);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: prompt reuses warm queue owner pid across turns", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));

    try {
      const created = await runCli(
        [...baseAgentArgs(cwd), "--format", "json", "sessions", "new"],
        homeDir,
      );
      assert.equal(created.code, 0, created.stderr);
      const createdEvent = JSON.parse(created.stdout.trim()) as {
        acpxRecordId?: string;
      };
      const sessionId = createdEvent.acpxRecordId;
      assert.equal(typeof sessionId, "string");

      const first = await runCli(
        [...baseAgentArgs(cwd), "--format", "quiet", "prompt", "echo first"],
        homeDir,
      );
      assert.equal(first.code, 0, first.stderr);
      assert.ok(
        first.stdout.trim().length > 0,
        "first quiet prompt output should not be empty",
      );

      const { lockPath } = queuePaths(homeDir, sessionId as string);
      const lockOne = JSON.parse(await fs.readFile(lockPath, "utf8")) as {
        pid?: number;
      };
      assert.equal(typeof lockOne.pid, "number");

      const second = await runCli(
        [...baseAgentArgs(cwd), "--format", "quiet", "prompt", "echo second"],
        homeDir,
      );
      assert.equal(second.code, 0, second.stderr);
      assert.ok(
        second.stdout.trim().length > 0,
        "second quiet prompt output should not be empty",
      );

      const lockTwo = JSON.parse(await fs.readFile(lockPath, "utf8")) as {
        pid?: number;
      };
      assert.equal(lockTwo.pid, lockOne.pid);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: prompt recovers when loadSession fails on empty session", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const flakyLoadAgentCommand = `${MOCK_AGENT_COMMAND} --load-session-fails-on-empty`;

    try {
      const created = await runCli(
        [
          "--agent",
          flakyLoadAgentCommand,
          "--approve-all",
          "--cwd",
          cwd,
          "--format",
          "json",
          "sessions",
          "new",
        ],
        homeDir,
      );
      assert.equal(created.code, 0, created.stderr);
      const createdEvent = JSON.parse(created.stdout.trim()) as {
        acpxRecordId?: string;
      };
      const originalSessionId = createdEvent.acpxRecordId;
      assert.equal(typeof originalSessionId, "string");

      const prompt = await runCli(
        [
          "--agent",
          flakyLoadAgentCommand,
          "--approve-all",
          "--cwd",
          cwd,
          "--format",
          "json",
          "prompt",
          "echo recovered",
        ],
        homeDir,
      );
      assert.equal(prompt.code, 0, prompt.stderr);

      const payloads = prompt.stdout
        .trim()
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map(
          (line) =>
            JSON.parse(line) as { jsonrpc?: string; result?: { stopReason?: string } },
        );
      assert.equal(
        payloads.some((payload) => Object.hasOwn(payload, "error")),
        true,
        prompt.stdout,
      );
      assert.equal(
        payloads.some((payload) => payload.result?.stopReason === "end_turn"),
        true,
        prompt.stdout,
      );

      const storedRecordPath = path.join(
        homeDir,
        ".acpx",
        "sessions",
        `${encodeURIComponent(originalSessionId as string)}.json`,
      );
      const storedRecord = JSON.parse(await fs.readFile(storedRecordPath, "utf8")) as {
        acp_session_id?: string;
        messages?: unknown[];
      };

      assert.notEqual(storedRecord.acp_session_id, originalSessionId);
      const messages = Array.isArray(storedRecord.messages)
        ? storedRecord.messages
        : [];
      assert.equal(
        messages.some(
          (message) =>
            typeof message === "object" &&
            message !== null &&
            "Agent" in (message as Record<string, unknown>),
        ),
        true,
      );
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: cancel yields cancelled stopReason without queue error", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));

    try {
      const created = await runCli(
        [...baseAgentArgs(cwd), "--format", "json", "sessions", "new"],
        homeDir,
      );
      assert.equal(created.code, 0, created.stderr);

      const promptChild = spawn(
        process.execPath,
        [CLI_PATH, ...baseAgentArgs(cwd), "--format", "json", "prompt", "sleep 5000"],
        {
          env: {
            ...process.env,
            HOME: homeDir,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      try {
        const doneEventPromise = waitForPromptDoneEvent(promptChild, 20_000, "prompt");

        let cancelled = false;
        for (let attempt = 0; attempt < 80; attempt += 1) {
          const cancelResult = await runCli(
            [...baseAgentArgs(cwd), "--format", "json", "cancel"],
            homeDir,
          );
          assert.equal(cancelResult.code, 0, cancelResult.stderr);

          const payload = JSON.parse(cancelResult.stdout.trim()) as {
            action?: string;
            cancelled?: boolean;
          };
          assert.equal(payload.action, "cancel_result");
          cancelled = payload.cancelled === true;
          if (cancelled) {
            break;
          }

          await sleep(100);
        }

        assert.equal(
          cancelled,
          true,
          "cancel command never reached active queue owner",
        );

        const promptResult = await doneEventPromise;
        assert.equal(
          promptResult.events.some((event) => event.result?.stopReason === "cancelled"),
          true,
          promptResult.stdout,
        );
        assert.equal(
          promptResult.events.some((event) => Object.hasOwn(event, "error")),
          false,
          promptResult.stdout,
        );
      } finally {
        await stopChildProcess(promptChild, 5_000, "prompt");
      }
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: prompt exits after done while detached owner stays warm", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));

    try {
      const created = await runCli(
        [...baseAgentArgs(cwd), "--format", "json", "sessions", "new"],
        homeDir,
      );
      assert.equal(created.code, 0, created.stderr);
      const createdPayload = JSON.parse(created.stdout.trim()) as {
        acpxRecordId?: string;
        acpx_record_id?: string;
        acpSessionId?: string;
        acp_session_id?: string;
        sessionId?: string;
        session_id?: string;
      };
      const sessionId =
        createdPayload.acpxRecordId ??
        createdPayload.acpx_record_id ??
        createdPayload.acpSessionId ??
        createdPayload.acp_session_id ??
        createdPayload.sessionId ??
        createdPayload.session_id;
      if (typeof sessionId !== "string" || sessionId.length === 0) {
        throw new Error(`missing session id in sessions new output: `);
      }

      const firstPromptStartedAt = Date.now();
      const firstPrompt = await runCli(
        [
          ...baseAgentArgs(cwd),
          "--format",
          "quiet",
          "--ttl",
          "3600",
          "prompt",
          "say exactly: warm-owner-ready",
        ],
        homeDir,
      );
      const firstPromptDurationMs = Date.now() - firstPromptStartedAt;
      assert.equal(firstPrompt.code, 0, firstPrompt.stderr);
      assert.match(firstPrompt.stdout, /warm-owner-ready/);
      assert.equal(
        firstPromptDurationMs < 8_000,
        true,
        `expected prompt to return quickly, got ${firstPromptDurationMs}ms`,
      );

      const lock = await readQueueOwnerLock(homeDir, sessionId);
      assert.equal(Number.isInteger(lock.pid) && lock.pid > 0, true);
      assert.equal(isPidAlive(lock.pid), true);

      const secondPrompt = await runCli(
        [
          ...baseAgentArgs(cwd),
          "--format",
          "quiet",
          "prompt",
          "say exactly: second-turn",
        ],
        homeDir,
      );
      assert.equal(secondPrompt.code, 0, secondPrompt.stderr);
      assert.match(secondPrompt.stdout, /second-turn/);

      const closed = await runCli(
        [...baseAgentArgs(cwd), "--format", "json", "sessions", "close"],
        homeDir,
      );
      assert.equal(closed.code, 0, closed.stderr);

      assert.equal(await waitForPidExit(lock.pid, 5_000), true);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

function baseAgentArgs(cwd: string): string[] {
  return ["--agent", MOCK_AGENT_COMMAND, "--approve-all", "--cwd", cwd];
}

function baseExecArgs(cwd: string): string[] {
  return [...baseAgentArgs(cwd), "--format", "quiet", "exec"];
}

async function withTempHome(run: (homeDir: string) => Promise<void>): Promise<void> {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-home-"));
  try {
    await run(tempHome);
  } finally {
    await fs.rm(tempHome, { recursive: true, force: true });
  }
}

type CliRunOptions = {
  timeoutMs?: number;
};

async function runCli(
  args: string[],
  homeDir: string,
  options: CliRunOptions = {},
): Promise<CliRunResult> {
  return await new Promise<CliRunResult>((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env: {
        ...process.env,
        HOME: homeDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const timeoutMs = options.timeoutMs ?? 15_000;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`CLI timed out after ${timeoutMs}ms: acpx ${args.join(" ")}`));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        code,
        signal,
        stdout,
        stderr,
      });
    });
  });
}

type PromptEvent = {
  jsonrpc?: string;
  method?: string;
  params?: unknown;
  result?: {
    stopReason?: string;
  };
  error?: {
    code?: unknown;
    message?: string;
  };
};

type PromptDoneResult = {
  events: PromptEvent[];
  stdout: string;
  stderr: string;
};

async function waitForPromptDoneEvent(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
  label: string,
): Promise<PromptDoneResult> {
  return await new Promise<PromptDoneResult>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let lineBuffer = "";
    const events: PromptEvent[] = [];
    let settled = false;

    const finish = (run: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.stdout?.off("data", onStdoutData);
      child.stderr?.off("data", onStderrData);
      child.off("close", onClose);
      child.off("error", onError);
      run();
    };

    const parseLine = (line: string): void => {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        return;
      }

      let event: PromptEvent;
      try {
        event = JSON.parse(trimmed) as PromptEvent;
      } catch {
        finish(() => {
          reject(
            new Error(
              `${label} emitted invalid JSON line: ${trimmed}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
            ),
          );
        });
        return;
      }

      events.push(event);
      if (event.result?.stopReason) {
        finish(() => {
          resolve({
            events,
            stdout,
            stderr,
          });
        });
      }
    };

    const flushLineBuffer = (): void => {
      const remainder = lineBuffer.trim();
      if (remainder.length > 0) {
        parseLine(remainder);
      }
      lineBuffer = "";
    };

    const onStdoutData = (chunk: string): void => {
      stdout += chunk;
      lineBuffer += chunk;

      for (;;) {
        const newline = lineBuffer.indexOf("\n");
        if (newline < 0) {
          break;
        }
        const line = lineBuffer.slice(0, newline);
        lineBuffer = lineBuffer.slice(newline + 1);
        parseLine(line);
        if (settled) {
          return;
        }
      }
    };

    const onStderrData = (chunk: string): void => {
      stderr += chunk;
    };

    const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
      flushLineBuffer();
      if (settled) {
        return;
      }
      finish(() => {
        reject(
          new Error(
            `${label} exited before done event (code=${code}, signal=${signal})\nstdout:\n${stdout}\nstderr:\n${stderr}`,
          ),
        );
      });
    };

    const onError = (error: Error): void => {
      finish(() => reject(error));
    };

    const timer = setTimeout(() => {
      finish(() => {
        reject(new Error(`${label} process timed out waiting for done event`));
      });
    }, timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", onStdoutData);
    child.stderr?.on("data", onStderrData);
    child.on("close", onClose);
    child.on("error", onError);
  });
}

async function stopChildProcess(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
  label: string,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  child.kill("SIGKILL");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} did not exit after SIGKILL within ${timeoutMs}ms`));
    }, timeoutMs);

    child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function listSleep60Pids(): Promise<Set<number>> {
  const output = await runCommand("ps", ["-eo", "pid=,args="]);
  const pids = new Set<number>();

  for (const line of output.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!match) {
      continue;
    }

    const pid = Number(match[1]);
    const commandLine = match[2].trim();
    if (!Number.isInteger(pid) || pid <= 0) {
      continue;
    }

    if (/(^|\s)sleep 60(\s|$)/.test(commandLine)) {
      pids.add(pid);
    }
  }

  return pids;
}

async function assertNoNewSleep60Processes(
  baseline: Set<number>,
  timeoutMs = 4_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const current = await listSleep60Pids();
    const leaked = [...current].filter((pid) => !baseline.has(pid));
    if (leaked.length === 0) {
      return;
    }

    if (Date.now() >= deadline) {
      for (const pid of leaked) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // best-effort cleanup
        }
      }
      assert.fail(`Found orphan sleep process(es): ${leaked.join(", ")}`);
    }

    await sleep(100);
  }
}

async function runCommand(command: string, args: string[]): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.once("error", (error) => {
      reject(error);
    });

    child.once("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} failed (${code}): ${stderr}`));
    });
  });
}

function queueOwnerLockPath(homeDir: string, sessionId: string): string {
  const queueKey = createHash("sha256").update(sessionId).digest("hex").slice(0, 24);
  return path.join(homeDir, ".acpx", "queues", `${queueKey}.lock`);
}

async function readQueueOwnerLock(
  homeDir: string,
  sessionId: string,
): Promise<{ pid: number }> {
  const lockPath = queueOwnerLockPath(homeDir, sessionId);
  const payload = await fs.readFile(lockPath, "utf8");
  const parsed = JSON.parse(payload) as { pid?: unknown };
  const pid = Number(parsed.pid);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`queue owner lock missing valid pid: ${payload}`);
  }
  return {
    pid,
  };
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) {
      return true;
    }
    await sleep(50);
  }
  return !isPidAlive(pid);
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
