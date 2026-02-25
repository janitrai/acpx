import { InvalidArgumentError } from "commander";
import type { Command } from "commander";
import type { ResolvedAcpxConfig } from "./config.js";

type AgentTokenScan = {
  token?: string;
  hasAgentOverride: boolean;
};

type ConfigurePublicCliOptions = {
  program: Command;
  argv: string[];
  config: ResolvedAcpxConfig;
  requestedJsonStrict: boolean;
  topLevelVerbs: ReadonlySet<string>;
  listBuiltInAgents: (agents: ResolvedAcpxConfig["agents"]) => string[];
  detectAgentToken: (argv: string[]) => AgentTokenScan;
  registerAgentCommand: (
    program: Command,
    agentName: string,
    config: ResolvedAcpxConfig,
  ) => void;
  registerDefaultCommands: (program: Command, config: ResolvedAcpxConfig) => void;
  handlePromptAction: (command: Command, promptParts: string[]) => Promise<void>;
};

export function configurePublicCli(options: ConfigurePublicCliOptions): void {
  const builtInAgents = options.listBuiltInAgents(options.config.agents);

  for (const agentName of builtInAgents) {
    options.registerAgentCommand(options.program, agentName, options.config);
  }

  options.registerDefaultCommands(options.program, options.config);

  const scan = options.detectAgentToken(options.argv);
  if (
    !scan.hasAgentOverride &&
    scan.token &&
    !options.topLevelVerbs.has(scan.token) &&
    !builtInAgents.includes(scan.token)
  ) {
    options.registerAgentCommand(options.program, scan.token, options.config);
  }

  options.program.argument("[prompt...]", "Prompt text").action(async function (
    this: Command,
    promptParts: string[],
  ) {
    if (promptParts.length === 0 && process.stdin.isTTY) {
      if (options.requestedJsonStrict) {
        throw new InvalidArgumentError(
          "Prompt is required (pass as argument, --file, or pipe via stdin)",
        );
      }
      this.outputHelp();
      return;
    }

    await options.handlePromptAction(this, promptParts);
  });

  options.program.addHelpText(
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
}
