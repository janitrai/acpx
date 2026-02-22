export class AcpxOperationalError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class SessionNotFoundError extends AcpxOperationalError {
  readonly sessionId: string;

  constructor(sessionId: string) {
    super(`Session not found: ${sessionId}`);
    this.sessionId = sessionId;
  }
}

export class SessionResolutionError extends AcpxOperationalError {}

export class AgentSpawnError extends AcpxOperationalError {
  readonly agentCommand: string;

  constructor(agentCommand: string, cause?: unknown) {
    super(`Failed to spawn agent command: ${agentCommand}`, {
      cause: cause instanceof Error ? cause : undefined,
    });
    this.agentCommand = agentCommand;
  }
}

export class AuthPolicyError extends AcpxOperationalError {}

export class QueueConnectionError extends AcpxOperationalError {}

export class QueueProtocolError extends AcpxOperationalError {}

export class PermissionDeniedError extends AcpxOperationalError {}

export class PermissionPromptUnavailableError extends AcpxOperationalError {
  constructor() {
    super("Permission prompt unavailable in non-interactive mode");
  }
}
