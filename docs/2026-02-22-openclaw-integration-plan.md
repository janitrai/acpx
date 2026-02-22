---
title: acpx OpenClaw Integration Plan
author: Onur <2453968+osolmaz@users.noreply.github.com>
date: 2026-02-22
---

# acpx OpenClaw Integration Plan

Plan for making `acpx` a robust runtime backend for OpenClaw ACP sessions in Discord threads.

## Context

OpenClaw will route bound Discord thread messages to ACP-backed sessions and use `acpx` as the data-plane runtime backend.

`acpx` already provides most required primitives:

- persistent sessions and named sessions
- queue owner with prompt queueing
- cooperative cancel
- TTL-based queue owner lifetime
- `--format json` streaming output

What is missing for production-safe orchestration is mostly machine-facing contract hardening.

## Goals

- Make `acpx` JSON output fully correlation-safe for orchestrators.
- Make failures machine-readable in JSON mode across all layers (CLI, runtime, queue, ACP).
- Make non-interactive permission behavior explicit and policy-driven.
- Add idempotent session ensure flow for orchestrators.
- Keep human CLI UX unchanged for default text mode.

## Non-goals

- No ACP protocol redesign.
- No daemon/server rewrite.
- No breaking changes to existing text output UX.

## Core design decision

Use a two-layer error contract:

- preserve ACP-native error details (numeric JSON-RPC `code`, `message`, optional `data`) when available
- expose stable `acpx` machine error codes for orchestrators

This avoids fragile text parsing while keeping ACP semantics visible for precise handling.

## Required changes

### 1. Correlation-safe JSON event envelope

Current `--format json` events do not consistently carry session/request correlation fields.

Add envelope fields to all JSON stream events:

- `eventVersion: 1`
- `sessionId: string`
- `requestId?: string`
- `seq: number` (monotonic per request stream)
- `stream: "prompt" | "control"`
- existing payload-specific fields (`type`, `content`, `toolCallId`, etc.)

Notes:

- `requestId` is required for queue-owner submitted turns.
- For direct (non-queued) local turn execution, `requestId` may be omitted.
- `seq` resets per request stream.

### 2. General structured JSON error contract

In JSON mode, all fatal failures should emit a structured final `error` event before exit.

Error event shape:

```json
{
  "type": "error",
  "code": "NO_SESSION|TIMEOUT|PERMISSION_DENIED|PERMISSION_PROMPT_UNAVAILABLE|RUNTIME|USAGE",
  "detailCode": "QUEUE_PROTOCOL_INVALID_JSON|QUEUE_OWNER_CLOSED|...",
  "origin": "cli|runtime|queue|acp",
  "message": "...",
  "retryable": true,
  "sessionId": "...",
  "requestId": "...",
  "timestamp": "...",
  "acp": {
    "code": -32002,
    "message": "Resource not found: ...",
    "data": {}
  }
}
```

Rules:

- `code` is stable, small, and orchestrator-friendly.
- `detailCode` is optional, more specific, and additive.
- `origin` identifies where normalization occurred.
- `acp` is optional and only included when there is a source ACP/JSON-RPC error.
- Text mode behavior remains unchanged.
- Exit codes remain unchanged.

### 3. Error normalization and mapping strategy

Add a single normalization path used by CLI, runtime, and queue IPC.

High-level `acpx` code mapping:

- `NO_SESSION`:
  - missing/invalid session state (for example ACP resource-not-found)
- `TIMEOUT`:
  - local timeout wrappers
- `PERMISSION_DENIED`:
  - explicit deny/cancel permission outcomes
- `PERMISSION_PROMPT_UNAVAILABLE`:
  - non-interactive policy is `fail` and prompt cannot be shown
- `USAGE`:
  - CLI argument/config usage failures
- `RUNTIME`:
  - everything else (spawn/runtime/protocol/queue/internal)

Queue `detailCode` values (initial set):

- `QUEUE_OWNER_CLOSED`
- `QUEUE_OWNER_SHUTTING_DOWN`
- `QUEUE_REQUEST_INVALID`
- `QUEUE_REQUEST_PAYLOAD_INVALID_JSON`
- `QUEUE_ACK_MISSING`
- `QUEUE_DISCONNECTED_BEFORE_ACK`
- `QUEUE_DISCONNECTED_BEFORE_COMPLETION`
- `QUEUE_PROTOCOL_INVALID_JSON`
- `QUEUE_PROTOCOL_MALFORMED_MESSAGE`
- `QUEUE_PROTOCOL_UNEXPECTED_RESPONSE`
- `QUEUE_NOT_ACCEPTING_REQUESTS`

ACP compatibility behavior:

