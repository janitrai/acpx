---
title: acpx Session Management
description: How acpx resumes, names, stores, and closes sessions including pid tracking and subprocess lifecycle.
author: Bob <bob@dutifulbob.com>
date: 2026-02-18
---

## Session model

`acpx` is conversational by default.

Session lookup is scoped by:

- agent command
- a scope directory (session is created at a directory; prompts route to the nearest parent scope)
- optional session name (`-s <name>`)

No `-s` means the default cwd session for that agent command.

Session records can also be soft-closed:

- `closed: true`
- `closedAt: <timestamp>`

Soft-closed records stay on disk and are visible in `sessions list`.

## Auto-resume behavior

For prompt commands:

1. `findSessionByDirectoryWalk` searches for the nearest active (non-closed) record by walking up from the current `cwd` (or `--cwd`) to `/`.
   - at each level, it checks for a matching `(agentCommand, dir, name?)` record
2. If no record exists anywhere up the tree, prompt exits with a "no session found" error and instructs the user to create one via `sessions new`.
3. `sendSession` starts a fresh adapter process and tries `loadSession`.
4. If load is unsupported or fails with known not-found/invalid errors, it falls back to `newSession`.
5. After prompt completes, record metadata is updated and re-written (`closed` cleared if needed).

## Named sessions

`-s backend` selects a parallel conversation stream for the same agent, routed via the same directory-walk behavior.

Example:

- create default session: `acpx codex sessions new`
- create named session: `acpx codex sessions new --name backend`
- default prompt: `acpx codex 'fix tests'`
- named prompt: `acpx codex -s backend 'fix API'`

Both can coexist because names are part of the scope key.

`sessions new --name backend` creates a fresh named session in that scope and soft-closes the prior open one.

## Session files

Stored under `~/.acpx/sessions/` as JSON files.

Record fields include:

- `id`
- `sessionId`
- `agentCommand`
- `cwd`
- `name` (optional)
- `createdAt`, `lastUsedAt`
- `closed`, `closedAt` (soft-close state)
- `pid` (adapter process pid, optional)
- `protocolVersion`, `agentCapabilities` (optional)

Writes are done via temp file + rename for safer updates.

## loadSession protocol flow

Resume path in `sendSession`:

1. start ACP client process
2. initialize protocol
3. `loadSession(sessionId, cwd, mcpServers: [])`
4. suppress replayed updates during load
5. wait for session-update drain
6. send new prompt

If resume fails with a fallback-eligible error, `newSession` is used and stored `sessionId` is replaced.

Closed records can still be resumed explicitly via direct record id/session load flows when supported by the adapter.

## Soft-close behavior

Soft-close is used by:

- `acpx <agent> sessions close [name]`
- `acpx <agent> sessions new [--name <name>]` (for the replaced session)

What soft-close does:

1. terminate queue owner for the session if present
2. terminate adapter process pid (`SIGTERM` then `SIGKILL`) when still alive and matching
3. persist session JSON with `closed: true` and `closedAt`
4. keep session file on disk (no deletion)

## PID tracking and process lifecycle

`acpx` stores the adapter pid in each session record to help with cleanup and diagnostics.

Lifecycle behavior:

- a queue owner `acpx` process is elected per active session turn and accepts queued prompts over local IPC
- the owner drains queued prompts sequentially (one ACP prompt at a time)
- after the queue drains, owner waits for new prompts up to an idle TTL (default 300s)
- TTL is configurable via `--ttl <seconds>` (`0` disables TTL)
- when TTL expires, owner shuts down, releases socket/lock, and exits
- each prompt turn launches a fresh adapter subprocess owned by that queue owner process
- records track pid of the latest process used
- `closeSession` soft-closes and terminates related processes instead of deleting the record
- process termination uses `SIGTERM` then `SIGKILL` fallback
- signal handling (`SIGINT`, `SIGTERM`) closes client resources before exit

This keeps session files and local processes in sync while remaining robust to stale pids.
