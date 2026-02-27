# ACPX Session Model

Date: 2026-02-27
Status: Specification (target model)

## Goal

Define a long-term stable persistence model with:

- one canonical event schema,
- one authoritative event timeline,
- one checkpoint/session schema where conversation and ACPX runtime state are both top-level.

## Core Decisions

1. Persist exactly one canonical event schema: `acpx.event.v1`.
2. Use append-only NDJSON event files as source of truth.
3. Use `session.json` as a derived checkpoint/index.
4. Keep conversation fields at the root of `session.json` (no nested conversation object).
5. Keep ACPX runtime fields at the root of `session.json` (no separate runtime file).
6. Use `snake_case` for all persisted acpx-owned keys.

## Canonical ID Semantics

- `session_id`: acpx local record id (stable primary id for storage paths and lookup).
- `acp_session_id`: ACP adapter/session id exposed by the adapter/runtime.
- `agent_session_id`: upstream harness-native session id (Codex/Claude/OpenCode/Pi/etc), if available.
- `request_id`: turn/control request scope id.
- `event_id`: unique id of one persisted event.

Rules:

- `session_id` is always required.
- `acp_session_id` and `agent_session_id` are optional but should be populated when known.
- IDs may be equal in some runtimes; semantics remain distinct.

## Storage Layout

For each `session_id`:

```text
~/.acpx/sessions/<session_id>.events.ndjson
~/.acpx/sessions/<session_id>.events.1.ndjson
~/.acpx/sessions/<session_id>.events.2.ndjson
...
~/.acpx/sessions/<session_id>.json
~/.acpx/sessions/<session_id>.events.lock
```

Rules:

- `events*.ndjson` is authoritative history.
- `<session_id>.json` is derived checkpoint/index.
- `.events.lock` enforces single-writer sequencing.
- No second persisted event schema.

## Canonical Event Schema (`acpx.event.v1`)

Each NDJSON line is exactly one object:

```json
{
  "schema": "acpx.event.v1",
  "event_id": "dce8a12e-4f8b-4a4e-b9f6-1f8f6fd2d66e",
  "session_id": "019c....",
  "acp_session_id": "019c....",
  "agent_session_id": "019c....",
  "request_id": "req_123",
  "seq": 412,
  "ts": "2026-02-27T12:10:00.000Z",
  "type": "output_delta",
  "data": {
    "stream": "output",
    "text": "hello"
  }
}
```

Field contract:

- `schema`: fixed string, currently `acpx.event.v1`.
- `event_id`: UUID, unique per event.
- `session_id`: required.
- `acp_session_id`: optional.
- `agent_session_id`: optional.
- `request_id`: optional for session lifecycle events.
- `seq`: strict monotonic integer per session; never resets.
- `ts`: ISO-8601 UTC emit timestamp.
- `type`: event discriminator.
- `data`: type-specific payload.

## Canonical Event Types

### Prompt/Turn Flow

#### `turn_started`

```json
{
  "type": "turn_started",
  "data": {
    "mode": "prompt",
    "resumed": true,
    "input_preview": "first 200 chars"
  }
}
```

#### `output_delta`

```json
{
  "type": "output_delta",
  "data": {
    "stream": "output",
    "text": "chunk"
  }
}
```

`data.stream` enum:

- `output`
- `thought`

#### `tool_call`

```json
{
  "type": "tool_call",
  "data": {
    "tool_call_id": "call_1",
    "title": "run_command",
    "status": "in_progress"
  }
}
```

`data.status` enum:

- `pending`
- `in_progress`
- `completed`
- `failed`
- `unknown`

#### `turn_done`

```json
{
  "type": "turn_done",
  "data": {
    "stop_reason": "end_turn",
    "permission_stats": {
      "requested": 1,
      "approved": 1,
      "denied": 0,
      "cancelled": 0
    }
  }
}
```

#### `error`

```json
{
  "type": "error",
  "data": {
    "code": "RUNTIME",
    "detail_code": "QUEUE_RUNTIME_PROMPT_FAILED",
    "origin": "queue",
    "message": "Queue owner disconnected",
    "retryable": true,
    "acp_error": {
      "code": -32002,
      "message": "...",
      "data": {}
    }
  }
}
```

`data.code` enum:

- `NO_SESSION`
- `TIMEOUT`
- `PERMISSION_DENIED`
- `PERMISSION_PROMPT_UNAVAILABLE`
- `RUNTIME`
- `USAGE`

`data.origin` enum:

- `cli`
- `runtime`
- `queue`
- `acp`

### Control/Lifecycle Flow

#### `session_ensured`

```json
{
  "type": "session_ensured",
  "data": {
    "created": true,
    "name": "my-session"
  }
}
```

#### `cancel_requested`

```json
{
  "type": "cancel_requested",
  "data": {}
}
```

#### `cancel_result`

```json
{
  "type": "cancel_result",
  "data": {
    "cancelled": true
  }
}
```

#### `mode_set`

```json
{
  "type": "mode_set",
  "data": {
    "mode_id": "code"
  }
}
```

#### `config_set`

