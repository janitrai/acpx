---
title: ACPX Error Strategy
author: Onur <2453968+osolmaz@users.noreply.github.com>
date: 2026-02-22
---

# ACPX Error Strategy

Permanent machine-facing error contract for `acpx` orchestrators (for example OpenClaw).

## Scope

This document defines how `acpx` should represent errors across:

- CLI entrypoints
- runtime/session execution
- queue owner IPC
- ACP protocol boundary

## Design principles

- Keep ACP semantics intact when available.
- Provide stable `acpx` codes for orchestrator logic.
- Avoid parsing free-form message text.
- Keep text mode UX unchanged.
- Make changes additive to preserve backward compatibility.

## Two-layer contract

`acpx` should expose both:

- `acpx` machine codes (stable, small enum for orchestration)
- raw ACP error details (numeric JSON-RPC code/message/data) when the source error is ACP-native

## JSON error event shape

In JSON mode, fatal failures should emit:

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

Field rules:

- `code`: required stable `acpx` code.
- `detailCode`: optional, fine-grained diagnostics.
- `origin`: optional source classification for debugging and metrics.
- `retryable`: optional hint for orchestrator retry policy.
- `acp`: optional raw ACP/JSON-RPC error envelope when available.

## Top-level `acpx` codes

- `NO_SESSION`: session missing/invalid (including ACP resource-not-found).
- `TIMEOUT`: local timeout wrappers fired.
- `PERMISSION_DENIED`: permission request denied/cancelled by policy/user.
- `PERMISSION_PROMPT_UNAVAILABLE`: non-interactive prompt policy is `fail` and prompt cannot be shown.
- `USAGE`: CLI/config invocation errors.
- `RUNTIME`: all other failures.

## Queue detail codes (initial set)

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

## ACP compatibility rules

- Treat ACP `-32002` as canonical resource-not-found.
- Keep compatibility fallback for legacy variants (`-32001` or known historical message forms), but do not use message parsing as primary detection.
- Preserve raw ACP error in `acp` whenever available.

## Cancellation semantics

Cancellation is a normal completion path, not an error path:

- expected result is `done`/`result` with `stopReason = "cancelled"`
- queue `error` should be used only for transport/protocol/runtime failure

## Rollout and compatibility

- Queue error parsing should accept both old (`message` only) and new (`code/detailCode/message`) payload shapes during migration.
- Text mode output and existing exit codes stay unchanged.
- New JSON fields remain additive.

## Implementation notes

- Use one shared normalization path (for example `src/error-normalization.ts`) consumed by CLI, runtime, and queue.
- Avoid duplicate mapping logic per layer.
- Keep mapping tests table-driven to prevent drift.

## Testing requirements

Unit:

- normalization mapping matrix (ACP/native/runtime/queue/usage/permission/timeouts)
- queue parse compatibility for old and new error payloads

Integration:

- queue disconnect/protocol failures emit typed `detailCode`
- no-session, timeout, permission paths emit structured error with expected `code`
- cancel flow ends with `stopReason = "cancelled"` and no spurious queue error
