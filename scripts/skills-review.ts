#!/usr/bin/env node
/**
 * Skills Review CLI
 *
 * Interactive command to review pending learned skills from skills/learned/
 * and approve or reject them.
 *
 * Usage: npm run skills:review
 */

import { readdir, readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { join, basename } from "node:path";
import { createInterface } from "node:readline";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

const LEARNED_DIR = "./skills/learned";
const APPROVED_DIR = "./skills/approved";
const REJECTED_DIR = "./skills/rejected";

interface LearnedSkillCandidate {
  schemaVersion: string;
  id: string;
  name: string;
  version: string;
  description: string;
  tags: string[];
  role: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  capabilities: string[];
  learnedFrom: {
    runIds: string[];
    agentId: string;
    extractedAt: string;
    confidenceScore: number;
    patternType: string;
  };
  qualityMetrics: {
    successRate: number;
    averageLatencyMs: number;
    averageTokenUsage: number;
    sampleSize: number;
  };
  approvedForUse: boolean;
  reviewStatus: "pending" | "approved" | "rejected";
  rejectionReason?: string;
  reviewedAt?: string;
  reviewedBy?: string;
}

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

async function ensureDirectories(): Promise<void> {
  await mkdir(APPROVED_DIR, { recursive: true });
  await mkdir(REJECTED_DIR, { recursive: true });
}

async function listPendingSkills(): Promise<{ filePath: string; skill: LearnedSkillCandidate }[]> {
  const pending: { filePath: string; skill: LearnedSkillCandidate }[] = [];

  try {
    const files = await readdir(LEARNED_DIR);
    const yamlFiles = files.filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));

    for (const file of yamlFiles) {
      const filePath = join(LEARNED_DIR, file);
      const content = await readFile(filePath, "utf-8");
      const skill = parseYaml(content) as LearnedSkillCandidate;

      if (skill.reviewStatus === "pending" || !skill.reviewStatus) {
        pending.push({ filePath, skill });
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  return pending;
}

function displaySkill(skill: LearnedSkillCandidate, index: number, total: number): void {
  console.log(`\n${"=".repeat(70)}`);
  console.log(`Skill ${index + 1} of ${total}: ${skill.name}`);
  console.log(`${"=".repeat(70)}`);
  console.log(`ID:        ${skill.id}`);
  console.log(`Role:      ${skill.role}`);
  console.log(`Version:   ${skill.version}`);
  console.log(`Description: ${skill.description}`);
  console.log(`\nTags:      ${skill.tags.join(", ")}`);
  console.log(`Capabilities: ${skill.capabilities.join(", ")}`);
  console.log(`\nLearned From:`);
  console.log(`  Agent:     ${skill.learnedFrom.agentId}`);
  console.log(`  Runs:      ${skill.learnedFrom.runIds.join(", ")}`);
  console.log(`  Extracted: ${skill.learnedFrom.extractedAt}`);
  console.log(`  Pattern:   ${skill.learnedFrom.patternType}`);
  console.log(`  Confidence: ${(skill.learnedFrom.confidenceScore * 100).toFixed(0)}%`);
  console.log(`\nQuality Metrics:`);
  console.log(`  Success Rate: ${(skill.qualityMetrics.successRate * 100).toFixed(0)}%`);
  console.log(`  Avg Latency:  ${skill.qualityMetrics.averageLatencyMs.toFixed(0)}ms`);
  console.log(`  Token Usage:  ${skill.qualityMetrics.averageTokenUsage.toFixed(0)}`);
  console.log(`  Sample Size:  ${skill.qualityMetrics.sampleSize}`);
  console.log(`\nOutput Schema Fields: ${Object.keys(skill.outputSchema.properties || {}).join(", ")}`);
  console.log(`${"=".repeat(70)}\n`);
}

async function approveSkill(
  filePath: string,
  skill: LearnedSkillCandidate,
  reviewerId: string
): Promise<void> {
  const timestamp = new Date().toISOString();
  const filename = basename(filePath);

  // Update skill metadata
  const approvedSkill: LearnedSkillCandidate = {
    ...skill,
    approvedForUse: true,
    reviewStatus: "approved",
    reviewedAt: timestamp,
    reviewedBy: reviewerId,
  };

  // Write to approved directory
  const approvedPath = join(APPROVED_DIR, filename);
  const yaml = stringifyYaml(approvedSkill, { indentSeq: true });
  await writeFile(approvedPath, yaml, "utf-8");

  // Remove from learned directory
  // Note: In a real implementation, you might want to archive instead of delete
  // For now, we keep it in learned but update its status
  const updatedYaml = stringifyYaml(approvedSkill, { indentSeq: true });
  await writeFile(filePath, updatedYaml, "utf-8");

  console.log(`✓ Approved: ${skill.id}`);
  console.log(`  Moved to: ${approvedPath}`);

  // Note: Registration in FileSystemSkillRegistry happens automatically
  // when the skill is loaded from the approved directory on next startup.
  // For immediate registration, you would need to call registry.put() here.
}

async function rejectSkill(
  filePath: string,
  skill: LearnedSkillCandidate,
  reviewerId: string,
  reason: string
): Promise<void> {
  const timestamp = new Date().toISOString();
  const filename = basename(filePath);

  // Update skill metadata
  const rejectedSkill: LearnedSkillCandidate = {
    ...skill,
    approvedForUse: false,
    reviewStatus: "rejected",
    rejectionReason: reason,
    reviewedAt: timestamp,
    reviewedBy: reviewerId,
  };

  // Write to rejected directory
  const rejectedPath = join(REJECTED_DIR, filename);
  const yaml = stringifyYaml(rejectedSkill, { indentSeq: true });
  await writeFile(rejectedPath, yaml, "utf-8");

  // Update original file with rejection status
  const updatedYaml = stringifyYaml(rejectedSkill, { indentSeq: true });
  await writeFile(filePath, updatedYaml, "utf-8");

  console.log(`✗ Rejected: ${skill.id}`);
  console.log(`  Reason:   ${reason}`);
  console.log(`  Moved to: ${rejectedPath}`);
}

async function getReviewerId(): Promise<string> {
  const reviewer = process.env.USER || process.env.USERNAME || "unknown";
  const custom = await ask(`Reviewer ID [${reviewer}]: `);
  return custom.trim() || reviewer;
}

async function reviewSkills(): Promise<void> {
  console.log("\n🔍 Loading pending learned skills...\n");

  await ensureDirectories();

  const pending = await listPendingSkills();

  if (pending.length === 0) {
    console.log("No pending skills to review.");
    console.log(`\nDirectories:`);
    console.log(`  Learned:  ${LEARNED_DIR}`);
    console.log(`  Approved: ${APPROVED_DIR}`);
    console.log(`  Rejected: ${REJECTED_DIR}`);
    rl.close();
    return;
  }

  console.log(`Found ${pending.length} pending skill(s) to review.\n`);

  const reviewerId = await getReviewerId();

  for (let i = 0; i < pending.length; i++) {
    const { filePath, skill } = pending[i];

    displaySkill(skill, i, pending.length);

    while (true) {
      const action = await ask("Approve (a), Reject (r), Skip (s), or Quit (q)? [a/r/s/q]: ");
      const choice = action.trim().toLowerCase();

      if (choice === "a" || choice === "approve") {
        await approveSkill(filePath, skill, reviewerId);
        break;
      } else if (choice === "r" || choice === "reject") {
        const reason = await ask("Rejection reason: ");
        if (!reason.trim()) {
          console.log("❌ A reason is required to reject.");
          continue;
        }
        await rejectSkill(filePath, skill, reviewerId, reason.trim());
        break;
      } else if (choice === "s" || choice === "skip") {
        console.log("⏭️  Skipped.");
        break;
      } else if (choice === "q" || choice === "quit") {
        console.log("\n👋 Review session ended.");
        rl.close();
        return;
      } else {
        console.log("Invalid choice. Please enter a, r, s, or q.");
      }
    }
  }

  console.log("\n✅ All skills reviewed!");
  console.log(`\nSummary:`);
  console.log(`  Reviewed by: ${reviewerId}`);
  console.log(`  Total:       ${pending.length}`);
  rl.close();
}

// Run the review session
reviewSkills().catch((error) => {
  console.error("❌ Error:", error);
  process.exit(1);
});