```json
{
  "type": "config_set",
  "data": {
    "config_id": "model",
    "value": "gpt-5.3-codex"
  }
}
```

#### `status_snapshot`

```json
{
  "type": "status_snapshot",
  "data": {
    "status": "alive",
    "pid": 1234,
    "summary": "status=alive"
  }
}
```

#### `session_closed`

```json
{
  "type": "session_closed",
  "data": {
    "reason": "close"
  }
}
```

## Stdout Contract (All JSON Commands)

When `--format json --json-strict` is enabled:

- every stdout line must be valid JSON,
- every JSON line must conform to `acpx.event.v1`,
- no non-JSON diagnostics are allowed on stdout.

Command behavior:

- prompt commands emit `turn_started`, zero or more `output_delta`/`tool_call`, then terminal event (`turn_done` or `error`).
- control/status/session commands emit relevant control/lifecycle events (`session_ensured`, `mode_set`, `config_set`, `status_snapshot`, `cancel_result`, `session_closed`) and may emit `error`.
- `seq` ordering must match emission order for each `session_id`.

## Session Checkpoint Schema (`acpx.session.v1`)

`session.json` is derived from event replay.

Conversation fields and runtime fields are stored at the same top level.

```json
{
  "schema": "acpx.session.v1",
  "version": "1.0.0",

  "session_id": "019c....",
  "acp_session_id": "019c....",
  "agent_session_id": "019c....",

  "agent_command": "npx codex-acp",
  "cwd": "/repo",
  "name": "my-session",

  "created_at": "2026-02-27T12:00:00.000Z",
  "updated_at": "2026-02-27T12:10:00.000Z",
  "last_used_at": "2026-02-27T12:10:00.000Z",

  "last_seq": 412,
  "last_request_id": "req_123",
  "closed": false,
  "closed_at": null,
  "pid": 1234,

  "event_log": {
    "active_path": "/home/user/.acpx/sessions/019c....events.ndjson",
    "segment_count": 3,
    "max_segment_bytes": 67108864,
    "max_segments": 5,
    "last_write_at": "2026-02-27T12:10:00.000Z",
    "last_write_error": null
  },

  "title": null,
  "messages": [],
  "cumulative_token_usage": {},
  "request_token_usage": {}
}
```

Rules:

- Conversation fields must remain top-level.
- Runtime fields must remain top-level.
- `session.json` must be reconstructible by replaying `events*.ndjson`.

### Message Encoding

`messages` uses externally tagged variants:

- user message: `{ "User": { ... } }`
- agent message: `{ "Agent": { ... } }`
- resume marker: `"Resume"`

## Sequence and Single-Writer Rules

To preserve strict monotonic `seq`:

1. Acquire exclusive lock on `<session_id>.events.lock`.
2. Determine next `seq` from checkpoint tail/replay state.
3. Append event line to active segment.
4. Flush append (`fdatasync`/equivalent durability step).
5. Update checkpoint and write `session.json` atomically (temp + rename).
6. Release lock.

No writes are allowed without acquiring lock.

## Write Ordering and Failure Behavior

For each event write:

1. Validate event against `acpx.event.v1`.
2. Validate persisted key policy (`snake_case`).
3. Append event.
4. Update checkpoint.

Failure policy:

- append failure: operation fails; no synthetic success.
- checkpoint failure after successful append: event remains authoritative; checkpoint rebuilt later.

## Replay and Recovery

On startup or repair:

1. Read all segments oldest -> newest.
2. Validate `schema` and event payloads.
3. Enforce monotonic `seq`.
4. Rebuild checkpoint state.
5. Rewrite `session.json` atomically.

Corrupt line policy:

- trailing partial final line: ignore only that final line,
- any mid-file invalid line: fatal in strict mode.

## Rotation and Retention

Defaults:

- `max_segment_bytes`: `64 MiB`
- `max_segments`: `5`

Rotation:

1. `.events.(n-1).ndjson -> .events.n.ndjson`
2. active `.events.ndjson -> .events.1.ndjson`
3. create new active `.events.ndjson`
4. delete oldest beyond limit.

All rotation operations must occur under the same session lock.

## Privacy and Redaction

Default behavior:

- persist output deltas and minimal tool-call summaries,
- do not persist raw terminal secrets,
- do not persist opaque provider blobs unless explicitly enabled.

## Validation and Guardrails

Required:

- schema validator for `acpx.event.v1` before write,
- persisted-key-casing validator before write,
- contract tests with golden NDJSON fixtures,
- CI checks for unknown/invalid persisted keys,
- parser contract tests that consume canonical events from stdout.

## Mapping from ACP Runtime to Canonical Events

- turn accepted -> `turn_started`
- `agent_message_chunk` -> `output_delta` (`stream=output`)
- `agent_thought_chunk` -> `output_delta` (`stream=thought`)
- `tool_call` / `tool_call_update` -> `tool_call`
- runtime/queue/acp failures -> `error`
- completion -> `turn_done`
- ensure/status/set/cancel/close control paths -> matching control/lifecycle types

## Non-Goals

- backward-compat layers for legacy persisted event schemas,
- multiple persisted event schemas for one timeline,
- duplicate canonical event history in `session.json`.
