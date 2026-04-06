// File: src/skills.ts
/**
 * Skill registry implementations for Git-backed files and learned-skill storage.
 */

import { readdir, readFile } from "node:fs/promises";
import { join, resolve, extname } from "node:path";
import type {
  MemoryRecord,
  MemoryStore,
  SkillDefinition,
  SkillId,
  SkillRegistry,
  TenantScope,
} from "./types";

/** Simple document codec for parsing serialized skill files. */
export interface SkillDocumentCodec {
  readonly extensions: string[];
  parse<T>(content: string, filePath: string): T;
}

/** Backend used to persist learned skills outside the Git-backed library. */
export interface SkillPersistenceStore {
  list(prefix: string): Promise<SkillDefinition[]>;
  get(key: string): Promise<SkillDefinition | null>;
  put(key: string, value: SkillDefinition): Promise<void>;
}

/** Filesystem source configuration for workspace-scoped skill libraries. */
export interface FileSystemSkillSourceConfig {
  rootDirectory: string;
  includeSharedLibrary?: boolean;
}

/** Indexes canonical skill metadata into semantic memory for fast retrieval. */
export class SkillMemoryIndexer {
  /** Creates an indexer that writes skill search documents into memory storage. */
  constructor(private readonly memoryStore: MemoryStore) {}

  /** Indexes one skill definition for semantic recall and routing-time lookup. */
  async index(scope: TenantScope, skill: SkillDefinition): Promise<void> {
    await this.memoryStore.write([toSkillMemoryRecord(scope, skill)]);
  }

  /** Indexes many skills in one batched memory-store call. */
  async indexMany(scope: TenantScope, skills: SkillDefinition[]): Promise<void> {
    if (!skills.length) {
      return;
    }
    await this.memoryStore.write(skills.map((skill) => toSkillMemoryRecord(scope, skill)));
  }
}

/** JSON codec for `.json` skill documents. */
export class JsonSkillDocumentCodec implements SkillDocumentCodec {
  readonly extensions = [".json"];

  /** Parses a JSON skill document. */
  parse<T>(content: string): T {
    return JSON.parse(content) as T;
  }
}

/**
 * YAML codec factory.
 *
 * `parseYaml` must come from a real YAML parser package such as `yaml`.
 */
export function createYamlSkillDocumentCodec(parseYaml: (content: string) => unknown): SkillDocumentCodec {
  return {
    extensions: [".yaml", ".yml"],
    parse<T>(content: string): T {
      // REQUIRES: install and pass a production YAML parser implementation.
      return parseYaml(content) as T;
    },
  };
}

/** Loads versioned skill definitions from a workspace directory at runtime. */
export class FileSystemSkillSource {
  /** Creates a file-backed skill source rooted in a Git-managed directory. */
  constructor(
    private readonly config: FileSystemSkillSourceConfig,
    private readonly codecs: SkillDocumentCodec[],
  ) {}

  /** Loads all matching JSON/YAML skill files visible to the provided scope. */
  async load(scope: TenantScope): Promise<SkillDefinition[]> {
    const directories = [
      this.config.includeSharedLibrary !== false
        ? join(this.config.rootDirectory, "shared")
        : null,
      join(this.config.rootDirectory, scope.tenantId),
      join(this.config.rootDirectory, scope.tenantId, scope.workspaceId),
    ].filter((value): value is string => Boolean(value));

    const filePaths = new Set<string>();
    for (const directory of directories) {
      for (const filePath of await walkFiles(directory)) {
        filePaths.add(filePath);
      }
    }

    const definitions = await Promise.all(
      [...filePaths].map(async (filePath) => this.readSkillFile(filePath)),
    );
    return definitions.filter((item): item is SkillDefinition => Boolean(item));
  }

  private async readSkillFile(filePath: string): Promise<SkillDefinition | null> {
    const codec = this.resolveCodec(filePath);
    if (!codec) {
      return null;
    }

    const content = await readFile(filePath, "utf8");
    const skill = codec.parse<SkillDefinition>(content, filePath);
    validateSkillDefinition(skill, filePath);
    return skill;
  }

  private resolveCodec(filePath: string): SkillDocumentCodec | undefined {
    const extension = extname(filePath).toLowerCase();
    return this.codecs.find((codec) => codec.extensions.includes(extension));
  }
}

/** Composite registry that merges file-backed skills with learned persisted skills. */
export class CompositeSkillRegistry implements SkillRegistry {
  /** Creates a registry that reads from disk and writes learned skills to storage. */
  constructor(
    private readonly source: FileSystemSkillSource,
    private readonly learnedStore: SkillPersistenceStore,
    private readonly skillMemoryIndexer?: SkillMemoryIndexer,
  ) {}

