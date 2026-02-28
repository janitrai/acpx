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

Canonical permanent reference for error behavior:

- `docs/ACPX_ERROR_STRATEGY.md`

## Goals

- Make `acpx` JSON stream ACP-pure for orchestrators.
- Make failures machine-readable in JSON mode across all layers (CLI, runtime, queue, ACP).
- Make non-interactive permission behavior explicit and policy-driven.
- Add idempotent session ensure flow for orchestrators.
- Keep human CLI UX unchanged for default text mode.

## Non-goals

- No ACP protocol redesign.
- No daemon/server rewrite.
- No breaking changes to existing text output UX.

## Core design decision

Use a two-layer error contract (fully specified in `docs/ACPX_ERROR_STRATEGY.md`):

- preserve ACP-native error details (numeric JSON-RPC `code`, `message`, optional `data`) when available
- expose stable `acpx` machine error codes for orchestrators

## Resolved decisions

- Keep top-level `AUTH_REQUIRED` under `code=RUNTIME` with `detailCode=AUTH_REQUIRED` and preserve raw ACP details (`acp.code=-32000` etc.) when available.
- Add `--json-strict` for orchestrators that require JSON-only output channels; it requires `--format json` and suppresses non-JSON stderr output.

## Required changes

### 1. ACP-only JSON stream

Current JSON output includes acpx-specific envelope/event objects.

Replace that with strict ACP JSON-RPC stream behavior:

- `--format json --json-strict` stdout emits only raw ACP JSON-RPC messages.
- no acpx-specific stream envelope fields (`eventVersion`, `sessionId`, `seq`, `stream`, custom `type`).
- no ACP payload key renaming in stream messages.
- local orchestration metadata stays out-of-band (checkpoint/state/status APIs), not in stream payloads.

### 2. General structured JSON error contract

Adopt the permanent contract in `docs/ACPX_ERROR_STRATEGY.md`:

- stable top-level `acpx` error `code`
- optional `detailCode` for fine-grained diagnostics (especially queue IPC)
- optional raw ACP error payload for protocol-native failures
- additive JSON fields, unchanged text mode and exit codes
- auth-required behavior represented as `code=RUNTIME` plus `detailCode=AUTH_REQUIRED`

### 3. Error normalization and mapping strategy

Implement one shared normalization path consumed by CLI, runtime, and queue layers, as specified in `docs/ACPX_ERROR_STRATEGY.md`.

### 3.1 Strict JSON mode for orchestrators

Add:

- `--json-strict`

Behavior:

- requires `--format json`
- rejects `--verbose` (to avoid debug stderr noise)
- suppresses non-JSON stderr output paths (for example Commander usage/help banners)

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

- `error` with typed fields as defined in `docs/ACPX_ERROR_STRATEGY.md`

### 7. Cancellation semantics

Align with ACP prompt-turn behavior per `docs/ACPX_ERROR_STRATEGY.md`:

- normal cancel path is not an error
- cancelled turns should complete with `done`/`result` and `stopReason = "cancelled"`

### 8. Output and error-emission ownership refactor

Current error/output behavior is spread across CLI/runtime/queue/client layers, which causes recurring regressions (duplicate errors, missing errors, and strict-mode leakage).

Add one ownership boundary for emission policy:

- define a single resolved output policy from CLI flags (`format`, `jsonStrict`, `verbose`)
- route all final error emission decisions through one policy path
- keep queue/runtime focused on producing typed errors, not deciding fallback emission behavior
- replace ad-hoc emission markers with explicit policy-driven behavior for queued failures
- enforce `json-strict` channel guarantees for runtime failures, not only Commander output
- guarantee non-silent non-zero exits in non-JSON modes, including queued failure paths

## Backward compatibility

- Text mode output remains unchanged.
- Existing JSON consumers continue to receive `type` and existing fields.
- New envelope fields are additive.
- Queue error parsing should accept both old shape (`message` only) and new typed shape during rollout.
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

- ACP-only JSON stream contract
- structured JSON errors
- session ensure command

### Phase 2 (policy hardening)

- non-interactive permission policy flag + config
- centralized error normalization
- queue failure typing cleanup (typed queue codes, not message-only)
- compatibility fallback for legacy ACP resource-not-found variants
- output/error emission ownership refactor (single policy path across CLI/runtime/queue/client)

### Phase 3 (polish)

- docs updates (`README.md`, `docs/CLI.md`)
- end-to-end examples for orchestrators

## Testing plan

Unit tests:

- output formatter ACP pass-through behavior in JSON mode
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
- output-policy matrix:
- `text|quiet|json` x `jsonStrict on|off` x `direct|queued` failure paths
- assert no duplicate error emission, no missing terminal diagnostics, and no non-JSON leakage in strict mode

## Acceptance criteria

- every JSON line in streamed prompt mode is a valid ACP JSON-RPC message
- no acpx-specific envelope/event keys are emitted on ACP stream
- JSON mode failures emit structured machine-readable diagnostics without violating JSON-only strict mode
- auth-required failures include `detailCode=AUTH_REQUIRED` and preserve ACP payload when present
- `sessions ensure` is idempotent and returns deterministic JSON
- `--json-strict` enforces JSON-only output behavior
- non-interactive permission behavior is explicitly configurable
- queue failures include machine-readable typed error fields (not message-only)
- ACP error details are preserved when available
- error emission behavior is policy-consistent across direct and queued failures (no duplicates, no silent non-zero exits)
