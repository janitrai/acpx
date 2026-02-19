import type {
  AgentCapabilities,
  SessionNotification,
  StopReason,
} from "@agentclientprotocol/sdk";

export const EXIT_CODES = {
  SUCCESS: 0,
  ERROR: 1,
  USAGE: 2,
  TIMEOUT: 3,
  NO_SESSION: 4,
  PERMISSION_DENIED: 5,
  INTERRUPTED: 130,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

export const OUTPUT_FORMATS = ["text", "json", "quiet"] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

export const PERMISSION_MODES = ["approve-all", "approve-reads", "deny-all"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export type PermissionStats = {
  requested: number;
  approved: number;
  denied: number;
  cancelled: number;
};

export type OutputEvent =
  | {
      type: "text";
      content: string;
      timestamp: string;
    }
  | {
      type: "thought";
      content: string;
      timestamp: string;
    }
  | {
      type: "tool_call";
      toolCallId?: string;
      title?: string;
      status?: string;
      timestamp: string;
    }
  | {
      type: "plan";
      entries: Array<{
        content: string;
        status: string;
        priority: string;
      }>;
      timestamp: string;
    }
  | {
      type: "update";
      update: string;
      timestamp: string;
    }
  | {
      type: "done";
      stopReason: StopReason;
      timestamp: string;
    };

export interface OutputFormatter {
  onSessionUpdate(notification: SessionNotification): void;
  onDone(stopReason: StopReason): void;
  flush(): void;
}

export type AcpClientOptions = {
  agentCommand: string;
  cwd: string;
  permissionMode: PermissionMode;
  verbose?: boolean;
  onSessionUpdate?: (notification: SessionNotification) => void;
};

export type SessionHistoryRole = "user" | "assistant";

export type SessionHistoryEntry = {
  role: SessionHistoryRole;
  timestamp: string;
  textPreview: string;
};

export type SessionRecord = {
  id: string;
  sessionId: string;
  agentCommand: string;
  cwd: string;
  name?: string;
  createdAt: string;
  lastUsedAt: string;
  closed?: boolean;
  closedAt?: string;
  pid?: number;
  agentStartedAt?: string;
  lastPromptAt?: string;
  lastAgentExitCode?: number | null;
  lastAgentExitSignal?: NodeJS.Signals | null;
  lastAgentExitAt?: string;
  lastAgentDisconnectReason?: string;
  turnHistory?: SessionHistoryEntry[];
  protocolVersion?: number;
  agentCapabilities?: AgentCapabilities;
};

export type RunPromptResult = {
  stopReason: StopReason;
  permissionStats: PermissionStats;
  sessionId: string;
};

export type SessionSendResult = RunPromptResult & {
  record: SessionRecord;
  resumed: boolean;
  loadError?: string;
};

export type SessionEnqueueResult = {
  queued: true;
  sessionId: string;
  requestId: string;
};

export type SessionSendOutcome = SessionSendResult | SessionEnqueueResult;
