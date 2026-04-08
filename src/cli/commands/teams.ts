// File: src/cli/commands/teams.ts
/**
 * tenclaw teams command - Manage teams
 *
 * Subcommands: list, create, show
 */

import chalk from "chalk";
import { readdirSync, readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

// Dynamic import for ESM-only inquirer
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getInquirer(): Promise<any> {
  const { default: inquirer } = await import("inquirer");
  return inquirer;
}

interface ListOptions {
  format: string;
}

interface CreateOptions {
  name?: string;
  file?: string;
}

interface TeamInfo {
  id: string;
  name: string;
  description: string;
  agentCount: number;
  filePath: string;
}

function getTeamsRoot(): string {
  return process.env.TEAMS_ROOT ?? resolve(process.cwd(), "teams");
}

function loadTeam(filePath: string): TeamInfo | null {
  try {
    const content = readFileSync(filePath, "utf-8");
    const isYaml = filePath.endsWith(".yaml") || filePath.endsWith(".yml");
    const data = isYaml ? parseYaml(content) : JSON.parse(content);

    return {
      id: data.id || data.slug || "unknown",
      name: data.name || data.id || "Unknown Team",
      description: data.description || "No description",
      agentCount: data.agents?.length || 0,
      filePath,
    };
  } catch (error) {
    return null;
  }
}

async function listTeams(): Promise<TeamInfo[]> {
  const teamsRoot = getTeamsRoot();
  if (!existsSync(teamsRoot)) {
    return [];
  }

  const files = readdirSync(teamsRoot);
  const teams: TeamInfo[] = [];

  for (const file of files) {
    if (file.endsWith(".yaml") || file.endsWith(".yml") || file.endsWith(".json")) {
      const team = loadTeam(resolve(teamsRoot, file));
      if (team) {
        teams.push(team);
      }
    }
  }

  return teams;
}

export const teamsCommand = {
  async list(options: ListOptions): Promise<void> {
    const teams = await listTeams();

    if (teams.length === 0) {
      console.log(chalk.yellow("⚠ No teams found"));
      console.log(chalk.gray(`  Looking in: ${getTeamsRoot()}`));
      return;
    }

    switch (options.format) {
      case "json":
        console.log(JSON.stringify(teams, null, 2));
        break;
      case "yaml":
        console.log(stringifyYaml(teams));
        break;
      case "table":
      default:
        console.log(chalk.bold("\nAvailable Teams:\n"));
        console.log(
          chalk.gray(
            `${"ID".padEnd(20)} ${"Name".padEnd(25)} ${"Agents".padStart(8)} ${"Description"}`
          )
        );
        console.log(chalk.gray("─".repeat(80)));

        for (const team of teams) {
          const id = team.id.padEnd(20);
          const name = team.name.substring(0, 24).padEnd(25);
          const agents = String(team.agentCount).padStart(8);
          const desc = team.description.substring(0, 30);
          console.log(`${chalk.cyan(id)} ${chalk.white(name)} ${chalk.gray(agents)} ${chalk.gray(desc)}`);
        }
        console.log();
        break;
    }
  },

  async create(options: CreateOptions): Promise<void> {
    console.log(chalk.blue("▶ Creating new team\n"));
    const inquirer = await getInquirer();

    if (options.file) {
      // Load from file
      console.log(chalk.gray(`Loading from: ${options.file}`));
      // TODO: Implement file loading
      console.log(chalk.yellow("⚠ File loading not yet implemented"));
      return;
    }

    // Interactive prompts
    const answers = await inquirer.prompt([
      {
        type: "input",
        name: "name",
        message: "Team name:",
        default: options.name,
        validate: (input: string) => input.trim().length > 0 || "Name is required",
      },
      {
        type: "input",
        name: "id",
        message: "Team ID (slug):",
        default: (answers: { name: string }) => answers.name?.toLowerCase().replace(/\s+/g, "-") || "",
        validate: (input: string) => /^[a-z0-9-]+$/.test(input) || "Use only lowercase letters, numbers, and hyphens",
      },
      {
        type: "input",
        name: "description",
        message: "Description:",
        default: "A new TenClaw team",
      },
      {
        type: "list",
        name: "type",
        message: "Team type:",
        choices: ["development", "business", "research", "custom"],
        default: "development",
      },
    ]);

    console.log(chalk.gray("\nTeam configuration:"));
    console.log(chalk.gray(`  ID: ${answers.id}`));
    console.log(chalk.gray(`  Name: ${answers.name}`));
    console.log(chalk.gray(`  Type: ${answers.type}`));
    console.log();

    const confirm = await inquirer.prompt([
      {
        type: "confirm",
        name: "save",
        message: "Create this team?",
        default: true,
      },
    ]);

    if (confirm.save) {
      // TODO: Save team to file
      console.log(chalk.green(`✔ Team "${answers.name}" created (not yet saved)`));
    } else {
      console.log(chalk.gray("Cancelled"));
    }
  },

  async show(teamId: string): Promise<void> {
    const teams = await listTeams();
    const team = teams.find((t) => t.id === teamId);

    if (!team) {
      console.error(chalk.red(`✖ Team not found: ${teamId}`));
      process.exit(1);
    }

    console.log(chalk.bold(`\nTeam: ${team.name}\n`));
    console.log(chalk.gray("  ID:"), team.id);
    console.log(chalk.gray("  Description:"), team.description);
    console.log(chalk.gray("  Agents:"), team.agentCount);
    console.log(chalk.gray("  File:"), team.filePath);
    console.log();
  },
};
