import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PermissionPromptUnavailableError } from "../src/errors.js";
import { TerminalManager } from "../src/terminal.js";

test("terminal manager create/output/wait/release lifecycle", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-terminal-test-"));
  try {
    const manager = new TerminalManager({
      cwd: tmp,
      permissionMode: "approve-all",
    });

    const created = await manager.createTerminal({
      sessionId: "session-1",
      command: process.execPath,
      args: ["-e", "console.log('hello-terminal')"],
    });

    const waitResult = await manager.waitForTerminalExit({
      sessionId: "session-1",
      terminalId: created.terminalId,
    });
    assert.equal(waitResult.exitCode, 0);

    const outputResult = await manager.terminalOutput({
      sessionId: "session-1",
      terminalId: created.terminalId,
    });
    assert.match(outputResult.output, /hello-terminal/);
    assert.equal(outputResult.truncated, false);

    await manager.releaseTerminal({
      sessionId: "session-1",
      terminalId: created.terminalId,
    });

    await assert.rejects(
      manager.terminalOutput({
        sessionId: "session-1",
        terminalId: created.terminalId,
      }),
      /Unknown terminal/,
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("terminal manager kill sends termination and process exits", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-terminal-test-"));
  try {
    const manager = new TerminalManager({
      cwd: tmp,
      permissionMode: "approve-all",
      killGraceMs: 200,
    });

    const created = await manager.createTerminal({
      sessionId: "session-1",
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
    });

    await manager.killTerminal({
      sessionId: "session-1",
      terminalId: created.terminalId,
    });

    const waitResult = await manager.waitForTerminalExit({
      sessionId: "session-1",
      terminalId: created.terminalId,
    });
    assert.ok(waitResult.exitCode !== null || waitResult.signal !== null);

    await manager.releaseTerminal({
      sessionId: "session-1",
      terminalId: created.terminalId,
    });
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("terminal manager prompts in approve-reads mode and can deny", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-terminal-test-"));
  try {
    let confirmations = 0;
    const manager = new TerminalManager({
      cwd: tmp,
      permissionMode: "approve-reads",
      confirmExecute: async () => {
        confirmations += 1;
        return false;
      },
    });

    await assert.rejects(
      manager.createTerminal({
        sessionId: "session-1",
        command: process.execPath,
        args: ["-e", "console.log('blocked')"],
      }),
      /Permission denied for terminal\/create/,
    );
    assert.equal(confirmations, 1);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("terminal manager fails when prompt is unavailable and policy is fail", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-terminal-test-"));
  try {
    const manager = new TerminalManager({
      cwd: tmp,
      permissionMode: "approve-reads",
      nonInteractivePermissions: "fail",
    });

    await assert.rejects(
      manager.createTerminal({
        sessionId: "session-1",
        command: process.execPath,
        args: ["-e", "console.log('blocked')"],
      }),
      PermissionPromptUnavailableError,
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
