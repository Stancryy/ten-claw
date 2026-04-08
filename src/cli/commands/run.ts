// File: src/cli/commands/run.ts
/**
 * tenclaw run command - Execute a pipeline with a goal
 *
 * Usage: tenclaw run "<goal>" --team dev|business
 */

import chalk from "chalk";
import { execSync } from "child_process";
import { existsSync } from "fs";
import { resolve } from "path";

interface RunOptions {
  team: string;
  provider?: string;
  wait: boolean;
  output: string;
}

export async function runCommand(goal: string, options: RunOptions): Promise<void> {
  console.log(chalk.blue("▶ Starting pipeline execution...\n"));

  // Validate team
  const validTeams = ["dev", "business", "dev-team", "business-team"];
  const teamId = options.team.toLowerCase();
  if (!validTeams.includes(teamId)) {
    console.error(chalk.red(`✖ Invalid team: ${options.team}`));
    console.error(chalk.gray(`  Valid teams: dev, business`));
    process.exit(1);
  }

  // Map to full team ID
  const fullTeamId = teamId === "dev" ? "dev-team" : teamId === "business" ? "business-team" : teamId;

  // Check if examples/run.ts exists
  const runScriptPath = resolve(process.cwd(), "examples/run.ts");
  if (!existsSync(runScriptPath)) {
    console.error(chalk.red(`✖ Run script not found: ${runScriptPath}`));
    console.error(chalk.gray("  Make sure you're in the TenClaw project root"));
    process.exit(1);
  }

  // Build environment variables
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    TEAM: fullTeamId,
  };

  if (options.provider) {
    env.LLM_PROVIDER = options.provider;
  }

  // Set a custom goal via environment variable
  // The run.ts script will need to be modified to accept a custom goal
  env.TENCLAW_GOAL = goal;

  console.log(chalk.gray("  Team:"), chalk.cyan(fullTeamId));
  console.log(chalk.gray("  Goal:"), chalk.white(goal));
  if (options.provider) {
    console.log(chalk.gray("  Provider:"), chalk.cyan(options.provider));
  }
  console.log();

  try {
    // Execute the run script
    console.log(chalk.blue("▶ Executing pipeline...\n"));

    const result = execSync(
      `npx ts-node "${runScriptPath}"`,
      {
        env,
        stdio: "inherit",
        cwd: process.cwd(),
      }
    );

    console.log(chalk.green("\n✔ Pipeline completed successfully"));
  } catch (error: any) {
    if (error.status !== 0) {
      console.error(chalk.red(`\n✖ Pipeline failed with exit code ${error.status}`));
    } else {
      console.error(chalk.red(`\n✖ Pipeline failed: ${error.message}`));
    }
    process.exit(error.status || 1);
  }
}