  /** Lists visible skills, letting learned skills override file-backed definitions by id. */
  async list(scope: TenantScope): Promise<SkillDefinition[]> {
    const [fileSkills, learnedSkills] = await Promise.all([
      this.source.load(scope),
      this.learnedStore.list(toSkillScopePrefix(scope)),
    ]);

    const merged = new Map<SkillId, SkillDefinition>();
    for (const skill of fileSkills) {
      merged.set(skill.id, skill);
    }
    for (const skill of learnedSkills) {
      merged.set(skill.id, skill);
    }
    return [...merged.values()];
  }

  /** Gets one skill from learned storage first, then falls back to file-backed definitions. */
  async get(scope: TenantScope, skillId: SkillId): Promise<SkillDefinition | null> {
    const learned = await this.learnedStore.get(toLearnedSkillKey(scope, skillId));
    if (learned) {
      return learned;
    }

    const fileSkills = await this.source.load(scope);
    return fileSkills.find((skill) => skill.id === skillId) ?? null;
  }

  /** Persists a learned skill definition for the current tenant/workspace scope. */
  async put(scope: TenantScope, skill: SkillDefinition): Promise<void> {
    validateSkillDefinition(skill, skill.id);
    await this.learnedStore.put(toLearnedSkillKey(scope, skill.id), skill);
    if (this.skillMemoryIndexer) {
      await this.skillMemoryIndexer.index(scope, skill);
    }
  }
}

/** Stable key prefix used for listing learned skills per isolated workspace. */
export function toSkillScopePrefix(scope: TenantScope): string {
  return [
    "skills",
    scope.tenantId,
    scope.workspaceId,
    scope.projectId ?? "default-project",
  ].join(":");
}

/** Stable key used for one learned skill in the persistence backend. */
export function toLearnedSkillKey(scope: TenantScope, skillId: SkillId): string {
  return `${toSkillScopePrefix(scope)}:${skillId}`;
}

/** Converts a skill definition into a vector-searchable memory record. */
export function toSkillMemoryRecord(scope: TenantScope, skill: SkillDefinition): MemoryRecord {
  return {
    id: `skillmem:${scope.tenantId}:${scope.workspaceId}:${skill.id}:${skill.version}`,
    scope,
    namespace: "skill",
    text: buildSkillSearchText(skill),
    attributes: {
      skillId: skill.id,
      name: skill.name,
      role: skill.role,
      version: skill.version,
      tags: skill.tags,
      capabilities: skill.capabilities,
      preferredRuntimeTargets: skill.preferredRuntimeTargets,
      routingHints: skill.routingHints,
    },
    createdAt: new Date().toISOString(),
  };
}

function validateSkillDefinition(skill: SkillDefinition, source: string): void {
  const required: Array<keyof SkillDefinition> = [
    "schemaVersion",
    "id",
    "name",
    "version",
    "description",
    "tags",
    "role",
    "inputSchema",
    "outputSchema",
  ];

  for (const key of required) {
    if (!skill[key]) {
      throw new Error(`Skill document at ${source} is missing required field "${key}".`);
    }
  }
}

function buildSkillSearchText(skill: SkillDefinition): string {
  const parts = [
    skill.name,
    skill.description,
    skill.role,
    skill.tags.join(" "),
    skill.capabilities?.join(" ") ?? "",
    skill.routingHints?.join(" ") ?? "",
  ].filter((value) => value.length > 0);

  return parts.join("\n");
}

async function walkFiles(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(resolve(directory), { withFileTypes: true });
    const nested = await Promise.all(
      entries.map(async (entry) => {
        const entryPath = join(directory, entry.name);
        return entry.isDirectory() ? walkFiles(entryPath) : [entryPath];
      }),
    );
    return nested.flat();
  } catch (error) {
    if (isNotFoundError(error)) {
      return [];
    }
    throw error;
  }
}

function isNotFoundError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT",
  );
}

/** Schema type for skill document validation. Mirrors SkillDefinition structure for runtime validation. */
export interface SkillSchema {
  schemaVersion: string;
  id: string;
  name: string;
  version: string;
  description: string;
  tags: string[];
  role: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  capabilities?: string[];
  preferredRuntimeTargets?: string[];
  routingHints?: string[];
  promptRef?: string;
  examples?: Record<string, unknown>[];
  securityNotes?: string[];
  metadata?: Record<string, unknown>;
}

/** Required fields for a valid skill document. */
const SKILL_REQUIRED_FIELDS: Array<keyof SkillSchema> = [
  "schemaVersion",
  "id",
  "name",
  "version",
  "description",
  "tags",
  "role",
  "inputSchema",
  "outputSchema",
];

