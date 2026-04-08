// File: src/cli/commands/dashboard.ts
/**
 * tenclaw dashboard command - Launch the web dashboard
 *
 * Usage: tenclaw dashboard [--port 3000] [--open]
 */

import chalk from "chalk";
import { spawn } from "child_process";
import { existsSync } from "fs";
import { resolve } from "path";

interface DashboardOptions {
  port: string;
  open: boolean;
}

export async function dashboardCommand(options: DashboardOptions): Promise<void> {
  const port = parseInt(options.port, 10);
  const serverScript = resolve(process.cwd(), "src/dashboard/server.ts");

  if (!existsSync(serverScript)) {
    console.error(chalk.red(`✖ Dashboard server not found: ${serverScript}`));
    console.error(chalk.gray("  Make sure you're in the TenClaw project root"));
    process.exit(1);
  }

  console.log(chalk.blue("▶ Starting dashboard server...\n"));
  console.log(chalk.gray(`  Port: ${port}`));
  console.log(chalk.gray(`  Script: ${serverScript}`));
  if (options.open) {
    console.log(chalk.gray("  Auto-open: enabled"));
  }
  console.log();

  const env = {
    ...process.env,
    PORT: String(port),
  };

  try {
    const child = spawn(
      "npx",
      ["ts-node", serverScript],
      {
        env,
        stdio: "inherit",
        cwd: process.cwd(),
      }
    );

    // Handle graceful shutdown
    process.on("SIGINT", () => {
      console.log(chalk.yellow("\n⚠ Shutting down dashboard..."));
      child.kill("SIGINT");
    });

    child.on("close", (code) => {
      if (code !== 0 && code !== null) {
        console.error(chalk.red(`\n✖ Dashboard exited with code ${code}`));
        process.exit(code);
      }
    });
  } catch (error: any) {
    console.error(chalk.red(`\n✖ Failed to start dashboard: ${error.message}`));
    process.exit(1);
  }
}
