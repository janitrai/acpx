---
title: Warm Session Owner Architecture (Detached Mode)
description: Long-term production design for non-blocking CLI calls with persistent warm ACP sessions.
author: Bob <bob@dutifulbob.com>
date: 2026-02-25
---

## Why this document exists

`acpx` currently keeps prompt queue ownership in the foreground caller process. That enables queue reuse, but it also means a direct CLI call can appear "hung" after `[done] end_turn` while the owner waits for idle TTL expiry.

For orchestrators and terminal users, the target behavior is:

- keep sessions warm and reusable
- return control to the caller as soon as the turn finishes
- keep queueing, cancel, and control operations reliable under crashes/restarts

This document defines that target architecture.

## Problem summary (current behavior)

Today, `acpx` prompt flow behaves like this:

1. caller acquires queue-owner lease for a session
2. same caller process runs the active turn
3. same caller process stays alive waiting for queue tasks until idle TTL
4. process exits when TTL expires or owner is terminated

Consequence:

- direct CLI usage can block after final output even though the turn is complete
- shell integrations and scripts see this as "hang"
- warm-session behavior and caller lifecycle are coupled

## Goals

1. Non-blocking caller lifecycle

- `acpx <agent> prompt ...` exits immediately after turn completion.
- caller does not wait for owner idle TTL.

2. Persistent warm sessions

- one owner process per session stays alive in background.
- owner keeps ACP session state warm across prompts.

3. Single-writer concurrency model

- exactly one active owner per session.
- all turn/control mutations serialize through owner actor.

4. Crash-safe recovery

- stale locks and dead owners are detected and reclaimed.
- subsequent calls can recover automatically.

5. Orchestrator-friendly semantics

- queueing, cancel, set-mode, set-config behave identically from CLI and orchestrators.
- predictable timeouts and explicit error codes.

## OpenClaw-specific expectations

For OpenClaw ACP runtime usage, detached warm owners must provide:

1. Fast thread turn handling

- thread message -> enqueue prompt -> stream output -> complete response
- no hidden 300s wait in gateway-facing process paths

2. Stable session affinity

- one OpenClaw ACP session maps to one `acpx` owner target at a time
- follow-up turns reliably route to same warm owner until close/reset

3. Safe concurrent thread load

- multiple bound sessions can run in parallel without cross-session contention
- each owner remains isolated by `sessionId`

4. Recovery after restart/crash

- OpenClaw can reconnect to existing warm owner if alive
- otherwise it can recreate owner without manual intervention

## Non-goals

- replacing ACP wire behavior with custom transport
- changing ACP semantics of prompt/cancel/mode/config calls
- cross-machine distributed queue ownership (design remains local-host scoped)

## Target architecture (holy grail)

### High-level model

Split `acpx` into two roles:

1. Session owner daemon (detached)

- long-lived per-session actor
- owns ACP client connection and turn queue
- enforces ordering and session-local policy
- survives beyond a single CLI invocation

2. Thin request client (foreground command)

- discovers or spawns owner
- submits one request and optionally streams its result
- exits when request completes (or on explicit no-wait path)

### Process topology

For one session id:

- at most one owner daemon process
- many short-lived request clients

For many sessions:

- one owner daemon per active session
- independent lifecycle per owner (idle TTL, close, crash recovery)

## State model

### Session record (`~/.acpx/sessions/*.json`)

Keep current session metadata and extend with owner state projection:

- `acpxRecordId`
- `acpxSessionId`
- `agentSessionId` (optional)
- `agentCommand`, `cwd`, `name`
- `closed`, `closedAt`
- `owner`: `{ pid, socketPath, startedAt, lastHeartbeatAt, status }` (best-effort projection)

Important rule:

- owner projection is advisory only; source of truth is lease + heartbeat checks.

### Owner lease record (`~/.acpx/queues/*.lock`)

Lease remains the single ownership token:

- `sessionId`
- `pid`
- `socketPath`
- `createdAt`
- `protocolVersion`
- `ownerGeneration`

Generation increments each owner spawn to prevent stale takeover races.

### IPC socket

- Unix domain socket (or Windows named pipe)
- owner accepts queue/control requests and emits request-scoped responses

## Current implementation checkpoints (to be replaced)

These current behaviors explain the blocking UX and define migration targets:

- queue lease currently stores the foreground caller pid (`process.pid`) when ownership is acquired
- owner loop currently runs in the same process that handled the caller prompt
- caller currently waits in owner idle loop until TTL expiry
- subsequent callers already know how to submit to running owner via socket/lock

Detached mode keeps the socket protocol model but moves owner loop into a separate spawned process.

## Request lifecycle

### Prompt (wait for completion)

1. resolve session record
2. discover running owner from lease + heartbeat
3. if missing, spawn detached owner and wait for readiness handshake
4. submit prompt request with `requestId`
5. stream request-scoped updates (`thinking`, `tool_call`, `text`, `done`)
6. client exits immediately on final `done`/terminal error

### Prompt (`--no-wait`)

Same as above, but caller exits after enqueue ack.

