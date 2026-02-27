# ACPX Session Model

Date: 2026-02-27
Status: Implemented + Extended Specification

## Goal

Define a stable acpx persistence model that:

1. Keeps conversation/thread semantics as close as practical to Zed thread persistence.
2. Keeps runtime bookkeeping separate from conversation content.
3. Adds a dedicated append-only NDJSON event log for deep auditing.
4. Avoids backward-compat complexity in this alpha phase.

Reference alignment targets:

- `crates/agent/src/db.rs` (`DbThread`)
- `crates/agent/src/thread.rs` (`Message`, `UserMessage`, `AgentMessage`, content/tool types)

## Design Rules

1. `thread` is the canonical conversation snapshot.
2. `acpx.*` is runtime/control bookkeeping.
3. High-volume event stream data goes to `events.ndjson`, not embedded in `thread`.
4. `session.json` stays deterministic and cheap to read/write.
5. No legacy schema read path for old message shapes.

## File Layout

For each session record id (`acpxRecordId`):

```text
~/.acpx/sessions/<acpxRecordId>.json
~/.acpx/sessions/<acpxRecordId>.events.ndjson
~/.acpx/sessions/<acpxRecordId>.events.1.ndjson
~/.acpx/sessions/<acpxRecordId>.events.2.ndjson
...
```

Notes:

- `<acpxRecordId>.json` is the authoritative current snapshot.
- `.events*.ndjson` files are append-only audit timeline segments.

## Canonical `session.json` Schema

```json
{
  "schema": "acpx.session.v1",
  "acpxRecordId": "...",
  "acpSessionId": "...",
  "agentSessionId": "...",
  "agentCommand": "npx @zed-industries/codex-acp",
  "cwd": "/repo",
  "name": "backend",
  "createdAt": "2026-02-27T12:00:00.000Z",
  "lastUsedAt": "2026-02-27T12:10:00.000Z",
  "closed": false,
  "closedAt": null,
  "pid": 1234,
  "agentStartedAt": "2026-02-27T12:00:01.000Z",
  "lastPromptAt": "2026-02-27T12:09:40.000Z",
  "lastAgentExitCode": null,
  "lastAgentExitSignal": null,
  "lastAgentExitAt": null,
  "lastAgentDisconnectReason": null,
  "protocolVersion": 1,
  "agentCapabilities": {},
  "thread": {},
  "acpx": {}
}
```

## `thread` Payload (Zed-Analogous)

```json
{
  "version": "0.3.0",
  "title": "...",
  "messages": [],
  "updated_at": "2026-02-27T12:10:00.000Z",
  "detailed_summary": null,
  "initial_project_snapshot": null,
  "cumulative_token_usage": {},
  "request_token_usage": {},
  "model": null,
  "profile": null,
  "imported": false,
  "subagent_context": null,
  "speed": null,
  "thinking_enabled": false,
  "thinking_effort": null
}
```

### `messages` Variants

User message:

```json
{
  "User": {
    "id": "2f8f2028-df7d-4479-a0a0-9f10238986cd",
    "content": [{ "Text": "hello" }]
  }
}
```

Agent message:

```json
{
  "Agent": {
    "content": [
      { "Text": "hi" },
      { "Thinking": { "text": "planning", "signature": null } },
      {
        "ToolUse": {
          "id": "call_123",
          "name": "run_command",
          "raw_input": "{\"command\":\"ls\"}",
          "input": { "command": "ls" },
          "is_input_complete": true,
          "thought_signature": null
        }
      }
    ],
    "tool_results": {
      "call_123": {
        "tool_use_id": "call_123",
        "tool_name": "run_command",
        "is_error": false,
        "content": { "Text": "ok" },
        "output": { "exitCode": 0 }
      }
    },
    "reasoning_details": null
  }
}
```

Resume marker:

```json
"Resume"
```

### Token Usage Shape

`cumulative_token_usage` and each entry in `request_token_usage` use:

```json
{
  "input_tokens": 120,
  "output_tokens": 80,
  "cache_creation_input_tokens": 0,
  "cache_read_input_tokens": 32
}
```

`request_token_usage` is keyed by user message id.

## `acpx` Namespace

`acpx` holds runtime/control metadata, never conversation content.

```json
{
  "current_mode_id": "code",
  "available_commands": ["create_plan", "run"],
  "config_options": [],
  "audit_seq": 412,
  "audit_dropped_count": 31,
  "audit_events": [],
  "last_turn": null,
  "last_control_update": null,
  "event_log": {
    "format_version": 1,
    "active_path": "~/.acpx/sessions/<acpxRecordId>.events.ndjson",
    "segment_count": 3,
    "max_segment_bytes": 67108864,
    "max_segments": 5,
    "last_seq": 412,
    "last_write_at": "2026-02-27T12:10:00.000Z",
    "last_write_error": null
  }
}
```

### `acpx.audit_events` (In-JSON Compact Ring)

- Purpose: quick local introspection without scanning NDJSON logs.
- Shape: compact summaries of session updates/client operations.
- Limit: capped ring buffer.
- Overflow behavior: drop oldest entries and increment `audit_dropped_count`.

## `last_turn` Schema

Tracks terminal outcome of the latest prompt turn.

```json
{
  "request_id": "req_123",
  "started_at": "2026-02-27T12:09:40.000Z",
  "ended_at": "2026-02-27T12:09:48.000Z",
  "resumed": true,
  "stop_reason": "end_turn",
  "outcome": "completed",
  "error": null,
  "permission_stats": {
    "requested": 1,
    "approved": 1,
    "denied": 0,
    "cancelled": 0
  }
}
```

Error outcome example:

```json
{
  "request_id": "req_124",
  "started_at": "2026-02-27T12:11:00.000Z",
  "ended_at": "2026-02-27T12:11:05.000Z",
  "resumed": false,
  "stop_reason": null,
  "outcome": "failed",
  "error": {
    "code": "RUNTIME",
    "detailCode": "QUEUE_RUNTIME_PROMPT_FAILED",
    "message": "Queue owner disconnected",
    "retryable": true
  },
  "permission_stats": {
    "requested": 0,
    "approved": 0,
    "denied": 0,
    "cancelled": 0
  }
}
```

## `last_control_update` Schema

Tracks latest non-prompt control mutation:

- mode change
- config option change
- cancel request result

```json
{
  "action": "set_mode",
  "request_id": "ctl_201",
  "updated_at": "2026-02-27T12:12:00.000Z",
  "ok": true,
  "payload": {
    "mode_id": "code"
  },
  "error": null
}
```

Config option example:

```json
{
  "action": "set_config_option",
  "request_id": "ctl_202",
  "updated_at": "2026-02-27T12:13:00.000Z",
  "ok": true,
  "payload": {
    "config_id": "model",
    "value": "gpt-5.3-codex"
  },
  "error": null
}
```

## NDJSON Audit Log (`events.ndjson`)

Each line is one JSON object (no multiline JSON entries).

### Envelope

```json
{
  "eventVersion": 1,
  "seq": 413,
  "timestamp": "2026-02-27T12:10:00.000Z",
  "acpxRecordId": "...",
  "acpSessionId": "...",
  "requestId": "req_123",
  "stream": "prompt",
  "source": "acp",
  "type": "session_update",
  "payload": {}
}
```

Fields:

- `eventVersion`: fixed `1`.
- `seq`: strict monotonic per session (incrementing integer).
- `timestamp`: ISO-8601 UTC.
- `acpxRecordId`, `acpSessionId`: stable correlation ids.
- `requestId`: optional, present for prompt/control turn-scoped events.
- `stream`: `prompt | control | lifecycle | queue`.
- `source`: `acp | runtime | queue | client`.
- `type`: event type discriminator.
- `payload`: event-type-specific body.

### Event Types

#### `session_update`

