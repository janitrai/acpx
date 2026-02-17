#!/usr/bin/env node

import { Command, CommanderError, InvalidArgumentError } from "commander";
import path from "node:path";
import {
  DEFAULT_AGENT_NAME,
  listBuiltInAgents,
  resolveAgentCommand as resolveAgentCommandFromRegistry,
} from "./agent-registry.js";
import { createOutputFormatter } from "./output.js";
import {
  InterruptedError,
  TimeoutError,
  closeSession,
  createSession,
  findSession,
  listSessionsForAgent,
  runOnce,
  sendSession,
} from "./session.js";
import {
  EXIT_CODES,
  OUTPUT_FORMATS,
  type OutputFormat,
  type PermissionMode,
  type SessionRecord,
} from "./types.js";

type PermissionFlags = {
  approveAll?: boolean;
  approveReads?: boolean;
  denyAll?: boolean;
};

type GlobalFlags = PermissionFlags & {
  agent?: string;
  cwd: string;
  timeout?: number;
  verbose?: boolean;
  format: OutputFormat;
};

type PromptFlags = {
  session?: string;
};

const TOP_LEVEL_VERBS = new Set(["prompt", "exec", "sessions", "help"]);

function parseOutputFormat(value: string): OutputFormat {
  if (!OUTPUT_FORMATS.includes(value as OutputFormat)) {
    throw new InvalidArgumentError(
      `Invalid format \"${value}\". Expected one of: ${OUTPUT_FORMATS.join(", ")}`,
    );
  }
  return value as OutputFormat;
}

