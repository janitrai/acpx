---
title: acpx CLI Reference
description: Definitive command and behavior reference for the acpx CLI, including grammar, options, session rules, output modes, permissions, and exit codes.
author: Bob <bob@dutifulbob.com>
date: 2026-02-18
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
acpx [global_options] exec [prompt_options] [prompt_text...]
acpx [global_options] status [-s <name>]
acpx [global_options] sessions [list | new [--name <name>] | close [name] | show [name] | history [name] [--limit <count>]]
acpx [global_options] config [show | init]

acpx [global_options] <agent> [prompt_options] [prompt_text...]
acpx [global_options] <agent> prompt [prompt_options] [prompt_text...]
acpx [global_options] <agent> exec [prompt_options] [prompt_text...]
acpx [global_options] <agent> status [-s <name>]
acpx [global_options] <agent> sessions [list | new [--name <name>] | close [name] | show [name] | history [name] [--limit <count>]]
```

`<agent>` can be:

- built-in friendly name: `codex`, `claude`, `gemini`, `opencode`, `pi`
- unknown token (treated as raw command)
- overridden by `--agent <command>` escape hatch

Prompt options:

```bash
-s, --session <name>   Use named session instead of cwd default
--no-wait              Queue prompt and return immediately if session is busy
-f, --file <path>      Read prompt text from file (`-` means stdin)
```

Notes:

- Top-level `prompt`, `exec`, `sessions`, and bare `acpx <prompt>` default to `codex`.
- If a prompt argument is omitted, `acpx` reads prompt text from stdin when piped.
- `--file` works for implicit prompt, `prompt`, and `exec` commands.
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
| `--ttl <seconds>`     | Queue owner idle TTL before shutdown           | Default `300`. `0` disables TTL.                                    |
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
acpx --ttl 30 codex 'keep queue owner warm for quick follow-up'
acpx --verbose codex 'debug adapter startup issues'
```

## Agent commands

Each agent command supports the same shape.

### `codex`

```bash
acpx [global_options] codex [prompt_options] [prompt_text...]
acpx [global_options] codex prompt [prompt_options] [prompt_text...]
acpx [global_options] codex exec [prompt_text...]
acpx [global_options] codex sessions [list | new [--name <name>] | close [name]]
```

Built-in command mapping: `codex -> npx @zed-industries/codex-acp`

### `claude`

```bash
acpx [global_options] claude [prompt_options] [prompt_text...]
acpx [global_options] claude prompt [prompt_options] [prompt_text...]
acpx [global_options] claude exec [prompt_text...]
acpx [global_options] claude sessions [list | new [--name <name>] | close [name]]
```

Built-in command mapping: `claude -> npx @zed-industries/claude-agent-acp`

### `gemini`

```bash
acpx [global_options] gemini [prompt_options] [prompt_text...]
acpx [global_options] gemini prompt [prompt_options] [prompt_text...]
acpx [global_options] gemini exec [prompt_text...]
acpx [global_options] gemini sessions [list | new [--name <name>] | close [name]]
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
- Does not auto-create sessions; missing scope exits with code `4` and guidance to run `sessions new`
- Sends prompt on resumed/new session
- If another prompt is already running for that session, submits to the running queue owner instead of starting a second ACP subprocess
- By default waits for queued prompt completion; `--no-wait` returns after queue acknowledgement
- Updates session metadata after completion

The agent command itself also has an implicit prompt form:

```bash
acpx [global_options] <agent> [prompt_options] [prompt_text...]
acpx [global_options] [prompt_text...]   # defaults to codex
```

## `exec` subcommand

One-shot prompt (no saved session):

```bash
acpx [global_options] <agent> exec [prompt_options] [prompt_text...]
acpx [global_options] exec [prompt_options] [prompt_text...]   # defaults to codex
```

Behavior:

- Creates temporary ACP session
- Sends prompt once
- Does not write/use a saved session record
- Supports prompt text from args, stdin, `--file <path>`, and `--file -`

## `sessions` subcommand

```bash
acpx [global_options] <agent> sessions
acpx [global_options] <agent> sessions list
acpx [global_options] <agent> sessions new
acpx [global_options] <agent> sessions new --name <name>
acpx [global_options] <agent> sessions close
acpx [global_options] <agent> sessions close <name>
acpx [global_options] <agent> sessions show
acpx [global_options] <agent> sessions show <name>
acpx [global_options] <agent> sessions history
acpx [global_options] <agent> sessions history <name> [--limit <count>]

