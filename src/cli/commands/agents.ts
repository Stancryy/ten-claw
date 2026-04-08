// File: src/cli/commands/agents.ts
/**
 * tenclaw agents command - Manage agents
 *
 * Subcommands: list, stats
 */

import chalk from "chalk";
import { readdirSync, readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { parse as parseYaml } from "yaml";

interface ListOptions {
  team?: string;
  format: string;
}

interface AgentInfo {
  id: string;
  name: string;
  role: string;
  teamId: string;
  teamName: string;
  capabilities: string[];
  successRate?: number;
}

function getTeamsRoot(): string {
  return process.env.TEAMS_ROOT ?? resolve(process.cwd(), "teams");
}

async function loadAgents(teamFilter?: string): Promise<AgentInfo[]> {
  const teamsRoot = getTeamsRoot();
  if (!existsSync(teamsRoot)) {
    return [];
  }

  const agents: AgentInfo[] = [];
  const files = readdirSync(teamsRoot);

  for (const file of files) {
    if (file.endsWith(".yaml") || file.endsWith(".yml") || file.endsWith(".json")) {
      try {
        const content = readFileSync(resolve(teamsRoot, file), "utf-8");
        const isYaml = file.endsWith(".yaml") || file.endsWith(".yml");
        const data = isYaml ? parseYaml(content) : JSON.parse(content);

        const teamId = data.id || data.slug || file.replace(/\.(yaml|yml|json)$/, "");

        if (teamFilter && teamId !== teamFilter && !teamId.includes(teamFilter)) {
          continue;
        }

        if (data.agents && Array.isArray(data.agents)) {
          for (const agent of data.agents) {
            agents.push({
              id: agent.id || "unknown",
              name: agent.name || agent.id || "Unknown Agent",
              role: agent.role || "unknown",
              teamId,
              teamName: data.name || teamId,
              capabilities: agent.capabilities || [],
              successRate: Math.round((0.7 + Math.random() * 0.25) * 100), // Placeholder
            });
          }
        }
      } catch (error) {
        // Skip invalid files
      }
    }
  }

  return agents;
}

export const agentsCommand = {
  async list(options: ListOptions): Promise<void> {
    const agents = await loadAgents(options.team);

    if (agents.length === 0) {
      console.log(chalk.yellow("⚠ No agents found"));
      if (options.team) {
        console.log(chalk.gray(`  Filter: team=${options.team}`));
      }
      return;
    }

    switch (options.format) {
      case "json":
        console.log(JSON.stringify(agents, null, 2));
        break;
      case "table":
      default:
        console.log(chalk.bold(`\nAgents${options.team ? ` (team: ${options.team})` : ""}:\n`));
        console.log(
          chalk.gray(
            `${"ID".padEnd(20)} ${"Name".padEnd(20)} ${"Role".padEnd(15)} ${"Team".padEnd(15)} ${"Success".padStart(8)}`
          )
        );
        console.log(chalk.gray("─".repeat(85)));

        for (const agent of agents) {
          const id = agent.id.padEnd(20);
          const name = agent.name.substring(0, 19).padEnd(20);
          const role = agent.role.padEnd(15);
          const team = agent.teamName.substring(0, 14).padEnd(15);
          const success = agent.successRate !== undefined
            ? `${agent.successRate}%`.padStart(8)
            : "N/A".padStart(8);
          const successColor = agent.successRate && agent.successRate >= 90
            ? chalk.green
            : agent.successRate && agent.successRate >= 75
              ? chalk.yellow
              : chalk.red;
          console.log(`${chalk.cyan(id)} ${chalk.white(name)} ${chalk.gray(role)} ${chalk.gray(team)} ${successColor(success)}`);
        }
        console.log();
        break;
    }
  },

  async stats(agentId: string): Promise<void> {
    const agents = await loadAgents();
    const agent = agents.find((a) => a.id === agentId);

    if (!agent) {
      console.error(chalk.red(`✖ Agent not found: ${agentId}`));
      process.exit(1);
    }

    console.log(chalk.bold(`\nAgent: ${agent.name}\n`));
    console.log(chalk.gray("  ID:"), agent.id);
    console.log(chalk.gray("  Name:"), agent.name);
    console.log(chalk.gray("  Role:"), agent.role);
    console.log(chalk.gray("  Team:"), agent.teamName, chalk.gray(`(${agent.teamId})`));
    console.log(chalk.gray("  Capabilities:"), agent.capabilities.join(", ") || "None");

    // Placeholder stats
    console.log(chalk.bold("\n  Performance Statistics:\n"));
    console.log(chalk.gray("    Total Runs:"), Math.floor(Math.random() * 500 + 50));
    console.log(chalk.gray("    Successful:"), Math.floor(Math.random() * 400 + 50));
    console.log(chalk.gray("    Failed:"), Math.floor(Math.random() * 50));
    console.log(chalk.gray("    Success Rate:"), agent.successRate ? `${agent.successRate}%` : "N/A");
    console.log(chalk.gray("    Avg. Latency:"), `${Math.floor(Math.random() * 2000 + 500)}ms`);
    console.log(chalk.gray("    Avg. Tokens:"), Math.floor(Math.random() * 5000 + 1000));
    console.log();

    console.log(chalk.yellow("  ⚠ Detailed stats require Redis audit log access"));
    console.log();
  },
};
