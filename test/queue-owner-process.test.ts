import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { resolveQueueOwnerSpawnArgs } from "../src/session-runtime/queue-owner-process.js";

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "acpx-queue-owner-path-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("resolveQueueOwnerSpawnArgs", () => {
  it("returns <real cli path> and __queue-owner", async () => {
    await withTempDir(async (dir) => {
      const cliFile = path.join(dir, "cli.js");
      const cliLink = path.join(dir, "acpx-link.js");
      await writeFile(cliFile, "// stub\n", "utf8");
      await symlink(cliFile, cliLink);

      const args = resolveQueueOwnerSpawnArgs(["node", cliLink]);
      assert.deepEqual(args, [realpathSync(cliLink), "__queue-owner"]);
    });
  });

  it("throws when argv lacks an entry path", () => {
    assert.throws(() => resolveQueueOwnerSpawnArgs(["node"]), {
      message: "acpx self-spawn failed: missing CLI entry path",
    });
  });
});
