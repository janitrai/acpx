import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { InvalidArgumentError } from "commander";
import { formatPromptSessionBannerLine, parseTtlSeconds } from "../src/cli.js";
import { serializeSessionRecordForDisk } from "../src/session-persistence.js";
import type { SessionRecord } from "../src/types.js";
import {
  cleanupOwnerArtifacts,
  closeServer,
  listenServer,
  queuePaths,
  startKeeperProcess,
  stopProcess,
  writeQueueOwnerLock,
} from "./queue-test-helpers.js";

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));
const MOCK_AGENT_COMMAND = `node ${JSON.stringify(MOCK_AGENT_PATH)}`;
const MOCK_CODEX_AGENT_WITH_RUNTIME_SESSION_ID = `${MOCK_AGENT_COMMAND} --codex-session-id codex-runtime-session`;
const MOCK_CLAUDE_AGENT_WITH_RUNTIME_SESSION_ID = `${MOCK_AGENT_COMMAND} --claude-session-id claude-runtime-session`;
const MOCK_AGENT_WITH_LOAD_RUNTIME_SESSION_ID = `${MOCK_AGENT_COMMAND} --supports-load-session --load-runtime-session-id loaded-runtime-session`;

type CliRunResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

type ParsedAcpError = {
  code?: number;
  message?: string;
  data?: {
    acpxCode?: string;
    detailCode?: string;
    origin?: string;
    sessionId?: string;
  };
};

function parseSingleAcpErrorLine(stdout: string): ParsedAcpError {
  const payload = JSON.parse(stdout.trim()) as {
    jsonrpc?: string;
    error?: ParsedAcpError;
  };
  assert.equal(payload.jsonrpc, "2.0");
  assert.equal(typeof payload.error, "object");
  return payload.error ?? {};
}

function parseJsonRpcLines(stdout: string): Array<Record<string, unknown>> {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  assert(lines.length > 0, "expected at least one stdout line");
  return lines.map((line) => {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    assert.equal(parsed.jsonrpc, "2.0");
    return parsed;
  });
}

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
  const record = makeSessionRecord({
    acpxRecordId: "abc123",
    acpSessionId: "abc123",
    agentCommand: "agent-a",
    cwd: "/home/user/project",
    name: "calm-forest",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastUsedAt: "2026-01-01T00:00:00.000Z",
    closed: false,
  });

  const line = formatPromptSessionBannerLine(record, "/home/user/project");
  assert.equal(
    line,
    "[acpx] session calm-forest (abc123) · /home/user/project · agent needs reconnect",
  );
});

test("formatPromptSessionBannerLine includes routed-from path when cwd differs", () => {
  const record = makeSessionRecord({
    acpxRecordId: "abc123",
    acpSessionId: "abc123",
    agentCommand: "agent-a",
    cwd: "/home/user/project",
    name: "calm-forest",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastUsedAt: "2026-01-01T00:00:00.000Z",
    closed: false,
  });

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

    const session = makeSessionRecord({
      acpxRecordId: "custom-session",
      acpSessionId: "custom-session",
      agentCommand: "custom-agent",
      cwd,
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUsedAt: "2026-01-01T00:00:00.000Z",
      closed: false,
    });
    await writeSessionRecord(homeDir, session);

    const result = await runCli(
      ["--cwd", cwd, "--format", "quiet", "custom-agent", "sessions"],
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
    assert.match(result.stdout, /\bensure\b/);

    const newHelp = await runCli(["sessions", "new", "--help"], homeDir);
    assert.equal(newHelp.code, 0, newHelp.stderr);
    assert.match(newHelp.stdout, /--name <name>/);

    const ensureHelp = await runCli(["sessions", "ensure", "--help"], homeDir);
    assert.equal(ensureHelp.code, 0, ensureHelp.stderr);
    assert.match(ensureHelp.stdout, /--name <name>/);
  });
});