- treat ACP `-32002` as canonical resource-not-found
- keep compatibility fallback for legacy/adapter variants (`-32001` or known message patterns) but do not rely on message parsing as primary behavior
- preserve raw ACP error in `acp` field whenever available

### 4. Explicit non-interactive permission policy

Current behavior in non-TTY environments effectively denies interactive approvals.

Add explicit option:

- `--non-interactive-permissions <deny|fail>`

Config key:

- `nonInteractivePermissions: "deny" | "fail"`

Default:

- `deny` (preserve current behavior)

Behavior:

- `deny`: reject permission request as today
- `fail`: abort with structured error (`PERMISSION_PROMPT_UNAVAILABLE`) so orchestrator can retry with different permission mode

### 5. Session ensure command

Add idempotent session ensure for orchestrators:

- `acpx <agent> sessions ensure [--name <name>]`

Behavior:

- if matching active session exists for `(agent command, cwd walk, optional name)`, return it
- otherwise create a new session and return it

JSON output:

```json
{
  "type": "session_ensured",
  "id": "...",
  "sessionId": "...",
  "name": "...",
  "created": true|false
}
```

### 6. Queue event parity in JSON mode

Ensure queued turn lifecycle emits deterministic machine stream:

- `accepted`
- zero or more streamed events
- `done`
- `result`

and on failures:

- `error` with `code`, `detailCode`, and `message` (plus `acp` when relevant)

### 7. Cancellation semantics

Align with ACP prompt-turn behavior:

- normal cancel path is not an error
- cancelled turns should complete with `done`/`result` and `stopReason = "cancelled"`
- queue `error` should only be used for transport/protocol/runtime failures, not expected cancellation completion

## Backward compatibility

- Text mode output remains unchanged.
- Existing JSON consumers continue to receive `type` and existing fields.
- New envelope fields are additive.
- Queue error parsing should accept both old shape (`message` only) and new shape (`code/detailCode/message`) during rollout.
- Exit codes unchanged.

## Implementation sketch

Primary files:

- `src/types.ts`
  - extend `OutputEvent` for `detailCode`, `origin`, optional `acp` payload
- `src/errors.ts` (or new `src/error-normalization.ts`)
  - centralized error normalization to `acpx` machine codes
- `src/output.ts`
  - emit envelope fields and `seq`
- `src/session-runtime.ts`
  - plumb `sessionId/requestId` context and preserve structured error fields
- `src/queue-ipc.ts`
  - ensure request lifecycle always surfaces typed queue failures
- `src/queue-messages.ts`
  - extend queue `error` message schema with typed fields and compatibility parser
- `src/permissions.ts` + `src/permission-prompt.ts`
  - add non-interactive policy behavior
- `src/cli.ts`
  - parse new flag/config and emit normalized structured errors in JSON mode
- `src/config.ts`
  - config key for non-interactive policy

## Phased delivery

### Phase 1 (MVP hardening)

- JSON envelope (`eventVersion/sessionId/requestId/seq`)
- structured JSON errors
- session ensure command

### Phase 2 (policy hardening)

- non-interactive permission policy flag + config
- centralized error normalization
- queue failure typing cleanup (typed queue codes, not message-only)
- compatibility fallback for legacy ACP resource-not-found variants

### Phase 3 (polish)

- docs updates (`README.md`, `docs/CLI.md`)
- end-to-end examples for orchestrators

## Testing plan

Unit tests:

- output formatter JSON envelope fields and sequence behavior
- structured error mapping from exit paths
- normalization matrix (ACP `RequestError`, queue protocol errors, permission errors, usage errors)
- ensure command path resolution (`created=true|false`)
- non-interactive permission policy behavior (`deny|fail`)
- queue parser compatibility: old + new `error` payload shapes

Integration tests:

- queued request emits deterministic JSON lifecycle
- timeout path returns structured error event and expected exit code
- no-session path returns structured error in JSON mode
- queue disconnect/protocol-failure paths return typed queue `detailCode`
- cancellation path resolves with `stopReason: "cancelled"` (not queue `error`)

Regression tests:

- text mode snapshots unchanged
- existing queue behavior unchanged for non-JSON mode

## Acceptance criteria

- every JSON event in streamed prompt mode includes `eventVersion`, `sessionId`, and `seq`
- queue-submitted turns include `requestId` on all events
- JSON mode failures emit at least one structured `error` event before exit, with stable `code`
- `sessions ensure` is idempotent and returns deterministic JSON
- non-interactive permission behavior is explicitly configurable
- queue failures include machine-readable typed error fields (not message-only)
- ACP error details are preserved when available

## Open questions

- Should we add a first-class top-level `AUTH_REQUIRED` `acpx` code, or keep it under `RUNTIME` + `acp.code=-32000`?
- Should we add `--json-strict` that suppresses all non-JSON stderr output?
