import assert from "node:assert/strict";
import test from "node:test";
import type { SetSessionConfigOptionResponse } from "@agentclientprotocol/sdk";
import {
  QueueOwnerTurnController,
  type QueueOwnerActiveSessionController,
} from "../src/queue-owner-turn-controller.js";

test("QueueOwnerTurnController tracks explicit lifecycle states", async () => {
  const controller = createQueueOwnerTurnController();
  assert.equal(controller.lifecycleState, "idle");

  controller.beginTurn();
  assert.equal(controller.lifecycleState, "starting");

  controller.markPromptActive();
  assert.equal(controller.lifecycleState, "active");

  controller.endTurn();
  assert.equal(controller.lifecycleState, "idle");

  controller.beginClosing();
  assert.equal(controller.lifecycleState, "closing");
  const cancelled = await controller.requestCancel();
  assert.equal(cancelled, false);
});

test("QueueOwnerTurnController cancels immediately for active prompts", async () => {
  const controller = createQueueOwnerTurnController();
  let cancelCalls = 0;

  controller.beginTurn();
  controller.setActiveController(
    makeActiveController({
      hasActivePrompt: () => true,
      requestCancelActivePrompt: async () => {
        cancelCalls += 1;
        return true;
      },
    }),
  );
  controller.markPromptActive();

  const cancelled = await controller.requestCancel();
  assert.equal(cancelled, true);
  assert.equal(cancelCalls, 1);
  assert.equal(controller.hasPendingCancel, false);
});

test("QueueOwnerTurnController defers cancel while turn is starting", async () => {
  const controller = createQueueOwnerTurnController();
  let promptActive = false;
  let cancelCalls = 0;

  controller.beginTurn();
  controller.setActiveController(
    makeActiveController({
      hasActivePrompt: () => promptActive,
      requestCancelActivePrompt: async () => {
        cancelCalls += 1;
        return promptActive;
      },
    }),
  );

  const accepted = await controller.requestCancel();
  assert.equal(accepted, true);
  assert.equal(cancelCalls, 0);
  assert.equal(controller.hasPendingCancel, true);

  const beforeActive = await controller.applyPendingCancel();
  assert.equal(beforeActive, false);
  assert.equal(cancelCalls, 0);
  assert.equal(controller.hasPendingCancel, true);

  promptActive = true;
  controller.markPromptActive();
  const afterActive = await controller.applyPendingCancel();
  assert.equal(afterActive, true);
  assert.equal(cancelCalls, 1);
  assert.equal(controller.hasPendingCancel, false);
});

test("QueueOwnerTurnController routes setSessionMode through active controller", async () => {
  let activeCalls = 0;
  let fallbackCalls = 0;
  const observedTimeouts: Array<number | undefined> = [];
  const fallbackTimeouts: Array<number | undefined> = [];

  const controller = createQueueOwnerTurnController({
    withTimeout: async (run, timeoutMs) => {
      observedTimeouts.push(timeoutMs);
      return await run();
    },
    setSessionModeFallback: async (_modeId, timeoutMs) => {
      fallbackCalls += 1;
      fallbackTimeouts.push(timeoutMs);
    },
  });

  controller.setActiveController(
    makeActiveController({
      setSessionMode: async () => {
        activeCalls += 1;
      },
    }),
  );

  await controller.setSessionMode("plan", 1250);
  assert.equal(activeCalls, 1);
  assert.equal(fallbackCalls, 0);
  assert.deepEqual(observedTimeouts, [1250]);
  assert.deepEqual(fallbackTimeouts, []);
});

test("QueueOwnerTurnController routes setSessionConfigOption through fallback when inactive", async () => {
  let fallbackCalls = 0;
  const fallbackTimeouts: Array<number | undefined> = [];

  const controller = createQueueOwnerTurnController({
    setSessionConfigOptionFallback: async (_configId, _value, timeoutMs) => {
      fallbackCalls += 1;
      fallbackTimeouts.push(timeoutMs);
      return { configOptions: [] };
    },
  });

  const response = await controller.setSessionConfigOption(
    "approval_policy",
    "strict",
    2300,
  );
  assert.equal(fallbackCalls, 1);
  assert.deepEqual(fallbackTimeouts, [2300]);
  assert.deepEqual(response, { configOptions: [] });
});

test("QueueOwnerTurnController rejects control requests while closing", async () => {
  let setModeFallbackCalls = 0;
  let setConfigFallbackCalls = 0;
  const controller = createQueueOwnerTurnController({
    setSessionModeFallback: async () => {
      setModeFallbackCalls += 1;
    },
    setSessionConfigOptionFallback: async () => {
      setConfigFallbackCalls += 1;
      return { configOptions: [] };
    },
  });

  controller.beginClosing();

  await assert.rejects(
    async () => await controller.setSessionMode("plan"),
    /Queue owner is closing/,
  );
  await assert.rejects(
    async () => await controller.setSessionConfigOption("k", "v"),
    /Queue owner is closing/,
  );
  assert.equal(setModeFallbackCalls, 0);
  assert.equal(setConfigFallbackCalls, 0);
});

type QueueOwnerTurnControllerOverrides = Partial<{
  withTimeout: <T>(run: () => Promise<T>, timeoutMs?: number) => Promise<T>;
  setSessionModeFallback: (modeId: string, timeoutMs?: number) => Promise<void>;
  setSessionConfigOptionFallback: (
    configId: string,
    value: string,
    timeoutMs?: number,
  ) => Promise<SetSessionConfigOptionResponse>;
}>;

function createQueueOwnerTurnController(
  overrides: QueueOwnerTurnControllerOverrides = {},
): QueueOwnerTurnController {
  const withTimeout =
    overrides.withTimeout ??
    (async <T>(run: () => Promise<T>): Promise<T> => await run());
  const setSessionModeFallback =
    overrides.setSessionModeFallback ??
    (async (): Promise<void> => {
      // no-op
    });
  const setSessionConfigOptionFallback =
    overrides.setSessionConfigOptionFallback ??
    (async () => ({
      configOptions: [],
    }));

  return new QueueOwnerTurnController({
    withTimeout,
    setSessionModeFallback,
    setSessionConfigOptionFallback,
  });
}

type ActiveControllerOverrides = Partial<QueueOwnerActiveSessionController>;

function makeActiveController(
  overrides: ActiveControllerOverrides = {},
): QueueOwnerActiveSessionController {
  return {
    hasActivePrompt: overrides.hasActivePrompt ?? (() => false),
    requestCancelActivePrompt:
      overrides.requestCancelActivePrompt ?? (async () => false),
    setSessionMode:
      overrides.setSessionMode ??
      (async () => {
        // no-op
      }),
    setSessionConfigOption:
      overrides.setSessionConfigOption ?? (async () => ({ configOptions: [] })),
  };
}
