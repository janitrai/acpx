---
title: acpx Architecture
description: Internal architecture and runtime flow from CLI command to ACP session updates.
author: Bob <bob@dutifulbob.com>
date: 2026-02-18
---

## Overview

`acpx` is a CLI client that speaks ACP over stdio.

Data path:

`CLI command -> AcpClient -> ndjson/stdio -> ACP adapter -> coding agent`

The CLI never scrapes terminal text from an interactive UI. It talks structured ACP JSON-RPC messages directly.

## Core components

- `src/cli.ts`: command grammar, flags, output mode selection, and top-level command handling.
- `src/client.ts`: ACP transport and protocol methods. Spawns the adapter process and connects with `ClientSideConnection` + `ndJsonStream`.
- `src/session.ts`: session persistence, resume/create logic, queue ownership, soft-close lifecycle, timeout/interrupt handling, and cleanup.
- `src/permissions.ts`: permission policy (`approve-all`, `approve-reads`, `deny-all`) and interactive fallback.
- `src/output.ts`: streaming text/json/quiet output formatters.

## Protocol flow

Typical prompt flow:

1. `initialize`
2. `newSession` or `loadSession`
3. `prompt`
4. stream `sessionUpdate` notifications until done

Details:

- `initialize` advertises client capabilities (`fs.readTextFile`, `fs.writeTextFile`, `terminal`).
- If a saved session exists and agent supports it, `loadSession` is attempted.
- If load fails with not-found style errors, `acpx` falls back to `newSession`.
- Prompt responses and notifications are streamed through the active formatter.

## Session persistence

Session metadata is stored in `~/.acpx/sessions/*.json`.

Each record includes:

- stable file/session id
- ACP session id
- agent command
- cwd
- optional named session
- timestamps (`createdAt`, `lastUsedAt`, optional `closedAt`)
- optional soft-close state (`closed`)
- adapter process pid (when known)
- protocol/version capabilities snapshot

This lets `acpx` resume conversational context by default.

Auto-resume lookup skips soft-closed records unless a record is selected explicitly.

## Queue owner lifecycle

Prompt submission is queue-aware per persistent session:

- one `acpx` process becomes queue owner for the active turn
- concurrent invocations submit prompt requests to the owner via local IPC
- after queue drain, owner waits up to idle TTL (`--ttl`, default 300s) for new work
- TTL expiry shuts down owner, releases socket/lock, and clears queue-owner record
- `sessions close`/`sessions new` soft-close and terminate related processes without deleting session JSON

## Permission handling

Permission requests come in through ACP `requestPermission` callbacks.

Modes:

- `approve-all`: auto-approve first allow option
- `approve-reads`: auto-approve read/search; prompt for others
- `deny-all`: reject when possible

`acpx` tracks permission stats (requested/approved/denied/cancelled) and uses them for exit-code behavior.
