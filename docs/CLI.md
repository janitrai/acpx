---
title: acpx CLI Reference
description: Definitive command and behavior reference for the acpx CLI, including grammar, options, session rules, output modes, permissions, and exit codes.
author: Bob <bob@dutifulbob.com>
date: 2026-02-17
---

## Overview

`acpx` is a headless ACP client for scriptable agent workflows.

Default behavior is conversational:

- prompt commands use a persisted session
- session lookup is scoped by agent command and working directory (plus optional session name)
- `exec` runs one prompt in a temporary session

## Full command grammar

Global options apply to all commands.

```bash
acpx [global_options] [prompt_text...]
acpx [global_options] prompt [prompt_options] [prompt_text...]
acpx [global_options] exec [prompt_text...]
acpx [global_options] sessions [list | close [name]]

acpx [global_options] <agent> [prompt_options] [prompt_text...]
acpx [global_options] <agent> prompt [prompt_options] [prompt_text...]
acpx [global_options] <agent> exec [prompt_text...]
acpx [global_options] <agent> sessions [list | close [name]]
```

`<agent>` can be:

- built-in friendly name: `codex`, `claude`, `gemini`
- unknown token (treated as raw command)
- overridden by `--agent <command>` escape hatch

Prompt options:

```bash
-s, --session <name>   Use named session instead of cwd default
```

Notes:

- Top-level `prompt`, `exec`, `sessions`, and bare `acpx <prompt>` default to `codex`.
- If a prompt argument is omitted, `acpx` reads prompt text from stdin when piped.
- `acpx` with no args in an interactive terminal shows help.

## Global options

All global options:

| Option                | Description                                    | Details                                                             |
| --------------------- | ---------------------------------------------- | ------------------------------------------------------------------- |
| `--agent <command>`   | Raw ACP agent command (escape hatch)           | Do not combine with positional agent token.                         |
| `--cwd <dir>`         | Working directory                              | Defaults to current directory. Stored as absolute path for scoping. |
| `--approve-all`       | Auto-approve all permissions                   | Permission mode `approve-all`.                                      |
| `--approve-reads`     | Auto-approve reads/searches, prompt for others | Default permission mode.                                            |
| `--deny-all`          | Deny all permissions                           | Permission mode `deny-all`.                                         |
| `--format <fmt>`      | Output format                                  | `text` (default), `json`, `quiet`.                                  |
| `--timeout <seconds>` | Max wait time for agent response               | Must be positive. Decimal seconds allowed.                          |
| `--verbose`           | Enable verbose logs                            | Prints ACP/debug details to stderr.                                 |

Permission flags are mutually exclusive. Using more than one of `--approve-all`, `--approve-reads`, `--deny-all` is a usage error.

### Global option examples

```bash
acpx --approve-all codex 'apply this patch and run tests'
acpx --approve-reads codex 'inspect the repo and propose a plan'
acpx --deny-all codex 'summarize this code without running tools'

acpx --cwd ~/repos/api codex 'review auth middleware'
acpx --format json codex exec 'summarize open TODO items'
acpx --timeout 120 codex 'investigate flaky test failures'
acpx --verbose codex 'debug adapter startup issues'
```

## Agent commands

Each agent command supports the same shape.

### `codex`

```bash
acpx [global_options] codex [prompt_options] [prompt_text...]
acpx [global_options] codex prompt [prompt_options] [prompt_text...]
acpx [global_options] codex exec [prompt_text...]
acpx [global_options] codex sessions [list | close [name]]
```

Built-in command mapping: `codex -> npx @zed-industries/codex-acp`

### `claude`

```bash
acpx [global_options] claude [prompt_options] [prompt_text...]
acpx [global_options] claude prompt [prompt_options] [prompt_text...]
acpx [global_options] claude exec [prompt_text...]
acpx [global_options] claude sessions [list | close [name]]
```

Built-in command mapping: `claude -> npx @zed-industries/claude-agent-acp`

### `gemini`

```bash
acpx [global_options] gemini [prompt_options] [prompt_text...]
acpx [global_options] gemini prompt [prompt_options] [prompt_text...]
acpx [global_options] gemini exec [prompt_text...]
acpx [global_options] gemini sessions [list | close [name]]
```

Built-in command mapping: `gemini -> gemini`

### Custom positional agents

Unknown agent names are treated as raw commands:

```bash
acpx [global_options] my-agent [prompt_options] [prompt_text...]
acpx [global_options] my-agent exec [prompt_text...]
acpx [global_options] my-agent sessions
```

## `prompt` subcommand (explicit)

Persistent-session prompt command:

```bash
acpx [global_options] <agent> prompt [prompt_options] [prompt_text...]
acpx [global_options] prompt [prompt_options] [prompt_text...]
```

Behavior:

- Finds existing session for scope key `(agentCommand, cwd, name?)`
- Creates a new session record if missing
- Sends prompt on resumed/new session
- Updates session metadata after completion

