// File: src/cli/commands/infra.ts
/**
 * tenclaw infra command - Manage infrastructure (Redis, ChromaDB)
 *
 * Subcommands: up, down, status, logs
 */

import chalk from "chalk";
import { execSync, spawn } from "child_process";
import { existsSync } from "fs";
import { resolve } from "path";

interface UpOptions {
  detach: boolean;
}

interface DownOptions {
  volumes: boolean;
}

interface LogsOptions {
  follow: boolean;
  tail: string;
}

function getComposeFile(): string {
  return resolve(process.cwd(), "docker-compose.yml");
}

function checkDockerCompose(): void {
  if (!existsSync(getComposeFile())) {
    console.error(chalk.red(`✖ docker-compose.yml not found: ${getComposeFile()}`));
    console.error(chalk.gray("  Make sure you're in the TenClaw project root"));
    process.exit(1);
  }

  try {
    execSync("docker --version", { stdio: "ignore" });
  } catch {
    console.error(chalk.red("✖ Docker is not installed or not in PATH"));
    process.exit(1);
  }

  try {
    execSync("docker compose version", { stdio: "ignore" });
  } catch {
    console.error(chalk.red("✖ Docker Compose is not available"));
    process.exit(1);
  }
}

export const infraCommand = {
  async up(options: UpOptions): Promise<void> {
    checkDockerCompose();

    console.log(chalk.blue("▶ Starting infrastructure services...\n"));
    console.log(chalk.gray("  Services: Redis, ChromaDB"));
    console.log(chalk.gray(`  Compose: ${getComposeFile()}`));
    console.log();

    try {
      const args = ["compose", "up"];
      if (options.detach) {
        args.push("-d");
      }

      execSync(`docker ${args.join(" ")}`, {
        stdio: "inherit",
        cwd: process.cwd(),
      });

      console.log();
      console.log(chalk.green("✔ Infrastructure is up"));
      console.log(chalk.gray("  Redis: redis://localhost:6379"));
      console.log(chalk.gray("  ChromaDB: http://localhost:8000"));
    } catch (error: any) {
      console.error(chalk.red(`\n✖ Failed to start infrastructure`));
      process.exit(1);
    }
  },

  async down(options: DownOptions): Promise<void> {
    checkDockerCompose();

    console.log(chalk.blue("▶ Stopping infrastructure services...\n"));

    try {
      const args = ["compose", "down"];
      if (options.volumes) {
        args.push("-v");
        console.log(chalk.yellow("  ⚠ Will remove volumes (data will be lost)"));
      }

      execSync(`docker ${args.join(" ")}`, {
        stdio: "inherit",
        cwd: process.cwd(),
      });

      console.log();
      console.log(chalk.green("✔ Infrastructure is down"));
    } catch (error: any) {
      console.error(chalk.red(`\n✖ Failed to stop infrastructure`));
      process.exit(1);
    }
  },

  async status(): Promise<void> {
    checkDockerCompose();

    console.log(chalk.blue("▶ Checking infrastructure status...\n"));

    try {
      const result = execSync("docker compose ps", {
        encoding: "utf-8",
        cwd: process.cwd(),
      });

      if (result.trim()) {
        console.log(result);
      } else {
        console.log(chalk.yellow("⚠ No services are running"));
      }

      // Additional health check
      console.log(chalk.gray("\nHealth Checks:"));

      // Check Redis
      try {
        execSync("docker exec tenclaw-redis redis-cli ping", { stdio: "ignore" });
        console.log(chalk.green("  ✔ Redis: responding"));
      } catch {
        console.log(chalk.red("  ✖ Redis: not responding"));
      }

      // Check ChromaDB (simplified - just check if container is running)
      try {
        const chromaRunning = execSync(
          'docker ps --filter "name=chroma" --format "{{.Names}}"',
          { encoding: "utf-8" }
        );
        if (chromaRunning.includes("chroma")) {
          console.log(chalk.green("  ✔ ChromaDB: container running"));
        } else {
          console.log(chalk.red("  ✖ ChromaDB: not running"));
        }
      } catch {
        console.log(chalk.red("  ✖ ChromaDB: check failed"));
      }
    } catch (error: any) {
      console.error(chalk.red(`\n✖ Failed to check status: ${error.message}`));
      process.exit(1);
    }
  },

  async logs(service: string | undefined, options: LogsOptions): Promise<void> {
    checkDockerCompose();

    console.log(chalk.blue("▶ Fetching infrastructure logs...\n"));

    const args = ["compose", "logs"];
    if (options.follow) {
      args.push("-f");
    }
    if (options.tail) {
      args.push("--tail", options.tail);
    }
    if (service) {
      args.push(service);
    }

    try {
      spawn("docker", args, {
        stdio: "inherit",
        cwd: process.cwd(),
      });
    } catch (error: any) {
      console.error(chalk.red(`\n✖ Failed to fetch logs`));
      process.exit(1);
    }
  },
};
