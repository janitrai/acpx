#!/usr/bin/env node

import { Command, CommanderError, InvalidArgumentError } from "commander";
import { createOutputFormatter } from "./output.js";
import {
  InterruptedError,
  TimeoutError,
  closeSession,
  createSession,
  listSessions,
  runOnce,
  sendSession,
} from "./session.js";
import {
  EXIT_CODES,
  OUTPUT_FORMATS,
  type OutputFormat,
  type PermissionMode,
} from "./types.js";

type PermissionFlags = {
  approveAll?: boolean;
  approveReads?: boolean;
  denyAll?: boolean;
};

type BaseRunFlags = PermissionFlags & {
  timeout?: number;
  verbose?: boolean;
  format: OutputFormat;
};

type RunFlags = BaseRunFlags & {
  agent: string;
  cwd: string;
};

type SessionCreateFlags = PermissionFlags & {
  agent: string;
  cwd: string;
  timeout?: number;
  verbose?: boolean;
  format: OutputFormat;
};

type SessionSendFlags = BaseRunFlags;

type FormatFlag = {
  format: OutputFormat;
};

function parseOutputFormat(value: string): OutputFormat {
  if (!OUTPUT_FORMATS.includes(value as OutputFormat)) {
    throw new InvalidArgumentError(
      `Invalid format "${value}". Expected one of: ${OUTPUT_FORMATS.join(", ")}`,
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

function addPermissionFlags(command: Command): Command {
  return command
    .option("--approve-all", "Auto-approve all permission requests")
    .option(
      "--approve-reads",
      "Auto-approve read/search requests and prompt for writes",
    )
    .option("--deny-all", "Deny all permission requests");
}

function addFormatFlag(command: Command): Command {
  return command.option(
    "--format <fmt>",
    "Output format: text, json, quiet",
    parseOutputFormat,
    "text",
  );
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

function printSessionRecordByFormat(
  record: {
    id: string;
    sessionId: string;
    agentCommand: string;
    cwd: string;
    createdAt: string;
    lastUsedAt: string;
  },
  format: OutputFormat,
): void {
  if (format === "json") {
    process.stdout.write(
      `${JSON.stringify({
        type: "session",
        ...record,
      })}\n`,
    );
    return;
  }

  process.stdout.write(`${record.id}\n`);
}

function printSessionsByFormat(
  sessions: Array<{
    id: string;
    sessionId: string;
    cwd: string;
    agentCommand: string;
    lastUsedAt: string;
  }>,
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
      `${session.id}\t${session.cwd}\t${session.lastUsedAt}\n`,
    );
  }
}

async function main(): Promise<void> {
  const program = new Command();

  program
    .name("acpx")
    .description("Headless CLI client for the Agent Client Protocol")
    .showHelpAfterError();

  program
    .command("run")
    .description("Run a one-shot prompt")
    .argument("[prompt...]", "Prompt text")
    .requiredOption("--agent <command>", "ACP adapter command")
    .option("--cwd <dir>", "Working directory", process.cwd())
    .option(
      "--timeout <seconds>",
      "Maximum time to wait for agent response",
      parseTimeoutSeconds,
    )
    .option("--verbose", "Enable verbose debug logs")
    .allowUnknownOption(false);

  const runCommand = program.commands.find((cmd) => cmd.name() === "run");
  if (!runCommand) {
    throw new Error("Failed to build run command");
  }

  addPermissionFlags(runCommand);
  addFormatFlag(runCommand);

  runCommand.action(async (promptParts: string[], flags: RunFlags) => {
    const prompt = await readPrompt(promptParts);
    const permissionMode = resolvePermissionMode(flags);
    const formatter = createOutputFormatter(flags.format);

    const result = await runOnce({
      agentCommand: flags.agent,
      cwd: flags.cwd,
      message: prompt,
      permissionMode,
      outputFormatter: formatter,
      timeoutMs: flags.timeout,
      verbose: flags.verbose,
    });

    applyPermissionExitCode(result);
  });

  const session = program.command("session").description("Session management");

  const sessionCreate = session
    .command("create")
    .description("Create a persistent session")
    .requiredOption("--agent <command>", "ACP adapter command")
    .option("--cwd <dir>", "Working directory", process.cwd())
    .option(
      "--timeout <seconds>",
      "Maximum time to wait for agent response",
      parseTimeoutSeconds,
    )
    .option("--verbose", "Enable verbose debug logs");

  addPermissionFlags(sessionCreate);
  addFormatFlag(sessionCreate);

  sessionCreate.action(async (flags: SessionCreateFlags) => {
    const permissionMode = resolvePermissionMode(flags);
    const record = await createSession({
      agentCommand: flags.agent,
      cwd: flags.cwd,
      permissionMode,
      timeoutMs: flags.timeout,
      verbose: flags.verbose,
    });
    printSessionRecordByFormat(record, flags.format);
  });

  const sessionSend = session
    .command("send")
    .description("Send a prompt to an existing session")
    .argument("<sessionId>", "Session ID")
    .argument("[prompt...]", "Prompt text")
    .option(
      "--timeout <seconds>",
      "Maximum time to wait for agent response",
      parseTimeoutSeconds,
    )
    .option("--verbose", "Enable verbose debug logs");

  addPermissionFlags(sessionSend);
  addFormatFlag(sessionSend);

  sessionSend.action(
    async (sessionId: string, promptParts: string[], flags: SessionSendFlags) => {
      const prompt = await readPrompt(promptParts);
      const permissionMode = resolvePermissionMode(flags);
      const formatter = createOutputFormatter(flags.format);

      const result = await sendSession({
        sessionId,
        message: prompt,
        permissionMode,
        outputFormatter: formatter,
        timeoutMs: flags.timeout,
        verbose: flags.verbose,
      });

      applyPermissionExitCode(result);

      if (flags.verbose && result.loadError) {
        process.stderr.write(
          `[acpx] loadSession failed, started fresh session: ${result.loadError}\n`,
        );
      }
    },
  );

  const sessionList = session
    .command("list")
    .description("List saved sessions");
  addFormatFlag(sessionList);

  sessionList.action(async (flags: FormatFlag) => {
    const sessions = await listSessions();
    printSessionsByFormat(sessions, flags.format);
  });

  const sessionClose = session
    .command("close")
    .description("Close and remove a saved session")
    .argument("<sessionId>", "Session ID");
  addFormatFlag(sessionClose);

  sessionClose.action(async (sessionId: string, flags: FormatFlag) => {
    const record = await closeSession(sessionId);

    if (flags.format === "json") {
      process.stdout.write(
        `${JSON.stringify({
          type: "session_closed",
          id: record.id,
          sessionId: record.sessionId,
        })}\n`,
      );
      return;
    }

    if (flags.format === "quiet") {
      return;
    }

    process.stdout.write(`${record.id}\n`);
  });

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
