#!/usr/bin/env node

import { Command, CommanderError, InvalidArgumentError } from "commander";
import { realpathSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { findSkillsRoot, maybeHandleSkillflag } from "skillflag";
import {
  DEFAULT_AGENT_NAME,
  listBuiltInAgents,
  resolveAgentCommand as resolveAgentCommandFromRegistry,
} from "./agent-registry.js";
import { parseQueueOwnerFlags } from "./cli-internal-owner.js";
import { configurePublicCli } from "./cli-public.js";
import {
  initGlobalConfigFile,
  loadResolvedConfig,
  toConfigDisplay,
  type ResolvedAcpxConfig,
} from "./config.js";
import {
  exitCodeForOutputErrorCode,
  normalizeOutputError,
  type NormalizedOutputError,
} from "./error-normalization.js";
import { createOutputFormatter } from "./output.js";
import {
  DEFAULT_HISTORY_LIMIT,
  DEFAULT_QUEUE_OWNER_TTL_MS,
  InterruptedError,
  cancelSessionPrompt,
  closeSession,
  createSession,
  ensureSession,
  findGitRepositoryRoot,
  findSession,
  findSessionByDirectoryWalk,
  isProcessAlive,
  listSessionsForAgent,
  runOnce,
  runQueueOwnerProcess,
  readSessionQueueOwnerStatus,
  setSessionConfigOption,
  setSessionMode,
  sendSession,
} from "./session.js";
import { normalizeAgentSessionId } from "./agent-session-id.js";
import { getAcpxVersion } from "./version.js";
import {
  AUTH_POLICIES,
  EXIT_CODES,
  NON_INTERACTIVE_PERMISSION_POLICIES,
  OUTPUT_FORMATS,
  type NonInteractivePermissionPolicy,
  type AuthPolicy,
  type OutputFormat,
  type OutputPolicy,
  type PermissionMode,
  type SessionRecord,
} from "./types.js";

class NoSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoSessionError";
  }
}

type PermissionFlags = {
  approveAll?: boolean;
  approveReads?: boolean;
  denyAll?: boolean;
};

type GlobalFlags = PermissionFlags & {
  agent?: string;
  cwd: string;
  authPolicy?: AuthPolicy;
  nonInteractivePermissions: NonInteractivePermissionPolicy;
  jsonStrict?: boolean;
  timeout?: number;
  ttl: number;
  verbose?: boolean;
  format: OutputFormat;
};

type PromptFlags = {
  session?: string;
  wait?: boolean;
  file?: string;
};

type ExecFlags = {
  file?: string;
};

type SessionsNewFlags = {
  name?: string;
};

type SessionsHistoryFlags = {
  limit: number;
};

type StatusFlags = {
  session?: string;
};

const TOP_LEVEL_VERBS = new Set([
  "__queue-owner",
  "prompt",
  "exec",
  "cancel",
  "set-mode",
  "set",
  "sessions",
  "status",
  "config",
  "help",
]);

function parseOutputFormat(value: string): OutputFormat {
  if (!OUTPUT_FORMATS.includes(value as OutputFormat)) {
    throw new InvalidArgumentError(
      `Invalid format "${value}". Expected one of: ${OUTPUT_FORMATS.join(", ")}`,
    );
  }
  return value as OutputFormat;
}

function parseAuthPolicy(value: string): AuthPolicy {
  if (!AUTH_POLICIES.includes(value as AuthPolicy)) {
    throw new InvalidArgumentError(
      `Invalid auth policy "${value}". Expected one of: ${AUTH_POLICIES.join(", ")}`,
    );
  }
  return value as AuthPolicy;
}

function parseNonInteractivePermissionPolicy(
  value: string,
): NonInteractivePermissionPolicy {
  if (
    !NON_INTERACTIVE_PERMISSION_POLICIES.includes(
      value as NonInteractivePermissionPolicy,
    )
  ) {
    throw new InvalidArgumentError(
      `Invalid non-interactive permission policy "${value}". Expected one of: ${NON_INTERACTIVE_PERMISSION_POLICIES.join(", ")}`,
    );
  }
  return value as NonInteractivePermissionPolicy;
}

function parseTimeoutSeconds(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new InvalidArgumentError("Timeout must be a positive number of seconds");
  }
  return Math.round(parsed * 1000);
}

export function parseTtlSeconds(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new InvalidArgumentError("TTL must be a non-negative number of seconds");
  }
  return Math.round(parsed * 1000);
}

function parseSessionName(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new InvalidArgumentError("Session name must not be empty");
  }
  return trimmed;
}

function parseNonEmptyValue(label: string, value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new InvalidArgumentError(`${label} must not be empty`);
  }
  return trimmed;
}

function parseHistoryLimit(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError("Limit must be a positive integer");
  }
  return parsed;
}

function resolvePermissionMode(
  flags: PermissionFlags,
  defaultMode: PermissionMode,
): PermissionMode {
  const selected = [flags.approveAll, flags.approveReads, flags.denyAll].filter(
    Boolean,
  ).length;

  if (selected > 1) {
    throw new InvalidArgumentError(
      "Use only one permission mode: --approve-all, --approve-reads, or --deny-all",
    );
  }

  if (flags.approveAll) {
    return "approve-all";
  }
  if (flags.denyAll) {
    return "deny-all";
  }

  return defaultMode;
}

async function readPromptInputFromStdin(): Promise<string> {
  let data = "";
  for await (const chunk of process.stdin) {
    data += String(chunk);
  }
  return data;
}

async function readPrompt(
  promptParts: string[],
  filePath: string | undefined,
  cwd: string,
): Promise<string> {
  if (filePath) {
    const source =
      filePath === "-"
        ? await readPromptInputFromStdin()
        : await fs.readFile(path.resolve(cwd, filePath), "utf8");
    const pieces = [source.trim(), promptParts.join(" ").trim()].filter(
      (value) => value.length > 0,
    );
    const prompt = pieces.join("\n\n").trim();
    if (!prompt) {
      throw new InvalidArgumentError("Prompt from --file is empty");
    }
    return prompt;
  }

  const joined = promptParts.join(" ").trim();
  if (joined.length > 0) {
    return joined;
  }

  if (process.stdin.isTTY) {
    throw new InvalidArgumentError(
      "Prompt is required (pass as argument, --file, or pipe via stdin)",
    );
  }

  const prompt = (await readPromptInputFromStdin()).trim();
  if (!prompt) {
    throw new InvalidArgumentError("Prompt from stdin is empty");
  }

  return prompt;
}

function applyPermissionExitCode(result: {
  permissionStats: {
    requested: number;
    approved: number;
    denied: number;
    cancelled: number;
  };
}): void {
  const stats = result.permissionStats;
  const deniedOrCancelled = stats.denied + stats.cancelled;

  if (stats.requested > 0 && stats.approved === 0 && deniedOrCancelled > 0) {
    process.exitCode = EXIT_CODES.PERMISSION_DENIED;
  }
}

