import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initGlobalConfigFile, loadResolvedConfig } from "../src/config.js";

test("loadResolvedConfig merges global and project config with project priority", async () => {
  await withTempEnv(async ({ homeDir, xdgConfigHome }) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(path.join(xdgConfigHome, "acpx"), { recursive: true });

    await fs.writeFile(
      path.join(xdgConfigHome, "acpx", "config.json"),
      `${JSON.stringify(
        {
          defaultAgent: "codex",
          defaultPermissions: "deny-all",
          ttl: 15,
          timeout: 30,
          format: "json",
          agents: {
            custom: { command: "global-custom" },
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
          ttl: 42,
          timeout: null,
          format: "quiet",
          agents: {
            custom: { command: "project-custom" },
            extra: { command: "./bin/extra" },
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
    assert.equal(config.ttlMs, 42_000);
    assert.equal(config.timeoutMs, undefined);
    assert.equal(config.format, "quiet");
    assert.deepEqual(config.agents, {
      custom: "project-custom",
      extra: "./bin/extra",
    });
    assert.equal(config.hasGlobalConfig, true);
    assert.equal(config.hasProjectConfig, true);
  });
});

test("initGlobalConfigFile creates the config once and then reports existing file", async () => {
  await withTempEnv(async ({ xdgConfigHome }) => {
    const first = await initGlobalConfigFile();
    assert.equal(first.created, true);
    assert.equal(first.path, path.join(xdgConfigHome, "acpx", "config.json"));

    const second = await initGlobalConfigFile();
    assert.equal(second.created, false);
    assert.equal(second.path, first.path);

    const payload = JSON.parse(await fs.readFile(first.path, "utf8")) as {
      defaultAgent: string;
      defaultPermissions: string;
    };
    assert.equal(payload.defaultAgent, "codex");
    assert.equal(payload.defaultPermissions, "approve-all");
  });
});

async function withTempEnv(
  run: (ctx: { homeDir: string; xdgConfigHome: string }) => Promise<void>,
): Promise<void> {
  const originalHome = process.env.HOME;
  const originalXdg = process.env.XDG_CONFIG_HOME;

  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-config-home-"));
  const xdgConfigHome = path.join(homeDir, "xdg");
  process.env.HOME = homeDir;
  process.env.XDG_CONFIG_HOME = xdgConfigHome;

  try {
    await run({ homeDir, xdgConfigHome });
  } finally {
    if (originalHome == null) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }

    if (originalXdg == null) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalXdg;
    }

    await fs.rm(homeDir, { recursive: true, force: true });
  }
}
