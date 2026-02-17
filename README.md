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

## Core usage

```bash
acpx codex 'fix the tests'               # implicit prompt, auto-resume session
acpx codex prompt 'fix the tests'        # same, explicit
acpx codex exec 'what does this repo do' # one-shot, no session
acpx codex -s backend 'fix the API'      # named session
acpx codex sessions                      # list sessions
acpx claude 'refactor auth'              # different agent
```

## Session behavior

- Default mode is conversational: prompts use a saved session scoped to `(agent command, cwd)`.
- `-s <name>` switches to a named session scoped to `(agent command, cwd, name)`.
- `exec` is fire-and-forget: temporary session, prompt once, then discard.

Session files are stored in `~/.acpx/sessions/`.

## Built-in agents and custom servers

Built-ins:

- `codex`
- `claude`
- `gemini`

Use `--agent` as an escape hatch for custom ACP servers:

```bash
acpx --agent ./my-custom-acp-server 'do something'
```

## License

MIT
