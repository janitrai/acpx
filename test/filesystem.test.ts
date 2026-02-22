import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PermissionPromptUnavailableError } from "../src/errors.js";
import { FileSystemHandlers } from "../src/filesystem.js";
import type { ClientOperation } from "../src/types.js";

test("readTextFile respects line/limit and logs operations", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fs-test-"));
  try {
    const filePath = path.join(tmp, "notes.txt");
    await fs.writeFile(filePath, "one\ntwo\nthree\nfour\n", "utf8");

    const ops: ClientOperation[] = [];
    const handlers = new FileSystemHandlers({
      cwd: tmp,
      permissionMode: "approve-reads",
      onOperation: (operation) => ops.push(operation),
    });

    const response = await handlers.readTextFile({
      sessionId: "session-1",
      path: filePath,
      line: 2,
      limit: 2,
    });

    assert.equal(response.content, "two\nthree");
    assert.equal(
      ops.some(
        (operation) =>
          operation.method === "fs/read_text_file" && operation.status === "completed",
      ),
      true,
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("readTextFile is denied in deny-all mode", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fs-test-"));
  try {
    const filePath = path.join(tmp, "notes.txt");
    await fs.writeFile(filePath, "hello", "utf8");

    const handlers = new FileSystemHandlers({
      cwd: tmp,
      permissionMode: "deny-all",
    });

    await assert.rejects(
      handlers.readTextFile({
        sessionId: "session-1",
        path: filePath,
      }),
      /Permission denied for fs\/read_text_file/,
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("writeTextFile prompts in approve-reads mode and can deny", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fs-test-"));
  try {
    let confirmCalls = 0;
    const handlers = new FileSystemHandlers({
      cwd: tmp,
      permissionMode: "approve-reads",
      confirmWrite: async () => {
        confirmCalls += 1;
        return false;
      },
    });

    await assert.rejects(
      handlers.writeTextFile({
        sessionId: "session-1",
        path: path.join(tmp, "blocked.txt"),
        content: "blocked",
      }),
      /Permission denied for fs\/write_text_file/,
    );
    assert.equal(confirmCalls, 1);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("writeTextFile fails when prompt is unavailable and policy is fail", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fs-test-"));
  try {
    const handlers = new FileSystemHandlers({
      cwd: tmp,
      permissionMode: "approve-reads",
      nonInteractivePermissions: "fail",
    });

    await assert.rejects(
      handlers.writeTextFile({
        sessionId: "session-1",
        path: path.join(tmp, "blocked.txt"),
        content: "blocked",
      }),
      PermissionPromptUnavailableError,
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("writeTextFile blocks paths outside cwd subtree", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fs-test-"));
  try {
    const outside = path.resolve(tmp, "..", "outside.txt");
    const handlers = new FileSystemHandlers({
      cwd: tmp,
      permissionMode: "approve-all",
    });

    await assert.rejects(
      handlers.writeTextFile({
        sessionId: "session-1",
        path: outside,
        content: "nope",
      }),
      /outside allowed cwd subtree/,
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("readTextFile requires absolute paths", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fs-test-"));
  try {
    const handlers = new FileSystemHandlers({
      cwd: tmp,
      permissionMode: "approve-reads",
    });

    await assert.rejects(
      handlers.readTextFile({
        sessionId: "session-1",
        path: "relative.txt",
      }),
      /Path must be absolute/,
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
