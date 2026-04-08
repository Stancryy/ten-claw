#!/usr/bin/env node
// File: src/cli/index.ts
/**
 * TenClaw CLI Entry Point
 *
 * A Claude Code-style CLI for the TenClaw multi-agent framework.
 *
 * Commands:
 *   tenclaw run "<goal>" --team dev|business    Run a pipeline
 *   tenclaw teams list                          List available teams
 *   tenclaw teams create                        Create a new team interactively
 *   tenclaw skills list                         List skills (dev/business/learned/approved)
 *   tenclaw skills review                       Approve/reject pending skills
 *   tenclaw agents list                         List agents and success rates
 *   tenclaw dashboard                           Opens the dashboard
 *   tenclaw infra up|down|status                Manages infrastructure
 *   tenclaw logs --run <runId>                  Shows audit log of a specific run
 *   tenclaw config set|get                      Manages configurations (.env)
 *
 * @path src/cli/index.ts
 */

import { Command } from "commander";
import chalk from "chalk";
import "dotenv/config";

// Import commands
import { runCommand } from "./commands/run";
import { teamsCommand } from "./commands/teams";
import { skillsCommand } from "./commands/skills";
import { agentsCommand } from "./commands/agents";
import { dashboardCommand } from "./commands/dashboard";
import { infraCommand } from "./commands/infra";
import { logsCommand } from "./commands/logs";
import { configCommand } from "./commands/config";

// CLI metadata
const CLI_VERSION = "1.6.0";
const CLI_NAME = "tenclaw";

// ASCII art banner
const BANNER = `
${chalk.cyan.bold("╔═══════════════════════════════════════════════════════════╗")}
${chalk.cyan.bold("║")}  ${chalk.white.bold("🦀 TenClaw")} ${chalk.gray("v" + CLI_VERSION)} - Self-Optimizing Multi-Agent Framework  ${chalk.cyan.bold("║")}
${chalk.cyan.bold("╚═══════════════════════════════════════════════════════════╝")}
`;

