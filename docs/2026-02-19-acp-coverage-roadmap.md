---
title: ACP Spec Coverage
author: Bob <bob@dutifulbob.com>
date: 2026-02-19
---

# ACP Spec Coverage

What acpx implements from the ACP spec today and what is not yet implemented.

## Supported Now

| ACP Method                   | acpx Feature                                     | Supported |
| ---------------------------- | ------------------------------------------------ | --------- |
| `initialize`                 | Handshake, capability negotiation                | yes       |
| `session/new`                | `sessions new`                                   | yes       |
| `session/load`               | Crash resume / reconnect                         | yes       |
| `session/prompt`             | `prompt`, `exec`, implicit prompt                | yes       |
| `session/update`             | Streaming output (thinking, tools, text, diffs)  | yes       |
| `session/cancel`             | Graceful cancel + `acpx <agent> cancel`          | yes       |
| `session/request_permission` | `--approve-all`, `--approve-reads`, `--deny-all` | yes       |
| `session/set_mode`           | `acpx <agent> set-mode <mode>`                   | yes       |
| `session/set_config_option`  | `acpx <agent> set <key> <value>`                 | yes       |
| `fs/read_text_file`          | ACP client file read handler                     | yes       |
| `fs/write_text_file`         | ACP client file write handler                    | yes       |
| `terminal/create`            | ACP client terminal spawn handler                | yes       |
| `terminal/output`            | ACP client terminal output handler               | yes       |
| `terminal/wait_for_exit`     | ACP client terminal wait handler                 | yes       |
| `terminal/kill`              | ACP client terminal kill handler                 | yes       |
| `terminal/release`           | ACP client terminal release handler              | yes       |
| `authenticate`               | Auth handshake handling                          | yes       |

### Supported Behavior Notes

#### Session cancel and controls

- `acpx <agent> cancel` sends `session/cancel` through the queue path and keeps the session alive for follow-up prompts.
- This is intentionally different from process-level SIGINT behavior, which can tear down the running process.
- `session/set_mode` and `session/set_config_option` are exposed as `set-mode` and `set` commands and return agent-side validation errors when invalid.

#### Filesystem client methods

- acpx handles `fs/read_text_file` and `fs/write_text_file` as client-authority operations.
- Permission behavior follows selected mode (`--approve-all`, `--approve-reads`, `--deny-all`).
- Path sandboxing is applied to keep file operations scoped to cwd by default.

#### Terminal client methods

- acpx handles full terminal lifecycle: create, output, wait_for_exit, kill, release.
- The implementation includes process tracking, output buffering, and cleanup behavior for terminal IDs.

#### Authentication

- acpx handles `authenticate` when adapters request it.
- This keeps compatibility with adapters that rely on ACP auth handshake rather than out-of-band environment setup.

## Not Yet Supported

| ACP Method          | What it does                        | Spec status |
| ------------------- | ----------------------------------- | ----------- |
| `session/fork`      | Branch a session into two           | unstable    |
| `session/list`      | List sessions server-side           | unstable    |
| `session/resume`    | Resume a paused session             | unstable    |
| `session/set_model` | Change model mid-session            | unstable    |
| `$/cancel_request`  | Cancel any pending JSON-RPC request | unstable    |

### Not Yet Supported Notes

- `session/fork`: would allow branching one conversation into parallel alternatives.
- `session/list`: would expose adapter-side session inventory in addition to acpx local store listing.
- `session/resume`: distinct from `session/load`; expected to support resume semantics without replay-like behavior.
- `session/set_model`: mid-session model switching command surface.
- `$/cancel_request`: transport-level JSON-RPC cancellation beyond session-scoped cancel.

## ACP-Adjacent Features Not Yet Supported

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