`payload` contains raw ACP session notification body:

```json
{
  "sessionId": "...",
  "update": {
    "sessionUpdate": "agent_message_chunk",
    "content": { "type": "text", "text": "hi" }
  },
  "_meta": null
}
```

#### `client_operation`

```json
{
  "method": "terminal/create",
  "status": "completed",
  "summary": "Ran command",
  "details": "...",
  "timestamp": "..."
}
```

#### `prompt_started`

```json
{
  "message_preview": "first 200 chars",
  "resumed": true
}
```

#### `prompt_done`

```json
{
  "stopReason": "end_turn",
  "permissionStats": {
    "requested": 1,
    "approved": 1,
    "denied": 0,
    "cancelled": 0
  }
}
```

#### `prompt_error`

```json
{
  "code": "RUNTIME",
  "detailCode": "QUEUE_RUNTIME_PROMPT_FAILED",
  "message": "...",
  "retryable": true,
  "acp": {
    "code": -32002,
    "message": "...",
    "data": {}
  }
}
```

#### `control_started`

```json
{
  "action": "set_mode",
  "input": { "modeId": "code" }
}
```

#### `control_done`

```json
{
  "action": "set_mode",
  "ok": true,
  "result": {}
}
```

#### `control_error`

```json
{
  "action": "set_config_option",
  "ok": false,
  "error": {
    "code": "RUNTIME",
    "detailCode": "...",
    "message": "..."
  }
}
```

#### `queue_event`

Used for queue accepts/results/errors in owner flow.

```json
{
  "phase": "accepted",
  "requestId": "req_123"
}
```

#### `lifecycle_event`

```json
{
  "phase": "agent_exit",
  "exitCode": 1,
  "signal": null,
  "reason": "process_exit"
}
```

## Write Ordering and Consistency

For every event:

1. Increment `acpx.audit_seq`.
2. Build NDJSON envelope with that `seq`.
3. Append one line to active `.events.ndjson`.
4. Update `acpx.event_log.last_seq` and `last_write_at`.
5. Update in-memory/session snapshot structures (`thread`, `acpx.audit_events`, `last_turn`, etc.).
6. Persist `session.json` (atomic temp-file rename).

Failure policy:

- Event log append failure must not silently disappear:
  - set `acpx.event_log.last_write_error`.
  - still attempt to persist `session.json`.
- `session.json` write failure is fatal for the operation path currently using it.

## Rotation and Retention

Defaults:

- `max_segment_bytes`: `64 MiB`
- `max_segments`: `5`

When active segment exceeds max bytes:

1. Rotate: `.events.(n-1).ndjson -> .events.n.ndjson`
2. Move active `.events.ndjson -> .events.1.ndjson`
3. Create new empty active `.events.ndjson`
4. Delete oldest beyond `max_segments`

`session.json` should reflect resulting `segment_count`.

## Strictness and Validation

- Only `schema: "acpx.session.v1"` is valid for session files.
- `thread.messages` must be tagged `User`/`Agent`/`"Resume"` shape.
- Legacy `kind/type` thread shapes are invalid and ignored.
- Token usage objects must have numeric non-negative values.
- `speed` must be `standard`, `fast`, or `null`.

## ACP Mapping Summary

- prompt send: add `User` message with UUID id
- `agent_message_chunk`: append `Text`
- `agent_thought_chunk`: append `Thinking`
- `tool_call` / `tool_call_update`: upsert `ToolUse` + `tool_results`
- `usage_update`: map to token usage fields when available
- `session_info_update`: title / updated timestamp
- `available_commands_update`: `acpx.available_commands`
- `current_mode_update`: `acpx.current_mode_id`
- `config_option_update`: `acpx.config_options`

Everything above also emits corresponding NDJSON entries.

## Non-Goals

- No attempt to preserve old session file compatibility in this phase.
- No embedding of raw high-volume audit stream inside `thread`.
- No editor-specific Zed UI/domain data in acpx thread payload.