test("sessions ensure creates when missing and returns existing on subsequent calls", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });
    await fs.writeFile(
      path.join(homeDir, ".acpx", "config.json"),
      `${JSON.stringify(
        {
          agents: {
            codex: {
              command: MOCK_AGENT_COMMAND,
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const first = await runCli(
      ["--cwd", cwd, "--format", "json", "codex", "sessions", "ensure"],
      homeDir,
    );
    assert.equal(first.code, 0, first.stderr);
    const firstPayload = JSON.parse(first.stdout.trim()) as Record<string, unknown>;
    assert.equal(firstPayload.action, "session_ensured");
    assert.equal(firstPayload.created, true);

    const second = await runCli(
      ["--cwd", cwd, "--format", "json", "codex", "sessions", "ensure"],
      homeDir,
    );
    assert.equal(second.code, 0, second.stderr);
    const secondPayload = JSON.parse(second.stdout.trim()) as Record<string, unknown>;
    assert.equal(secondPayload.action, "session_ensured");
    assert.equal(secondPayload.created, false);
    assert.equal(secondPayload.acpxRecordId, firstPayload.acpxRecordId);
  });
});

test("sessions ensure resolves existing session by directory walk", async () => {
  await withTempHome(async (homeDir) => {
    const root = path.join(homeDir, "workspace");
    const child = path.join(root, "packages", "app");
    await fs.mkdir(child, { recursive: true });
    await fs.mkdir(path.join(root, ".git"), { recursive: true });

    await writeSessionRecord(homeDir, {
      acpxRecordId: "parent-session",
      acpSessionId: "parent-session",
      agentCommand: "npx @zed-industries/codex-acp",
      cwd: root,
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUsedAt: "2026-01-01T00:00:00.000Z",
      closed: false,
    });

    const result = await runCli(
      ["--cwd", child, "--format", "json", "codex", "sessions", "ensure"],
      homeDir,
    );
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    assert.equal(payload.acpxRecordId, "parent-session");
    assert.equal(payload.action, "session_ensured");
    assert.equal(payload.created, false);
  });
});

test("sessions and status surface agentSessionId for codex and claude in JSON mode", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const runtimeScenarios = [
      {
        agentName: "codex",
        command: MOCK_CODEX_AGENT_WITH_RUNTIME_SESSION_ID,
        expectedRuntimeSessionId: "codex-runtime-session",
      },
      {
        agentName: "claude",
        command: MOCK_CLAUDE_AGENT_WITH_RUNTIME_SESSION_ID,
        expectedRuntimeSessionId: "claude-runtime-session",
      },
    ] as const;

    const agentsConfig = Object.fromEntries(
      runtimeScenarios.map((scenario) => [
        scenario.agentName,
        { command: scenario.command },
      ]),
    );

    await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });
    await fs.writeFile(
      path.join(homeDir, ".acpx", "config.json"),
      `${JSON.stringify(
        {
          agents: agentsConfig,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    for (const scenario of runtimeScenarios) {
      const created = await runCli(
        ["--cwd", cwd, "--format", "json", scenario.agentName, "sessions", "new"],
        homeDir,
      );
      assert.equal(created.code, 0, created.stderr);
      const createdPayload = JSON.parse(created.stdout.trim()) as Record<
        string,
        unknown
      >;
      assert.equal(createdPayload.action, "session_ensured");
      assert.equal(createdPayload.created, true);
      assert.equal(createdPayload.agentSessionId, scenario.expectedRuntimeSessionId);

      const ensured = await runCli(
        ["--cwd", cwd, "--format", "json", scenario.agentName, "sessions", "ensure"],
        homeDir,
      );
      assert.equal(ensured.code, 0, ensured.stderr);
      const ensuredPayload = JSON.parse(ensured.stdout.trim()) as Record<
        string,
        unknown
      >;
      assert.equal(ensuredPayload.action, "session_ensured");
      assert.equal(ensuredPayload.created, false);
      assert.equal(ensuredPayload.agentSessionId, scenario.expectedRuntimeSessionId);

      const status = await runCli(
        ["--cwd", cwd, "--format", "json", scenario.agentName, "status"],
        homeDir,
      );
      assert.equal(status.code, 0, status.stderr);
      const statusPayload = JSON.parse(status.stdout.trim()) as Record<string, unknown>;
      assert.equal(statusPayload.action, "status_snapshot");
      assert.equal(statusPayload.agentSessionId, scenario.expectedRuntimeSessionId);
    }
  });
});