async function main(): Promise<void> {
  const program = new Command();

  program
    .name(CLI_NAME)
    .description("TenClaw - Self-optimizing multi-agent TypeScript framework")
    .version(CLI_VERSION, "-v, --version", "Display version number")
    .helpOption("-h, --help", "Display help for command")
    .configureHelp({
      sortSubcommands: true,
      subcommandTerm: (cmd: { name: () => string; usage: () => string }) => `${chalk.cyan(cmd.name())} ${cmd.usage() || ""}`,
    });

  // Show banner on main help
  program.on("--help", () => {
    console.log(BANNER);
  });

  // Global error handler
  program.exitOverride();

  // ─────────────────────────────────────────────────────────────────────────────
  // Register commands
  // ─────────────────────────────────────────────────────────────────────────────

  // tenclaw run "<goal>" --team dev|business
  program
    .command("run")
    .description("Run a pipeline with a goal")
    .argument("<goal>", "The goal/task to accomplish")
    .option("-t, --team <team>", "Team to use (dev or business)", "dev")
    .option("-p, --provider <provider>", "LLM provider (openai, anthropic, lmstudio, ollama)")
    .option("-w, --wait", "Wait for completion and show results", true)
    .option("-o, --output <format>", "Output format (json, yaml, pretty)", "pretty")
    .action(runCommand);

  // tenclaw teams [list|create]
  const teams = program
    .command("teams")
    .description("Manage teams");

  teams
    .command("list")
    .description("List available teams")
    .option("-f, --format <format>", "Output format (table, json, yaml)", "table")
    .action(teamsCommand.list);

  teams
    .command("create")
    .description("Create a new team interactively")
    .option("-n, --name <name>", "Team name")
    .option("-f, --file <file>", "Load from YAML/JSON file")
    .action(teamsCommand.create);

  teams
    .command("show <team>")
    .description("Show team details")
    .action(teamsCommand.show);

  // tenclaw skills [list|review]
  const skills = program
    .command("skills")
    .description("Manage skills");

  skills
    .command("list")
    .description("List skills")
    .option("-c, --category <cat>", "Category (dev, business, learned, approved, all)", "all")
    .option("-f, --format <format>", "Output format (table, json)", "table")
    .action(skillsCommand.list);

  skills
    .command("review")
    .description("Approve/reject pending skills")
    .option("-a, --auto", "Auto-approve above threshold", false)
    .action(skillsCommand.review);

  skills
    .command("show <skill>")
    .description("Show skill details")
    .action(skillsCommand.show);

  // tenclaw agents list
  const agents = program
    .command("agents")
    .description("Manage agents");

  agents
    .command("list")
    .description("List agents and their success rates")
    .option("-t, --team <team>", "Filter by team")
    .option("-f, --format <format>", "Output format (table, json)", "table")
    .action(agentsCommand.list);

  agents
    .command("stats <agent>")
    .description("Show detailed agent statistics")
    .action(agentsCommand.stats);

  // tenclaw dashboard
  program
    .command("dashboard")
    .description("Launch the web dashboard")
    .option("-p, --port <port>", "Port to run on", "3000")
    .option("-o, --open", "Open browser automatically", false)
    .action(dashboardCommand);

  // tenclaw infra [up|down|status]
  const infra = program
    .command("infra")
    .description("Manage infrastructure (Redis, ChromaDB)");

  infra
    .command("up")
    .description("Start infrastructure services")
    .option("-d, --detach", "Run in background", true)
    .action(infraCommand.up);

  infra
    .command("down")
    .description("Stop infrastructure services")
    .option("-v, --volumes", "Remove volumes", false)
    .action(infraCommand.down);

  infra
    .command("status")
    .description("Check infrastructure status")
    .action(infraCommand.status);

  infra
    .command("logs [service]")
    .description("Show infrastructure logs")
    .option("-f, --follow", "Follow logs", false)
    .option("-n, --tail <lines>", "Number of lines to show", "100")
    .action(infraCommand.logs);

  // tenclaw logs --run <runId>
  program
    .command("logs")
    .description("Show audit logs")
    .option("-r, --run <runId>", "Show logs for specific run")
    .option("-a, --agent <agentId>", "Filter by agent")
    .option("-f, --follow", "Follow new logs", false)
    .option("-n, --limit <count>", "Limit number of entries", "50")
    .action(logsCommand);

  // tenclaw config [set|get]
  const config = program
    .command("config")
    .description("Manage configuration (.env)");

  config
    .command("get <key>")
    .description("Get configuration value")
    .action(configCommand.get);

  config
    .command("set <key> <value>")
    .description("Set configuration value")
    .option("-g, --global", "Set in global config", false)
    .action(configCommand.set);

  config
    .command("list")
    .alias("ls")
    .description("List all configuration values")
    .action(configCommand.list);

  config
    .command("edit")
    .description("Open .env file in default editor")
    .action(configCommand.edit);

  // ─────────────────────────────────────────────────────────────────────────────
  // Parse arguments
  // ─────────────────────────────────────────────────────────────────────────────

  try {
    // Show banner for most commands (except when output is piped)
    if (process.stdout.isTTY && process.argv.length > 2) {
      const cmd = process.argv[2] || "";
      if (!["--version", "-v", "--help", "-h"].includes(cmd)) {
        console.log(BANNER);
      }
    }

    await program.parseAsync(process.argv);
  } catch (error: any) {
    if (error.code !== "commander.help" && error.code !== "commander.version") {
      console.error(chalk.red(`\n✖ Error: ${error.message}`));
      process.exit(1);
    }
  }
}

// Run main
main().catch((error) => {
  console.error(chalk.red(`\n✖ Fatal error: ${error.message}`));
  process.exit(1);
});
