import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { InvalidArgumentError } from "commander";
import { formatPromptSessionBannerLine, parseTtlSeconds } from "../src/cli.js";
import type { SessionRecord } from "../src/types.js";

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));

type CliRunResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

test("parseTtlSeconds parses and rounds valid numeric values", () => {
  assert.equal(parseTtlSeconds("30"), 30_000);
  assert.equal(parseTtlSeconds("0"), 0);
  assert.equal(parseTtlSeconds("1.49"), 1_490);
});

test("parseTtlSeconds rejects non-numeric values", () => {
  assert.throws(() => parseTtlSeconds("abc"), InvalidArgumentError);
});

test("parseTtlSeconds rejects negative values", () => {
  assert.throws(() => parseTtlSeconds("-1"), InvalidArgumentError);
});

test("formatPromptSessionBannerLine prints single-line prompt banner for matching cwd", () => {
  const record: SessionRecord = {
    id: "abc123",
    sessionId: "abc123",
    agentCommand: "agent-a",
    cwd: "/home/user/project",
    name: "calm-forest",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastUsedAt: "2026-01-01T00:00:00.000Z",
    closed: false,
  };

  const line = formatPromptSessionBannerLine(record, "/home/user/project");
  assert.equal(
    line,
    "[acpx] session calm-forest (abc123) · /home/user/project · agent needs reconnect",
  );
});

test("formatPromptSessionBannerLine includes routed-from path when cwd differs", () => {
  const record: SessionRecord = {
    id: "abc123",
    sessionId: "abc123",
    agentCommand: "agent-a",
    cwd: "/home/user/project",
    name: "calm-forest",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastUsedAt: "2026-01-01T00:00:00.000Z",
    closed: false,
  };

  const line = formatPromptSessionBannerLine(record, "/home/user/project/src/auth");
  assert.equal(
    line,
    "[acpx] session calm-forest (abc123) · /home/user/project (routed from ./src/auth) · agent needs reconnect",
  );
});

test("CLI resolves unknown subcommand names as raw agent commands", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const session: SessionRecord = {
      id: "custom-session",
      sessionId: "custom-session",
      agentCommand: "custom-agent",
      cwd,
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUsedAt: "2026-01-01T00:00:00.000Z",
      closed: false,
    };
    await writeSessionRecord(homeDir, session);

    const result = await runCli(
      ["--cwd", cwd, "custom-agent", "sessions", "--format", "quiet"],
      homeDir,
    );

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /custom-session/);
  });
});

test("sessions new command is present in help output", async () => {
  await withTempHome(async (homeDir) => {
    const result = await runCli(["sessions", "--help"], homeDir);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /\bnew\b/);

    const newHelp = await runCli(["sessions", "new", "--help"], homeDir);
    assert.equal(newHelp.code, 0, newHelp.stderr);
    assert.match(newHelp.stdout, /--name <name>/);
  });
});

test("--ttl flag is parsed for sessions commands", async () => {
  await withTempHome(async (homeDir) => {
    const ok = await runCli(["--ttl", "30", "sessions", "--format", "json"], homeDir);
    assert.equal(ok.code, 0, ok.stderr);
    assert.doesNotThrow(() => JSON.parse(ok.stdout.trim()));

    const invalid = await runCli(["--ttl", "bad", "sessions"], homeDir);
    assert.equal(invalid.code, 2);
    assert.match(invalid.stderr, /TTL must be a non-negative number of seconds/);

    const negative = await runCli(["--ttl", "-1", "sessions"], homeDir);
    assert.equal(negative.code, 2);
    assert.match(negative.stderr, /TTL must be a non-negative number of seconds/);
  });
});

test("prompt exits with NO_SESSION when no session exists (no auto-create)", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace", "packages", "app");
    await fs.mkdir(cwd, { recursive: true });

    const result = await runCli(["--cwd", cwd, "codex", "hello"], homeDir);

    assert.equal(result.code, 4);
    const escapedCwd = escapeRegex(cwd);
    assert.match(
      result.stderr,
      new RegExp(
        `⚠ No acpx session found \\(searched up to ${escapedCwd}\\)\\.\\nCreate one: acpx codex sessions new\\n?`,
      ),
    );
  });
});

test("prompt reads from stdin when no prompt argument is provided", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const result = await runCli(["--cwd", cwd, "codex"], homeDir, {
      stdin: "fix the tests\n",
    });

    assert.equal(result.code, 4);
    assert.match(result.stderr, /No acpx session found/);
    assert.doesNotMatch(result.stderr, /Prompt is required/);
  });
});

