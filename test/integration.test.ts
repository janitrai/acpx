import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));
const MOCK_AGENT_COMMAND = `node ${JSON.stringify(MOCK_AGENT_PATH)}`;

type CliRunResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

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
            JSON.parse(line) as { type?: string; code?: string; stream?: string },
        );
      assert(payloads.length > 0, "expected at least one JSON payload");
      const timeoutError = payloads.find((payload) => payload.type === "error");
      assert(timeoutError, `expected error event in output:\n${result.stdout}`);
      assert.equal(timeoutError.code, "TIMEOUT");
      assert.equal(timeoutError.stream, "control");
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
            JSON.parse(line) as { type?: string; code?: string; stream?: string },
        );
      assert(payloads.length > 0, "expected at least one JSON payload");
      const permissionError = payloads.find((payload) => payload.type === "error");
      assert(permissionError, `expected error event in output:\n${result.stdout}`);
      assert.equal(permissionError.code, "PERMISSION_PROMPT_UNAVAILABLE");
      assert.equal(permissionError.stream, "control");
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
            cancelled: boolean;
          };
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
          promptResult.events.some(
            (event) => event.type === "done" && event.stopReason === "cancelled",
          ),
          true,
          promptResult.stdout,
        );
        assert.equal(
          promptResult.events.some((event) => event.type === "error"),
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
  type?: string;
  stopReason?: string;
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
      if (event.type === "done") {
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

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