function addGlobalFlags(command: Command): Command {
  return command
    .option("--agent <command>", "Raw ACP agent command (escape hatch)")
    .option("--cwd <dir>", "Working directory", process.cwd())
    .option(
      "--auth-policy <policy>",
      "Authentication policy: skip or fail when auth is required",
      parseAuthPolicy,
    )
    .option("--approve-all", "Auto-approve all permission requests")
    .option(
      "--approve-reads",
      "Auto-approve read/search requests and prompt for writes",
    )
    .option("--deny-all", "Deny all permission requests")
    .option(
      "--non-interactive-permissions <policy>",
      "When prompting is unavailable: deny or fail",
      parseNonInteractivePermissionPolicy,
    )
    .option("--format <fmt>", "Output format: text, json, quiet", parseOutputFormat)
    .option(
      "--json-strict",
      "Strict JSON mode: requires --format json and suppresses non-JSON stderr output",
    )
    .option(
      "--timeout <seconds>",
      "Maximum time to wait for agent response",
      parseTimeoutSeconds,
    )
    .option(
      "--ttl <seconds>",
      "Queue owner idle TTL before shutdown (0 = keep alive forever) (default: 300)",
      parseTtlSeconds,
    )
    .option("--verbose", "Enable verbose debug logs");
}

function addSessionOption(command: Command): Command {
  return command
    .option(
      "-s, --session <name>",
      "Use named session instead of cwd default",
      parseSessionName,
    )
    .option(
      "--no-wait",
      "Queue prompt and return immediately when another prompt is already running",
    );
}

function addSessionNameOption(command: Command): Command {
  return command.option(
    "-s, --session <name>",
    "Use named session instead of cwd default",
    parseSessionName,
  );
}

function resolveSessionNameFromFlags(
  flags: StatusFlags,
  command: Command,
): string | undefined {
  if (flags.session) {
    return flags.session;
  }

  // Commander parses options on the parent command when flags appear before the
  // subcommand (e.g. `acpx codex -s foo cancel`). Use optsWithGlobals() so
  // subcommands can still access those values.
  const allOpts = (
    command as unknown as { optsWithGlobals?: () => unknown }
  ).optsWithGlobals?.();
  if (allOpts && typeof (allOpts as { session?: unknown }).session === "string") {
    return parseSessionName((allOpts as { session: string }).session);
  }

  const parentOpts = command.parent?.opts?.();
  if (parentOpts && typeof (parentOpts as { session?: unknown }).session === "string") {
    return parseSessionName((parentOpts as { session: string }).session);
  }

  return undefined;
}

function addPromptInputOption(command: Command): Command {
  return command.option(
    "-f, --file <path>",
    "Read prompt text from file path (use - for stdin)",
  );
}

function resolveGlobalFlags(command: Command, config: ResolvedAcpxConfig): GlobalFlags {
  const opts = command.optsWithGlobals() as Partial<GlobalFlags>;
  const format = opts.format ?? config.format ?? "text";
  const jsonStrict = opts.jsonStrict === true;
  const verbose = opts.verbose === true;

  if (jsonStrict && format !== "json") {
    throw new InvalidArgumentError("--json-strict requires --format json");
  }

  if (jsonStrict && verbose) {
    throw new InvalidArgumentError("--json-strict cannot be combined with --verbose");
  }

  return {
    agent: opts.agent,
    cwd: opts.cwd ?? process.cwd(),
    authPolicy: opts.authPolicy ?? config.authPolicy,
    nonInteractivePermissions:
      opts.nonInteractivePermissions ?? config.nonInteractivePermissions,
    jsonStrict,
    timeout: opts.timeout ?? config.timeoutMs,
    ttl: opts.ttl ?? config.ttlMs ?? DEFAULT_QUEUE_OWNER_TTL_MS,
    verbose,
    format,
    approveAll: opts.approveAll ? true : undefined,
    approveReads: opts.approveReads ? true : undefined,
    denyAll: opts.denyAll ? true : undefined,
  };
}

function resolveOutputPolicy(format: OutputFormat, jsonStrict: boolean): OutputPolicy {
  return {
    format,
    jsonStrict,
    suppressNonJsonStderr: jsonStrict,
    queueErrorAlreadyEmitted: format !== "quiet",
    suppressSdkConsoleErrors: jsonStrict,
  };
}

function resolveAgentInvocation(
  explicitAgentName: string | undefined,
  globalFlags: GlobalFlags,
  config: ResolvedAcpxConfig,
): {
  agentName: string;
  agentCommand: string;
  cwd: string;
} {
  const override = globalFlags.agent?.trim();
  if (override && explicitAgentName) {
    throw new InvalidArgumentError(
      "Do not combine positional agent with --agent override",
    );
  }

  const agentName = explicitAgentName ?? config.defaultAgent ?? DEFAULT_AGENT_NAME;
  const agentCommand =
    override && override.length > 0
      ? override
      : resolveAgentCommandFromRegistry(agentName, config.agents);

  return {
    agentName,
    agentCommand,
    cwd: path.resolve(globalFlags.cwd),
  };
}

function printSessionsByFormat(sessions: SessionRecord[], format: OutputFormat): void {
  if (format === "json") {
    process.stdout.write(
      `${JSON.stringify(
        sessions.map((session) => {
          const { id, sessionId, agentSessionId, ...rest } = session;
          return {
            ...rest,
            ...canonicalSessionIdentity({
              id,
              sessionId,
              agentSessionId,
            }),
          };
        }),
      )}\n`,
    );
    return;
  }

  if (format === "quiet") {
    for (const session of sessions) {
      const closedMarker = session.closed ? " [closed]" : "";
      process.stdout.write(`${session.id}${closedMarker}\n`);
    }
    return;
  }

  if (sessions.length === 0) {
    process.stdout.write("No sessions\n");
    return;
  }

  for (const session of sessions) {
    const closedMarker = session.closed ? " [closed]" : "";
    process.stdout.write(
      `${session.id}${closedMarker}\t${session.name ?? "-"}\t${session.cwd}\t${session.lastUsedAt}\n`,
    );
  }
}

function printClosedSessionByFormat(record: SessionRecord, format: OutputFormat): void {
  if (format === "json") {
    process.stdout.write(
      `${JSON.stringify({
        type: "session_closed",
        ...canonicalSessionIdentity(record),
        name: record.name,
      })}\n`,
    );
    return;
  }

  if (format === "quiet") {
    return;
  }

  process.stdout.write(`${record.id}\n`);
}

function canonicalSessionIdentity(record: {
  id: string;
  sessionId: string;
  agentSessionId?: string;
}): {
  acpxRecordId: string;
  acpxSessionId: string;
  agentSessionId?: string;
} {
  const normalizedAgentSessionId = normalizeAgentSessionId(record.agentSessionId);
  return {
    acpxRecordId: record.id,
    acpxSessionId: record.sessionId,
    ...(normalizedAgentSessionId ? { agentSessionId: normalizedAgentSessionId } : {}),
  };
}

