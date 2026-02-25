import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { SessionRecord } from "../src/types.js";
import {
  MOCK_AGENT_COMMAND,
  runCli,
  runMetadataContract,
  withTempHome,
  writeSessionRecord,
} from "./adapter-contract-suite.js";

const AGENT_WITH_META_AGENT_SESSION = `${MOCK_AGENT_COMMAND} --agent-session-id codex-runtime-id --supports-load-session --load-agent-session-id codex-load-id`;
const AGENT_WITH_META_SESSION_ID = `${MOCK_AGENT_COMMAND} --meta-session-id claude-runtime-id --supports-load-session --load-meta-session-id claude-load-id`;
const AGENT_WITH_RECOVERABLE_NOT_FOUND = `${MOCK_AGENT_COMMAND} --load-internal-session-not-found`;

test("adapter contract: metadata ids are extracted on newSession and loadSession", async () => {
  await withTempHome(async (homeDir, cwd) => {
    await runMetadataContract(homeDir, cwd, [
      {
        agentName: "adapter_codex",
        command: AGENT_WITH_META_AGENT_SESSION,
        expectedNewSessionId: "codex-runtime-id",
        expectedLoadSessionId: "codex-load-id",
      },
      {
        agentName: "adapter_claude",
        command: AGENT_WITH_META_SESSION_ID,
        expectedNewSessionId: "claude-runtime-id",
        expectedLoadSessionId: "claude-load-id",
      },
    ]);
  });
});

test("adapter contract: recoverable session-not-found load errors fall back to createSession", async () => {
  await withTempHome(async (homeDir, cwd) => {
    await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });
    await fs.writeFile(
      path.join(homeDir, ".acpx", "config.json"),
      `${JSON.stringify(
        {
          agents: {
            adapter_reconnect: {
              command: AGENT_WITH_RECOVERABLE_NOT_FOUND,
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const staleSessionId = "stale-session-id";
    await writeSessionRecord(homeDir, {
      id: staleSessionId,
      sessionId: staleSessionId,
      agentCommand: AGENT_WITH_RECOVERABLE_NOT_FOUND,
      cwd,
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUsedAt: "2026-01-01T00:00:00.000Z",
      closed: false,
    } satisfies SessionRecord);

    const prompted = await runCli(
      ["--cwd", cwd, "adapter_reconnect", "prompt", "echo reconnect-ok"],
      homeDir,
    );
    assert.equal(prompted.code, 0, prompted.stderr);
    assert.match(prompted.stdout, /reconnect-ok/);

    const storedRecord = JSON.parse(
      await fs.readFile(
        path.join(
          homeDir,
          ".acpx",
          "sessions",
          `${encodeURIComponent(staleSessionId)}.json`,
        ),
        "utf8",
      ),
    ) as SessionRecord;
    assert.notEqual(storedRecord.sessionId, staleSessionId);
  });
});
