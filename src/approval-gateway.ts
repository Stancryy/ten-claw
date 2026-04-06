// File: src/approval-gateway.ts
/**
 * CLI-based ApprovalGateway implementation that prompts the user for approval
 * decisions via stdin, with a 60-second timeout.
 */

import * as readline from "node:readline";
import type {
  ApprovalGateway,
  ApprovalRequest,
  ApprovalDecision,
} from "./types";

/** Decision log entry for audit trail */
interface DecisionLogEntry {
  timestamp: string;
  requestId: string;
  approved: boolean;
  approverId: string;
  decidedAt: string;
  reason: string;
  timeout: boolean;
  originalPayload: unknown;
}

/** CLI-based approval gateway that prompts the user interactively. */
export class CliApprovalGateway implements ApprovalGateway {
  private readonly timeoutMs: number;
  private decisionLog: DecisionLogEntry[] = [];

  constructor(options: { timeoutMs?: number } = {}) {
    this.timeoutMs = options.timeoutMs ?? 60_000; // Default 60 seconds
  }

  /**
   * Requests approval from the user via CLI prompt.
   * Times out after 60 seconds (default: false).
   * Logs every decision with full context.
   */
  async requestApproval(request: ApprovalRequest): Promise<ApprovalDecision> {
    const startedAt = Date.now();
    const expiresAt = startedAt + this.timeoutMs;

    // Print request details to stdout
    console.log();
    console.log("═".repeat(60));
    console.log("🔒 APPROVAL REQUESTED");
    console.log("═".repeat(60));
    console.log(`Request ID: ${request.id}`);
    console.log(`Kind: ${request.kind}`);
    console.log(`Requested by: ${request.requestedByAgentId}`);
    console.log(`Reason: ${request.reason}`);
    console.log(`Created at: ${request.createdAt}`);
    if (request.riskScore !== undefined) {
      console.log(`Risk score: ${request.riskScore.toFixed(2)}`);
    }
    console.log();
    console.log("Payload:");
    console.log(JSON.stringify(request.payload, null, 2));
    console.log();
    console.log(`⏱️  Timeout: ${(this.timeoutMs / 1000).toFixed(0)} seconds`);
    console.log("─".repeat(60));
    console.log("Approve? (y/n) [default: n]: ");

    // Wait for user input with timeout
    const input = await this.promptWithTimeout(this.timeoutMs);

    const decidedAt = new Date().toISOString();
    const timedOut = input === null;
    const approved = !timedOut && (input === "y" || input === "Y");
    const approverId = timedOut ? "timeout" : "cli-user";

    // Log the decision
    const logEntry: DecisionLogEntry = {
      timestamp: new Date().toISOString(),
      requestId: request.id,
      approved,
      approverId,
      decidedAt,
      reason: request.reason,
      timeout: timedOut,
      originalPayload: request.payload,
    };
    this.decisionLog.push(logEntry);

    // Print decision outcome
    console.log();
    if (timedOut) {
      console.log("⏱️  TIMEOUT — no response received, defaulting to DENIED");
    } else if (approved) {
      console.log("✅ APPROVED");
    } else {
      console.log("❌ DENIED");
    }
    console.log("─".repeat(60));

    return {
      requestId: request.id,
      approved,
      approverId,
      decidedAt,
      comment: timedOut ? "Timed out after 60 seconds" : "",
    };
  }

  /**
   * Returns the decision log for audit purposes.
   */
  getDecisionLog(): readonly DecisionLogEntry[] {
    return [...this.decisionLog];
  }

  /**
   * Clears the decision log.
   */
  clearDecisionLog(): void {
    this.decisionLog = [];
  }

  /**
   * Prompts the user with a timeout. Returns null if timed out.
   */
  private async promptWithTimeout(timeoutMs: number): Promise<string | null> {
    return new Promise((resolve) => {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      let resolved = false;

      // Set up timeout
      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          rl.close();
          resolve(null);
        }
      }, timeoutMs);

      // Wait for user input
      rl.question("", (answer) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          rl.close();
          resolve(answer.trim());
        }
      });
    });
  }
}