test("prompt reconciles agentSessionId from loadSession metadata", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });
    await fs.writeFile(
      path.join(homeDir, ".acpx", "config.json"),
      `${JSON.stringify(
        {
          agents: {
            codex: {
              command: MOCK_AGENT_WITH_LOAD_RUNTIME_SESSION_ID,
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const sessionId = "resume-runtime-session";
    await writeSessionRecord(homeDir, {
      acpxRecordId: sessionId,
      acpSessionId: sessionId,
      agentCommand: MOCK_AGENT_WITH_LOAD_RUNTIME_SESSION_ID,
      cwd,
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUsedAt: "2026-01-01T00:00:00.000Z",
      closed: false,
    });

    const prompt = await runCli(
      ["--cwd", cwd, "--ttl", "0.01", "codex", "prompt", "echo hello"],
      homeDir,
    );
    assert.equal(prompt.code, 0, prompt.stderr);

    const storedRecordPath = path.join(
      homeDir,
      ".acpx",
      "sessions",
      `${encodeURIComponent(sessionId)}.json`,
    );
    const storedRecord = JSON.parse(
      await fs.readFile(storedRecordPath, "utf8"),
    ) as Record<string, unknown>;
    assert.equal(storedRecord.agent_session_id, "loaded-runtime-session");
  });
});

test("--ttl flag is parsed for sessions commands", async () => {
  await withTempHome(async (homeDir) => {
    const ok = await runCli(["--ttl", "30", "--format", "json", "sessions"], homeDir);
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

test("--auth-policy flag validates supported values", async () => {
  await withTempHome(async (homeDir) => {
    const ok = await runCli(
      ["--auth-policy", "skip", "--format", "json", "sessions"],
      homeDir,
    );
    assert.equal(ok.code, 0, ok.stderr);

    const invalid = await runCli(["--auth-policy", "bad", "sessions"], homeDir);
    assert.equal(invalid.code, 2);
    assert.match(invalid.stderr, /Invalid auth policy/);
  });
});

test("--non-interactive-permissions validates supported values", async () => {
  await withTempHome(async (homeDir) => {
    const ok = await runCli(
      ["--non-interactive-permissions", "deny", "--format", "json", "sessions"],
      homeDir,
    );
    assert.equal(ok.code, 0, ok.stderr);

    const invalid = await runCli(
      ["--format", "json", "--non-interactive-permissions", "bad", "sessions"],
      homeDir,
    );
    assert.equal(invalid.code, 2);
    const error = parseSingleAcpErrorLine(invalid.stdout);
    assert.equal(error.code, -32602);
    assert.equal(error.data?.acpxCode, "USAGE");
    assert.match(error.message ?? "", /Invalid non-interactive permission policy/);
  });
});

test("--json-strict requires --format json", async () => {
  await withTempHome(async (homeDir) => {
    const result = await runCli(["--json-strict", "sessions"], homeDir);
    assert.equal(result.code, 2);
    assert.equal(result.stderr.trim(), "");
    const error = parseSingleAcpErrorLine(result.stdout);
    assert.equal(error.code, -32602);
    assert.equal(error.data?.acpxCode, "USAGE");
    assert.match(error.message ?? "", /--json-strict requires --format json/);
  });
});

test("--json-strict rejects --verbose", async () => {
  await withTempHome(async (homeDir) => {
    const result = await runCli(
      ["--format", "json", "--json-strict", "--verbose", "sessions"],
      homeDir,
    );
    assert.equal(result.code, 2);
    assert.equal(result.stderr.trim(), "");
    const error = parseSingleAcpErrorLine(result.stdout);
    assert.equal(error.code, -32602);
    assert.equal(error.data?.acpxCode, "USAGE");
    assert.match(
      error.message ?? "",
      /--json-strict cannot be combined with --verbose/,
    );
  });
});

test("queued prompt failures emit exactly one JSON error event", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });
    await fs.writeFile(
      path.join(homeDir, ".acpx", "config.json"),
      `${JSON.stringify(
        {
          agents: {
            codex: {
              command: MOCK_AGENT_COMMAND,
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const session = await runCli(
      ["--cwd", cwd, "--format", "json", "codex", "sessions", "new"],
      homeDir,
    );
    assert.equal(session.code, 0, session.stderr);

    const blocker = spawn(
      process.execPath,
      [CLI_PATH, "--cwd", cwd, "codex", "prompt", "sleep 1500"],
      {
        env: { ...process.env, HOME: homeDir },
        stdio: ["ignore", "ignore", "ignore"],
      },
    );

    try {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 200);
      });

      const writeResult = await runCli(
        [
          "--cwd",
          cwd,
          "--format",
          "json",
          "--non-interactive-permissions",
          "fail",
          "codex",
          "prompt",
          `write ${path.join(cwd, "x.txt")} hi`,
        ],
        homeDir,
      );

      assert.equal(writeResult.code, 5, writeResult.stderr);

      const events = writeResult.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>);

      const errors = events.filter(
        (event) => typeof event.error === "object" && event.error !== null,
      );
      assert.equal(errors.length, 1, writeResult.stdout);
      assert.equal((errors[0]?.error as { code?: unknown } | undefined)?.code, -32603);
      assert.notEqual(
        (errors[0]?.error as { data?: { sessionId?: unknown } } | undefined)?.data
          ?.sessionId,
        "unknown",
      );
    } finally {
      if (blocker.exitCode === null && blocker.signalCode == null) {
        blocker.kill("SIGKILL");
        await new Promise<void>((resolve) => {
          blocker.once("close", () => resolve());
        });
      }
    }
  });
});

