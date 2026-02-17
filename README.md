# acpx

Headless CLI client for the [Agent Client Protocol (ACP)](https://agentclientprotocol.com) — talk to coding agents from the command line.

```bash
# Conversational prompt (persistent session, auto-resume by agent+cwd)
acpx codex "fix the tests"

# Explicit prompt verb (same behavior)
acpx codex prompt "fix the tests"

# One-shot execution (no saved session)
acpx codex exec "what does this repo do"

# Named session
acpx codex -s backend "fix the API"

# Session management
acpx codex sessions
acpx codex sessions close
acpx codex sessions close backend
```

## Why?

ACP adapters exist for every major coding agent ([Codex](https://github.com/zed-industries/codex-acp), [Claude Code](https://github.com/zed-industries/claude-code-acp), [Gemini CLI](https://github.com/google-gemini/gemini-cli), etc.) but every ACP client is a GUI app or editor plugin.

`acpx` is the missing piece: a simple CLI that lets **agents talk to agents** (or humans script agents) over structured ACP instead of scraping terminal output.

## Install

```bash
npm install -g acpx
# or
npx acpx codex "hello"
```

### Prerequisites

You need an ACP-compatible agent installed:

```bash
# Codex ACP adapter
npm install -g @zed-industries/codex-acp

# Claude ACP adapter
npm install -g @zed-industries/claude-agent-acp

# Gemini CLI (native ACP support)
npm install -g @google/gemini-cli
```

## Usage

### Command grammar

```bash
acpx <agent> [prompt] <text>
acpx <agent> exec <text>
acpx <agent> sessions [list|close]
```

`prompt` is the default verb, so `acpx codex "..."` and `acpx codex prompt "..."` are equivalent.

### Built-in agent registry

Friendly names are resolved automatically:

- `codex` -> `npx @zed-industries/codex-acp`
- `claude` -> `npx @zed-industries/claude-agent-acp`
- `gemini` -> `gemini`

Unknown agent names are treated as raw commands. You can also use the explicit escape hatch:

```bash
acpx --agent ./my-custom-server "do something"
```

### Session behavior

- `prompt` always uses a saved session.
- Sessions auto-resume by `(agent command, cwd)`.
- `-s, --session <name>` uses a named session for that `(agent command, cwd)`.
- `exec` is fire-and-forget (temporary session, not saved).

Examples:

```bash
acpx codex "fix the tests"
acpx codex -s backend "fix the API"
acpx claude "refactor auth"
acpx gemini "add logging"
```

### Default agent shortcuts

If agent is omitted, default agent is `codex`:

```bash
acpx prompt "fix tests"
acpx exec "summarize this repo"
acpx sessions
```

### Global options (before agent name)

```text
--agent <command>     Raw ACP agent command (escape hatch)
--cwd <dir>           Working directory (default: .)
--approve-all         Auto-approve all permission requests
--approve-reads       Auto-approve reads/searches, prompt for writes
--deny-all            Deny all permission requests
--format <fmt>        Output format: text (default), json, quiet
--timeout <seconds>   Maximum time to wait for agent response
--verbose             Enable debug output on stderr
```

### Output formats

| Format | Flag | Description |
|--------|------|-------------|
| text | `--format text` | Human-readable streaming (default) |
| json | `--format json` | Structured ndjson for machines |
| quiet | `--format quiet` | Final text output only |

## How it works

```
┌─────────┐     stdio/ndjson     ┌──────────────┐     wraps      ┌─────────┐
│  acpx   │ ◄──────────────────► │  ACP adapter │ ◄───────────► │  Agent  │
│ (client)│     ACP protocol     │ (codex-acp)  │               │ (Codex) │
└─────────┘                      └──────────────┘               └─────────┘
```

acpx spawns the ACP adapter as a child process, communicates over JSON-RPC/ndjson over stdio, and streams structured events (tool calls, text, permissions).

## License

Apache-2.0
