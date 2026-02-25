import { normalizeAgentSessionId } from "./agent-session-id.js";
import type { AgentLifecycleSnapshot } from "./client.js";
import type { SessionRecord } from "./types.js";

export function applyLifecycleSnapshotToRecord(
  record: SessionRecord,
  snapshot: AgentLifecycleSnapshot,
): void {
  record.pid = snapshot.pid;
  record.agentStartedAt = snapshot.startedAt;

  if (snapshot.lastExit) {
    record.lastAgentExitCode = snapshot.lastExit.exitCode;
    record.lastAgentExitSignal = snapshot.lastExit.signal;
    record.lastAgentExitAt = snapshot.lastExit.exitedAt;
    record.lastAgentDisconnectReason = snapshot.lastExit.reason;
    return;
  }

  record.lastAgentExitCode = undefined;
  record.lastAgentExitSignal = undefined;
  record.lastAgentExitAt = undefined;
  record.lastAgentDisconnectReason = undefined;
}

export function reconcileAgentSessionId(
  record: SessionRecord,
  agentSessionId: string | undefined,
): void {
  const normalized = normalizeAgentSessionId(agentSessionId);
  if (!normalized) {
    return;
  }

  record.agentSessionId = normalized;
}
