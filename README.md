# acpx

Headless CLI client for the [Agent Client Protocol (ACP)](https://agentclientprotocol.com).

`acpx` is built for scriptable, session-aware agent usage from the terminal.

## Install

```bash
npm i -g acpx
```

`acpx` manages persistent sessions, so prefer a global install. Avoid `npx acpx ...` for normal use.

## Agent prerequisites

`acpx` auto-downloads ACP adapters with `npx` on first use. You do not need to install adapter packages manually.

The only prerequisite is the underlying coding agent you want to use:

- `acpx codex` -> Codex CLI: https://codex.openai.com
- `acpx claude` -> Claude Code: https://claude.ai/code
- `acpx gemini` -> Gemini CLI: https://github.com/google/gemini-cli

## Usage examples

```bash
acpx codex 'fix the tests'                     # implicit prompt (persistent session)
acpx codex prompt 'fix the tests'              # explicit prompt subcommand
acpx exec 'summarize this repo'                # default agent shortcut (codex)
acpx codex exec 'what does this repo do?'      # one-shot, no saved session

acpx codex -s api 'implement cursor pagination' # named session
acpx codex -s docs 'rewrite API docs'           # parallel work in another named session

acpx codex sessions              # list sessions for codex command
acpx codex sessions list         # explicit list
acpx codex sessions close        # close cwd-scoped default session
acpx codex sessions close api    # close cwd-scoped named session

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
acpx --verbose codex 'debug why adapter startup is failing'
```

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

- `codex`
- `claude`
- `gemini`

Use `--agent` as an escape hatch for custom ACP servers:

```bash
acpx --agent ./my-custom-acp-server 'do something'
```

## Session behavior

- Prompt commands use saved sessions scoped to `(agent command, cwd, optional name)`.
- `-s <name>` creates/selects a parallel named session in the same repo.
- `exec` is always one-shot and does not reuse saved sessions.
- Session metadata is stored under `~/.acpx/sessions/`.

## Full CLI reference

See `docs/CLI.md`.

## License

MIT
