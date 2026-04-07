#!/usr/bin/env node
/**
 * Test script to approve skills programmatically and verify registry loading
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, basename } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { FileSystemSkillSource, createYamlSkillDocumentCodec } from "../src/skills";

const LEARNED_DIR = "./skills/learned";
const APPROVED_DIR = "./skills/approved";

async function approveSkill(filePath: string): Promise<void> {
  const filename = basename(filePath);
  const content = await readFile(filePath, "utf-8");
  const skill = parseYaml(content) as Record<string, unknown>;

  // Update skill metadata
  skill.approvedForUse = true;
  skill.reviewStatus = "approved";
  skill.reviewedAt = new Date().toISOString();
  skill.reviewedBy = "test-script";

  // Write to approved directory
  const approvedPath = join(APPROVED_DIR, filename);
  const yaml = stringifyYaml(skill, { indentSeq: true });
  await writeFile(approvedPath, yaml, "utf-8");

  console.log(`✓ Approved: ${skill.id} (${skill.name})`);
  console.log(`  Copied to: ${approvedPath}`);
}

async function main(): Promise<void> {
  console.log("=== Skills Approval Test ===\n");

  // Ensure directories exist
  await mkdir(APPROVED_DIR, { recursive: true });

  // Get first 2 learned skills
  const skillsToApprove = [
    "skills/learned/coder-2026-04-07T09-36-27-635Z.yaml",
    "skills/learned/planner-2026-04-07T09-36-27-632Z.yaml",
  ];

  console.log("Approving skills...\n");
  for (const filePath of skillsToApprove) {
    await approveSkill(filePath);
  }

  console.log("\n=== Verifying Registry Loading ===\n");

  // Create skill source and test loading
  const yamlParser = (content: string): unknown => parseYaml(content);
  const source = new FileSystemSkillSource(
    { rootDirectory: "./skills", includeSharedLibrary: false },
    [createYamlSkillDocumentCodec(yamlParser)]
  );

  const scope = { tenantId: "demo-tenant", workspaceId: "demo-workspace" };
  const skills = await source.load(scope);

  console.log(`Total skills loaded from registry: ${skills.length}`);
  console.log("\nApproved skills in registry:");

  const approvedSkills = skills.filter(s => s.id.startsWith("learned-"));
  for (const skill of approvedSkills) {
    console.log(`  - ${skill.id} (${skill.name})`);
    console.log(`    role: ${skill.role}, version: ${skill.version}`);
  }

  console.log(`\n✅ Successfully loaded ${approvedSkills.length} approved learned skills!`);
}

main().catch(console.error);