/**
 * FileSystemSkillRegistry loads skills from a specific directory on the filesystem.
 * Implements SkillRegistry with YAML/JSON support and strict validation.
 * Throws descriptive errors if referenced skills are missing.
 */
export class FileSystemSkillRegistry implements SkillRegistry {
  private readonly codec: SkillDocumentCodec;
  private skillsCache: Map<string, SkillDefinition> | null = null;
  private lastLoadTime = 0;

  /**
   * Creates a file-backed skill registry rooted in a specific directory.
   * @param config.rootDirectory - Directory to load skills from (e.g., "./skills/dev")
   * @param config.parseYaml - YAML parser function (e.g., from `yaml` package)
   * @param config.cacheTtlMs - Cache time-to-live in milliseconds (default: 5000)
   */
  constructor(
    private readonly config: {
      rootDirectory: string;
      parseYaml: (content: string) => unknown;
      cacheTtlMs?: number;
    }
  ) {
    this.codec = createYamlSkillDocumentCodec(config.parseYaml);
  }

  /** Lists all skills available in the configured directory. */
  async list(scope: TenantScope): Promise<SkillDefinition[]> {
    await this.ensureLoaded(scope);
    return [...(this.skillsCache?.values() ?? [])];
  }

  /**
   * Gets a specific skill by ID.
   * Throws a descriptive error if the skill is not found.
   */
  async get(scope: TenantScope, skillId: SkillId): Promise<SkillDefinition | null> {
    await this.ensureLoaded(scope);
    
    const skill = this.skillsCache?.get(skillId);
    if (!skill) {
      const available = [...(this.skillsCache?.keys() ?? [])].join(", ") || "none";
      throw new Error(
        `Skill "${skillId}" not found in ${this.config.rootDirectory}. ` +
        `Available skills: ${available}. ` +
        `Ensure the skill file exists (e.g., ${this.config.rootDirectory}/${skillId}.yaml)`
      );
    }
    return skill;
  }

  /**
   * Put operation is not supported for read-only filesystem registry.
   * Use CompositeSkillRegistry if you need to persist learned skills.
   */
  async put(_scope: TenantScope, _skill: SkillDefinition): Promise<void> {
    throw new Error(
      "FileSystemSkillRegistry is read-only. " +
      "Use CompositeSkillRegistry with a SkillPersistenceStore to save learned skills."
    );
  }

  /** Clears the in-memory cache to force reload on next access. */
  clearCache(): void {
    this.skillsCache = null;
    this.lastLoadTime = 0;
  }

  /** Validates a skill against the schema without loading it into the registry. */
  validateSkill(skill: unknown, source: string): asserts skill is SkillDefinition {
    validateSkillDefinition(skill as SkillDefinition, source);
  }

  private async ensureLoaded(scope: TenantScope): Promise<void> {
    const ttl = this.config.cacheTtlMs ?? 5000;
    const now = Date.now();
    
    if (this.skillsCache && now - this.lastLoadTime < ttl) {
      return;
    }

    await this.loadAll(scope);
  }

  private async loadAll(scope: TenantScope): Promise<void> {
    const skills = new Map<string, SkillDefinition>();
    const directory = this.config.rootDirectory;

    try {
      const filePaths = await walkFiles(directory);
      
      for (const filePath of filePaths) {
        if (!this.isSupportedFile(filePath)) continue;
        
        try {
          const skill = await this.readSkillFile(filePath);
          if (skill) {
            skills.set(skill.id, skill);
          }
        } catch (error) {
          console.error(`Failed to load skill from ${filePath}:`, error);
        }
      }
    } catch (error) {
      if (isNotFoundError(error)) {
        throw new Error(
          `Skill directory not found: ${directory}. ` +
          `Create the directory and add skill YAML files.`
        );
      }
      throw error;
    }

    this.skillsCache = skills;
    this.lastLoadTime = Date.now();
  }

  private isSupportedFile(filePath: string): boolean {
    const ext = extname(filePath).toLowerCase();
    return this.codec.extensions.includes(ext) || ext === ".json";
  }

  private async readSkillFile(filePath: string): Promise<SkillDefinition | null> {
    const content = await readFile(filePath, "utf8");
    const parsed = this.codec.parse<SkillDefinition>(content, filePath);
    validateSkillDefinition(parsed, filePath);
    return parsed;
  }
}

// TODO:
// - Add schema validation against `inputSchema` and `outputSchema` before registry writes.
// - Add hot-reload caching with mtime invalidation for large skill libraries.
// - Add signature verification for enterprise-controlled skill bundles.
// - Add background reindexing for file-backed skills when the shared library changes.
// - REQUIRES: a concrete `SkillPersistenceStore` plus a YAML parser if `.yaml` skills are enabled.
