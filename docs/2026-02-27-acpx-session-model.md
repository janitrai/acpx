# ACPX Session Model

Date: 2026-02-27
Status: Proposed

## Goal

Store ACP sessions as durable event logs so acpx can always reconstruct truth from disk, including all relevant ACP traffic, queue behavior, tool activity, and turn lifecycle.

This model is designed to survive protocol evolution without schema churn.

## Design Principles

1. Append only event log is the source of truth.
2. Mutable state is only a projection that can be rebuilt from events.
3. Every ACP wire frame is persisted losslessly.
4. IDs are explicit and non-overlapping.
5. Unknown future ACP methods and notifications are preserved without parser updates.

## Canonical IDs

- `acpxRecordId`: stable local record key for the lifetime of a saved acpx session record.
- `acpSessionId`: ACP session identity used on the wire. May change after reconnect fallback.
- `agentSessionId`: optional inner harness session id (Codex, Claude Code, OpenCode, Pi, Gemini) if adapter exposes it.
- `turnId`: acpx generated id for one user prompt lifecycle (start to done/error/cancel).
- `requestId`: optional queue/request correlation id.

## Storage Layout

Each session becomes a directory instead of one flat JSON file:

```text
~/.acpx/sessions/<acpxRecordId>/
  session.json                 # mutable projection
  events/
    000000000001.ndjson        # append only segments
    000000000002.ndjson
  index/
    turns.json                 # optional derived index
    latest.json                # optional derived cursor cache
```

Rules:

- `events/*.ndjson` is authoritative.
- `session.json` and `index/*` are caches/projections only.
- Segment files are immutable once rotated.

## Event Envelope Schema

Each line in `events/*.ndjson`:

```json
{
  "schema": "acpx.event.v1",
  "seq": 1234,
  "eventId": "01J4...ULID",
  "at": "2026-02-27T10:11:12.345Z",
  "acpxRecordId": "019c...",
  "acpSessionId": "019c...",
  "agentSessionId": "codex_...",
  "turnId": "turn_...",
  "requestId": "req_...",
  "source": "acpx",
  "kind": "acp.frame",
  "payload": {}
}
```

Stable constraints:

- `schema` is required and versioned (`acpx.event.v1`).
- `seq` is strictly increasing per `acpxRecordId`.
- `eventId` is globally unique.
- `payload` is free-form JSON object and never discarded.

## Required Event Kinds

### 1) Raw ACP wire capture (mandatory)

Capture every inbound and outbound JSON-RPC frame:

```json
{
  "kind": "acp.frame",
  "payload": {
    "direction": "out",
    "message": {
      "jsonrpc": "2.0",
      "id": "...",
      "method": "session/prompt",
      "params": {}
    }
  }
}
```

or

```json
{
  "kind": "acp.frame",
  "payload": {
    "direction": "in",
    "message": {
      "jsonrpc": "2.0",
      "method": "session/update",
      "params": {}
    }
  }
}
```

This guarantees future ACP fields/methods are retained even if acpx does not understand them yet.

### 2) Session lifecycle

- `session.created`
- `session.loaded`
- `session.closed`
- `session.rebound` (acpSessionId changed)
- `session.agent_session_id.updated`

### 3) Turn lifecycle

- `turn.started`
- `turn.completed`
- `turn.cancelled`
- `turn.failed`

### 4) Queue and owner lifecycle

- `queue.enqueued`
- `queue.dequeued`
- `queue.owner.started`
- `queue.owner.lease_renewed`
- `queue.owner.idle_expired`
- `queue.owner.stopped`

### 5) Runtime and transport

- `runtime.connected`
- `runtime.disconnected`
- `runtime.reconnect_attempt`
- `runtime.reconnected`

### 6) Error normalization

- `error` with `origin`, `code`, `detailCode`, and the raw error object in payload.

## Mutable Projection (`session.json`)

`session.json` is a fast cache, rebuildable from event replay:

```json
{
  "schema": "acpx.session.v1",
  "acpxRecordId": "019c...",
  "agent": {
    "command": "npx @zed-industries/codex-acp",
    "name": "codex"
  },
  "workspace": {
    "cwd": "/repo",
    "name": "backend"
  },
  "identity": {
    "acpSessionId": "019c...",
    "agentSessionId": "codex_..."
  },
  "lifecycle": {
    "createdAt": "...",
    "lastUsedAt": "...",
    "closed": false,
    "closedAt": null,
    "pid": 1234,
    "agentStartedAt": "...",
    "lastAgentExit": {
      "code": null,
      "signal": null,
      "at": "...",
      "reason": "connection_close"
    }
  },
  "log": {
    "firstSeq": 1,
    "lastSeq": 1234,
    "nextSeq": 1235,
    "activeSegment": "events/000000000002.ndjson"
  }
}
```

## Durability Rules

Write order for each event:

1. append event line to active segment
2. fsync segment
3. update projection fields in memory
4. periodically flush `session.json` (or on lifecycle boundaries)

Crash rule:

- If `session.json` lags, replay from `events/*` to recover.

## Replay and Recovery

On startup/session open:

1. read `session.json` if present
2. scan `events/*` from `log.lastSeq + 1` (or from start if missing)
3. apply reducer to reconstruct current state
4. rewrite `session.json` atomically

If projection is corrupt/missing, full replay is authoritative.

## Retention and Compaction

- Keep events forever by default.
- Optional operator retention policy may archive old segments, never mutate in-place.
- Derived indexes can be deleted anytime and rebuilt from events.

## Migration from Current Model

Current model stores a single JSON record with compact `turnHistory` previews.

Migration should:

1. create `<acpxRecordId>/session.json` from current fields
2. create `events/000000000001.ndjson`
3. backfill synthetic lifecycle events from existing metadata
4. backfill synthetic turn events from `turnHistory` previews
5. from that point onward, persist all ACP frames and lifecycle events

## Why This Should Last

- New ACP methods do not require storage schema changes because raw frames are preserved.
- Projection shape can evolve independently from immutable events.
- Debugging, auditing, analytics, and cross-tool integrations all depend on one stable contract: append-only event envelopes with explicit IDs.
