// File: src/cli/commands/config.ts
/**
 * tenclaw config command - Manage configuration (.env)
 *
 * Subcommands: get, set, list, edit
 */

import chalk from "chalk";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";
import { spawn } from "child_process";

// Dynamic import for ESM-only inquirer
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getInquirer(): Promise<any> {
  const { default: inquirer } = await import("inquirer");
  return inquirer;
}

interface SetOptions {
  global: boolean;
}

function getEnvFilePath(global: boolean): string {
  if (global) {
    return resolve(homedir(), ".tenclaw", "config");
  }
  return resolve(process.cwd(), ".env");
}

function parseEnv(content: string): Record<string, string> {
  const env: Record<string, string> = {};
  const lines = content.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#")) {
      const match = trimmed.match(/^([^=]+)=(.*)$/);
      if (match && match[1] && match[2] !== undefined) {
        const key = match[1].trim();
        const value = match[2].trim().replace(/^["']|["']$/g, "");
        env[key] = value;
      }
    }
  }

  return env;
}

function serializeEnv(env: Record<string, string>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    // Quote values with spaces
    const needsQuotes = value.includes(" ") || value.includes("#");
    lines.push(`${key}=${needsQuotes ? `"${value}"` : value}`);
  }
  return lines.join("\n") + "\n";
}

function loadEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) {
    return {};
  }

  try {
    const content = readFileSync(path, "utf-8");
    return parseEnv(content);
  } catch (error) {
    return {};
  }
}

function saveEnvFile(path: string, env: Record<string, string>): void {
  // Ensure directory exists
  const dir = path.substring(0, path.lastIndexOf("\\")) || path.substring(0, path.lastIndexOf("/"));
  if (dir && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const content = serializeEnv(env);
  writeFileSync(path, content, "utf-8");
}

export const configCommand = {
  async get(key: string): Promise<void> {
    const localEnv = loadEnvFile(getEnvFilePath(false));
    const globalEnv = loadEnvFile(getEnvFilePath(true));

    const value = localEnv[key] ?? globalEnv[key] ?? process.env[key];

    if (value === undefined) {
      console.log(chalk.yellow(`⚠ ${key} is not set`));
      process.exit(1);
    } else {
      console.log(value);
    }
  },

  async set(key: string, value: string, options: SetOptions): Promise<void> {
    const envPath = getEnvFilePath(options.global);

    console.log(chalk.blue("▶ Setting configuration\n"));
    console.log(chalk.gray(`  Key: ${key}`));
    console.log(chalk.gray(`  Value: ${value}`));
    console.log(chalk.gray(`  Location: ${options.global ? "global" : "local"} (${envPath})`));
    console.log();

    // Load existing env
    const env = loadEnvFile(envPath);

    // Set new value
    env[key] = value;

    // Save
    saveEnvFile(envPath, env);

    console.log(chalk.green(`✔ ${key} has been set`));
  },

  async list(): Promise<void> {
    const localEnv = loadEnvFile(getEnvFilePath(false));
    const globalEnv = loadEnvFile(getEnvFilePath(true));

    console.log(chalk.bold("\nConfiguration:\n"));

    // Local config
    console.log(chalk.cyan("Local (.env):"));
    if (Object.keys(localEnv).length === 0) {
      console.log(chalk.gray("  (empty or file not found)"));
    } else {
      for (const [key, value] of Object.entries(localEnv)) {
        const displayValue = key.toLowerCase().includes("key") || key.toLowerCase().includes("secret") || key.toLowerCase().includes("password")
          ? "***"
          : value;
        console.log(`  ${chalk.gray(key)}=${displayValue}`);
      }
    }

    // Global config
    console.log(chalk.cyan("\nGlobal (~/.tenclaw/config):"));
    if (Object.keys(globalEnv).length === 0) {
      console.log(chalk.gray("  (empty or file not found)"));
    } else {
      for (const [key, value] of Object.entries(globalEnv)) {
        const displayValue = key.toLowerCase().includes("key") || key.toLowerCase().includes("secret") || key.toLowerCase().includes("password")
          ? "***"
          : value;
        console.log(`  ${chalk.gray(key)}=${displayValue}`);
      }
    }

    // Environment (filtered)
    console.log(chalk.cyan("\nEnvironment (TENCLAW_*):"));
    const tenclawEnv = Object.entries(process.env).filter(([k]) => k.startsWith("TENCLAW_"));
    if (tenclawEnv.length === 0) {
      console.log(chalk.gray("  (none set)"));
    } else {
      for (const [key, value] of tenclawEnv) {
        console.log(`  ${chalk.gray(key)}=${value}`);
      }
    }

    console.log();
  },

  async edit(): Promise<void> {
    const envPath = getEnvFilePath(false);
    const inquirer = await getInquirer();

    if (!existsSync(envPath)) {
      console.log(chalk.yellow(`⚠ ${envPath} does not exist`));
      const answer = await inquirer.prompt([
        {
          type: "confirm",
          name: "create",
          message: "Create it?",
          default: true,
        },
      ]);

      if (!answer.create) {
        return;
      }

      writeFileSync(envPath, "# TenClaw Configuration\n\n", "utf-8");
    }

    console.log(chalk.blue(`▶ Opening ${envPath}...\n`));

    // Try to open with system default editor
    const editor = process.env.EDITOR || (process.platform === "win32" ? "notepad" : "vi");

    try {
      spawn(editor, [envPath], {
        stdio: "inherit",
        detached: true,
      });
    } catch (error: any) {
      console.error(chalk.red(`✖ Could not open editor: ${error.message}`));
      console.log(chalk.gray(`  File location: ${envPath}`));
    }
  },
};
