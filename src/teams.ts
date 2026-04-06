// File: src/teams.ts
/**
 * Team definition repositories and codecs for low-code YAML/JSON team files.
 */

import { access, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { SkillDefinition, SkillId, SkillRegistry, TeamDefinition, TenantScope } from "./types";
import type { TeamRepository } from "./orchestrator-support";

/** Parser contract for low-code team documents. */
export interface TeamDocumentCodec {
  readonly extensions: string[];
  parse<T>(content: string, filePath: string): T;
}

/** Filesystem repository configuration for team definition lookup. */
export interface FileSystemTeamRepositoryConfig {
  rootDirectory: string;
  includeSharedDirectory?: boolean;
}

/** JSON codec for `.json` team definitions. */
export class JsonTeamDocumentCodec implements TeamDocumentCodec {
  readonly extensions = [".json"];

  /** Parses a JSON team definition. */
  parse<T>(content: string): T {
    return JSON.parse(content) as T;
  }
}

/**
 * YAML codec factory for team definitions.
 *
 * `parseYaml` must come from a real YAML parser package such as `yaml`.
 */
export function createYamlTeamDocumentCodec(
  parseYaml: (content: string) => unknown,
): TeamDocumentCodec {
  return {
    extensions: [".yaml", ".yml"],
    parse<T>(content: string): T {
      // REQUIRES: install and pass a production YAML parser implementation.
      return parseYaml(content) as T;
    },
  };
}

/** Git-backed team repository that resolves team definitions by id and scope with skill validation. */
export class FileSystemTeamRepository implements TeamRepository {
  private readonly cache = new Map<string, { team: TeamDefinition; mtime: number }>();

  /** Creates a team repository rooted in a version-controlled directory tree with skill validation. */
  constructor(
    private readonly config: FileSystemTeamRepositoryConfig,
    private readonly codecs: TeamDocumentCodec[],
    private readonly skillRegistry: SkillRegistry,
  ) {}

  /** Resolves a team definition by id, searching shared and tenant-scoped directories. */
  async get(scope: TenantScope, teamId: string): Promise<TeamDefinition | null> {
    const candidateDirectories = [
      this.config.includeSharedDirectory !== false
        ? resolve(this.config.rootDirectory)
        : null,
      resolve(this.config.rootDirectory, scope.tenantId),
      resolve(this.config.rootDirectory, scope.tenantId, scope.workspaceId),
    ].filter((value): value is string => Boolean(value));

    for (const directory of candidateDirectories) {
      for (const codec of this.codecs) {
        for (const extension of codec.extensions) {
          const filePath = join(directory, `${teamId}${extension}`);
          if (!(await fileExists(filePath))) {
            continue;
          }

          const content = await readFile(filePath, "utf8");
          const definition = codec.parse<TeamDefinition>(content, filePath);
          validateTeamDefinition(definition, filePath);
          await this.validateAgentSkills(scope, definition, filePath);
          return definition;
        }
      }
    }

    return null;
  }

  /**
   * Lists all team definitions available in the repository.
   * Searches for team YAML/JSON files in the configured directories.
   */
  async listTeams(scope: TenantScope): Promise<Array<{ id: string; name: string; path: string }>> {
    const directories = [
      this.config.includeSharedDirectory !== false
        ? resolve(this.config.rootDirectory)
        : null,
      resolve(this.config.rootDirectory, scope.tenantId),
      resolve(this.config.rootDirectory, scope.tenantId, scope.workspaceId),
    ].filter((value): value is string => Boolean(value));

    const teams: Array<{ id: string; name: string; path: string }> = [];
    const seenIds = new Set<string>();

    for (const directory of directories) {
      const dirTeams = await this.listTeamsInDirectory(directory, scope);
      for (const team of dirTeams) {
        if (!seenIds.has(team.id)) {
          seenIds.add(team.id);
          teams.push(team);
        }
      }
    }

    return teams;
  }

  private async listTeamsInDirectory(
    directory: string,
    scope: TenantScope,
  ): Promise<Array<{ id: string; name: string; path: string }>> {
    const teams: Array<{ id: string; name: string; path: string }> = [];

    try {
      const entries = await readdir(directory, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isFile()) continue;

        const filePath = join(directory, entry.name);
        const codec = this.findCodec(filePath);
        if (!codec) continue;

        try {
          const content = await readFile(filePath, "utf8");
          const team = codec.parse<TeamDefinition>(content, filePath);

          // Basic validation before including in list
          if (team.id && team.name) {
            teams.push({
              id: team.id,
              name: team.name,
              path: filePath,
            });
          }
        } catch {
          // Skip invalid team files in listing
          continue;
        }
      }
    } catch {
      // Directory doesn't exist or is inaccessible
    }

    return teams;
  }

  private findCodec(filePath: string): TeamDocumentCodec | undefined {
    const ext = filePath.toLowerCase().split(".").pop();
    if (!ext) return undefined;

    return this.codecs.find((codec) =>
      codec.extensions.some((e) => e.toLowerCase().replace(".", "") === ext),
    );
  }

  private async validateAgentSkills(
    scope: TenantScope,
    team: TeamDefinition,
    source: string,
  ): Promise<void> {
    // Load available skills for error messages
    const availableSkills = await this.skillRegistry.list(scope);
    const availableSkillIds = new Set(availableSkills.map((s) => s.id));
    const availableRoles = new Set(availableSkills.map((s) => s.role));

    const errors: string[] = [];

    for (const agent of team.agents) {
      // Validate agent role matches available skills
      if (!availableRoles.has(agent.role)) {
        const availableRolesList = [...availableRoles].join(", ") || "none";
        errors.push(
          `Agent "${agent.id}" has role "${agent.role}" which does not match any available skill role. ` +
            `Available roles: ${availableRolesList}`,
        );
      }

      // Validate skill bindings
      for (const binding of agent.bindings) {
        if (!availableSkillIds.has(binding.skillId)) {
          const availableList = [...availableSkillIds].join(", ") || "none";
          errors.push(
            `Agent "${agent.id}" references unknown skill "${binding.skillId}". ` +
              `Available skills: ${availableList}. ` +
              `Ensure the skill file exists in the skills directory.`,
          );
        }

        // If skill exists, validate role compatibility
        const skill = availableSkills.find((s) => s.id === binding.skillId);
        if (skill && skill.role !== agent.role) {
          errors.push(
            `Agent "${agent.id}" with role "${agent.role}" ` +
              `references skill "${binding.skillId}" with mismatched role "${skill.role}". ` +
              `Roles must match for proper routing.`,
          );
        }
      }
    }

    if (errors.length > 0) {
      throw new Error(
        `Team validation failed for "${team.id}" (${source}):\n` + errors.map((e) => `  - ${e}`).join("\n"),
      );
    }
  }
}

function validateTeamDefinition(team: TeamDefinition, source: string): void {
  const required: Array<keyof TeamDefinition> = [
    "schemaVersion",
    "id",
    "name",
    "description",
    "entryAgentId",
    "agents",
    "routes",
  ];

  for (const field of required) {
    if (!team[field]) {
      throw new Error(`Team definition at ${source} is missing required field "${field}".`);
    }
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

// TODO:
// - Add directory-level caching with mtime invalidation for large team libraries.
// - Add JSON schema validation for team definitions before runtime load.
// - Add support for signed team bundles in enterprise environments.