### Cancel / set-mode / set-config

- always routed to owner when owner exists
- fallback to direct reconnect path only when no owner exists
- owner remains canonical execution path

## Detached owner behavior

### Startup

1. acquire lease atomically
2. bind IPC endpoint
3. publish readiness
4. initialize ACP client lazily on first task (or eagerly if configured)

### Event loop

- dequeue next request
- execute request in strict session order
- publish request-scoped output frames
- update last-activity timestamp

### Idle policy

Separate concepts:

- `ownerIdleTtlMs`: owner shutdown after inactivity
- `turnTimeoutMs`: max runtime per prompt request
- optional `ownerMaxLifetimeMs`: hard cap for daemon recycling

### Shutdown

Owner exits on:

- explicit `sessions close`
- idle TTL expiry
- fatal unrecoverable runtime errors
- graceful process termination signals

And always:

- flush and close IPC
- release lease/socket
- persist final owner status

## Error model

### Request-scoped errors

Returned to caller with stable machine fields:

- `code`
- `detailCode`
- `origin` (`queue` | `runtime` | `protocol` | `permission`)
- `retryable`
- optional ACP payload snapshot

### Owner-level errors

- owner crash: lease reclaimed by next caller after heartbeat/pid validation
- owner unresponsive: timeout and failover spawn
- stale socket: cleanup + respawn

### Design rule

- caller must never block indefinitely waiting for owner frames
- every request has explicit timeout and terminal outcome

## Observability

Add first-class counters/log fields:

- owner spawn count / failure count
- active owners
- queue depth per session
- request enqueue latency
- prompt turn latency
- cancel success/timeout counts
- owner takeover count (stale lease recovery)

Structured logs should always include:

- `sessionId`
- `requestId` (if applicable)
- `ownerPid`
- `ownerGeneration`

## Adapter command strategy

For startup speed and determinism:

- prefer direct adapter binaries in config (for example `codex-acp`, `claude-agent-acp`, `opencode acp`)
- keep `npx -y ...` only as fallback defaults
- recommend preinstall + prewarm for high-traffic adapters

This keeps owner spawn fast and removes first-run package-install stalls.

## Security and safety

- owner IPC endpoint should be local-user scoped
- validate all IPC payloads with strict schemas
- reject unknown request types and invalid values early
- avoid passing arbitrary shell interpolation in default registry commands
- enforce bounded request payload size for IPC

## Delivery approach (single-pass)

- implement detached owner mode as the only owner mode
- remove foreground owner loop in the same change set
- keep CLI/API command surface stable (`prompt`, `--no-wait`, `cancel`, `set-mode`, `set`, `sessions`)
- keep existing session files and queue lock paths; reclaim stale records on first contact
- no feature flag and no parallel legacy path

## Implementation plan (single-pass)

1. Owner process entrypoint

- add dedicated internal owner command entrypoint
- add detached spawn helper and owner readiness handshake

2. Queue IPC protocol v2

- add explicit request envelope (`requestId`, `deadline`, request kind)
- add owner hello/ready frame and request terminal frame guarantees

3. Session runtime split

- convert caller path into request client only
- move queue/turn loop fully into detached owner process

4. Lease and heartbeat hardening

- add heartbeat timestamp updates from owner
- enforce stale owner recovery using `pid`, heartbeat age, and generation

5. Config surface

- add `ownerIdleTtlSeconds` and `turnTimeoutSeconds`
- keep one default profile for all environments

6. Status and observability

- expose owner health and queue depth in `status` output (text + json)
- emit structured lifecycle metrics/log fields for owner spawn/exit/takeover

7. Cleanup

- remove caller-side idle wait loop and foreground-owner-only branches
- preserve `sessions close` and reconnect semantics on top of detached owners

## Test plan

### Unit tests

- owner lease acquisition/release and stale recovery
- request timeout and terminal outcome guarantees
- generation mismatch rejection
- heartbeat stale detection behavior

### Integration tests

- caller exits right after `done` while owner remains alive
- second prompt reuses warm owner without spawn
- owner crash between requests -> automatic takeover and retry
- cancel and mode/config operations while prompt active

### Manual smoke

1. `acpx <agent> sessions ensure`
2. `time acpx <agent> prompt "say hi"`
3. verify immediate exit after done
4. send second prompt; verify warm reuse
5. `acpx <agent> sessions close`; verify owner stops and lease removed

## Acceptance criteria

1. `prompt` no longer waits for idle TTL before process exit.
2. Exactly one owner daemon serves each active session.
3. Queueing/cancel/control behavior remains deterministic under concurrency.
4. Crash and stale-lock recovery works without manual cleanup.
5. CLI and orchestrator paths share one owner protocol and semantics.
6. Metrics/logs are sufficient to debug live owner and queue state.

## Scope decisions (resolved)

1. Owner initialization is lazy (initialize ACP client on first request).
2. One default idle TTL profile is used for all environments (`ownerIdleTtlSeconds=3600` by default); callers can override.
3. `status` includes owner health and queue depth by default in both text and json outputs.