function parseTimeoutSeconds(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new InvalidArgumentError("Timeout must be a positive number of seconds");
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

function resolvePermissionMode(flags: PermissionFlags): PermissionMode {
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

  return "approve-reads";
}

async function readPrompt(promptParts: string[]): Promise<string> {
  const joined = promptParts.join(" ").trim();
  if (joined.length > 0) {
    return joined;
  }

  if (process.stdin.isTTY) {
    throw new InvalidArgumentError(
      "Prompt is required (pass as argument or pipe via stdin)",
    );
  }

  let data = "";
  for await (const chunk of process.stdin) {
    data += String(chunk);
  }

  const prompt = data.trim();
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
    .option("--approve-all", "Auto-approve all permission requests")
    .option(
      "--approve-reads",
      "Auto-approve read/search requests and prompt for writes",
    )
    .option("--deny-all", "Deny all permission requests")
    .option(
      "--format <fmt>",
      "Output format: text, json, quiet",
      parseOutputFormat,
      "text",
    )
    .option(
      "--timeout <seconds>",
      "Maximum time to wait for agent response",
      parseTimeoutSeconds,
    )
    .option("--verbose", "Enable verbose debug logs");
}

function addSessionOption(command: Command): Command {
  return command.option(
    "-s, --session <name>",
    "Use named session instead of cwd default",
    parseSessionName,
  );
}

function resolveGlobalFlags(command: Command): GlobalFlags {
  const opts = command.optsWithGlobals() as Partial<GlobalFlags>;
  return {
    agent: opts.agent,
    cwd: opts.cwd ?? process.cwd(),
    timeout: opts.timeout,
    verbose: opts.verbose,
    format: opts.format ?? "text",
    approveAll: opts.approveAll,
    approveReads: opts.approveReads,
    denyAll: opts.denyAll,
  };
}

function resolveAgentInvocation(
  explicitAgentName: string | undefined,
  globalFlags: GlobalFlags,
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

  const agentName = explicitAgentName ?? DEFAULT_AGENT_NAME;
  const agentCommand =
    override && override.length > 0
      ? override
      : resolveAgentCommandFromRegistry(agentName);

  return {
    agentName,
    agentCommand,
    cwd: path.resolve(globalFlags.cwd),
  };
}

function printSessionsByFormat(
  sessions: SessionRecord[],
  format: OutputFormat,
): void {
  if (format === "json") {
    process.stdout.write(`${JSON.stringify(sessions)}\n`);
    return;
  }

  if (format === "quiet") {
    for (const session of sessions) {
      process.stdout.write(`${session.id}\n`);
    }
    return;
  }

  if (sessions.length === 0) {
    process.stdout.write("No sessions\n");
    return;
  }

  for (const session of sessions) {
    process.stdout.write(
      `${session.id}\t${session.name ?? "-"}\t${session.cwd}\t${session.lastUsedAt}\n`,
    );
  }
}

function printClosedSessionByFormat(
  record: SessionRecord,
  format: OutputFormat,
): void {
  if (format === "json") {
    process.stdout.write(
      `${JSON.stringify({
        type: "session_closed",
        id: record.id,
        sessionId: record.sessionId,
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

async function handlePrompt(
  explicitAgentName: string | undefined,
  promptParts: string[],
  flags: PromptFlags,
  command: Command,
): Promise<void> {
  const globalFlags = resolveGlobalFlags(command);
  const permissionMode = resolvePermissionMode(globalFlags);
  const prompt = await readPrompt(promptParts);
  const outputFormatter = createOutputFormatter(globalFlags.format);
  const agent = resolveAgentInvocation(explicitAgentName, globalFlags);

  let record = await findSession({
    agentCommand: agent.agentCommand,
    cwd: agent.cwd,
    name: flags.session,
  });

  if (!record) {
    record = await createSession({
      agentCommand: agent.agentCommand,
      cwd: agent.cwd,
      name: flags.session,
      permissionMode,
      timeoutMs: globalFlags.timeout,
      verbose: globalFlags.verbose,
    });

    if (globalFlags.verbose) {
      const scope = flags.session ? `named session \"${flags.session}\"` : "cwd session";
      process.stderr.write(`[acpx] created ${scope}: ${record.id}\n`);
    }
  }

  const result = await sendSession({
    sessionId: record.id,
    message: prompt,
    permissionMode,
    outputFormatter,
    timeoutMs: globalFlags.timeout,
    verbose: globalFlags.verbose,
  });

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
  command: Command,
): Promise<void> {
  const globalFlags = resolveGlobalFlags(command);
  const permissionMode = resolvePermissionMode(globalFlags);
  const prompt = await readPrompt(promptParts);
  const outputFormatter = createOutputFormatter(globalFlags.format);
  const agent = resolveAgentInvocation(explicitAgentName, globalFlags);

  const result = await runOnce({
    agentCommand: agent.agentCommand,
    cwd: agent.cwd,
    message: prompt,
    permissionMode,
    outputFormatter,
    timeoutMs: globalFlags.timeout,
    verbose: globalFlags.verbose,
  });

  applyPermissionExitCode(result);
}

async function handleSessionsList(
  explicitAgentName: string | undefined,
  command: Command,
): Promise<void> {
  const globalFlags = resolveGlobalFlags(command);
  const agent = resolveAgentInvocation(explicitAgentName, globalFlags);
  const sessions = await listSessionsForAgent(agent.agentCommand);
  printSessionsByFormat(sessions, globalFlags.format);
}

async function handleSessionsClose(
  explicitAgentName: string | undefined,
  sessionName: string | undefined,
  command: Command,
): Promise<void> {
  const globalFlags = resolveGlobalFlags(command);
  const agent = resolveAgentInvocation(explicitAgentName, globalFlags);

  const record = await findSession({
    agentCommand: agent.agentCommand,
    cwd: agent.cwd,
    name: sessionName,
  });

  if (!record) {
    if (sessionName) {
      throw new Error(
        `No named session \"${sessionName}\" for cwd ${agent.cwd} and agent ${agent.agentName}`,
      );
    }

    throw new Error(
      `No cwd session for ${agent.cwd} and agent ${agent.agentName}`,
    );
  }

  const closed = await closeSession(record.id);
  printClosedSessionByFormat(closed, globalFlags.format);
}

function registerSessionsCommand(
  parent: Command,
  explicitAgentName: string | undefined,
): void {
  const sessionsCommand = parent
    .command("sessions")
    .description("List or close sessions for this agent");

  sessionsCommand.action(async function (this: Command) {
    await handleSessionsList(explicitAgentName, this);
  });

  sessionsCommand
    .command("list")
    .description("List sessions")
    .action(async function (this: Command) {
      await handleSessionsList(explicitAgentName, this);
    });

  sessionsCommand
    .command("close")
    .description("Close session for current cwd")
    .argument("[name]", "Session name", parseSessionName)
    .action(async function (this: Command, name?: string) {
      await handleSessionsClose(explicitAgentName, name, this);
    });
}

function registerAgentCommand(program: Command, agentName: string): void {
  const agentCommand = program
    .command(agentName)
    .description(`Use ${agentName} agent`)
    .argument("[prompt...]", "Prompt text")
    .showHelpAfterError();

  addSessionOption(agentCommand);

  agentCommand.action(async function (
    this: Command,
    promptParts: string[],
    flags: PromptFlags,
  ) {
    await handlePrompt(agentName, promptParts, flags, this);
  });

  const promptCommand = agentCommand
    .command("prompt")
    .description("Prompt using persistent session")
    .argument("[prompt...]", "Prompt text")
    .showHelpAfterError();
  addSessionOption(promptCommand);

  promptCommand.action(async function (
    this: Command,
    promptParts: string[],
    flags: PromptFlags,
  ) {
    await handlePrompt(agentName, promptParts, flags, this);
  });

  agentCommand
    .command("exec")
    .description("One-shot prompt without saved session")
    .argument("[prompt...]", "Prompt text")
    .showHelpAfterError()
    .action(async function (this: Command, promptParts: string[]) {
      await handleExec(agentName, promptParts, this);
    });

  registerSessionsCommand(agentCommand, agentName);
}

function registerDefaultCommands(program: Command): void {
  const promptCommand = program
    .command("prompt")
    .description(`Prompt using ${DEFAULT_AGENT_NAME} by default`)
    .argument("[prompt...]", "Prompt text")
    .showHelpAfterError();
  addSessionOption(promptCommand);

  promptCommand.action(async function (
    this: Command,
    promptParts: string[],
    flags: PromptFlags,
  ) {
    await handlePrompt(undefined, promptParts, flags, this);
  });

  program
    .command("exec")
    .description(`One-shot prompt using ${DEFAULT_AGENT_NAME} by default`)
    .argument("[prompt...]", "Prompt text")
    .showHelpAfterError()
    .action(async function (this: Command, promptParts: string[]) {
      await handleExec(undefined, promptParts, this);
    });

  registerSessionsCommand(program, undefined);
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

    if (token === "--cwd" || token === "--format" || token === "--timeout") {
      index += 1;
      continue;
    }

    if (
      token.startsWith("--cwd=") ||
      token.startsWith("--format=") ||
      token.startsWith("--timeout=")
    ) {
      continue;
    }

    if (
      token === "--approve-all" ||
      token === "--approve-reads" ||
      token === "--deny-all" ||
      token === "--verbose"
    ) {
      continue;
    }

    return { hasAgentOverride };
  }

  return { hasAgentOverride };
}

