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
const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));
const MOCK_AGENT_COMMAND = `node ${JSON.stringify(MOCK_AGENT_PATH)}`;
const MOCK_CODEX_AGENT_WITH_AGENT_SESSION_ID = `${MOCK_AGENT_COMMAND} --agent-session-id codex-runtime-session`;
const MOCK_CLAUDE_AGENT_WITH_AGENT_SESSION_ID = `${MOCK_AGENT_COMMAND} --agent-session-id claude-runtime-session`;
const MOCK_AGENT_WITH_LOAD_AGENT_SESSION_ID = `${MOCK_AGENT_COMMAND} --supports-load-session --load-agent-session-id loaded-runtime-session`;
const MOCK_AGENT_WITH_LOAD_INTERNAL_NOT_FOUND = `${MOCK_AGENT_COMMAND} --load-internal-session-not-found`;
const MOCK_AGENT_REQUIRING_LOAD_AGENT_SESSION_ID = `${MOCK_AGENT_COMMAND} --require-load-session-id loaded-agent-session`;

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
    const firstPayload = JSON.parse(first.stdout.trim()) as {
      type: string;
      acpxRecordId: string;
      acpxSessionId: string;
      created: boolean;
    };
    assert.equal(firstPayload.type, "session_ensured");
    assert.equal(firstPayload.created, true);

    const second = await runCli(
      ["--cwd", cwd, "--format", "json", "codex", "sessions", "ensure"],
      homeDir,
    );
    assert.equal(second.code, 0, second.stderr);
    const secondPayload = JSON.parse(second.stdout.trim()) as {
      type: string;
      acpxRecordId: string;
      acpxSessionId: string;
      created: boolean;
    };
    assert.equal(secondPayload.type, "session_ensured");
    assert.equal(secondPayload.created, false);
    assert.equal(secondPayload.acpxRecordId, firstPayload.acpxRecordId);
    assert.equal(secondPayload.acpxSessionId, firstPayload.acpxSessionId);
  });
});