test("prompt reads from --file for persistent prompts", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await fs.writeFile(path.join(cwd, "prompt.md"), "fix the tests\n", "utf8");

    const result = await runCli(
      ["--cwd", cwd, "codex", "--file", "prompt.md"],
      homeDir,
    );

    assert.equal(result.code, 4);
    assert.match(result.stderr, /No acpx session found/);
    assert.doesNotMatch(result.stderr, /Prompt is required/);
  });
});

test("prompt supports --file - with additional argument text", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const result = await runCli(
      ["--cwd", cwd, "codex", "--file", "-", "additional context"],
      homeDir,
      { stdin: "from stdin\n" },
    );

    assert.equal(result.code, 4);
    assert.match(result.stderr, /No acpx session found/);
    assert.doesNotMatch(result.stderr, /Prompt is required/);
  });
});

test("sessions history prints stored history entries", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    await writeSessionRecord(homeDir, {
      id: "history-session",
      sessionId: "history-session",
      agentCommand: "npx @zed-industries/codex-acp",
      cwd,
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUsedAt: "2026-01-01T00:10:00.000Z",
      closed: false,
      turnHistory: [
        {
          role: "user",
          timestamp: "2026-01-01T00:01:00.000Z",
          textPreview: "first message",
        },
        {
          role: "assistant",
          timestamp: "2026-01-01T00:02:00.000Z",
          textPreview: "second message",
        },
      ],
    });

    const result = await runCli(
      ["--cwd", cwd, "codex", "sessions", "history", "--limit", "1"],
      homeDir,
    );

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /second message/);
    assert.doesNotMatch(result.stdout, /first message/);
  });
});

test("status reports running process when session pid is alive", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
      stdio: "ignore",
    });

    try {
      await writeSessionRecord(homeDir, {
        id: "status-live",
        sessionId: "status-live",
        agentCommand: "npx @zed-industries/codex-acp",
        cwd,
        createdAt: "2026-01-01T00:00:00.000Z",
        lastUsedAt: "2026-01-01T00:00:00.000Z",
        lastPromptAt: "2026-01-01T00:00:00.000Z",
        closed: false,
        pid: child.pid,
        agentStartedAt: "2026-01-01T00:00:00.000Z",
      });

      const result = await runCli(["--cwd", cwd, "codex", "status"], homeDir);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /status: running/);
    } finally {
      if (child.pid && child.exitCode == null && child.signalCode == null) {
        child.kill("SIGKILL");
      }
    }
  });
});

test("config defaults are loaded from global and project config files", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });

    await fs.writeFile(
      path.join(homeDir, ".acpx", "config.json"),
      `${JSON.stringify(
        {
          defaultAgent: "codex",
          format: "json",
          agents: {
            "my-custom": { command: "custom-global" },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await fs.writeFile(
      path.join(cwd, ".acpxrc.json"),
      `${JSON.stringify(
        {
          agents: {
            "my-custom": { command: "custom-project" },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    await writeSessionRecord(homeDir, {
      id: "custom-config-session",
      sessionId: "custom-config-session",
      agentCommand: "custom-project",
      cwd,
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUsedAt: "2026-01-01T00:00:00.000Z",
      closed: false,
    });

    const result = await runCli(["--cwd", cwd, "my-custom", "sessions"], homeDir);

    assert.equal(result.code, 0, result.stderr);
    assert.doesNotThrow(() => JSON.parse(result.stdout.trim()));
    assert.match(result.stdout, /custom-config-session/);
  });
});

async function withTempHome(run: (homeDir: string) => Promise<void>): Promise<void> {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-cli-test-home-"));
  try {
    await run(tempHome);
  } finally {
    await fs.rm(tempHome, { recursive: true, force: true });
  }
}

type CliRunOptions = {
  stdin?: string;
  cwd?: string;
};

async function runCli(
  args: string[],
  homeDir: string,
  options: CliRunOptions = {},
): Promise<CliRunResult> {
  return await new Promise<CliRunResult>((resolve) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env: {
        ...process.env,
        HOME: homeDir,
      },
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
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

    if (options.stdin != null) {
      child.stdin.end(options.stdin);
    } else {
      child.stdin.end();
    }

    child.once("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

async function writeSessionRecord(
  homeDir: string,
  record: SessionRecord,
): Promise<void> {
  const sessionDir = path.join(homeDir, ".acpx", "sessions");
  await fs.mkdir(sessionDir, { recursive: true });
  const file = path.join(sessionDir, `${encodeURIComponent(record.id)}.json`);
  await fs.writeFile(file, `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