test("json-strict queued prompt failure emits JSON-RPC lines only", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });
    await fs.writeFile(
      path.join(homeDir, ".acpx", "config.json"),
      `${JSON.stringify(
        {
          agents: {
            codex: {
              command: MOCK_AGENT_COMMAND,
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const session = await runCli(
      ["--cwd", cwd, "--format", "json", "codex", "sessions", "new"],
      homeDir,
    );
    assert.equal(session.code, 0, session.stderr);

    const blocker = spawn(
      process.execPath,
      [CLI_PATH, "--cwd", cwd, "codex", "prompt", "sleep 1500"],
      {
        env: { ...process.env, HOME: homeDir },
        stdio: ["ignore", "ignore", "ignore"],
      },
    );

    try {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 200);
      });

      const writeResult = await runCli(
        [
          "--cwd",
          cwd,
          "--format",
          "json",
          "--json-strict",
          "--non-interactive-permissions",
          "fail",
          "codex",
          "prompt",
          `write ${path.join(cwd, "x.txt")} hi`,
        ],
        homeDir,
      );

      assert.equal(writeResult.code, 5, writeResult.stderr);
      assert.equal(writeResult.stderr.trim(), "");

      const events = parseJsonRpcLines(writeResult.stdout);
      assert.equal(
        events.some(
          (event) =>
            typeof event.error === "object" &&
            event.error !== null &&
            typeof (event.error as { code?: unknown }).code === "number",
        ),
        true,
      );
    } finally {
      if (blocker.exitCode === null && blocker.signalCode == null) {
        blocker.kill("SIGKILL");
        await new Promise<void>((resolve) => {
          blocker.once("close", () => resolve());
        });
      }
    }
  });
});

test("queued prompt failures remain visible in quiet mode", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });
    await fs.writeFile(
      path.join(homeDir, ".acpx", "config.json"),
      `${JSON.stringify(
        {
          agents: {
            codex: {
              command: MOCK_AGENT_COMMAND,
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const session = await runCli(
      ["--cwd", cwd, "--format", "json", "codex", "sessions", "new"],
      homeDir,
    );
    assert.equal(session.code, 0, session.stderr);

    const blocker = spawn(
      process.execPath,
      [CLI_PATH, "--cwd", cwd, "codex", "prompt", "sleep 1500"],
      {
        env: { ...process.env, HOME: homeDir },
        stdio: ["ignore", "ignore", "ignore"],
      },
    );

    try {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 200);
      });

      const writeResult = await runCli(
        [
          "--cwd",
          cwd,
          "--format",
          "quiet",
          "--non-interactive-permissions",
          "fail",
          "codex",
          "prompt",
          `write ${path.join(cwd, "x.txt")} hi`,
        ],
        homeDir,
      );

      assert.equal(writeResult.code, 5);
      assert.match(writeResult.stdout, /error:\s*Internal error/i);
      assert.match(
        writeResult.stderr,
        /Permission prompt unavailable in non-interactive mode/,
      );
    } finally {
      if (blocker.exitCode === null && blocker.signalCode == null) {
        blocker.kill("SIGKILL");
        await new Promise<void>((resolve) => {
          blocker.once("close", () => resolve());
        });
      }
    }
  });
});

