import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initGlobalConfigFile, loadResolvedConfig } from "../src/config.js";

test("loadResolvedConfig merges global and project config with project priority", async () => {
  await withTempEnv(async ({ homeDir }) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });

    await fs.writeFile(
      path.join(homeDir, ".acpx", "config.json"),
      `${JSON.stringify(
        {
          defaultAgent: "codex",
          defaultPermissions: "deny-all",
          nonInteractivePermissions: "fail",
          authPolicy: "fail",
          ttl: 15,
          timeout: 30,
          format: "json",
          agents: {
            custom: { command: "global-custom" },
          },
          auth: {
            global_method: "global-token",
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
          defaultPermissions: "approve-all",
          nonInteractivePermissions: "deny",
          authPolicy: "skip",
          ttl: 42,
          timeout: null,
          format: "quiet",
          agents: {
            custom: { command: "project-custom" },
            extra: { command: "./bin/extra" },
          },
          auth: {
            global_method: "project-override",
            project_method: "project-token",
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const config = await loadResolvedConfig(cwd);
    assert.equal(config.defaultAgent, "codex");
    assert.equal(config.defaultPermissions, "approve-all");
    assert.equal(config.nonInteractivePermissions, "deny");
    assert.equal(config.authPolicy, "skip");
    assert.equal(config.ttlMs, 42_000);
    assert.equal(config.timeoutMs, undefined);
    assert.equal(config.format, "quiet");
    assert.deepEqual(config.agents, {
      custom: "project-custom",
      extra: "./bin/extra",
    });
    assert.deepEqual(config.auth, {
      global_method: "project-override",
      project_method: "project-token",
    });
    assert.equal(config.hasGlobalConfig, true);
    assert.equal(config.hasProjectConfig, true);
  });
});

test("initGlobalConfigFile creates the config once and then reports existing file", async () => {
  await withTempEnv(async ({ homeDir }) => {
    const first = await initGlobalConfigFile();
    assert.equal(first.created, true);
    assert.equal(first.path, path.join(homeDir, ".acpx", "config.json"));

    const second = await initGlobalConfigFile();
    assert.equal(second.created, false);
    assert.equal(second.path, first.path);

    const payload = JSON.parse(await fs.readFile(first.path, "utf8")) as {
      defaultAgent: string;
      defaultPermissions: string;
      nonInteractivePermissions: string;
      authPolicy: string;
    };
    assert.equal(payload.defaultAgent, "codex");
    assert.equal(payload.defaultPermissions, "approve-all");
    assert.equal(payload.nonInteractivePermissions, "deny");
    assert.equal(payload.authPolicy, "skip");
  });
});

test("disableExec defaults to false when not set", async () => {
  await withTempEnv(async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-exec-"));
    try {
      const config = await loadResolvedConfig(cwd);
      assert.equal(config.disableExec, false);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("disableExec is read from global config", async () => {
  await withTempEnv(async ({ homeDir }) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });

    await fs.writeFile(
      path.join(homeDir, ".acpx", "config.json"),
      `${JSON.stringify({ disableExec: true }, null, 2)}\n`,
      "utf8",
    );

    const config = await loadResolvedConfig(cwd);
    assert.equal(config.disableExec, true);
  });
});

test("disableExec project config overrides global config", async () => {
  await withTempEnv(async ({ homeDir }) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });

    await fs.writeFile(
      path.join(homeDir, ".acpx", "config.json"),
      `${JSON.stringify({ disableExec: true }, null, 2)}\n`,
      "utf8",
    );

    await fs.writeFile(
      path.join(cwd, ".acpxrc.json"),
      `${JSON.stringify({ disableExec: false }, null, 2)}\n`,
      "utf8",
    );

    const config = await loadResolvedConfig(cwd);
    assert.equal(config.disableExec, false);
  });
});

test("disableExec rejects non-boolean values", async () => {
  await withTempEnv(async ({ homeDir }) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });

    await fs.writeFile(
      path.join(homeDir, ".acpx", "config.json"),
      `${JSON.stringify({ disableExec: "yes" }, null, 2)}\n`,
      "utf8",
    );

    await assert.rejects(
      () => loadResolvedConfig(cwd),
      (error: Error) => {
        assert.match(error.message, /disableExec/);
        assert.match(error.message, /boolean/);
        return true;
      },
    );
  });
});

async function withTempEnv(
  run: (ctx: { homeDir: string }) => Promise<void>,
): Promise<void> {
  const originalHome = process.env.HOME;

  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-config-home-"));
  process.env.HOME = homeDir;

  try {
    await run({ homeDir });
  } finally {
    if (originalHome == null) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }

    await fs.rm(homeDir, { recursive: true, force: true });
  }
}