async function main(): Promise<void> {
  const program = new Command();

  program
    .name("acpx")
    .description("Headless CLI client for the Agent Client Protocol")
    .showHelpAfterError();

  addGlobalFlags(program);

  const builtInAgents = listBuiltInAgents();
  for (const agentName of builtInAgents) {
    registerAgentCommand(program, agentName);
  }

  registerDefaultCommands(program);

  const scan = detectAgentToken(process.argv.slice(2));
  if (
    !scan.hasAgentOverride &&
    scan.token &&
    !TOP_LEVEL_VERBS.has(scan.token) &&
    !builtInAgents.includes(scan.token)
  ) {
    registerAgentCommand(program, scan.token);
  }

  program
    .argument("[prompt...]", "Prompt text")
    .action(async function (this: Command, promptParts: string[]) {
      if (promptParts.length === 0 && process.stdin.isTTY) {
        this.outputHelp();
        return;
      }

      await handlePrompt(undefined, promptParts, {}, this);
    });

  program.addHelpText(
    "after",
    `
Examples:
  acpx codex \"fix the tests\"
  acpx codex prompt \"fix the tests\"
  acpx codex exec \"what does this repo do\"
  acpx codex -s backend \"fix the API\"
  acpx codex sessions
  acpx codex sessions close backend
  acpx claude \"refactor auth\"
  acpx gemini \"add logging\"
  acpx --agent ./my-custom-server \"do something\"`,
  );

  program.exitOverride((error) => {
    throw error;
  });

  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    if (error instanceof CommanderError) {
      if (
        error.code === "commander.helpDisplayed" ||
        error.code === "commander.version"
      ) {
        process.exit(EXIT_CODES.SUCCESS);
      }
      process.exit(EXIT_CODES.USAGE);
    }

    if (error instanceof InterruptedError) {
      process.exit(EXIT_CODES.INTERRUPTED);
    }

    if (error instanceof TimeoutError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(EXIT_CODES.TIMEOUT);
    }

    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(EXIT_CODES.ERROR);
  }
}

void main();