acpx [global_options] sessions ...   # defaults to codex
```

Behavior:

- `sessions` and `sessions list` are equivalent
- list returns all saved sessions for selected `agentCommand` (across all cwd values)
- `sessions new` creates a fresh cwd-scoped default session
- `sessions new --name <name>` creates a fresh named session for cwd
- creating a fresh session soft-closes the previous open session in that scope (if present)
- `sessions close` soft-closes the current cwd default session
- `sessions close <name>` soft-closes current cwd named session
- `sessions show [name]` displays stored session metadata
- `sessions history [name]` displays stored turn history previews (default 20, configurable with `--limit`)
- close errors if the target session does not exist

## `status` command

```bash
acpx [global_options] <agent> status
acpx [global_options] <agent> status -s <name>
acpx [global_options] status
acpx [global_options] status -s <name>
```

Shows local process status for the cwd-scoped session:

- `running`, `dead`, or `no-session`
- session id, agent command, pid
- uptime when running
- last prompt timestamp
- last known exit code/signal when dead

Status checks are local and PID-based (`kill(pid, 0)` semantics).

## `config` command

```bash
acpx [global_options] config show
acpx [global_options] config init
```

- `config show` prints the resolved config from global + project files.
- `config init` writes a default global config template if missing.

Config files:

- global: `~/.acpx/config.json`
- project: `<cwd>/.acpxrc.json` (merged on top of global)

Supported keys:

```json
{
  "defaultAgent": "codex",
  "defaultPermissions": "approve-all",
  "ttl": 300,
  "timeout": null,
  "format": "text",
  "agents": {
    "my-custom": { "command": "./bin/my-acp-server" }
  }
}
```

CLI flags always override config values.

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

1. Detect the nearest git root by checking for `.git` while walking up from `absoluteCwd`.
2. If a git root is found, walk from `absoluteCwd` up to that git root (inclusive).
3. If no git root exists, only check exact `absoluteCwd` (no parent-directory walk).
4. At each checked directory, find the first active (non-closed) session matching `(agentCommand, dir, optionalName)`.
5. If found, use that session record for prompt queueing and resume attempts.
6. If not found, exit with code `4` and print guidance to create one via `sessions new`.

`sessions new [--name <name>]` is the explicit creation point for saved session records.

If a saved session PID is dead, `acpx` respawns the agent, tries `session/load`, and transparently falls back to `session/new` when loading fails.

### Prompt queueing

When a prompt is already in flight for a session, `acpx` uses a per-session queue owner process:

1. owner process keeps the active turn running
2. other `acpx` invocations enqueue prompts through local IPC
3. owner drains queued prompts one-by-one after each completed turn
4. after the queue drains, owner waits for new work up to TTL (`--ttl`, default 300s)
5. submitter either blocks until completion (default) or exits immediately with `--no-wait`
6. if interrupted (`Ctrl+C`) during an active turn, `acpx` sends `session/cancel` first, waits briefly for cancelled completion, then force-kills only if needed

### Soft-close behavior

- soft-closed sessions remain on disk with `closed: true` and `closedAt`
- auto-resume ignores closed sessions during scope lookup
- closed sessions still keep full record data and can be resumed explicitly via record id/session load flows
- session records also keep lightweight turn history previews used by `sessions history`

### Named sessions

`-s, --session <name>` adds `name` into the scope key so multiple parallel conversations can coexist in the same repo and agent command.

### CWD scoping

`--cwd` sets the starting point for directory-walk routing (bounded by git root) and the exact scope directory when creating sessions via `sessions new`.

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

- `sessions list` with `text`: tab-separated `id`, `name`, `cwd`, `lastUsedAt` (closed sessions include a `[closed]` marker next to id)
- `sessions list` with `json`: a single JSON array of session records
- `sessions list` with `quiet`: one session id per line (closed sessions include `[closed]`)
- `sessions new` with `text`: new session id (and replaced id when applicable)
- `sessions new` with `json`: `{"type":"session_created",...}`
- `sessions new` with `quiet`: new session id
- `sessions close` with `text`: closed record id
- `sessions close` with `json`: `{"type":"session_closed",...}`
- `sessions close` with `quiet`: no output
- `sessions show` with `text`: key/value metadata dump
- `sessions show` with `json`: full session record object
- `sessions history` with `text`: tab-separated `timestamp role textPreview` entries
- `sessions history` with `json`: object containing `entries` array
- `status` with `text`: key/value process status lines
- `status` with `json`: structured status object with `running|dead|no-session`

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
| `4`   | No session found (prompt requires an explicit `sessions new`)                              |
| `5`   | Permission denied (permission requested, none approved, and at least one denied/cancelled) |
| `130` | Interrupted (`SIGINT`/`SIGTERM`)                                                           |

## Environment variables

No `acpx`-specific environment variables are currently defined.

Related runtime behavior:

- session storage path is derived from OS home directory (`~/.acpx/sessions`)
- child processes inherit the current environment by default

## Practical examples

```bash
# Review a PR in a dedicated named session
acpx --cwd ~/repos/shop codex sessions new --name pr-842
acpx --cwd ~/repos/shop codex -s pr-842 \
  'Review PR #842, list risks, and propose a minimal patch'

# Continue that same PR review later
acpx --cwd ~/repos/shop codex -s pr-842 \
  'Now draft commit message and rollout checklist'

# Parallel workstreams in one repo
acpx codex sessions new --name backend
acpx codex sessions new --name docs
acpx codex -s backend 'fix checkout timeout'
acpx codex -s docs 'document payment retry behavior'

# One-shot ask with no saved context
acpx claude exec 'summarize src/session.ts in 5 bullets'

# Manage sessions
acpx codex sessions
acpx codex sessions new --name docs
acpx codex sessions show docs
acpx codex sessions history docs --limit 10
acpx codex sessions close docs
acpx codex status

# Prompt from file/stdin
echo 'triage failing tests' | acpx codex
acpx codex --file prompt.md
acpx codex --file - 'also check lint warnings'

# Config inspection
acpx config show
acpx config init

# JSON automation pipeline
acpx --format json codex exec 'review latest diff for security issues' \
  | jq -r 'select(.type=="tool_call") | [.status, .title] | @tsv'
```
