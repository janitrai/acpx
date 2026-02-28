import { buildJsonRpcErrorResponse } from "./jsonrpc-error.js";
import type {
  OutputErrorAcpPayload,
  OutputErrorCode,
  OutputErrorOrigin,
  OutputFormatter,
  OutputFormatterContext,
} from "./types.js";

type WritableLike = {
  write(chunk: string): void;
};

const DEFAULT_JSON_SESSION_ID = "unknown";

class JsonOutputFormatter implements OutputFormatter {
  private readonly stdout: WritableLike;
  private sessionId: string;

  constructor(stdout: WritableLike, context?: OutputFormatterContext) {
    this.stdout = stdout;
    this.sessionId = context?.sessionId?.trim() || DEFAULT_JSON_SESSION_ID;
  }

  setContext(context: OutputFormatterContext): void {
    this.sessionId =
      context.sessionId?.trim() || this.sessionId || DEFAULT_JSON_SESSION_ID;
  }

  onAcpMessage(message: unknown): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  onError(params: {
    code: OutputErrorCode;
    detailCode?: string;
    origin?: OutputErrorOrigin;
    message: string;
    retryable?: boolean;
    acp?: OutputErrorAcpPayload;
    timestamp?: string;
  }): void {
    this.stdout.write(
      `${JSON.stringify(
        buildJsonRpcErrorResponse({
          outputCode: params.code,
          detailCode: params.detailCode,
          origin: params.origin,
          message: params.message,
          retryable: params.retryable,
          timestamp: params.timestamp,
          sessionId: this.sessionId,
          acp: params.acp,
        }),
      )}\n`,
    );
  }

  flush(): void {
    // no-op for streaming output
  }
}

export function createJsonOutputFormatter(
  stdout: WritableLike,
  context?: OutputFormatterContext,
): OutputFormatter {
  return new JsonOutputFormatter(stdout, context);
}
