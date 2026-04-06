// File: src/teams.ts
/**
 * Team definition repositories and codecs for low-code YAML/JSON team files.
 */

import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { TeamDefinition, TenantScope } from "./types";
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

/** Git-backed team repository that resolves team definitions by id and scope. */
export class FileSystemTeamRepository implements TeamRepository {
  /** Creates a team repository rooted in a version-controlled directory tree. */
  constructor(
    private readonly config: FileSystemTeamRepositoryConfig,
    private readonly codecs: TeamDocumentCodec[],
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
          return definition;
        }
      }
    }

    return null;
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
