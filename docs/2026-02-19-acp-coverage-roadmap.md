---
title: ACP Spec Coverage Roadmap
author: Bob <bob@dutifulbob.com>
date: 2026-02-19
---

# ACP Spec Coverage Roadmap

What acpx implements from the ACP spec today, what's missing, and the plan to
close the gaps.

## Current State (v0.1.x)

acpx implements the core prompt loop and session lifecycle. Enough to be a useful
CLI client for Codex, Claude, Gemini, OpenCode, and Pi.

### Implemented

| ACP Method                   | acpx Feature                                     | Since  |
| ---------------------------- | ------------------------------------------------ | ------ |
| `initialize`                 | Handshake, capability negotiation                | v0.1.0 |
| `session/new`                | `sessions new`                                   | v0.1.0 |
| `session/load`               | Crash resume / reconnect                         | v0.1.0 |
| `session/prompt`             | `prompt`, `exec`, implicit prompt                | v0.1.0 |
| `session/update`             | Streaming output (thinking, tools, text, diffs)  | v0.1.0 |
| `session/cancel`             | Graceful cancel on SIGINT                        | v0.1.4 |
| `session/request_permission` | `--approve-all`, `--approve-reads`, `--deny-all` | v0.1.0 |

### Not Implemented

| ACP Method          | What it does                        | Spec status |
| ------------------- | ----------------------------------- | ----------- |
| `session/fork`      | Branch a session into two           | unstable    |
| `session/list`      | List sessions server-side           | unstable    |
| `session/resume`    | Resume a paused session             | unstable    |
| `session/set_model` | Change model mid-session            | unstable    |
| `$/cancel_request`  | Cancel any pending JSON-RPC request | unstable    |

## Roadmap

### Tier 1 — Cancel and Control (next release)

In-flight prompt management. Users need to stop generation and redirect without
killing the session.

- [x] **`acpx <agent> cancel`** — Send `session/cancel` to the running turn via
      the queue socket. Agent stops generating, session stays alive, ready for next
      prompt immediately. This is different from SIGINT (which tears down the process);
      cancel is cooperative and keeps the connection open.
- [x] **`session/set_mode`** — `acpx <agent> set-mode <mode>`. Agents advertise
      supported modes in their capabilities. Codex supports `plan` vs `execute` (or
      equivalent). Simple JSON-RPC call, response is ack.
- [x] **`session/set_config_option`** — `acpx <agent> set <key> <value>`. Pass
      arbitrary config to the agent (temperature, max tokens, etc.). Agent validates,
      returns ack or error.

### Tier 2 — Filesystem Client Methods

The agent asks acpx (the client) to read/write files on its behalf. Today agents
handle their own filesystem access, but the ACP spec envisions the client as the
filesystem authority — the agent requests, the client decides.

This matters for:

- Sandboxed agents that can't touch the filesystem directly
- Fine-grained permission control (allow reads to `src/`, deny writes to `.env`)
- Audit logging of all file operations

Implementation:

- [x] **`fs/read_text_file`** — Agent sends path, client reads and returns content.
      Respect permission mode: `--approve-reads` allows automatically, `--deny-all`
      rejects. Could add path-based policies later.
- [x] **`fs/write_text_file`** — Agent sends path + content, client writes. Always
      requires permission unless `--approve-all`. Show diff preview before approving.
- [x] Path sandboxing: restrict reads/writes to cwd subtree by default.

### Tier 3 — Terminal Client Methods

The agent asks acpx to manage terminal processes. Same philosophy as filesystem:
the client is the execution authority.

- [x] **`terminal/create`** — Agent requests a command to run. Client spawns the
      process, returns a terminal ID. Permission check: similar to tool call approval.
- [x] **`terminal/output`** — Agent polls for terminal stdout/stderr. Client returns
      buffered output.
- [x] **`terminal/wait_for_exit`** — Agent blocks until terminal exits. Client
      returns exit code.
- [x] **`terminal/kill`** — Agent requests termination of a running terminal.
- [x] **`terminal/release`** — Agent releases terminal resources.

This is the heaviest lift. Requires:

- Terminal process lifecycle manager (spawn, track, buffer output, reap)
- Terminal ID allocation and cleanup
- Timeout handling for hung processes
- Integration with permission system

### Tier 4 — Authentication

- [x] **`authenticate`** — Handle auth handshake. Agent tells client what auth
      it needs (API key, OAuth token, etc.), client provides it. Today agents manage
      their own auth (env vars, config files). This would let acpx be the auth broker.
      Lower priority because current agents work fine without it.

### Tier 5 — Unstable / Future

Only implement these once they stabilize in the spec:

- [ ] **`session/fork`** — Branch a session. Use case: try two approaches in
      parallel. Would create two session files from one.
- [ ] **`session/list`** — Server-side session listing. We already have client-side
      `sessions list`; this would query the agent for its view.
- [ ] **`session/resume`** — Resume a paused session (different from `session/load`
      which replays history).
- [ ] **`session/set_model`** — `acpx <agent> set-model <model>`. Switch models
      mid-conversation.
- [ ] **`$/cancel_request`** — Cancel any pending JSON-RPC request by ID. More
      granular than `session/cancel`.

## Non-ACP Features

Things acpx needs that aren't in the ACP spec:

- [ ] **Permission policies** — Path-based rules (`allow reads to src/`, `deny
writes to .env`). Beyond the current all-or-nothing modes.
- [ ] **Multi-agent orchestration** — Agent A prompts Agent B through acpx.
      Session bridging.
- [ ] **Webhooks / callbacks** — Notify a URL when a prompt finishes. For CI/CD
      and automation pipelines.
- [ ] **Session export/import** — Move sessions between machines.
- [ ] **Watch mode** — Re-run prompt on file changes.
- [ ] **Cost/token tracking** — Surface usage stats when agents/ACP expose them.

## Release Mapping

| Release | Tier       | Key Features                                                                                |
| ------- | ---------- | ------------------------------------------------------------------------------------------- |
| v0.2.0  | current    | Config file, graceful cancel, crash resume, stdin/file input, session history, agent status |
| v0.3.0  | Tier 1     | `cancel` command, `set-mode`, `set-config-option`                                           |
| v0.4.0  | Tier 2     | `fs/read_text_file`, `fs/write_text_file`, path sandboxing                                  |
| v0.5.0  | Tier 3     | Terminal client methods (create, output, wait, kill, release)                               |
| v0.6.0  | Tier 4     | Authentication handshake                                                                    |
| v1.0.0  | all stable | Full stable ACP spec coverage, production-ready                                             |

Unstable methods land as they stabilize in the spec, likely post-1.0.
