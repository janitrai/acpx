<p align="center">
  <img src="acpx_banner.svg" alt="acpx banner" width="100%" />
</p>

# acpx

Your agents love acpx! 🤖❤️ They hate having to scrape characters from a PTY session 😤

`acpx` is a headless CLI client for the [Agent Client Protocol (ACP)](https://agentclientprotocol.com), so AI agents and orchestrators can talk to coding agents over a structured protocol instead of PTY scraping.

One command surface for Codex, Claude, Gemini, OpenCode, Pi, or custom ACP servers. Built for agent-to-agent communication over the command line.

- **Persistent sessions**: multi-turn conversations that survive across invocations, scoped per repo
- **Named sessions**: run parallel workstreams in the same repo (`-s backend`, `-s frontend`)
- **Prompt queueing**: submit prompts while one is already running, they execute in order
- **Cooperative cancel command**: `cancel` sends ACP `session/cancel` via queue IPC without tearing down session state
- **Soft-close lifecycle**: close sessions without deleting history from disk
- **Queue owner TTL**: keep queue owners alive briefly for follow-up prompts (`--ttl`)
- **Fire-and-forget**: `--no-wait` queues a prompt and returns immediately
- **Graceful cancel**: `Ctrl+C` sends ACP `session/cancel` before force-kill fallback
- **Session controls**: `set-mode` and `set <key> <value>` for `session/set_mode` and `session/set_config_option`
- **Crash reconnect**: dead agent processes are detected and sessions are reloaded automatically
- **Prompt from file/stdin**: `--file <path>` or piped stdin for prompt content
- **Config files**: global + project JSON config with `acpx config show|init`
- **Session inspect/history**: `sessions show` and `sessions history --limit <n>`
- **Local status checks**: `status` reports running/dead/no-session, pid, uptime, last prompt
- **Client methods**: stable `fs/*` and `terminal/*` handlers with permission controls and cwd sandboxing
- **Auth handshake**: stable `authenticate` support via env/config credentials
- **Structured output**: typed ACP messages (thinking, tool calls, diffs) instead of ANSI scraping
- **Any ACP agent**: built-in registry + `--agent` escape hatch for custom servers
- **One-shot mode**: `exec` for stateless fire-and-forget tasks

```bash
$ acpx codex sessions new
$ acpx codex "find the flaky test and fix it"

[thinking] Investigating test suite for flaky failures

[tool] Run npm test -- --reporter=verbose (running)
[tool] Run npm test -- --reporter=verbose (completed)
  output:
    ✓ auth.login (0.8s)
    ✗ checkout.submit (timed out after 5000ms)
    ✓ cart.add (0.3s)

[thinking] Found it — checkout.submit has a race condition in the async setup

[tool] Edit src/checkout.test.ts (completed)
  output:
    Success. Updated 1 file.

[tool] Run npm test -- checkout.submit (completed)
  output:
    ✓ checkout.submit (0.4s)

Fixed: added `await` to the setup hook in checkout.submit. The test was
reading stale state from the previous run.

[done] end_turn
```

## Quick setup — tell your agent about acpx

Copy the block below and paste it into your OpenClaw, Pi, Claude Code, or similar agent harness. It will install acpx, read the skill reference, and know how to use ACP for all future coding agent tasks.

```text
I want you to use acpx to run coding agents over the Agent Client Protocol
(ACP) instead of scraping PTY sessions. Please do the following:

1. Install acpx (global is recommended for frequent use, but npx works fine too):
   npm install -g acpx@latest

   Or, run without installing:
   npx acpx@latest

2. Install the acpx skill so you have the full reference available:
   acpx --skill export acpx | npx skillflag install
   (This launches an interactive wizard — pick your agent and scope with
   arrow keys, or pass --agent <agent> --scope <scope> to skip the wizard.)

3. Read the acpx skill reference so you know every command, flag, and
   workflow pattern:
   https://raw.githubusercontent.com/janitrai/acpx/main/skills/acpx/SKILL.md

4. If you need the full CLI reference with all options and examples:
   https://raw.githubusercontent.com/janitrai/acpx/main/docs/CLI.md

From now on, when you need to delegate work to a coding agent, use acpx
instead of spawning raw terminal sessions. For example:
  acpx codex "fix the failing tests"
  acpx claude "refactor the auth module"
  acpx codex exec "one-shot: summarize this repo"
```

## Install

```bash
npm install -g acpx@latest
```

Or run without installing:

```bash
npx acpx@latest codex "fix the tests"
```

Session state lives in `~/.acpx/` either way. Global install is a little faster, but `npx acpx@latest` works fine.

## Agent prerequisites

`acpx` auto-downloads ACP adapters with `npx` on first use. You do not need to install adapter packages manually.

The only prerequisite is the underlying coding agent you want to use:

- `acpx codex` -> Codex CLI: https://codex.openai.com
- `acpx claude` -> Claude Code: https://claude.ai/code
- `acpx gemini` -> Gemini CLI: https://github.com/google/gemini-cli
- `acpx opencode` -> OpenCode: https://opencode.ai
- `acpx pi` -> Pi Coding Agent: https://github.com/mariozechner/pi

## Usage examples

```bash
acpx codex sessions new                        # create a session (explicit) for this project dir
acpx codex 'fix the tests'                     # implicit prompt (routes via directory-walk)
acpx codex prompt 'fix the tests'              # explicit prompt subcommand
echo 'fix flaky tests' | acpx codex            # prompt from stdin
acpx codex --file prompt.md                    # prompt from file
acpx codex --file - "extra context"            # explicit stdin + appended args
acpx codex --no-wait 'draft test migration plan' # enqueue without waiting if session is busy
acpx codex cancel                               # cooperative cancel of in-flight prompt
acpx codex set-mode plan                        # session/set_mode
acpx codex set approval_policy conservative     # session/set_config_option
acpx exec 'summarize this repo'                # default agent shortcut (codex)
acpx codex exec 'what does this repo do?'      # one-shot, no saved session

acpx codex sessions new --name api              # create named session
acpx codex -s api 'implement cursor pagination' # prompt in named session
acpx codex sessions new --name docs             # create another named session
acpx codex -s docs 'rewrite API docs'           # parallel work in another named session

acpx codex sessions              # list sessions for codex command
acpx codex sessions list         # explicit list
acpx codex sessions show         # inspect cwd session metadata
acpx codex sessions history      # show recent turn history
acpx codex sessions new          # create fresh cwd-scoped default session
acpx codex sessions new --name api # create fresh named session
acpx codex sessions close        # close cwd-scoped default session
acpx codex sessions close api    # close cwd-scoped named session
acpx codex status                # local process status for current session

acpx config show                 # show resolved config (global + project)
acpx config init                 # create ~/.acpx/config.json template

acpx claude 'refactor auth middleware' # built-in claude agent
acpx gemini 'add startup logging'      # built-in gemini agent

acpx my-agent 'review this patch'                      # unknown name -> raw command
acpx --agent './bin/dev-acp --profile ci' 'run checks' # --agent escape hatch
```

## Practical scenarios

```bash
# Review a PR in a dedicated session and auto-approve permissions
acpx --cwd ~/repos/shop --approve-all codex -s pr-842 \
  'Review PR #842 for regressions and propose a minimal fix'

# Keep parallel streams for the same repo
acpx codex -s bugfix 'isolate flaky checkout test'
acpx codex -s release 'draft release notes from recent commits'
```

## Global options in practice

```bash
acpx --approve-all codex 'apply the patch and run tests'
acpx --approve-reads codex 'inspect repo structure and suggest plan' # default mode
acpx --deny-all codex 'explain what you can do without tool access'

acpx --cwd ~/repos/backend codex 'review recent auth changes'
acpx --format text codex 'summarize your findings'
acpx --format json codex exec 'review changed files'
acpx --format quiet codex 'final recommendation only'

acpx --timeout 90 codex 'investigate intermittent test timeout'
acpx --ttl 30 codex 'keep queue owner alive for quick follow-ups'
acpx --verbose codex 'debug why adapter startup is failing'
```

## Configuration files

`acpx` reads config in this order (later wins):

1. global: `~/.acpx/config.json`
2. project: `<cwd>/.acpxrc.json`

CLI flags always win over config values.

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
  },
  "auth": {
    "my_auth_method_id": "credential-value"
  }
}
```

Use `acpx config show` to inspect the resolved result and `acpx config init` to create the global template.

## Output formats

```bash
# text (default): human-readable stream with tool updates
acpx codex 'review this PR'

