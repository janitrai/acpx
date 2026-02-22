import assert from "node:assert/strict";
import test from "node:test";
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { PermissionPromptUnavailableError } from "../src/errors.js";
import { resolvePermissionRequest } from "../src/permissions.js";

const BASE_OPTIONS = [
  { optionId: "allow", kind: "allow_once" },
  { optionId: "reject", kind: "reject_once" },
] as const;

function makeRequest(
  kind: RequestPermissionRequest["toolCall"]["kind"],
): RequestPermissionRequest {
  return {
    sessionId: "session-1",
    toolCall: {
      toolCallId: "tool-1",
      kind,
      title: "tool call",
    },
    options: BASE_OPTIONS.map((option) => ({ ...option })),
  } as RequestPermissionRequest;
}

function withNonTty<T>(run: () => Promise<T>): Promise<T> {
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const stderrDescriptor = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");

  Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
  Object.defineProperty(process.stderr, "isTTY", { value: false, configurable: true });

  return run().finally(() => {
    if (stdinDescriptor) {
      Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
    } else {
      delete (process.stdin as { isTTY?: boolean }).isTTY;
    }

    if (stderrDescriptor) {
      Object.defineProperty(process.stderr, "isTTY", stderrDescriptor);
    } else {
      delete (process.stderr as { isTTY?: boolean }).isTTY;
    }
  });
}

test("approve-all approves everything", async () => {
  const request = makeRequest("execute");
  const response = await resolvePermissionRequest(request, "approve-all");
  assert.deepEqual(response, { outcome: { outcome: "selected", optionId: "allow" } });
});

test("deny-all denies everything", async () => {
  const request = makeRequest("execute");
  const response = await resolvePermissionRequest(request, "deny-all");
  assert.deepEqual(response, { outcome: { outcome: "selected", optionId: "reject" } });
});

test("approve-reads approves reads and denies writes", async () => {
  await withNonTty(async () => {
    const readResponse = await resolvePermissionRequest(
      makeRequest("read"),
      "approve-reads",
    );
    assert.deepEqual(readResponse, {
      outcome: { outcome: "selected", optionId: "allow" },
    });

    const writeResponse = await resolvePermissionRequest(
      makeRequest("edit"),
      "approve-reads",
    );
    assert.deepEqual(writeResponse, {
      outcome: { outcome: "selected", optionId: "reject" },
    });
  });
});

test("non-interactive policy fail throws when prompt is required", async () => {
  await withNonTty(async () => {
    await assert.rejects(
      async () =>
        await resolvePermissionRequest(makeRequest("edit"), "approve-reads", "fail"),
      PermissionPromptUnavailableError,
    );
  });
});
