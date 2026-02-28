#!/usr/bin/env node

import { Command, CommanderError, InvalidArgumentError } from "commander";
import { realpathSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { findSkillsRoot, maybeHandleSkillflag } from "skillflag";
import { listBuiltInAgents } from "./agent-registry.js";
import {
  addGlobalFlags,
  addPromptInputOption,
  addSessionNameOption,
  addSessionOption,
  parseHistoryLimit,
  parseNonEmptyValue,
  parseSessionName,
  parseTtlSeconds,
  resolveAgentInvocation,
  resolveGlobalFlags,
  resolveOutputPolicy,
  resolvePermissionMode,
  resolveSessionNameFromFlags,
  type ExecFlags,
  type PromptFlags,
  type SessionsHistoryFlags,
  type SessionsNewFlags,
  type StatusFlags,
} from "./cli/flags.js";
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
import {
  agentSessionIdPayload,
  emitJsonResult,
  printClosedSessionByFormat,
  printCreatedSessionBanner,
  printEnsuredSessionByFormat,
  printNewSessionByFormat,
  printPromptSessionBanner,
  printQueuedPromptByFormat,
  printSessionsByFormat,
} from "./cli/output-render.js";
import { createOutputFormatter } from "./output.js";
import {
  DEFAULT_HISTORY_LIMIT,
  InterruptedError,
  cancelSessionPrompt,
  closeSession,
  createSession,
  ensureSession,
  findGitRepositoryRoot,
  findSession,
  findSessionByDirectoryWalk,
  listSessionsForAgent,
  runOnce,
  setSessionConfigOption,
  setSessionMode,
  sendSession,
} from "./session.js";
import { probeQueueOwnerHealth } from "./queue-ipc.js";
import {
  EXIT_CODES,
  OUTPUT_FORMATS,
  type OutputFormat,
  type OutputPolicy,
  type SessionRecord,
  type SessionAgentContent,
  type SessionUserContent,
} from "./types.js";

class NoSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoSessionError";
  }
}