test("sessions ensure resolves existing session by directory walk", async () => {
  await withTempHome(async (homeDir) => {
    const root = path.join(homeDir, "workspace");
    const child = path.join(root, "packages", "app");
    await fs.mkdir(child, { recursive: true });
    await fs.mkdir(path.join(root, ".git"), { recursive: true });

    await writeSessionRecord(homeDir, {
      id: "parent-session",
      sessionId: "parent-session",
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
    const payload = JSON.parse(result.stdout.trim()) as {
      acpxRecordId: string;
      acpxSessionId: string;
      created: boolean;
    };
    assert.equal(payload.acpxRecordId, "parent-session");
    assert.equal(payload.acpxSessionId, "parent-session");
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
        command: MOCK_CODEX_AGENT_WITH_AGENT_SESSION_ID,
        expectedAgentSessionId: "codex-runtime-session",
      },
      {
        agentName: "claude",
        command: MOCK_CLAUDE_AGENT_WITH_AGENT_SESSION_ID,
        expectedAgentSessionId: "claude-runtime-session",
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
      const createdPayload = JSON.parse(created.stdout.trim()) as {
        type: string;
        acpxRecordId: string;
        acpxSessionId: string;
        agentSessionId?: string;
      };
      assert.equal(createdPayload.type, "session_created");
      assert.equal(createdPayload.acpxRecordId.length > 0, true);
      assert.equal(createdPayload.acpxSessionId.length > 0, true);
      assert.equal(createdPayload.agentSessionId, scenario.expectedAgentSessionId);

      const ensured = await runCli(
        ["--cwd", cwd, "--format", "json", scenario.agentName, "sessions", "ensure"],
        homeDir,
      );
      assert.equal(ensured.code, 0, ensured.stderr);
      const ensuredPayload = JSON.parse(ensured.stdout.trim()) as {
        type: string;
        created: boolean;
        acpxRecordId: string;
        acpxSessionId: string;
        agentSessionId?: string;
      };
      assert.equal(ensuredPayload.type, "session_ensured");
      assert.equal(ensuredPayload.created, false);
      assert.equal(ensuredPayload.acpxRecordId.length > 0, true);
      assert.equal(ensuredPayload.acpxSessionId.length > 0, true);
      assert.equal(ensuredPayload.agentSessionId, scenario.expectedAgentSessionId);

      const status = await runCli(
        ["--cwd", cwd, "--format", "json", scenario.agentName, "status"],
        homeDir,
      );
      assert.equal(status.code, 0, status.stderr);
      const statusPayload = JSON.parse(status.stdout.trim()) as {
        acpxRecordId: string;
        acpxSessionId: string;
        agentSessionId?: string;
      };
      assert.equal(statusPayload.acpxRecordId.length > 0, true);
      assert.equal(statusPayload.acpxSessionId.length > 0, true);
      assert.equal(statusPayload.agentSessionId, scenario.expectedAgentSessionId);
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
              command: MOCK_AGENT_WITH_LOAD_AGENT_SESSION_ID,
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
      id: sessionId,
      sessionId,
      agentCommand: MOCK_AGENT_WITH_LOAD_AGENT_SESSION_ID,
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
    ) as SessionRecord;
    assert.equal(storedRecord.agentSessionId, "loaded-runtime-session");
  });
});

test("prompt falls back to new session when loadSession returns internal session-not-found", async () => {
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
              command: MOCK_AGENT_WITH_LOAD_INTERNAL_NOT_FOUND,
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const staleSessionId = "stale-runtime-session";
    await writeSessionRecord(homeDir, {
      id: staleSessionId,
      sessionId: staleSessionId,
      agentCommand: MOCK_AGENT_WITH_LOAD_INTERNAL_NOT_FOUND,
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
    assert.match(prompt.stdout, /hello/);

    const storedRecordPath = path.join(
      homeDir,
      ".acpx",
      "sessions",
      `${encodeURIComponent(staleSessionId)}.json`,
    );
    const storedRecord = JSON.parse(
      await fs.readFile(storedRecordPath, "utf8"),
    ) as SessionRecord;
    assert.notEqual(storedRecord.sessionId, staleSessionId);
  });
});

test("prompt prefers agentSessionId when reconnecting loadSession", async () => {
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
              command: MOCK_AGENT_REQUIRING_LOAD_AGENT_SESSION_ID,
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const recordId = "local-record-id";
    const acpxSessionId = "local-runtime-session";
    await writeSessionRecord(homeDir, {
      id: recordId,
      sessionId: acpxSessionId,
      agentSessionId: "loaded-agent-session",
      agentCommand: MOCK_AGENT_REQUIRING_LOAD_AGENT_SESSION_ID,
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
    assert.match(prompt.stdout, /hello/);

    const storedRecordPath = path.join(
      homeDir,
      ".acpx",
      "sessions",
      `${encodeURIComponent(recordId)}.json`,
    );
    const storedRecord = JSON.parse(
      await fs.readFile(storedRecordPath, "utf8"),
    ) as SessionRecord;
    assert.equal(storedRecord.sessionId, acpxSessionId);
    assert.equal(storedRecord.agentSessionId, "loaded-agent-session");
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
    const payload = JSON.parse(invalid.stdout.trim()) as {
      type: string;
      code: string;
      message: string;
    };
    assert.equal(payload.type, "error");
    assert.equal(payload.code, "USAGE");
    assert.match(payload.message, /Invalid non-interactive permission policy/);
  });
});

test("--json-strict requires --format json", async () => {
  await withTempHome(async (homeDir) => {
    const result = await runCli(["--json-strict", "sessions"], homeDir);
    assert.equal(result.code, 2);
    assert.equal(result.stderr.trim(), "");
    const payload = JSON.parse(result.stdout.trim()) as {
      type: string;
      code: string;
      message: string;
    };
    assert.equal(payload.type, "error");
    assert.equal(payload.code, "USAGE");
    assert.match(payload.message, /--json-strict requires --format json/);
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
    const payload = JSON.parse(result.stdout.trim()) as {
      type: string;
      code: string;
      message: string;
    };
    assert.equal(payload.type, "error");
    assert.equal(payload.code, "USAGE");
    assert.match(payload.message, /--json-strict cannot be combined with --verbose/);
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
        .map(
          (line) =>
            JSON.parse(line) as {
              type: string;
              stream?: string;
              sessionId?: string;
            },
        );

      const errors = events.filter((event) => event.type === "error");
      assert.equal(errors.length, 1, writeResult.stdout);
      assert.equal(errors[0]?.stream, "prompt");
      assert.notEqual(errors[0]?.sessionId, "unknown");
    } finally {
      if (blocker.exitCode === null) {
        blocker.kill("SIGKILL");
      }
      await new Promise<void>((resolve) => {
        blocker.once("close", () => resolve());
      });
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
      assert.equal(writeResult.stdout.trim(), "");
      assert.match(
        writeResult.stderr,
        /Permission prompt unavailable in non-interactive mode/,
      );
    } finally {
      if (blocker.exitCode === null) {
        blocker.kill("SIGKILL");
      }
      await new Promise<void>((resolve) => {
        blocker.once("close", () => resolve());
      });
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
    const payload = JSON.parse(result.stdout.trim()) as {
      type: string;
      acpxRecordId: string;
      acpxSessionId: string;
    };
    assert.equal(payload.type, "session_created");
    assert.equal(typeof payload.acpxRecordId, "string");
    assert.equal(typeof payload.acpxSessionId, "string");
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
    const payload = JSON.parse(result.stdout.trim()) as {
      type: string;
      code: string;
      message: string;
      stream: string;
    };
    assert.equal(payload.type, "error");
    assert.equal(payload.code, "NO_SESSION");
    assert.equal(payload.stream, "control");
    assert.match(payload.message, /No acpx session found/);
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
      id: "named-cancel-session",
      sessionId: "named-cancel-session",
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
    const payload = JSON.parse(result.stdout.trim()) as {
      acpxRecordId: string | null;
      cancelled: boolean;
    };
    assert.equal(payload.acpxRecordId, "named-cancel-session");
    assert.equal(payload.cancelled, false);
  });
});

test("status resolves named session when -s is before subcommand", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    await writeSessionRecord(homeDir, {
      id: "named-status-session",
      sessionId: "named-status-session",
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
    const payload = JSON.parse(result.stdout.trim()) as {
      acpxRecordId: string | null;
      acpxSessionId: string | null;
      status: string;
      agentSessionId?: string | null;
    };
    assert.equal(payload.acpxRecordId, "named-status-session");
    assert.equal(payload.acpxSessionId, "named-status-session");
    assert.equal(payload.status, "dead");
    assert.notEqual(payload.status, "no-session");
    assert.equal("agentSessionId" in payload, false);
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
      id: "named-set-mode-session",
      sessionId: "named-set-mode-session",
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
      id: "named-set-config-session",
      sessionId: "named-set-config-session",
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

const LONG_OPTIONS_WITH_VALUE = new Set([
  "--cwd",
  "--auth-policy",
  "--non-interactive-permissions",
  "--format",
  "--timeout",
  "--ttl",
  "--agent",
  "--file",
]);
const SHORT_OPTIONS_WITH_VALUE = new Set(["-s", "-f"]);

function collectPositionalArgs(args: string[]): string[] {
  const positionals: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--") {
      positionals.push(...args.slice(index + 1));
      break;
    }
    if (token.startsWith("--")) {
      if (!token.includes("=") && LONG_OPTIONS_WITH_VALUE.has(token)) {
        index += 1;
      }
      continue;
    }
    if (token.startsWith("-") && token.length > 1) {
      if (SHORT_OPTIONS_WITH_VALUE.has(token)) {
        index += 1;
      }
      continue;
    }
    positionals.push(token);
  }

  return positionals;
}

function shouldInjectPromptTtl(args: string[]): boolean {
  if (args.some((arg) => arg === "--ttl" || arg.startsWith("--ttl="))) {
    return false;
  }

  const positionals = collectPositionalArgs(args);
  if (positionals.length === 0) {
    return false;
  }

  const nonPromptCommands = new Set([
    "sessions",
    "status",
    "set-mode",
    "set",
    "cancel",
    "exec",
    "config",
  ]);
  const [first, second] = positionals;

  if (first === "prompt") {
    return true;
  }
  if (nonPromptCommands.has(first)) {
    return false;
  }
  if (second === "prompt") {
    return true;
  }
  if (second && nonPromptCommands.has(second)) {
    return false;
  }

  // Agent + free-form prompt path.
  return positionals.length >= 2;
}

async function runCli(
  args: string[],
  homeDir: string,
  options: CliRunOptions = {},
): Promise<CliRunResult> {
  const normalizedArgs = shouldInjectPromptTtl(args)
    ? ["--ttl", "0.01", ...args]
    : args;
  return await new Promise<CliRunResult>((resolve) => {
    const child = spawn(process.execPath, [CLI_PATH, ...normalizedArgs], {
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