# json: NDJSON events, useful for automation
acpx --format json codex exec 'review this PR' \
  | jq -r 'select(.type=="tool_call") | [.status, .title] | @tsv'

# quiet: final assistant text only
acpx --format quiet codex 'give me a 3-line summary'
```

## Built-in agents and custom servers

Built-ins:

| Agent      | Adapter                                                                | Wraps                                                 |
| ---------- | ---------------------------------------------------------------------- | ----------------------------------------------------- |
| `codex`    | [codex-acp](https://github.com/zed-industries/codex-acp)               | [Codex CLI](https://codex.openai.com)                 |
| `claude`   | [claude-agent-acp](https://github.com/zed-industries/claude-agent-acp) | [Claude Code](https://claude.ai/code)                 |
| `gemini`   | native                                                                 | [Gemini CLI](https://github.com/google/gemini-cli)    |
| `opencode` | native                                                                 | [OpenCode](https://opencode.ai)                       |
| `pi`       | [pi-acp](https://github.com/svkozak/pi-acp)                            | [Pi Coding Agent](https://github.com/mariozechner/pi) |

Use `--agent` as an escape hatch for custom ACP servers:

```bash
acpx --agent ./my-custom-acp-server 'do something'
```

## Session behavior

- Prompt commands require an existing saved session record (created via `sessions new`).
- Prompts route by walking up from `cwd` (or `--cwd`) to the nearest git root (inclusive) and selecting the nearest active session matching `(agent command, dir, optional name)`.
- If no git root is found, prompts only match an exact `cwd` session (no parent-directory walk).
- `-s <name>` selects a parallel named session during that directory walk.
- `sessions new [--name <name>]` creates a fresh session for that scope and soft-closes the prior one.
- `sessions close [name]` soft-closes the session: queue owner/processes are terminated, record is kept with `closed: true`.
- Auto-resume for cwd scope skips sessions marked closed.
- Prompt submissions are queue-aware per session. If a prompt is already running, new prompts are queued and drained by the running `acpx` process.
- Queue owners use an idle TTL (default 300s). `--ttl <seconds>` overrides it; `--ttl 0` keeps owners alive indefinitely.
- `--no-wait` submits to that queue and returns immediately.
- `cancel` sends cooperative `session/cancel` to the running queue owner process and returns success when no prompt is running (`nothing to cancel`).
- `set-mode` and `set` route through queue-owner IPC when active, otherwise they reconnect directly to apply `session/set_mode` and `session/set_config_option`.
- `exec` is always one-shot and does not reuse saved sessions.
- Session metadata is stored under `~/.acpx/sessions/`.
- Each successful prompt appends lightweight turn history previews (`role`, `timestamp`, `textPreview`) to session metadata.
- `Ctrl+C` during a running turn sends ACP `session/cancel` and waits briefly for `stopReason=cancelled` before force-killing if needed.
- If a saved session pid is dead on the next prompt, `acpx` respawns the agent, attempts `session/load`, and transparently falls back to `session/new` if loading fails.

## Full CLI reference

See `docs/CLI.md`.

## License

MIT