function printNewSessionByFormat(
  record: SessionRecord,
  replaced: SessionRecord | undefined,
  format: OutputFormat,
): void {
  if (format === "json") {
    process.stdout.write(
      `${JSON.stringify({
        type: "session_created",
        ...canonicalSessionIdentity(record),
        name: record.name,
        ...(replaced ? { replacedAcpxRecordId: replaced.id } : {}),
      })}\n`,
    );
    return;
  }

  if (format === "quiet") {
    process.stdout.write(`${record.id}\n`);
    return;
  }

  if (replaced) {
    process.stdout.write(`${record.id}\t(replaced ${replaced.id})\n`);
    return;
  }

  process.stdout.write(`${record.id}\n`);
}

function printEnsuredSessionByFormat(
  record: SessionRecord,
  created: boolean,
  format: OutputFormat,
): void {
  if (format === "json") {
    process.stdout.write(
      `${JSON.stringify({
        type: "session_ensured",
        ...canonicalSessionIdentity(record),
        name: record.name,
        created,
      })}\n`,
    );
    return;
  }

  if (format === "quiet") {
    process.stdout.write(`${record.id}\n`);
    return;
  }

  const action = created ? "created" : "existing";
  process.stdout.write(`${record.id}\t(${action})\n`);
}

function printQueuedPromptByFormat(
  result: {
    sessionId: string;
    requestId: string;
  },
  format: OutputFormat,
): void {
  if (format === "json") {
    process.stdout.write(
      `${JSON.stringify({
        type: "queued",
        acpxRecordId: result.sessionId,
        requestId: result.requestId,
      })}\n`,
    );
    return;
  }

  if (format === "quiet") {
    return;
  }

  process.stdout.write(`[queued] ${result.requestId}\n`);
}

function formatSessionLabel(record: SessionRecord): string {
  return record.name ?? "cwd";
}

function formatRoutedFrom(sessionCwd: string, currentCwd: string): string | undefined {
  const relative = path.relative(sessionCwd, currentCwd);
  if (!relative || relative === ".") {
    return undefined;
  }
  return relative.startsWith(".") ? relative : `.${path.sep}${relative}`;
}

function sessionConnectionStatus(
  record: SessionRecord,
): "connected" | "needs reconnect" {
  return isProcessAlive(record.pid) ? "connected" : "needs reconnect";
}

export function formatPromptSessionBannerLine(
  record: SessionRecord,
  currentCwd: string,
): string {
  const label = formatSessionLabel(record);
  const normalizedSessionCwd = path.resolve(record.cwd);
  const normalizedCurrentCwd = path.resolve(currentCwd);
  const routedFrom =
    normalizedSessionCwd === normalizedCurrentCwd
      ? undefined
      : formatRoutedFrom(normalizedSessionCwd, normalizedCurrentCwd);
  const status = sessionConnectionStatus(record);

  if (routedFrom) {
    return `[acpx] session ${label} (${record.id}) · ${normalizedSessionCwd} (routed from ${routedFrom}) · agent ${status}`;
  }

  return `[acpx] session ${label} (${record.id}) · ${normalizedSessionCwd} · agent ${status}`;
}

function printPromptSessionBanner(
  record: SessionRecord,
  currentCwd: string,
  format: OutputFormat,
  jsonStrict = false,
): void {
  if (format === "quiet" || (jsonStrict && format === "json")) {
    return;
  }

  process.stderr.write(`${formatPromptSessionBannerLine(record, currentCwd)}\n`);
}

function printCreatedSessionBanner(
  record: SessionRecord,
  agentName: string,
  format: OutputFormat,
  jsonStrict = false,
): void {
  if (format === "quiet" || (jsonStrict && format === "json")) {
    return;
  }

  const label = formatSessionLabel(record);
  process.stderr.write(`[acpx] created session ${label} (${record.id})\n`);
  process.stderr.write(`[acpx] agent: ${agentName}\n`);
  process.stderr.write(`[acpx] cwd: ${record.cwd}\n`);
}

async function findRoutedSessionOrThrow(
  agentCommand: string,
  agentName: string,
  cwd: string,
  sessionName: string | undefined,
): Promise<SessionRecord> {
  const gitRoot = findGitRepositoryRoot(cwd);
  const walkBoundary = gitRoot ?? cwd;

  const record = await findSessionByDirectoryWalk({
    agentCommand,
    cwd,
    name: sessionName,
    boundary: walkBoundary,
  });

  if (record) {
    return record;
  }

  const createCmd = sessionName
    ? `acpx ${agentName} sessions new --name ${sessionName}`
    : `acpx ${agentName} sessions new`;
  throw new NoSessionError(
    `⚠ No acpx session found (searched up to ${walkBoundary}).\nCreate one: ${createCmd}`,
  );
}

