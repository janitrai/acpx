import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionRecord } from "../src/types.js";

export const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
export const MOCK_AGENT_PATH = fileURLToPath(
  new URL("./mock-agent.js", import.meta.url),
);
export const MOCK_AGENT_COMMAND = `node ${JSON.stringify(MOCK_AGENT_PATH)}`;

type CliRunResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

function shouldInjectPromptTtl(args: string[]): boolean {
  if (args.some((arg) => arg === "--ttl" || arg.startsWith("--ttl="))) {
    return false;
  }

  const positionals = args.filter((arg) => !arg.startsWith("-"));
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

  if (positionals[0] === "prompt") {
    return true;
  }
  if (nonPromptCommands.has(positionals[0])) {
    return false;
  }
  if (positionals[1] === "prompt") {
    return true;
  }
  if (positionals[1] && nonPromptCommands.has(positionals[1])) {
    return false;
  }

  return positionals.length >= 2;
}

export async function runCli(args: string[], homeDir: string): Promise<CliRunResult> {
  const normalizedArgs = shouldInjectPromptTtl(args)
    ? ["--ttl", "0.01", ...args]
    : args;
  return await new Promise<CliRunResult>((resolve) => {
    const child = spawn(process.execPath, [CLI_PATH, ...normalizedArgs], {
      env: {
        ...process.env,
        HOME: homeDir,
      },
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
    child.stdin.end();

    child.once("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

export async function withTempHome(
  run: (homeDir: string, cwd: string) => Promise<void>,
): Promise<void> {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-adapter-contract-"));
  const cwd = path.join(tempHome, "workspace");
  await fs.mkdir(cwd, { recursive: true });

  try {
    await run(tempHome, cwd);
  } finally {
    await fs.rm(tempHome, { recursive: true, force: true });
  }
}

export async function writeSessionRecord(
  homeDir: string,
  record: SessionRecord,
): Promise<void> {
  const sessionDir = path.join(homeDir, ".acpx", "sessions");
  await fs.mkdir(sessionDir, { recursive: true });
  const file = path.join(sessionDir, `${encodeURIComponent(record.id)}.json`);
  await fs.writeFile(file, `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

export type AdapterMetadataScenario = {
  agentName: string;
  command: string;
  expectedNewSessionId: string;
  expectedLoadSessionId: string;
};

export async function runMetadataContract(
  homeDir: string,
  cwd: string,
  scenarios: readonly AdapterMetadataScenario[],
): Promise<void> {
  const agentsConfig = Object.fromEntries(
    scenarios.map((scenario) => [scenario.agentName, { command: scenario.command }]),
  );
  await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });
  await fs.writeFile(
    path.join(homeDir, ".acpx", "config.json"),
    `${JSON.stringify({ agents: agentsConfig }, null, 2)}\n`,
    "utf8",
  );

  for (const scenario of scenarios) {
    const created = await runCli(
      ["--cwd", cwd, "--format", "json", scenario.agentName, "sessions", "new"],
      homeDir,
    );
    assert.equal(created.code, 0, created.stderr);
    const createdPayload = JSON.parse(created.stdout.trim()) as {
      agentSessionId?: string;
    };
    assert.equal(createdPayload.agentSessionId, scenario.expectedNewSessionId);

    const prompted = await runCli(
      ["--cwd", cwd, scenario.agentName, "prompt", "echo contract-ok"],
      homeDir,
    );
    assert.equal(prompted.code, 0, prompted.stderr);
    assert.match(prompted.stdout, /contract-ok/);

    const status = await runCli(
      ["--cwd", cwd, "--format", "json", scenario.agentName, "status"],
      homeDir,
    );
    assert.equal(status.code, 0, status.stderr);
    const statusPayload = JSON.parse(status.stdout.trim()) as {
      agentSessionId?: string;
    };
    assert.equal(statusPayload.agentSessionId, scenario.expectedLoadSessionId);
  }
}
