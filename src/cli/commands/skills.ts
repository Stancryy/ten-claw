// File: src/cli/commands/skills.ts
/**
 * tenclaw skills command - Manage skills
 *
 * Subcommands: list, review, show
 */

import chalk from "chalk";
import { readdirSync, readFileSync, existsSync, statSync } from "fs";
import { resolve, basename } from "path";
import { parse as parseYaml } from "yaml";

// Dynamic import for ESM-only inquirer
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getInquirer(): Promise<any> {
  const { default: inquirer } = await import("inquirer");
  return inquirer;
}

interface ListOptions {
  category: string;
  format: string;
}

interface ReviewOptions {
  auto: boolean;
}

interface SkillInfo {
  id: string;
  name: string;
  category: string;
  description: string;
  version?: string;
  filePath: string;
  status: "pending" | "approved" | "rejected" | "learned";
}

function getSkillsRoot(): string {
  return process.env.SKILLS_ROOT ?? resolve(process.cwd(), "skills");
}

function loadSkill(filePath: string, category: string): SkillInfo | null {
  try {
    const content = readFileSync(filePath, "utf-8");
    const isYaml = filePath.endsWith(".yaml") || filePath.endsWith(".yml");
    const data = isYaml ? parseYaml(content) : JSON.parse(content);

    const fileName = basename(filePath, isYaml ? ".yaml" : ".json");

    return {
      id: data.id || data.slug || fileName,
      name: data.name || data.id || fileName,
      category,
      description: data.description || data.summary || "No description",
      version: data.version,
      filePath,
      status: category === "approved" ? "approved" :
               category === "rejected" ? "rejected" :
               category === "learned" ? "learned" : "pending",
    };
  } catch (error) {
    return null;
  }
}

async function listSkills(category: string): Promise<SkillInfo[]> {
  const skillsRoot = getSkillsRoot();
  if (!existsSync(skillsRoot)) {
    return [];
  }

  const skills: SkillInfo[] = [];
  const categories = category === "all" ? ["dev", "business", "learned", "approved", "rejected"] : [category];

  for (const cat of categories) {
    const catPath = resolve(skillsRoot, cat);
    if (!existsSync(catPath)) continue;

    const stat = statSync(catPath);
    if (!stat.isDirectory()) continue;

    const files = readdirSync(catPath);
    for (const file of files) {
      if (file.endsWith(".yaml") || file.endsWith(".yml") || file.endsWith(".json")) {
        const skill = loadSkill(resolve(catPath, file), cat);
        if (skill) {
          skills.push(skill);
        }
      }
    }
  }

  return skills;
}

function getStatusColor(status: string): (text: string) => string {
  switch (status) {
    case "approved": return chalk.green;
    case "rejected": return chalk.red;
    case "learned": return chalk.blue;
    default: return chalk.yellow;
  }
}

export const skillsCommand = {
  async list(options: ListOptions): Promise<void> {
    const skills = await listSkills(options.category);

    if (skills.length === 0) {
      console.log(chalk.yellow(`⚠ No skills found in category: ${options.category}`));
      return;
    }

    switch (options.format) {
      case "json":
        console.log(JSON.stringify(skills, null, 2));
        break;
      case "table":
      default:
        console.log(chalk.bold(`\nSkills (${options.category}):\n`));
        console.log(
          chalk.gray(
            `${"ID".padEnd(25)} ${"Category".padEnd(12)} ${"Status".padEnd(12)} ${"Description"}`
          )
        );
        console.log(chalk.gray("─".repeat(90)));

        for (const skill of skills) {
          const id = skill.id.substring(0, 24).padEnd(25);
          const cat = skill.category.padEnd(12);
          const status = skill.status.padEnd(12);
          const desc = skill.description.substring(0, 35);
          const statusColor = getStatusColor(skill.status);
          console.log(`${chalk.cyan(id)} ${chalk.gray(cat)} ${statusColor(status)} ${chalk.gray(desc)}`);
        }
        console.log();
        break;
    }
  },

  async review(options: ReviewOptions): Promise<void> {
    console.log(chalk.blue("▶ Reviewing pending skills\n"));
    const inquirer = await getInquirer();

    // Get learned skills (pending review)
    const learnedSkills = await listSkills("learned");
    const pendingSkills = learnedSkills.filter((s) => s.status === "learned");

    if (pendingSkills.length === 0) {
      console.log(chalk.green("✔ No skills pending review"));
      return;
    }

    console.log(chalk.gray(`Found ${pendingSkills.length} skill(s) pending review\n`));

    for (const skill of pendingSkills) {
      console.log(chalk.bold(`Reviewing: ${skill.name}`));
      console.log(chalk.gray(`  File: ${skill.filePath}`));
      console.log(chalk.gray(`  Description: ${skill.description}`));
      console.log();

      if (options.auto) {
        // Auto-approve logic would go here
        console.log(chalk.green("  ✔ Auto-approved"));
      } else {
        const answer = await inquirer.prompt([
          {
            type: "list",
            name: "action",
            message: "Action:",
            choices: [
              { name: "✔ Approve", value: "approve" },
              { name: "✖ Reject", value: "reject" },
              { name: "⏭ Skip", value: "skip" },
              { name: "👁 View details", value: "view" },
            ],
            default: "skip",
          },
        ]);

        switch (answer.action) {
          case "approve":
            console.log(chalk.green(`  ✔ Approved: ${skill.id}`));
            // TODO: Move to approved directory
            break;
          case "reject":
            console.log(chalk.red(`  ✖ Rejected: ${skill.id}`));
            // TODO: Move to rejected directory
            break;
          case "view":
            const content = readFileSync(skill.filePath, "utf-8");
            console.log(chalk.gray("\n--- Content ---"));
            console.log(content.substring(0, 500));
            console.log(chalk.gray("---\n"));
            break;
          default:
            console.log(chalk.gray("  ⏭ Skipped"));
        }
      }
      console.log();
    }

    console.log(chalk.green("✔ Review complete"));
  },

  async show(skillId: string): Promise<void> {
    const skills = await listSkills("all");
    const skill = skills.find((s) => s.id === skillId);

    if (!skill) {
      console.error(chalk.red(`✖ Skill not found: ${skillId}`));
      process.exit(1);
    }

    console.log(chalk.bold(`\nSkill: ${skill.name}\n`));
    console.log(chalk.gray("  ID:"), skill.id);
    console.log(chalk.gray("  Category:"), skill.category);
    console.log(chalk.gray("  Status:"), getStatusColor(skill.status)(skill.status));
    if (skill.version) {
      console.log(chalk.gray("  Version:"), skill.version);
    }
    console.log(chalk.gray("  Description:"), skill.description);
    console.log(chalk.gray("  File:"), skill.filePath);

    // Show file content
    try {
      const content = readFileSync(skill.filePath, "utf-8");
      console.log(chalk.gray("\n  Content:"));
      console.log(chalk.gray("  ─".repeat(40)));
      console.log(content.substring(0, 1000));
      if (content.length > 1000) {
        console.log(chalk.gray(`  ... (${content.length - 1000} more characters)`));
      }
    } catch (error) {
      console.log(chalk.red("  Could not read file content"));
    }

    console.log();
  },
};
