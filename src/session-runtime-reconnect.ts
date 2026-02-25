import { normalizeAgentSessionId } from "./agent-session-id.js";
import type { AcpClient } from "./client.js";
import { formatErrorMessage } from "./error-normalization.js";
import type { QueueOwnerActiveSessionController } from "./queue-owner-turn-controller.js";
import { isProcessAlive } from "./queue-ipc.js";
import { writeSessionRecord } from "./session-persistence.js";
import {
  applyLifecycleSnapshotToRecord,
  reconcileAgentSessionId,
} from "./session-runtime-lifecycle.js";
import type { SessionRecord } from "./types.js";

function loadSessionCandidates(record: SessionRecord): string[] {
  const candidates = [normalizeAgentSessionId(record.agentSessionId), record.sessionId];
  const unique: string[] = [];

  for (const candidate of candidates) {
    if (!candidate || unique.includes(candidate)) {
      continue;
    }
    unique.push(candidate);
  }

  return unique;
}

export type ConnectAndLoadSessionOptions = {
  client: AcpClient;
  record: SessionRecord;
  timeoutMs?: number;
  verbose?: boolean;
  activeController: QueueOwnerActiveSessionController;
  withTimeout: <T>(promise: Promise<T>, timeoutMs?: number) => Promise<T>;
  shouldFallbackToNewSession: (error: unknown) => boolean;
  onClientAvailable?: (controller: QueueOwnerActiveSessionController) => void;
  onConnectedRecord?: (record: SessionRecord) => void;
  onSessionIdResolved?: (sessionId: string) => void;
};

export type ConnectAndLoadSessionResult = {
  sessionId: string;
  agentSessionId?: string;
  resumed: boolean;
  loadError?: string;
};

export async function connectAndLoadSession(
  options: ConnectAndLoadSessionOptions,
): Promise<ConnectAndLoadSessionResult> {
  const record = options.record;
  const client = options.client;
  const storedProcessAlive = isProcessAlive(record.pid);
  const shouldReconnect = Boolean(record.pid) && !storedProcessAlive;

  if (options.verbose) {
    if (storedProcessAlive) {
      process.stderr.write(
        `[acpx] saved session pid ${record.pid} is running; reconnecting with loadSession\n`,
      );
    } else if (shouldReconnect) {
      process.stderr.write(
        `[acpx] saved session pid ${record.pid} is dead; respawning agent and attempting session/load\n`,
      );
    }
  }

  await options.withTimeout(client.start(), options.timeoutMs);
  options.onClientAvailable?.(options.activeController);
  applyLifecycleSnapshotToRecord(record, client.getAgentLifecycleSnapshot());
  record.closed = false;
  record.closedAt = undefined;
  options.onConnectedRecord?.(record);
  await writeSessionRecord(record);

  let resumed = false;
  let loadError: string | undefined;
  let sessionId = record.sessionId;

  if (client.supportsLoadSession()) {
    const candidates = loadSessionCandidates(record);
    for (const candidate of candidates) {
      if (options.verbose && candidates.length > 1) {
        process.stderr.write(`[acpx] attempting session/load with ${candidate}\n`);
      }

      try {
        const loadResult = await options.withTimeout(
          client.loadSessionWithOptions(candidate, record.cwd, {
            suppressReplayUpdates: true,
          }),
          options.timeoutMs,
        );
        reconcileAgentSessionId(record, loadResult.agentSessionId);
        resumed = true;
        sessionId = candidate;
        loadError = undefined;
        break;
      } catch (error) {
        loadError = formatErrorMessage(error);
        if (!options.shouldFallbackToNewSession(error)) {
          throw error;
        }
        if (options.verbose) {
          process.stderr.write(
            `[acpx] session/load failed for ${candidate}: ${loadError}\n`,
          );
        }
      }
    }

    if (!resumed) {
      const createdSession = await options.withTimeout(
        client.createSession(record.cwd),
        options.timeoutMs,
      );
      sessionId = createdSession.sessionId;
      record.sessionId = sessionId;
      reconcileAgentSessionId(record, createdSession.agentSessionId);
    }
  } else {
    const createdSession = await options.withTimeout(
      client.createSession(record.cwd),
      options.timeoutMs,
    );
    sessionId = createdSession.sessionId;
    record.sessionId = sessionId;
    reconcileAgentSessionId(record, createdSession.agentSessionId);
  }

  options.onSessionIdResolved?.(sessionId);

  return {
    sessionId,
    agentSessionId: record.agentSessionId,
    resumed,
    loadError,
  };
}