test("--json-strict suppresses session banners on stderr", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });
    await fs.writeFile(
      path.join(homeDir, ".acpx", "config.json"),
      `${JSON.stringify(
        {
          agents: {
            codex: {
              command: MOCK_AGENT_COMMAND,
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const result = await runCli(
      ["--cwd", cwd, "--format", "json", "--json-strict", "codex", "sessions", "new"],
      homeDir,
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr.trim(), "");
    const payload = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    assert.equal(payload.action, "session_ensured");
    assert.equal(payload.created, true);
    assert.equal(typeof payload.acpxRecordId, "string");
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

test("json format emits structured no-session error event", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const result = await runCli(
      ["--cwd", cwd, "--format", "json", "codex", "hello"],
      homeDir,
    );
    assert.equal(result.code, 4);
    const error = parseSingleAcpErrorLine(result.stdout);
    assert.equal(error.code, -32002);
    assert.equal(error.data?.acpxCode, "NO_SESSION");
    assert.match(error.message ?? "", /No acpx session found/);
  });
});

test("set-mode exits with NO_SESSION when no session exists", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace", "packages", "app");
    await fs.mkdir(cwd, { recursive: true });

    const result = await runCli(["--cwd", cwd, "codex", "set-mode", "plan"], homeDir);

    assert.equal(result.code, 4);
    assert.match(result.stderr, /No acpx session found/);
  });
});

test("set command exits with NO_SESSION when no session exists", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace", "packages", "app");
    await fs.mkdir(cwd, { recursive: true });

    const result = await runCli(
      ["--cwd", cwd, "codex", "set", "temperature", "high"],
      homeDir,
    );

    assert.equal(result.code, 4);
    assert.match(result.stderr, /No acpx session found/);
  });
});

test("cancel prints nothing to cancel and exits success when no session exists", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace", "packages", "app");
    await fs.mkdir(cwd, { recursive: true });

    const result = await runCli(["--cwd", cwd, "codex", "cancel"], homeDir);

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /nothing to cancel/);
  });
});

test("cancel resolves named session when -s is before subcommand", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    await writeSessionRecord(homeDir, {
      acpxRecordId: "named-cancel-session",
      acpSessionId: "named-cancel-session",
      agentCommand: "npx @zed-industries/codex-acp",
      cwd,
      name: "named",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUsedAt: "2026-01-01T00:00:00.000Z",
      closed: false,
    });

    const result = await runCli(
      ["--cwd", cwd, "--format", "json", "codex", "-s", "named", "cancel"],
      homeDir,
    );

    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    assert.equal(payload.action, "cancel_result");
    assert.equal(payload.acpxRecordId, "named-cancel-session");
    assert.equal(payload.cancelled, false);
  });
});

test("status resolves named session when -s is before subcommand", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    await writeSessionRecord(homeDir, {
      acpxRecordId: "named-status-session",
      acpSessionId: "named-status-session",
      agentCommand: "npx @zed-industries/codex-acp",
      cwd,
      name: "named",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUsedAt: "2026-01-01T00:00:00.000Z",
      closed: false,
    });

    const result = await runCli(
      ["--cwd", cwd, "--format", "json", "codex", "-s", "named", "status"],
      homeDir,
    );

    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    assert.equal(payload.action, "status_snapshot");
    assert.equal(payload.acpxRecordId, "named-status-session");
    assert.equal(payload.status, "dead");
    assert.notEqual(payload.status, "no-session");
    assert.equal(payload.agentSessionId, undefined);
  });
});

test("set-mode resolves named session when -s is before subcommand", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });

    const missingAgentCommand = "acpx-test-missing-agent-binary";
    await fs.writeFile(
      path.join(homeDir, ".acpx", "config.json"),
      `${JSON.stringify(
        {
          agents: {
            codex: { command: missingAgentCommand },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    await writeSessionRecord(homeDir, {
      acpxRecordId: "named-set-mode-session",
      acpSessionId: "named-set-mode-session",
      agentCommand: missingAgentCommand,
      cwd,
      name: "named",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUsedAt: "2026-01-01T00:00:00.000Z",
      closed: false,
    });

    const result = await runCli(
      ["--cwd", cwd, "codex", "-s", "named", "set-mode", "plan"],
      homeDir,
    );

    assert.equal(result.code, 1);
    assert.doesNotMatch(result.stderr, /No acpx session found/);
    assert.match(result.stderr, /ENOENT|spawn|not found/i);
  });
});

test("set resolves named session when -s is before subcommand", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });

    const missingAgentCommand = "acpx-test-missing-agent-binary-2";
    await fs.writeFile(
      path.join(homeDir, ".acpx", "config.json"),
      `${JSON.stringify(
        {
          agents: {
            codex: { command: missingAgentCommand },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    await writeSessionRecord(homeDir, {
      acpxRecordId: "named-set-config-session",
      acpSessionId: "named-set-config-session",
      agentCommand: missingAgentCommand,
      cwd,
      name: "named",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUsedAt: "2026-01-01T00:00:00.000Z",
      closed: false,
    });

    const result = await runCli(
      ["--cwd", cwd, "codex", "-s", "named", "set", "approval_policy", "strict"],
      homeDir,
    );

    assert.equal(result.code, 1);
    assert.doesNotMatch(result.stderr, /No acpx session found/);
    assert.match(result.stderr, /ENOENT|spawn|not found/i);
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

test("prompt subcommand accepts --file without being consumed by parent command", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await fs.writeFile(path.join(cwd, "prompt.md"), "fix the tests\n", "utf8");

    const result = await runCli(
      ["--cwd", cwd, "codex", "prompt", "--file", "prompt.md"],
      homeDir,
    );

    assert.equal(result.code, 4);
    assert.match(result.stderr, /No acpx session found/);
    assert.doesNotMatch(result.stderr, /unknown option/i);
  });
});

test("exec subcommand accepts --file without being consumed by parent command", async () => {
  await withTempHome(async (homeDir) => {
    const promptPath = path.join(homeDir, "prompt.txt");
    await fs.writeFile(promptPath, "say exactly: file-flag-test\n", "utf8");

    const result = await runCli(
      ["custom-agent", "exec", "--file", promptPath],
      homeDir,
    );

    assert.equal(result.code, 1);
    assert.doesNotMatch(result.stderr, /unknown option/i);
  });
});

test("sessions history prints stored history entries", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    await writeSessionRecord(homeDir, {
      acpxRecordId: "history-session",
      acpSessionId: "history-session",
      agentCommand: "npx @zed-industries/codex-acp",
      cwd,
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUsedAt: "2026-01-01T00:10:00.000Z",
      closed: false,
      title: null,
      messages: [
        {
          User: {
            id: "7d7b0e67-9725-4f57-ba31-491bf4f97767",
            content: [{ Text: "first message" }],
          },
        },
        {
          Agent: {
            content: [{ Text: "second message" }],
            tool_results: {},
          },
        },
      ],
      updated_at: "2026-01-01T00:02:00.000Z",
      cumulative_token_usage: {},
      request_token_usage: {},
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

test("status reports running queue owner when owner socket is reachable", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const sessionId = "status-live";
    const keeper = await startKeeperProcess();
    const { lockPath, socketPath } = queuePaths(homeDir, sessionId);

    const server = net.createServer((socket) => {
      socket.end();
    });

    try {
      await writeSessionRecord(homeDir, {
        acpxRecordId: sessionId,
        acpSessionId: sessionId,
        agentCommand: "npx @zed-industries/codex-acp",
        cwd,
        createdAt: "2026-01-01T00:00:00.000Z",
        lastUsedAt: "2026-01-01T00:00:00.000Z",
        lastPromptAt: "2026-01-01T00:00:00.000Z",
        closed: false,
        pid: keeper.pid,
        agentStartedAt: "2026-01-01T00:00:00.000Z",
      });

      await writeQueueOwnerLock({
        lockPath,
        pid: keeper.pid,
        sessionId,
        socketPath,
      });
      await listenServer(server, socketPath);

      const result = await runCli(["--cwd", cwd, "codex", "status"], homeDir);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /status: running/);
    } finally {
      await closeServer(server);
      await cleanupOwnerArtifacts({ socketPath, lockPath });
      stopProcess(keeper);
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
      acpxRecordId: "custom-config-session",
      acpSessionId: "custom-config-session",
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

function makeSessionRecord(
  record: Partial<SessionRecord> & {
    acpxRecordId: string;
    acpSessionId: string;
    agentCommand: string;
    cwd: string;
    createdAt?: string;
    lastUsedAt?: string;
  },
): SessionRecord {
  const timestamp = "2026-01-01T00:00:00.000Z";
  return {
    schema: "acpx.session.v1",
    acpxRecordId: record.acpxRecordId,
    acpSessionId: record.acpSessionId,
    agentSessionId: record.agentSessionId,
    agentCommand: record.agentCommand,
    cwd: record.cwd,
    name: record.name,
    createdAt: record.createdAt ?? timestamp,
    lastUsedAt: record.lastUsedAt ?? timestamp,
    lastSeq: record.lastSeq ?? 0,
    lastRequestId: record.lastRequestId,
    eventLog: record.eventLog ?? {
      active_path: `.stream.ndjson`,
      segment_count: 1,
      max_segment_bytes: 1024,
      max_segments: 1,
      last_write_at: record.lastUsedAt ?? timestamp,
      last_write_error: null,
    },
    closed: record.closed ?? false,
    closedAt: record.closedAt,
    pid: record.pid,
    agentStartedAt: record.agentStartedAt,
    lastPromptAt: record.lastPromptAt,
    lastAgentExitCode: record.lastAgentExitCode,
    lastAgentExitSignal: record.lastAgentExitSignal,
    lastAgentExitAt: record.lastAgentExitAt,
    lastAgentDisconnectReason: record.lastAgentDisconnectReason,
    protocolVersion: record.protocolVersion,
    agentCapabilities: record.agentCapabilities,
    title: record.title ?? null,
    messages: record.messages ?? [],
    updated_at: record.updated_at ?? record.lastUsedAt ?? timestamp,
    cumulative_token_usage: record.cumulative_token_usage ?? {},
    request_token_usage: record.request_token_usage ?? {},
    acpx: record.acpx,
  };
}

async function writeSessionRecord(
  homeDir: string,
  record: Partial<SessionRecord> & {
    acpxRecordId: string;
    acpSessionId: string;
    agentCommand: string;
    cwd: string;
  },
): Promise<void> {
  const sessionDir = path.join(homeDir, ".acpx", "sessions");
  await fs.mkdir(sessionDir, { recursive: true });
  const file = path.join(sessionDir, `${encodeURIComponent(record.acpxRecordId)}.json`);
  await fs.writeFile(
    file,
    `${JSON.stringify(serializeSessionRecordForDisk(makeSessionRecord(record)), null, 2)}\n`,
    "utf8",
  );
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