The agent command itself also has an implicit prompt form:

```bash
acpx [global_options] <agent> [prompt_options] [prompt_text...]
acpx [global_options] [prompt_text...]   # defaults to codex
```

## `exec` subcommand

One-shot prompt (no saved session):

```bash
acpx [global_options] <agent> exec [prompt_text...]
acpx [global_options] exec [prompt_text...]   # defaults to codex
```

Behavior:

- Creates temporary ACP session
- Sends prompt once
- Does not write/use a saved session record

## `sessions` subcommand

```bash
acpx [global_options] <agent> sessions
acpx [global_options] <agent> sessions list
acpx [global_options] <agent> sessions close
acpx [global_options] <agent> sessions close <name>

acpx [global_options] sessions ...   # defaults to codex
```

Behavior:

- `sessions` and `sessions list` are equivalent
- list returns all saved sessions for selected `agentCommand` (across all cwd values)
- `sessions close` closes the current cwd default session
- `sessions close <name>` closes current cwd named session
- close errors if the target session does not exist

## `--agent` escape hatch

`--agent <command>` sets a raw adapter command explicitly.

Examples:

```bash
acpx --agent ./my-custom-acp-server 'do something'
acpx --agent 'node ./scripts/acp-dev-server.mjs --mode ci' exec 'summarize changes'
```

Rules:

- Do not combine positional agent and `--agent` in one command.
- The resolved command string becomes the session scope key (`agentCommand`).
- Invalid empty command or unterminated quoting in `--agent` is a usage error.

## Session behavior and scoping

Session records are stored in:

```text
~/.acpx/sessions/*.json
```

### Auto-resume

For prompt commands:

1. Find session by `(agentCommand, absoluteCwd, optionalName)`
2. If missing, create and persist a new session record
3. On send, attempt `loadSession` when the adapter supports it
4. If load fails with not-found/invalid-session style errors, create a fresh session and update record
5. Save updated `lastUsedAt`, capabilities, and session id metadata

### Named sessions

`-s, --session <name>` adds `name` into the scope key so multiple parallel conversations can coexist in the same repo and agent command.

### CWD scoping

`--cwd` changes session scope. The same session name in two different cwd values maps to different records.

## Output formats

`--format` controls output mode:

- `text` (default): human-readable stream
- `json`: NDJSON event stream for automation
- `quiet`: assistant text only

### Prompt/exec output behavior

- `text`: assistant text, tool status blocks, plan updates, and `[done] <reason>`
- `json`: one JSON object per line with event types like `text`, `thought`, `tool_call`, `plan`, `update`, `done`
- `quiet`: concatenated assistant text only

### Sessions command output behavior

- `sessions list` with `text`: tab-separated `id`, `name`, `cwd`, `lastUsedAt` (or `No sessions`)
- `sessions list` with `json`: a single JSON array of session records
- `sessions list` with `quiet`: one session id per line
- `sessions close` with `text`: closed record id
- `sessions close` with `json`: `{"type":"session_closed",...}`
- `sessions close` with `quiet`: no output

## Permission modes

Choose exactly one mode:

- `--approve-all`: auto-approve all permission requests
- `--approve-reads`: auto-approve read/search requests, prompt for other kinds (default)
- `--deny-all`: auto-deny/reject requests when possible

Prompting behavior in `--approve-reads`:

- interactive TTY: asks `Allow <tool>? (y/N)` for non-read/search requests
- non-interactive (no TTY): non-read/search requests are not approved

## Exit codes

| Code  | Meaning                                                                                    |
| ----- | ------------------------------------------------------------------------------------------ |
| `0`   | Success                                                                                    |
| `1`   | Agent/protocol/runtime error                                                               |
| `2`   | CLI usage error                                                                            |
| `3`   | Timeout                                                                                    |
| `4`   | Permission denied (permission requested, none approved, and at least one denied/cancelled) |
| `130` | Interrupted (`SIGINT`/`SIGTERM`)                                                           |

## Environment variables

No `acpx`-specific environment variables are currently defined.

Related runtime behavior:

- session storage path is derived from OS home directory (`~/.acpx/sessions`)
- child processes inherit the current environment by default

## Practical examples

```bash
# Review a PR in a dedicated named session
acpx --cwd ~/repos/shop codex -s pr-842 \
  'Review PR #842, list risks, and propose a minimal patch'

# Continue that same PR review later
acpx --cwd ~/repos/shop codex -s pr-842 \
  'Now draft commit message and rollout checklist'

# Parallel workstreams in one repo
acpx codex -s backend 'fix checkout timeout'
acpx codex -s docs 'document payment retry behavior'

# One-shot ask with no saved context
acpx claude exec 'summarize src/session.ts in 5 bullets'

# Manage sessions
acpx codex sessions
acpx codex sessions close docs

# JSON automation pipeline
acpx --format json codex exec 'review latest diff for security issues' \
  | jq -r 'select(.type=="tool_call") | [.status, .title] | @tsv'
```
