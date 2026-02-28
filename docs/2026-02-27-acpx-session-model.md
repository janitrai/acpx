# ACPX Session Model

Date: 2026-02-27
Status: Specification (target model)

## Goal

Define a long-term stable persistence model with:

- one authoritative ACP transcript stream,
- one session checkpoint/index schema,
- strict separation between ACP stream data and local runtime bookkeeping.

## Core Decisions

1. ACP messages are the only allowed payloads in the stream.
2. The stream is append-only NDJSON, one raw ACP JSON-RPC message per line.
3. `session.json` is a derived checkpoint/index, not a second event protocol.
4. Local reliability state (queue owner, process, retries, lock, offsets) is out-of-band from the ACP stream.
5. No custom event envelope is allowed on the ACP stream.

## Canonical ID Semantics

- `acpx_record_id`: acpx local record id (stable storage id).
- `acp_session_id`: ACP session id used on wire.
- `agent_session_id`: harness-native id (Codex/Claude/OpenCode/Pi/etc), when available.
- `request_id`: ACP request id scope.

Rules:

- `acpx_record_id` is always required in local storage.
- `acp_session_id` and `agent_session_id` are optional and may appear later.
- Values may be equal in some runtimes; semantics remain distinct.

## Storage Layout

For each `acpx_record_id`:

```text
~/.acpx/sessions/<acpx_record_id>.stream.ndjson
~/.acpx/sessions/<acpx_record_id>.stream.1.ndjson
~/.acpx/sessions/<acpx_record_id>.stream.2.ndjson
...
~/.acpx/sessions/<acpx_record_id>.json
~/.acpx/sessions/<acpx_record_id>.stream.lock
```

Rules:

- `*.stream*.ndjson` is authoritative history.
- `<acpx_record_id>.json` is the local checkpoint/index.
- No second persisted event protocol is allowed.

## ACP Stream Contract

Each NDJSON line is one raw ACP JSON-RPC message as exchanged over ACP.

Allowed message shapes are standard JSON-RPC 2.0 forms used by ACP:

- request: `{ "jsonrpc": "2.0", "id": ..., "method": "...", "params": ... }`
- response: `{ "jsonrpc": "2.0", "id": ..., "result": ... }`
- error: `{ "jsonrpc": "2.0", "id": ..., "error": { "code": ..., "message": ..., "data": ... } }`
- notification: `{ "jsonrpc": "2.0", "method": "...", "params": ... }`

Examples:

```json
{"jsonrpc":"2.0","id":"req-1","method":"session/prompt","params":{"sessionId":"019c...","prompt":"hi"}}
{"jsonrpc":"2.0","method":"session/update","params":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Hello"}}}
{"jsonrpc":"2.0","id":"req-1","result":{"stopReason":"end_turn"}}
```

Hard constraints:

- no custom `schema` field in streamed messages,
- no synthetic `type`/`stream` envelope keys,
- no acpx-only control/event wrappers in the stream,
- no key renaming of ACP payload fields in the stream.

## Stdout Contract (`--format json --json-strict`)

For commands that communicate with an ACP adapter, stdout must contain only raw ACP JSON-RPC messages, one per line.

- no non-ACP JSON objects in this stream,
- no human text in stdout,
- no stderr noise when `--json-strict` is enabled.

If local command output is needed for non-ACP commands, that output is not part of the ACP stream contract.

## Session Checkpoint Schema (`acpx.session.v1`)

`session.json` is derived from replay + local runtime state, with top-level conversation and top-level acpx state.

```json
{
  "schema": "acpx.session.v1",
  "acpx_record_id": "019c....",
  "acp_session_id": "019c....",
  "agent_session_id": "019c....",

  "agent_command": "npx codex-acp",
  "cwd": "/repo",
  "name": "my-session",

  "created_at": "2026-02-27T12:00:00.000Z",
  "last_used_at": "2026-02-27T12:10:00.000Z",
  "last_seq": 412,
  "last_request_id": "req_123",

  "event_log": {
    "active_path": "/home/user/.acpx/sessions/019c....stream.ndjson",
    "segment_count": 3,
    "max_segment_bytes": 67108864,
    "max_segments": 5,
    "last_write_at": "2026-02-27T12:10:00.000Z",
    "last_write_error": null
  },

  "title": null,
  "messages": [],
  "cumulative_token_usage": {},
  "request_token_usage": {},

  "acpx": {
    "current_mode_id": "code",
    "available_commands": ["session/set_mode", "session/set_config_option"]
  }
}
```

Rules:

- `session.json` is not a transport protocol.
- `session.json` may include local bookkeeping, but the stream may not.
- `session.json` must be reconstructible from stream + local deterministic projection rules.

## Local State Boundary

Local app state must stay out of the ACP stream.

Examples of local-only state:

- queue owner pid and health,
- lock/lease metadata,
- process lifecycle snapshots,
- retry counters,
- write offsets/segment pointers,
- local diagnostics.

This state belongs in checkpoint/state stores or status commands, never in streamed ACP payloads.

## Sequence and Single-Writer Rules

To preserve strict monotonic ordering:

1. Acquire `<acpx_record_id>.stream.lock`.
2. Determine next sequence position from checkpoint tail.
3. Append one raw ACP message line.
4. Flush append.
5. Update checkpoint atomically.
6. Release lock.

No writes are allowed without lock ownership.

## Replay and Recovery

On startup or repair:

1. Read all stream segments oldest to newest.
2. Parse each line as JSON-RPC ACP message.
3. Rebuild checkpoint projection.
4. Atomically rewrite `session.json`.

Corrupt line policy:

- trailing partial final line: ignore only that line,
- any mid-file invalid line: fail strict replay.

## Validation and Guardrails

Required:

- stream validator: each line must be JSON-RPC ACP message,
- no acpx envelope/event schema accepted on ACP stream,
- checkpoint validator for `acpx.session.v1`,
- contract tests that assert `--format json --json-strict` emits ACP-only lines.

## Non-Goals

- custom stream schema layered over ACP,
- mixed ACP + acpx envelope events in one stream,
- backward-compat wrappers in the ACP stream.