const TOP_LEVEL_VERBS = new Set([
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

export { parseTtlSeconds };
export { formatPromptSessionBannerLine } from "./cli/output-render.js";

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
      sessionId: record.acpxRecordId,
    },
  });

  await printPromptSessionBanner(
    record,
    agent.cwd,
    outputPolicy.format,
    outputPolicy.jsonStrict,
  );
  const result = await sendSession({
    sessionId: record.acpxRecordId,
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
  if (
    emitJsonResult(format, {
      action: "cancel_result",
      acpxRecordId: result.sessionId || "unknown",
      cancelled: result.cancelled,
    })
  ) {
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
  if (
    emitJsonResult(format, {
      action: "mode_set",
      modeId,
      resumed: result.resumed,
      acpxRecordId: result.record.acpxRecordId,
      acpxSessionId: result.record.acpSessionId,
      agentSessionId: result.record.agentSessionId,
    })
  ) {
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
  if (
    emitJsonResult(format, {
      action: "config_set",
      configId,
      value,
      resumed: result.resumed,
      configOptions: result.response.configOptions,
      acpxRecordId: result.record.acpxRecordId,
      acpxSessionId: result.record.acpSessionId,
      agentSessionId: result.record.agentSessionId,
    })
  ) {
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
    sessionId: record.acpxRecordId,
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
    sessionId: record.acpxRecordId,
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
    sessionId: record.acpxRecordId,
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

  const closed = await closeSession(record.acpxRecordId);
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
    await closeSession(replaced.acpxRecordId);
    if (globalFlags.verbose) {
      process.stderr.write(
        `[acpx] soft-closed prior session: ${replaced.acpxRecordId}\n`,
      );
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
    process.stderr.write(`[acpx] created ${scope}: ${created.acpxRecordId}\n`);
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

function userContentToText(content: SessionUserContent): string {
  if ("Text" in content) {
    return content.Text;
  }
  if ("Mention" in content) {
    return content.Mention.content;
  }
  if ("Image" in content) {
    return content.Image.source || "[image]";
  }
  return "";
}

function agentContentToText(content: SessionAgentContent): string {
  if ("Text" in content) {
    return content.Text;
  }
  if ("Thinking" in content) {
    return content.Thinking.text;
  }
  if ("RedactedThinking" in content) {
    return "[redacted_thinking]";
  }
  if ("ToolUse" in content) {
    return `[tool:${content.ToolUse.name}]`;
  }
  return "";
}

function conversationHistoryEntries(record: SessionRecord): Array<{
  role: "user" | "assistant";
  timestamp: string;
  textPreview: string;
}> {
  const entries: Array<{
    role: "user" | "assistant";
    timestamp: string;
    textPreview: string;
  }> = [];

  for (const message of record.messages) {
    if (message === "Resume") {
      continue;
    }

    if ("User" in message) {
      const text = message.User.content
        .map((entry) => userContentToText(entry))
        .join(" ")
        .trim();

      if (!text) {
        continue;
      }

      entries.push({
        role: "user",
        timestamp: record.updated_at,
        textPreview: text,
      });
      continue;
    }

    if ("Agent" in message) {
      const text = message.Agent.content
        .map((entry) => agentContentToText(entry))
        .join(" ")
        .trim();

      if (!text) {
        continue;
      }

      entries.push({
        role: "assistant",
        timestamp: record.updated_at,
        textPreview: text,
      });
    }
  }

  return entries;
}

function printSessionDetailsByFormat(
  record: SessionRecord,
  format: OutputFormat,
): void {
  if (format === "json") {
    process.stdout.write(`${JSON.stringify(record)}\n`);
    return;
  }

  if (format === "quiet") {
    process.stdout.write(`${record.acpxRecordId}\n`);
    return;
  }

  process.stdout.write(`id: ${record.acpxRecordId}\n`);
  process.stdout.write(`sessionId: ${record.acpSessionId}\n`);
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
  process.stdout.write(
    `historyEntries: ${conversationHistoryEntries(record).length}\n`,
  );
}

function printSessionHistoryByFormat(
  record: SessionRecord,
  limit: number,
  format: OutputFormat,
): void {
  const history = conversationHistoryEntries(record);
  const visible = history.slice(Math.max(0, history.length - limit));

  if (format === "json") {
    process.stdout.write(
      `${JSON.stringify({
        id: record.acpxRecordId,
        sessionId: record.acpSessionId,
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
    `session: ${record.acpxRecordId} (${visible.length}/${history.length} shown)\n`,
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
    if (
      emitJsonResult(globalFlags.format, {
        action: "status_snapshot",
        status: "no-session",
        summary: "no active session",
      })
    ) {
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
    return;
  }

  const health = await probeQueueOwnerHealth(record.acpxRecordId);
  const running = health.healthy;
  const payload = {
    sessionId: record.acpxRecordId,
    agentCommand: record.agentCommand,
    pid: health.pid ?? record.pid ?? null,
    status: running ? "running" : "dead",
    uptime: running ? (formatUptime(record.agentStartedAt) ?? null) : null,
    lastPromptTime: record.lastPromptAt ?? null,
    exitCode: running ? null : (record.lastAgentExitCode ?? null),
    signal: running ? null : (record.lastAgentExitSignal ?? null),
    ...agentSessionIdPayload(record.agentSessionId),
  };

  if (
    emitJsonResult(globalFlags.format, {
      action: "status_snapshot",
      status: running ? "alive" : "dead",
      pid: payload.pid ?? undefined,
      summary: running ? "queue owner healthy" : "queue owner unavailable",
      uptime: payload.uptime ?? undefined,
      lastPromptTime: payload.lastPromptTime ?? undefined,
      exitCode: payload.exitCode ?? undefined,
      signal: payload.signal ?? undefined,
      acpxRecordId: record.acpxRecordId,
      acpxSessionId: record.acpSessionId,
      agentSessionId: record.agentSessionId,
    })
  ) {
    return;
  }

  if (globalFlags.format === "quiet") {
    process.stdout.write(`${payload.status}\n`);
    return;
  }

  process.stdout.write(`session: ${payload.sessionId}\n`);
  if ("agentSessionId" in payload) {
    process.stdout.write(`agentSessionId: ${payload.agentSessionId}\n`);
  }
  process.stdout.write(`agent: ${payload.agentCommand}\n`);
  process.stdout.write(`pid: ${payload.pid ?? "-"}\n`);
  process.stdout.write(`status: ${payload.status}\n`);
  process.stdout.write(`uptime: ${payload.uptime ?? "-"}\n`);
  process.stdout.write(`lastPromptTime: ${payload.lastPromptTime ?? "-"}\n`);
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
  const builtInAgents = listBuiltInAgents(config.agents);

  const program = new Command();
  program
    .name("acpx")
    .description("Headless CLI client for the Agent Client Protocol")
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

  for (const agentName of builtInAgents) {
    registerAgentCommand(program, agentName, config);
  }

  registerDefaultCommands(program, config);

  const scan = detectAgentToken(argv.slice(2));
  if (
    !scan.hasAgentOverride &&
    scan.token &&
    !TOP_LEVEL_VERBS.has(scan.token) &&
    !builtInAgents.includes(scan.token)
  ) {
    registerAgentCommand(program, scan.token, config);
  }

  program.argument("[prompt...]", "Prompt text").action(async function (
    this: Command,
    promptParts: string[],
  ) {
    if (promptParts.length === 0 && process.stdin.isTTY) {
      if (requestedJsonStrict) {
        throw new InvalidArgumentError(
          "Prompt is required (pass as argument, --file, or pipe via stdin)",
        );
      }
      this.outputHelp();
      return;
    }

    await handlePrompt(undefined, promptParts, {}, this, config);
  });

  program.addHelpText(
    "after",
    `
Examples:
  acpx codex sessions new
  acpx codex "fix the tests"
  acpx codex prompt "fix the tests"
  acpx codex --no-wait "queue follow-up task"
  acpx codex exec "what does this repo do"
  acpx codex cancel
  acpx codex set-mode plan
  acpx codex set approval_policy conservative
  acpx codex -s backend "fix the API"
  acpx codex sessions
  acpx codex sessions new --name backend
  acpx codex sessions ensure --name backend
  acpx codex sessions close backend
  acpx codex status
  acpx config show
  acpx config init
  acpx --ttl 30 codex "investigate flaky tests"
  acpx claude "refactor auth"
  acpx gemini "add logging"
  acpx --agent ./my-custom-server "do something"`,
  );

  program.exitOverride((error) => {
    throw error;
  });

  await runWithOutputPolicy(requestedOutputPolicy, async () => {
    try {
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
