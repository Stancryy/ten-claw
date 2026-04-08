// File: src/cli/commands/logs.ts
/**
 * tenclaw logs command - Show audit logs
 *
 * Usage: tenclaw logs [--run <runId>] [--agent <agentId>] [--follow] [--limit <count>]
 */

import chalk from "chalk";
import Redis from "ioredis";

interface LogsOptions {
  run?: string;
  agent?: string;
  follow: boolean;
  limit: string;
}

interface AuditEntry {
  runId: string;
  timestamp: string;
  agentId: string | undefined;
  event: string;
  data: Record<string, unknown>;
}

async function getRedisClient(): Promise<Redis | null> {
  const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
  const redisPassword = process.env.REDIS_PASSWORD;

  try {
    const redis = new Redis(redisUrl, {
      password: redisPassword,
      maxRetriesPerRequest: 3,
      connectTimeout: 5000,
    });

    await redis.ping();
    return redis;
  } catch (error) {
    return null;
  }
}

export async function logsCommand(options: LogsOptions): Promise<void> {
  console.log(chalk.blue("▶ Fetching audit logs...\n"));

  const redis = await getRedisClient();

  if (!redis) {
    console.error(chalk.red("✖ Could not connect to Redis"));
    console.error(chalk.gray("  Make sure infrastructure is running: tenclaw infra up"));
    process.exit(1);
  }

  try {
    const limit = parseInt(options.limit, 10);
    const keyPrefix = "tenclaw";

    if (options.run) {
      // Fetch logs for specific run
      console.log(chalk.gray(`  Run ID: ${options.run}`));
      if (options.agent) {
        console.log(chalk.gray(`  Agent: ${options.agent}`));
      }
      console.log();

      // Read from Redis stream
      const streamKey = `${keyPrefix}:audit:${options.run}`;
      const entries = await redis.xrange(streamKey, "-", "+", "COUNT", String(limit));

      if (!entries || entries.length === 0) {
        console.log(chalk.yellow("⚠ No logs found for this run"));
      } else {
        console.log(chalk.bold(`Found ${entries.length} log entries:\n`));

        for (const [, fields] of entries) {
          const data = parseStreamEntry(fields);
          displayLogEntry(data, options.agent);
        }
      }
    } else {
      // List recent runs
      console.log(chalk.gray("  Recent runs:\n"));

      // Scan for run keys
      const runs: string[] = [];
      let cursor = "0";
      do {
        const result = await redis.scan(cursor, "MATCH", `${keyPrefix}:audit:*`, "COUNT", 100);
        cursor = result[0];
        runs.push(...result[1]);
      } while (cursor !== "0");

      if (runs.length === 0) {
        console.log(chalk.yellow("⚠ No runs found in audit log"));
      } else {
        // Get last entry from each run for summary
        const runSummaries = [];
        for (const runKey of runs.slice(0, limit)) {
          const runId = runKey.replace(`${keyPrefix}:audit:`, "");
          const lastEntries = await redis.xrevrange(runKey, "+", "-", "COUNT", 1);
          const lastEntry = lastEntries[0];

          runSummaries.push({
            runId,
            timestamp: lastEntry?.[0] ? new Date(parseInt(String(lastEntry[0]).split("-")[0] || "0")).toISOString() : "unknown",
            entries: await redis.xlen(runKey),
          });
        }

        console.log(
          chalk.gray(`${"Run ID".padEnd(40)} ${"Timestamp".padEnd(25)} ${"Entries".padStart(10)}`)
        );
        console.log(chalk.gray("─".repeat(80)));

        for (const summary of runSummaries) {
          console.log(
            `${chalk.cyan(summary.runId.padEnd(40))} ${chalk.gray(summary.timestamp.padEnd(25))} ${chalk.gray(String(summary.entries).padStart(10))}`
          );
        }
        console.log();
        console.log(chalk.gray("Use --run <runId> to see detailed logs for a specific run"));
      }
    }

    if (options.follow) {
      console.log(chalk.yellow("\n⚠ Follow mode not yet implemented"));
    }
  } catch (error: any) {
    console.error(chalk.red(`\n✖ Error fetching logs: ${error.message}`));
  } finally {
    await redis.quit();
  }
}

function parseStreamEntry(fields: string[]): AuditEntry {
  const data: Record<string, unknown> = {};
  for (let i = 0; i < fields.length - 1; i += 2) {
    const key = fields[i];
    const value = fields[i + 1];
    if (key !== undefined && value !== undefined) {
      try {
        data[key] = JSON.parse(value);
      } catch {
        data[key] = value;
      }
    }
  }

  return {
    runId: String(data.runId || "unknown"),
    timestamp: String(data.timestamp || new Date().toISOString()),
    agentId: data.agentId ? String(data.agentId) : undefined,
    event: String(data.event || "unknown"),
    data,
  };
}

function displayLogEntry(entry: AuditEntry, agentFilter?: string): void {
  if (agentFilter && entry.agentId !== agentFilter) {
    return;
  }

  const timestamp = new Date(entry.timestamp).toLocaleTimeString();
  const eventColor = getEventColor(entry.event);

  console.log(`${chalk.gray(timestamp)} ${eventColor(entry.event.padEnd(20))} ${chalk.gray(entry.agentId || "system")}`);

  // Show relevant data fields
  const relevantFields = ["status", "duration", "error", "message"];
  for (const field of relevantFields) {
    if (entry.data[field] !== undefined) {
      console.log(`  ${chalk.gray(field + ":")} ${entry.data[field]}`);
    }
  }
  console.log();
}

function getEventColor(event: string): (text: string) => string {
  if (event.includes("success") || event.includes("complete")) {
    return chalk.green;
  }
  if (event.includes("error") || event.includes("fail")) {
    return chalk.red;
  }
  if (event.includes("start") || event.includes("begin")) {
    return chalk.blue;
  }
  if (event.includes("handoff") || event.includes("route")) {
    return chalk.yellow;
  }
  return chalk.gray;
}
