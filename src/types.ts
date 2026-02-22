import type {
  AgentCapabilities,
  SessionNotification,
  SetSessionConfigOptionResponse,
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

export const AUTH_POLICIES = ["skip", "fail"] as const;
export type AuthPolicy = (typeof AUTH_POLICIES)[number];

export const NON_INTERACTIVE_PERMISSION_POLICIES = ["deny", "fail"] as const;
export type NonInteractivePermissionPolicy =
  (typeof NON_INTERACTIVE_PERMISSION_POLICIES)[number];

export const OUTPUT_STREAMS = ["prompt", "control"] as const;
export type OutputStream = (typeof OUTPUT_STREAMS)[number];

export const OUTPUT_ERROR_CODES = [
  "NO_SESSION",
  "TIMEOUT",
  "PERMISSION_DENIED",
  "PERMISSION_PROMPT_UNAVAILABLE",
  "RUNTIME",
  "USAGE",
] as const;
export type OutputErrorCode = (typeof OUTPUT_ERROR_CODES)[number];

export type PermissionStats = {
  requested: number;
  approved: number;
  denied: number;
  cancelled: number;
};

export type ClientOperationMethod =
  | "fs/read_text_file"
  | "fs/write_text_file"
  | "terminal/create"
  | "terminal/output"
  | "terminal/wait_for_exit"
  | "terminal/kill"
  | "terminal/release";

export type ClientOperationStatus = "running" | "completed" | "failed";

export type ClientOperation = {
  method: ClientOperationMethod;
  status: ClientOperationStatus;
  summary: string;
  details?: string;
  timestamp: string;
};

export type OutputEventEnvelope = {
  eventVersion: 1;
  sessionId: string;
  requestId?: string;
  seq: number;
  stream: OutputStream;
};

export type BaseOutputEvent = OutputEventEnvelope & {
  timestamp: string;
};

export type OutputEvent =
  | {
      eventVersion: 1;
      sessionId: string;
      requestId?: string;
      seq: number;
      stream: OutputStream;
      type: "text";
      content: string;
      timestamp: string;
    }
  | {
      eventVersion: 1;
      sessionId: string;
      requestId?: string;
      seq: number;
      stream: OutputStream;
      type: "thought";
      content: string;
      timestamp: string;
    }
  | {
      eventVersion: 1;
      sessionId: string;
      requestId?: string;
      seq: number;
      stream: OutputStream;
      type: "tool_call";
      toolCallId?: string;
      title?: string;
      status?: string;
      timestamp: string;
    }
  | {
      eventVersion: 1;
      sessionId: string;
      requestId?: string;
      seq: number;
      stream: OutputStream;
      type: "client_operation";
      method: ClientOperationMethod;
      status: ClientOperationStatus;
      summary: string;
      details?: string;
      timestamp: string;
    }
  | {
      eventVersion: 1;
      sessionId: string;
      requestId?: string;
      seq: number;
      stream: OutputStream;
      type: "plan";
      entries: Array<{
        content: string;
        status: string;
        priority: string;
      }>;
      timestamp: string;
    }
  | {
      eventVersion: 1;
      sessionId: string;
      requestId?: string;
      seq: number;
      stream: OutputStream;
      type: "update";
      update: string;
      timestamp: string;
    }
  | {
      eventVersion: 1;
      sessionId: string;
      requestId?: string;
      seq: number;
      stream: OutputStream;
      type: "done";
      stopReason: StopReason;
      timestamp: string;
    }
  | {
      eventVersion: 1;
      sessionId: string;
      requestId?: string;
      seq: number;
      stream: OutputStream;
      type: "error";
      code: OutputErrorCode;
      message: string;
      retryable?: boolean;
      timestamp: string;
    };

export type OutputFormatterContext = {
  sessionId: string;
  requestId?: string;
  stream?: OutputStream;
};

export interface OutputFormatter {
  setContext(context: OutputFormatterContext): void;
  onSessionUpdate(notification: SessionNotification): void;
  onClientOperation(operation: ClientOperation): void;
  onError(params: {
    code: OutputErrorCode;
    message: string;
    retryable?: boolean;
    timestamp?: string;
  }): void;
  onDone(stopReason: StopReason): void;
  flush(): void;
}

export type AcpClientOptions = {
  agentCommand: string;
  cwd: string;
  permissionMode: PermissionMode;
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  authCredentials?: Record<string, string>;
  authPolicy?: AuthPolicy;
  verbose?: boolean;
  onSessionUpdate?: (notification: SessionNotification) => void;
  onClientOperation?: (operation: ClientOperation) => void;
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

export type SessionSetModeResult = {
  record: SessionRecord;
  resumed: boolean;
  loadError?: string;
};

export type SessionSetConfigOptionResult = {
  record: SessionRecord;
  response: SetSessionConfigOptionResponse;
  resumed: boolean;
  loadError?: string;
};

export type SessionEnsureResult = {
  record: SessionRecord;
  created: boolean;
};

export type SessionEnqueueResult = {
  queued: true;
  sessionId: string;
  requestId: string;
};

export type SessionSendOutcome = SessionSendResult | SessionEnqueueResult;