async function handlePrompt(
  explicitAgentName: string | undefined,
  promptParts: string[],
  flags: PromptFlags,
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<void> {
  const globalFlags = resolveGlobalFlags(command, config);
  const outputPolicy = resolveOutputPolicy(
    globalFlags.format,
    globalFlags.jsonStrict === true,
  );
  const permissionMode = resolvePermissionMode(globalFlags, config.defaultPermissions);
  const prompt = await readPrompt(promptParts, flags.file, globalFlags.cwd);
  const agent = resolveAgentInvocation(explicitAgentName, globalFlags, config);
  const record = await findRoutedSessionOrThrow(
    agent.agentCommand,
    agent.agentName,
    agent.cwd,
    flags.session,
  );
  const outputFormatter = createOutputFormatter(outputPolicy.format, {
    jsonContext: {
      sessionId: record.id,
      stream: "prompt",
    },
  });

  printPromptSessionBanner(
    record,
    agent.cwd,
    outputPolicy.format,
    outputPolicy.jsonStrict,
  );
  const result = await sendSession({
    sessionId: record.id,
    message: prompt,
    permissionMode,
    nonInteractivePermissions: globalFlags.nonInteractivePermissions,
    authCredentials: config.auth,
    authPolicy: globalFlags.authPolicy,
    outputFormatter,
    errorEmissionPolicy: {
      queueErrorAlreadyEmitted: outputPolicy.queueErrorAlreadyEmitted,
    },
    suppressSdkConsoleErrors: outputPolicy.suppressSdkConsoleErrors,
    timeoutMs: globalFlags.timeout,
    ttlMs: globalFlags.ttl,
    verbose: globalFlags.verbose,
    waitForCompletion: flags.wait !== false,
  });

  if ("queued" in result) {
    printQueuedPromptByFormat(result, outputPolicy.format);
    return;
  }

  applyPermissionExitCode(result);

  if (globalFlags.verbose && result.loadError) {
    process.stderr.write(
      `[acpx] loadSession failed, started fresh session: ${result.loadError}\n`,
    );
  }
}

async function handleExec(
  explicitAgentName: string | undefined,
  promptParts: string[],
  flags: ExecFlags,
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<void> {
  if (config.disableExec) {
    throw new InvalidArgumentError(
      "exec is disabled by configuration (disableExec: true). Use prompt with a persistent session instead.",
    );
  }

  const globalFlags = resolveGlobalFlags(command, config);
  const outputPolicy = resolveOutputPolicy(
    globalFlags.format,
    globalFlags.jsonStrict === true,
  );
  const permissionMode = resolvePermissionMode(globalFlags, config.defaultPermissions);
  const prompt = await readPrompt(promptParts, flags.file, globalFlags.cwd);
  const outputFormatter = createOutputFormatter(outputPolicy.format);
  const agent = resolveAgentInvocation(explicitAgentName, globalFlags, config);

  const result = await runOnce({
    agentCommand: agent.agentCommand,
    cwd: agent.cwd,
    message: prompt,
    permissionMode,
    nonInteractivePermissions: globalFlags.nonInteractivePermissions,
    authCredentials: config.auth,
    authPolicy: globalFlags.authPolicy,
    outputFormatter,
    suppressSdkConsoleErrors: outputPolicy.suppressSdkConsoleErrors,
    timeoutMs: globalFlags.timeout,
    verbose: globalFlags.verbose,
  });

  applyPermissionExitCode(result);
}

function printCancelResultByFormat(
  result: { sessionId: string; cancelled: boolean },
  format: OutputFormat,
): void {
  if (format === "json") {
    process.stdout.write(
      `${JSON.stringify({
        acpxRecordId: result.sessionId || null,
        cancelled: result.cancelled,
      })}\n`,
    );
    return;
  }

  if (result.cancelled) {
    process.stdout.write("cancel requested\n");
    return;
  }

  process.stdout.write("nothing to cancel\n");
}

function printSetModeResultByFormat(
  modeId: string,
  result: { record: SessionRecord; resumed: boolean; loadError?: string },
  format: OutputFormat,
): void {
  if (format === "json") {
    process.stdout.write(
      `${JSON.stringify({
        ...canonicalSessionIdentity(result.record),
        modeId,
        resumed: result.resumed,
      })}\n`,
    );
    return;
  }

  if (format === "quiet") {
    process.stdout.write(`${modeId}\n`);
    return;
  }

  process.stdout.write(`mode set: ${modeId}\n`);
}

function printSetConfigOptionResultByFormat(
  configId: string,
  value: string,
  result: {
    record: SessionRecord;
    resumed: boolean;
    response: { configOptions: unknown[] };
  },
  format: OutputFormat,
): void {
  if (format === "json") {
    process.stdout.write(
      `${JSON.stringify({
        ...canonicalSessionIdentity(result.record),
        configId,
        value,
        resumed: result.resumed,
        configOptions: result.response.configOptions,
      })}\n`,
    );
    return;
  }

  if (format === "quiet") {
    process.stdout.write(`${value}\n`);
    return;
  }

  process.stdout.write(
    `config set: ${configId}=${value} (${result.response.configOptions.length} options)\n`,
  );
}

async function handleCancel(
  explicitAgentName: string | undefined,
  flags: StatusFlags,
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<void> {
  const globalFlags = resolveGlobalFlags(command, config);
  const agent = resolveAgentInvocation(explicitAgentName, globalFlags, config);
  const gitRoot = findGitRepositoryRoot(agent.cwd);
  const walkBoundary = gitRoot ?? agent.cwd;
  const record = await findSessionByDirectoryWalk({
    agentCommand: agent.agentCommand,
    cwd: agent.cwd,
    name: resolveSessionNameFromFlags(flags, command),
    boundary: walkBoundary,
  });

  if (!record) {
    printCancelResultByFormat(
      {
        sessionId: "",
        cancelled: false,
      },
      globalFlags.format,
    );
    return;
  }

  const result = await cancelSessionPrompt({
    sessionId: record.id,
    verbose: globalFlags.verbose,
  });
  printCancelResultByFormat(result, globalFlags.format);
}

async function handleSetMode(
  explicitAgentName: string | undefined,
  modeId: string,
  flags: StatusFlags,
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<void> {
  const globalFlags = resolveGlobalFlags(command, config);
  const agent = resolveAgentInvocation(explicitAgentName, globalFlags, config);
  const record = await findRoutedSessionOrThrow(
    agent.agentCommand,
    agent.agentName,
    agent.cwd,
    resolveSessionNameFromFlags(flags, command),
  );
  const result = await setSessionMode({
    sessionId: record.id,
    modeId,
    nonInteractivePermissions: globalFlags.nonInteractivePermissions,
    authCredentials: config.auth,
    authPolicy: globalFlags.authPolicy,
    timeoutMs: globalFlags.timeout,
    verbose: globalFlags.verbose,
  });

  if (globalFlags.verbose && result.loadError) {
    process.stderr.write(
      `[acpx] loadSession failed, started fresh session: ${result.loadError}\n`,
    );
  }

  printSetModeResultByFormat(modeId, result, globalFlags.format);
}

async function handleSetConfigOption(
  explicitAgentName: string | undefined,
  configId: string,
  value: string,
  flags: StatusFlags,
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<void> {
  const globalFlags = resolveGlobalFlags(command, config);
  const agent = resolveAgentInvocation(explicitAgentName, globalFlags, config);
  const record = await findRoutedSessionOrThrow(
    agent.agentCommand,
    agent.agentName,
    agent.cwd,
    resolveSessionNameFromFlags(flags, command),
  );
  const result = await setSessionConfigOption({
    sessionId: record.id,
    configId,
    value,
    nonInteractivePermissions: globalFlags.nonInteractivePermissions,
    authCredentials: config.auth,
    authPolicy: globalFlags.authPolicy,
    timeoutMs: globalFlags.timeout,
    verbose: globalFlags.verbose,
  });

  if (globalFlags.verbose && result.loadError) {
    process.stderr.write(
      `[acpx] loadSession failed, started fresh session: ${result.loadError}\n`,
    );
  }

  printSetConfigOptionResultByFormat(configId, value, result, globalFlags.format);
}

async function handleSessionsList(
  explicitAgentName: string | undefined,
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<void> {
  const globalFlags = resolveGlobalFlags(command, config);
  const agent = resolveAgentInvocation(explicitAgentName, globalFlags, config);
  const sessions = await listSessionsForAgent(agent.agentCommand);
  printSessionsByFormat(sessions, globalFlags.format);
}

async function handleSessionsClose(
  explicitAgentName: string | undefined,
  sessionName: string | undefined,
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<void> {
  const globalFlags = resolveGlobalFlags(command, config);
  const agent = resolveAgentInvocation(explicitAgentName, globalFlags, config);

  const record = await findSession({
    agentCommand: agent.agentCommand,
    cwd: agent.cwd,
    name: sessionName,
  });

  if (!record) {
    if (sessionName) {
      throw new Error(
        `No named session "${sessionName}" for cwd ${agent.cwd} and agent ${agent.agentName}`,
      );
    }

    throw new Error(`No cwd session for ${agent.cwd} and agent ${agent.agentName}`);
  }

  const closed = await closeSession(record.id);
  printClosedSessionByFormat(closed, globalFlags.format);
}

async function handleSessionsNew(
  explicitAgentName: string | undefined,
  flags: SessionsNewFlags,
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<void> {
  const globalFlags = resolveGlobalFlags(command, config);
  const permissionMode = resolvePermissionMode(globalFlags, config.defaultPermissions);
  const agent = resolveAgentInvocation(explicitAgentName, globalFlags, config);

  const replaced = await findSession({
    agentCommand: agent.agentCommand,
    cwd: agent.cwd,
    name: flags.name,
  });

  if (replaced) {
    await closeSession(replaced.id);
    if (globalFlags.verbose) {
      process.stderr.write(`[acpx] soft-closed prior session: ${replaced.id}\n`);
    }
  }

  const created = await createSession({
    agentCommand: agent.agentCommand,
    cwd: agent.cwd,
    name: flags.name,
    permissionMode,
    nonInteractivePermissions: globalFlags.nonInteractivePermissions,
    authCredentials: config.auth,
    authPolicy: globalFlags.authPolicy,
    timeoutMs: globalFlags.timeout,
    verbose: globalFlags.verbose,
  });

  printCreatedSessionBanner(
    created,
    agent.agentName,
    globalFlags.format,
    globalFlags.jsonStrict,
  );

  if (globalFlags.verbose) {
    const scope = flags.name ? `named session "${flags.name}"` : "cwd session";
    process.stderr.write(`[acpx] created ${scope}: ${created.id}\n`);
  }

  printNewSessionByFormat(created, replaced, globalFlags.format);
}

async function handleSessionsEnsure(
  explicitAgentName: string | undefined,
  flags: SessionsNewFlags,
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<void> {
  const globalFlags = resolveGlobalFlags(command, config);
  const permissionMode = resolvePermissionMode(globalFlags, config.defaultPermissions);
  const agent = resolveAgentInvocation(explicitAgentName, globalFlags, config);
  const result = await ensureSession({
    agentCommand: agent.agentCommand,
    cwd: agent.cwd,
    name: flags.name,
    permissionMode,
    nonInteractivePermissions: globalFlags.nonInteractivePermissions,
    authCredentials: config.auth,
    authPolicy: globalFlags.authPolicy,
    timeoutMs: globalFlags.timeout,
    verbose: globalFlags.verbose,
  });

  if (result.created) {
    printCreatedSessionBanner(
      result.record,
      agent.agentName,
      globalFlags.format,
      globalFlags.jsonStrict,
    );
  }

  printEnsuredSessionByFormat(result.record, result.created, globalFlags.format);
}

function printSessionDetailsByFormat(
  record: SessionRecord,
  format: OutputFormat,
): void {
  if (format === "json") {
    const { id, sessionId, agentSessionId, ...rest } = record;
    process.stdout.write(
      `${JSON.stringify({
        ...rest,
        ...canonicalSessionIdentity({
          id,
          sessionId,
          agentSessionId,
        }),
      })}\n`,
    );
    return;
  }

  if (format === "quiet") {
    process.stdout.write(`${record.id}\n`);
    return;
  }

  process.stdout.write(`acpxRecordId: ${record.id}\n`);
  process.stdout.write(`acpxSessionId: ${record.sessionId}\n`);
  process.stdout.write(`agentSessionId: ${record.agentSessionId ?? "-"}\n`);
  process.stdout.write(`agent: ${record.agentCommand}\n`);
  process.stdout.write(`cwd: ${record.cwd}\n`);
  process.stdout.write(`name: ${record.name ?? "-"}\n`);
  process.stdout.write(`created: ${record.createdAt}\n`);
  process.stdout.write(`lastActivity: ${record.lastUsedAt}\n`);
  process.stdout.write(`lastPrompt: ${record.lastPromptAt ?? "-"}\n`);
  process.stdout.write(`closed: ${record.closed ? "yes" : "no"}\n`);
  process.stdout.write(`closedAt: ${record.closedAt ?? "-"}\n`);
  process.stdout.write(`pid: ${record.pid ?? "-"}\n`);
  process.stdout.write(`agentStartedAt: ${record.agentStartedAt ?? "-"}\n`);
  process.stdout.write(`lastExitCode: ${record.lastAgentExitCode ?? "-"}\n`);
  process.stdout.write(`lastExitSignal: ${record.lastAgentExitSignal ?? "-"}\n`);
  process.stdout.write(`lastExitAt: ${record.lastAgentExitAt ?? "-"}\n`);
  process.stdout.write(
    `disconnectReason: ${record.lastAgentDisconnectReason ?? "-"}\n`,
  );
  process.stdout.write(`historyEntries: ${record.turnHistory?.length ?? 0}\n`);
}

function printSessionHistoryByFormat(
  record: SessionRecord,
  limit: number,
  format: OutputFormat,
): void {
  const history = record.turnHistory ?? [];
  const visible = history.slice(Math.max(0, history.length - limit));

  if (format === "json") {
    process.stdout.write(
      `${JSON.stringify({
        ...canonicalSessionIdentity(record),
        limit,
        count: visible.length,
        entries: visible,
      })}\n`,
    );
    return;
  }

  if (format === "quiet") {
    for (const entry of visible) {
      process.stdout.write(`${entry.textPreview}\n`);
    }
    return;
  }

  process.stdout.write(
    `session: ${record.id} (${visible.length}/${history.length} shown)\n`,
  );
  if (visible.length === 0) {
    process.stdout.write("No history\n");
    return;
  }

  for (const entry of visible) {
    process.stdout.write(`${entry.timestamp}\t${entry.role}\t${entry.textPreview}\n`);
  }
}

async function handleSessionsShow(
  explicitAgentName: string | undefined,
  sessionName: string | undefined,
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<void> {
  const globalFlags = resolveGlobalFlags(command, config);
  const agent = resolveAgentInvocation(explicitAgentName, globalFlags, config);
  const record = await findSession({
    agentCommand: agent.agentCommand,
    cwd: agent.cwd,
    name: sessionName,
    includeClosed: true,
  });

  if (!record) {
    throw new Error(
      sessionName
        ? `No named session "${sessionName}" for cwd ${agent.cwd} and agent ${agent.agentName}`
        : `No cwd session for ${agent.cwd} and agent ${agent.agentName}`,
    );
  }

  printSessionDetailsByFormat(record, globalFlags.format);
}

async function handleSessionsHistory(
  explicitAgentName: string | undefined,
  sessionName: string | undefined,
  flags: SessionsHistoryFlags,
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<void> {
  const globalFlags = resolveGlobalFlags(command, config);
  const agent = resolveAgentInvocation(explicitAgentName, globalFlags, config);
  const record = await findSession({
    agentCommand: agent.agentCommand,
    cwd: agent.cwd,
    name: sessionName,
    includeClosed: true,
  });

  if (!record) {
    throw new Error(
      sessionName
        ? `No named session "${sessionName}" for cwd ${agent.cwd} and agent ${agent.agentName}`
        : `No cwd session for ${agent.cwd} and agent ${agent.agentName}`,
    );
  }

  printSessionHistoryByFormat(record, flags.limit, globalFlags.format);
}

function formatUptime(startedAt: string | undefined): string | undefined {
  if (!startedAt) {
    return undefined;
  }

  const startedMs = Date.parse(startedAt);
  if (!Number.isFinite(startedMs)) {
    return undefined;
  }

  const elapsedMs = Math.max(0, Date.now() - startedMs);
  const seconds = Math.floor(elapsedMs / 1_000);
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remSeconds = seconds % 60;
  return `${hours.toString().padStart(2, "0")}:${minutes
    .toString()
    .padStart(2, "0")}:${remSeconds.toString().padStart(2, "0")}`;
}

async function handleStatus(
  explicitAgentName: string | undefined,
  flags: StatusFlags,
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<void> {
  const globalFlags = resolveGlobalFlags(command, config);
  const agent = resolveAgentInvocation(explicitAgentName, globalFlags, config);
  const record = await findSession({
    agentCommand: agent.agentCommand,
    cwd: agent.cwd,
    name: resolveSessionNameFromFlags(flags, command),
  });

  if (!record) {
    const payload = {
      acpxRecordId: null,
      acpxSessionId: null,
      agentSessionId: null,
      agentCommand: agent.agentCommand,
      pid: null,
      status: "no-session",
      uptime: null,
      lastPromptTime: null,
      exitCode: null,
      signal: null,
      ownerPid: null,
      ownerStatus: null,
      ownerGeneration: null,
      ownerHeartbeatAt: null,
      ownerQueueDepth: null,
    } as const;

    if (globalFlags.format === "json") {
      process.stdout.write(`${JSON.stringify(payload)}\n`);
      return;
    }
    if (globalFlags.format === "quiet") {
      process.stdout.write("no-session\n");
      return;
    }

    process.stdout.write(`session: -\n`);
    process.stdout.write(`agent: ${agent.agentCommand}\n`);
    process.stdout.write(`pid: -\n`);
    process.stdout.write(`status: no-session\n`);
    process.stdout.write(`uptime: -\n`);
    process.stdout.write(`lastPromptTime: -\n`);
    process.stdout.write(`ownerStatus: -\n`);
    return;
  }

  const running = isProcessAlive(record.pid);
  const owner = await readSessionQueueOwnerStatus(record.id);
  const ownerStatus = owner ? (owner.stale ? "stale" : "active") : "inactive";
  const payload = {
    ...canonicalSessionIdentity(record),
    agentCommand: record.agentCommand,
    pid: record.pid ?? null,
    status: running ? "running" : "dead",
    uptime: running ? (formatUptime(record.agentStartedAt) ?? null) : null,
    lastPromptTime: record.lastPromptAt ?? null,
    exitCode: running ? null : (record.lastAgentExitCode ?? null),
    signal: running ? null : (record.lastAgentExitSignal ?? null),
    ownerPid: owner?.pid ?? null,
    ownerStatus,
    ownerGeneration: owner?.ownerGeneration ?? null,
    ownerHeartbeatAt: owner?.heartbeatAt ?? null,
    ownerQueueDepth: owner?.queueDepth ?? null,
  };

  if (globalFlags.format === "json") {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return;
  }

  if (globalFlags.format === "quiet") {
    process.stdout.write(`${payload.status}\n`);
    return;
  }

  process.stdout.write(`acpxRecordId: ${payload.acpxRecordId}\n`);
  process.stdout.write(`acpxSessionId: ${payload.acpxSessionId}\n`);
  process.stdout.write(`agentSessionId: ${payload.agentSessionId ?? "-"}\n`);
  process.stdout.write(`agent: ${payload.agentCommand}\n`);
  process.stdout.write(`pid: ${payload.pid ?? "-"}\n`);
  process.stdout.write(`status: ${payload.status}\n`);
  process.stdout.write(`uptime: ${payload.uptime ?? "-"}\n`);
  process.stdout.write(`lastPromptTime: ${payload.lastPromptTime ?? "-"}\n`);
  process.stdout.write(`ownerStatus: ${payload.ownerStatus}\n`);
  process.stdout.write(`ownerPid: ${payload.ownerPid ?? "-"}\n`);
  process.stdout.write(`ownerGeneration: ${payload.ownerGeneration ?? "-"}\n`);
  process.stdout.write(`ownerHeartbeatAt: ${payload.ownerHeartbeatAt ?? "-"}\n`);
  process.stdout.write(`ownerQueueDepth: ${payload.ownerQueueDepth ?? "-"}\n`);
  if (payload.status === "dead") {
    process.stdout.write(`exitCode: ${payload.exitCode ?? "-"}\n`);
    process.stdout.write(`signal: ${payload.signal ?? "-"}\n`);
  }
}

async function handleConfigShow(
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<void> {
  const globalFlags = resolveGlobalFlags(command, config);
  const payload = {
    ...toConfigDisplay(config),
    paths: {
      global: config.globalPath,
      project: config.projectPath,
    },
    loaded: {
      global: config.hasGlobalConfig,
      project: config.hasProjectConfig,
    },
  };

  if (globalFlags.format === "json") {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return;
  }

  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

async function handleConfigInit(
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<void> {
  const globalFlags = resolveGlobalFlags(command, config);
  const result = await initGlobalConfigFile();
  if (globalFlags.format === "json") {
    process.stdout.write(
      `${JSON.stringify({
        path: result.path,
        created: result.created,
      })}\n`,
    );
    return;
  }
  if (globalFlags.format === "quiet") {
    process.stdout.write(`${result.path}\n`);
    return;
  }

  if (result.created) {
    process.stdout.write(`Created ${result.path}\n`);
    return;
  }
  process.stdout.write(`Config already exists: ${result.path}\n`);
}

function registerSessionsCommand(
  parent: Command,
  explicitAgentName: string | undefined,
  config: ResolvedAcpxConfig,
): void {
  const sessionsCommand = parent
    .command("sessions")
    .description("List, ensure, create, or close sessions for this agent");

  sessionsCommand.action(async function (this: Command) {
    await handleSessionsList(explicitAgentName, this, config);
  });

  sessionsCommand
    .command("list")
    .description("List sessions")
    .action(async function (this: Command) {
      await handleSessionsList(explicitAgentName, this, config);
    });

  sessionsCommand
    .command("new")
    .description("Create a fresh session for current cwd")
    .option("--name <name>", "Session name", parseSessionName)
    .action(async function (this: Command, flags: SessionsNewFlags) {
      await handleSessionsNew(explicitAgentName, flags, this, config);
    });

  sessionsCommand
    .command("ensure")
    .description("Ensure a session exists for current cwd or ancestor")
    .option("--name <name>", "Session name", parseSessionName)
    .action(async function (this: Command, flags: SessionsNewFlags) {
      await handleSessionsEnsure(explicitAgentName, flags, this, config);
    });

  sessionsCommand
    .command("close")
    .description("Close session for current cwd")
    .argument("[name]", "Session name", parseSessionName)
    .action(async function (this: Command, name?: string) {
      await handleSessionsClose(explicitAgentName, name, this, config);
    });

  sessionsCommand
    .command("show")
    .description("Show session metadata for current cwd")
    .argument("[name]", "Session name", parseSessionName)
    .action(async function (this: Command, name?: string) {
      await handleSessionsShow(explicitAgentName, name, this, config);
    });

  sessionsCommand
    .command("history")
    .description("Show recent session history entries")
    .argument("[name]", "Session name", parseSessionName)
    .option(
      "--limit <count>",
      "Maximum number of entries to show (default: 20)",
      parseHistoryLimit,
      DEFAULT_HISTORY_LIMIT,
    )
    .action(async function (
      this: Command,
      name: string | undefined,
      flags: SessionsHistoryFlags,
    ) {
      await handleSessionsHistory(explicitAgentName, name, flags, this, config);
    });
}

type SharedSubcommandDescriptions = {
  prompt: string;
  exec: string;
  cancel: string;
  setMode: string;
  setConfig: string;
  status: string;
};

function registerSharedAgentSubcommands(
  parent: Command,
  explicitAgentName: string | undefined,
  config: ResolvedAcpxConfig,
  descriptions: SharedSubcommandDescriptions,
): void {
  const promptCommand = parent
    .command("prompt")
    .description(descriptions.prompt)
    .argument("[prompt...]", "Prompt text")
    .showHelpAfterError();
  addSessionOption(promptCommand);
  addPromptInputOption(promptCommand);
  promptCommand.action(async function (
    this: Command,
    promptParts: string[],
    flags: PromptFlags,
  ) {
    await handlePrompt(explicitAgentName, promptParts, flags, this, config);
  });

  const execCommand = parent
    .command("exec")
    .description(descriptions.exec)
    .argument("[prompt...]", "Prompt text")
    .showHelpAfterError();
  addPromptInputOption(execCommand);
  execCommand.action(async function (
    this: Command,
    promptParts: string[],
    flags: ExecFlags,
  ) {
    await handleExec(explicitAgentName, promptParts, flags, this, config);
  });

  const cancelCommand = parent.command("cancel").description(descriptions.cancel);
  addSessionNameOption(cancelCommand);
  cancelCommand.action(async function (this: Command, flags: StatusFlags) {
    await handleCancel(explicitAgentName, flags, this, config);
  });

  const setModeCommand = parent
    .command("set-mode")
    .description(descriptions.setMode)
    .argument("<mode>", "Mode id", (value: string) =>
      parseNonEmptyValue("Mode", value),
    );
  addSessionNameOption(setModeCommand);
  setModeCommand.action(async function (
    this: Command,
    modeId: string,
    flags: StatusFlags,
  ) {
    await handleSetMode(explicitAgentName, modeId, flags, this, config);
  });

  const setConfigCommand = parent
    .command("set")
    .description(descriptions.setConfig)
    .argument("<key>", "Config option id", (value: string) =>
      parseNonEmptyValue("Config option key", value),
    )
    .argument("<value>", "Config option value", (value: string) =>
      parseNonEmptyValue("Config option value", value),
    );
  addSessionNameOption(setConfigCommand);
  setConfigCommand.action(async function (
    this: Command,
    key: string,
    value: string,
    flags: StatusFlags,
  ) {
    await handleSetConfigOption(explicitAgentName, key, value, flags, this, config);
  });

  const statusCommand = parent.command("status").description(descriptions.status);
  addSessionNameOption(statusCommand);
  statusCommand.action(async function (this: Command, flags: StatusFlags) {
    await handleStatus(explicitAgentName, flags, this, config);
  });
}

function registerAgentCommand(
  program: Command,
  agentName: string,
  config: ResolvedAcpxConfig,
): void {
  const agentCommand = program
    .command(agentName)
    .description(`Use ${agentName} agent`)
    .argument("[prompt...]", "Prompt text")
    .enablePositionalOptions()
    .passThroughOptions()
    .showHelpAfterError();

  addSessionOption(agentCommand);
  addPromptInputOption(agentCommand);
  agentCommand.action(async function (
    this: Command,
    promptParts: string[],
    flags: PromptFlags,
  ) {
    await handlePrompt(agentName, promptParts, flags, this, config);
  });

  registerSharedAgentSubcommands(agentCommand, agentName, config, {
    prompt: "Prompt using persistent session",
    exec: "One-shot prompt without saved session",
    cancel: "Cooperatively cancel current in-flight prompt",
    setMode: "Set session mode",
    setConfig: "Set session config option",
    status: "Show local status of current session agent process",
  });

  registerSessionsCommand(agentCommand, agentName, config);
}

function registerConfigCommand(program: Command, config: ResolvedAcpxConfig): void {
  const configCommand = program
    .command("config")
    .description("Inspect and initialize acpx configuration");

  configCommand
    .command("show")
    .description("Show resolved config")
    .action(async function (this: Command) {
      await handleConfigShow(this, config);
    });

  configCommand
    .command("init")
    .description("Create global config template")
    .action(async function (this: Command) {
      await handleConfigInit(this, config);
    });

  configCommand.action(async function (this: Command) {
    await handleConfigShow(this, config);
  });
}

function registerDefaultCommands(program: Command, config: ResolvedAcpxConfig): void {
  registerSharedAgentSubcommands(program, undefined, config, {
    prompt: `Prompt using ${config.defaultAgent} by default`,
    exec: `One-shot prompt using ${config.defaultAgent} by default`,
    cancel: `Cancel active prompt for ${config.defaultAgent} by default`,
    setMode: `Set session mode for ${config.defaultAgent} by default`,
    setConfig: `Set session config option for ${config.defaultAgent} by default`,
    status: `Show local status for ${config.defaultAgent} by default`,
  });

  registerSessionsCommand(program, undefined, config);
  registerConfigCommand(program, config);
}

type AgentTokenScan = {
  token?: string;
  hasAgentOverride: boolean;
};

function detectAgentToken(argv: string[]): AgentTokenScan {
  let hasAgentOverride = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === "--") {
      break;
    }

    if (!token.startsWith("-") || token === "-") {
      return { token, hasAgentOverride };
    }

    if (token === "--agent") {
      hasAgentOverride = true;
      index += 1;
      continue;
    }

    if (token.startsWith("--agent=")) {
      hasAgentOverride = true;
      continue;
    }

    if (
      token === "--cwd" ||
      token === "--auth-policy" ||
      token === "--non-interactive-permissions" ||
      token === "--format" ||
      token === "--timeout" ||
      token === "--ttl" ||
      token === "--file"
    ) {
      index += 1;
      continue;
    }

    if (
      token.startsWith("--cwd=") ||
      token.startsWith("--auth-policy=") ||
      token.startsWith("--non-interactive-permissions=") ||
      token.startsWith("--format=") ||
      token.startsWith("--json-strict=") ||
      token.startsWith("--timeout=") ||
      token.startsWith("--ttl=") ||
      token.startsWith("--file=")
    ) {
      continue;
    }

    if (
      token === "--approve-all" ||
      token === "--approve-reads" ||
      token === "--deny-all" ||
      token === "--json-strict" ||
      token === "--verbose"
    ) {
      continue;
    }

    return { hasAgentOverride };
  }

  return { hasAgentOverride };
}

function detectInitialCwd(argv: string[]): string {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--cwd") {
      const next = argv[index + 1];
      if (next && next !== "--") {
        return path.resolve(next);
      }
      break;
    }
    if (token.startsWith("--cwd=")) {
      const value = token.slice("--cwd=".length).trim();
      if (value.length > 0) {
        return path.resolve(value);
      }
      break;
    }
    if (token === "--") {
      break;
    }
  }
  return process.cwd();
}

function detectRequestedOutputFormat(
  argv: string[],
  fallback: OutputFormat,
): OutputFormat {
  let detectedFormat = fallback;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") {
      break;
    }

    if (token === "--json-strict" || token.startsWith("--json-strict=")) {
      return "json";
    }

    if (token === "--format") {
      const raw = argv[index + 1];
      if (raw && OUTPUT_FORMATS.includes(raw as OutputFormat)) {
        detectedFormat = raw as OutputFormat;
      }
      continue;
    }

    if (token.startsWith("--format=")) {
      const raw = token.slice("--format=".length).trim();
      if (OUTPUT_FORMATS.includes(raw as OutputFormat)) {
        detectedFormat = raw as OutputFormat;
      }
    }
  }

  return detectedFormat;
}

function detectJsonStrict(argv: string[]): boolean {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") {
      break;
    }
    if (token === "--json-strict") {
      return true;
    }
    if (token.startsWith("--json-strict=")) {
      return true;
    }
  }
  return false;
}

function emitJsonErrorEvent(error: NormalizedOutputError): void {
  const formatter = createOutputFormatter("json", {
    jsonContext: {
      sessionId: "unknown",
      stream: "control",
    },
  });
  formatter.onError(error);
  formatter.flush();
}

function isOutputAlreadyEmitted(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  return (error as { outputAlreadyEmitted?: unknown }).outputAlreadyEmitted === true;
}

function emitRequestedError(
  error: unknown,
  normalized: NormalizedOutputError,
  outputPolicy: OutputPolicy,
): void {
  if (isOutputAlreadyEmitted(error)) {
    return;
  }
  if (outputPolicy.format === "json") {
    emitJsonErrorEvent(normalized);
  } else if (!outputPolicy.suppressNonJsonStderr) {
    process.stderr.write(`${normalized.message}\n`);
  }
}

async function runWithOutputPolicy<T>(
  _outputPolicy: OutputPolicy,
  run: () => Promise<T>,
): Promise<T> {
  return await run();
}

export async function main(argv: string[] = process.argv): Promise<void> {
  await maybeHandleSkillflag(argv, {
    skillsRoot: findSkillsRoot(import.meta.url),
    includeBundledSkill: false,
  });

  const config = await loadResolvedConfig(detectInitialCwd(argv.slice(2)));
  const requestedJsonStrict = detectJsonStrict(argv.slice(2));
  const requestedOutputFormat = detectRequestedOutputFormat(
    argv.slice(2),
    config.format,
  );
  const requestedOutputPolicy = resolveOutputPolicy(
    requestedOutputFormat,
    requestedJsonStrict,
  );
  const internalQueueOwnerFlags = parseQueueOwnerFlags(
    argv.slice(2),
    DEFAULT_QUEUE_OWNER_TTL_MS,
  );

  const program = new Command();
  program
    .name("acpx")
    .description("Headless CLI client for the Agent Client Protocol")
    .version(getAcpxVersion())
    .enablePositionalOptions()
    .showHelpAfterError();

  if (requestedJsonStrict) {
    program.configureOutput({
      writeOut: () => {
        // json-strict intentionally suppresses non-JSON stdout output.
      },
      writeErr: () => {
        // json-strict intentionally suppresses non-JSON stderr output.
      },
    });
  }

  addGlobalFlags(program);
  configurePublicCli({
    program,
    argv: argv.slice(2),
    config,
    requestedJsonStrict,
    topLevelVerbs: TOP_LEVEL_VERBS,
    listBuiltInAgents,
    detectAgentToken,
    registerAgentCommand,
    registerDefaultCommands,
    handlePromptAction: async (command, promptParts) => {
      await handlePrompt(undefined, promptParts, {}, command, config);
    },
  });

  program.exitOverride((error) => {
    throw error;
  });

  await runWithOutputPolicy(requestedOutputPolicy, async () => {
    try {
      if (internalQueueOwnerFlags) {
        await runQueueOwnerProcess({
          sessionId: internalQueueOwnerFlags.sessionId,
          ttlMs: internalQueueOwnerFlags.ttlMs,
          permissionMode: internalQueueOwnerFlags.permissionMode,
          nonInteractivePermissions: internalQueueOwnerFlags.nonInteractivePermissions,
          authCredentials: config.auth,
          authPolicy: internalQueueOwnerFlags.authPolicy,
          timeoutMs: internalQueueOwnerFlags.timeoutMs,
          suppressSdkConsoleErrors: internalQueueOwnerFlags.suppressSdkConsoleErrors,
          verbose: internalQueueOwnerFlags.verbose,
        });
        return;
      }

      await program.parseAsync(argv);
    } catch (error) {
      if (error instanceof CommanderError) {
        if (
          error.code === "commander.helpDisplayed" ||
          error.code === "commander.version"
        ) {
          process.exit(EXIT_CODES.SUCCESS);
        }
        const normalized = normalizeOutputError(error, {
          defaultCode: "USAGE",
          origin: "cli",
        });
        if (requestedOutputPolicy.format === "json") {
          emitRequestedError(error, normalized, requestedOutputPolicy);
        }
        process.exit(exitCodeForOutputErrorCode(normalized.code));
      }

      if (error instanceof InterruptedError) {
        process.exit(EXIT_CODES.INTERRUPTED);
      }

      const normalized = normalizeOutputError(error, {
        origin: "cli",
      });
      emitRequestedError(error, normalized, requestedOutputPolicy);
      process.exit(exitCodeForOutputErrorCode(normalized.code));
    }
  });
}

function isCliEntrypoint(argv: string[]): boolean {
  const entry = argv[1];
  if (!entry) {
    return false;
  }

  try {
    // Resolve symlinks so global npm installs match (argv[1] is the
    // symlink in node_modules/.bin, import.meta.url is the real path).
    const resolved = pathToFileURL(realpathSync(entry)).href;
    return import.meta.url === resolved;
  } catch {
    return false;
  }
}

if (isCliEntrypoint(process.argv)) {
  void main(process.argv);
}
