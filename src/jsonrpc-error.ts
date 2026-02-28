import type {
  OutputErrorAcpPayload,
  OutputErrorCode,
  OutputErrorOrigin,
} from "./types.js";

export const OUTPUT_ERROR_JSONRPC_CODES: Record<OutputErrorCode, number> = {
  NO_SESSION: -32002,
  TIMEOUT: -32070,
  PERMISSION_DENIED: -32071,
  PERMISSION_PROMPT_UNAVAILABLE: -32072,
  RUNTIME: -32603,
  USAGE: -32602,
};

type JsonRpcErrorObject = {
  code: number;
  message: string;
  data?: unknown;
};

export type BuildJsonRpcErrorParams = {
  id?: string | number | null;
  outputCode: OutputErrorCode;
  detailCode?: string;
  origin?: OutputErrorOrigin;
  message: string;
  retryable?: boolean;
  timestamp?: string;
  sessionId?: string;
  acp?: OutputErrorAcpPayload;
};

function hasValidAcpError(
  acp: OutputErrorAcpPayload | undefined,
): acp is { code: number; message: string; data?: unknown } {
  return Boolean(
    acp &&
    Number.isFinite(acp.code) &&
    typeof acp.message === "string" &&
    acp.message.trim().length > 0,
  );
}

function buildFallbackData(params: BuildJsonRpcErrorParams): Record<string, unknown> {
  const data: Record<string, unknown> = {
    acpxCode: params.outputCode,
    detailCode: params.detailCode,
    origin: params.origin,
    retryable: params.retryable,
    timestamp: params.timestamp,
    sessionId: params.sessionId,
  };

  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) {
      delete data[key];
    }
  }

  return data;
}

function buildErrorObject(params: BuildJsonRpcErrorParams): JsonRpcErrorObject {
  if (hasValidAcpError(params.acp)) {
    return {
      code: params.acp.code,
      message: params.acp.message,
      ...(params.acp.data !== undefined ? { data: params.acp.data } : {}),
    };
  }

  const data = buildFallbackData(params);
  return {
    code: OUTPUT_ERROR_JSONRPC_CODES[params.outputCode] ?? -32603,
    message: params.message,
    ...(Object.keys(data).length > 0 ? { data } : {}),
  };
}

export function buildJsonRpcErrorResponse(params: BuildJsonRpcErrorParams): {
  jsonrpc: "2.0";
  id: string | number | null;
  error: JsonRpcErrorObject;
} {
  return {
    jsonrpc: "2.0",
    id: params.id ?? null,
    error: buildErrorObject(params),
  };
}
