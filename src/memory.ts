// File: src/memory.ts
/**
 * Memory layer implementations backed by injected vector and key-value clients.
 */

import type {
  JsonObject,
  JsonValue,
  MemoryQuery,
  MemoryRecord,
  MemorySnapshot,
  MemoryStore,
  SessionId,
  SessionStateStore,
  SkillDefinition,
  SkillRegistry,
  TenantScope,
} from "./types";

/** Document shape expected by a pluggable vector index client. */
export interface VectorDocument {
  id: string;
  namespace: string;
  content: string;
  metadata: JsonObject;
}

/** Query result returned by a pluggable vector index client. */
export interface VectorQueryMatch {
  id: string;
  content: string;
  score?: number;
  metadata: JsonObject;
}

/** Dependency-injected vector client. */
export interface VectorStoreClient {
  upsert(documents: VectorDocument[]): Promise<void>;
  query(args: {
    namespace: string;
    queryText: string;
    topK: number;
    minScore?: number;
    filter?: JsonObject;
  }): Promise<VectorQueryMatch[]>;
}

/** Dependency-injected key-value client for session state. */
export interface KeyValueStoreClient {
  get(key: string): Promise<JsonObject | null>;
  set(key: string, value: JsonObject): Promise<void>;
}

/** Query arguments for building an agent-ready memory snapshot. */
export interface MemorySnapshotQuery {
  scope: TenantScope;
  sessionId: SessionId;
  queryText: string;
  semanticTopK: number;
  skillTopK?: number;
  minSemanticScore?: number;
  minSkillScore?: number;
}

/** Checkpoint payload written into session state for cross-session continuity. */
export interface SessionCheckpoint {
  summary: string;
  updatedAt: string;
  agentId?: string;
  runId?: string;
  metadata?: JsonObject;
}

/** Persistent write request for semantic or audit-grade memory capture. */
export interface PersistentMemoryWrite {
  scope: TenantScope;
  namespace: MemoryRecord["namespace"];
  id: string;
  text: string;
  attributes: JsonObject;
  createdAt: string;
  expiresAt?: string;
  embeddingRef?: string;
}

/** Coordinates session, semantic, and skill memory retrieval for runtime contexts. */
export class MemorySnapshotBuilder {
  /** Creates a snapshot builder over pluggable session, memory, and skill backends. */
  constructor(
    private readonly sessionStateStore: SessionStateStore,
    private readonly memoryStore: MemoryStore,
    private readonly skillRegistry: SkillRegistry,
  ) {}

  /** Builds a runtime memory snapshot with targeted semantic and skill recall. */
  async build(query: MemorySnapshotQuery): Promise<MemorySnapshot> {
    const sessionStatePromise = this.sessionStateStore.get(query.scope, query.sessionId);
    const semanticMemoryPromise = this.memoryStore.query({
      scope: query.scope,
      namespace: "semantic",
      queryText: query.queryText,
      topK: query.semanticTopK,
      ...(query.minSemanticScore !== undefined ? { minScore: query.minSemanticScore } : {}),
    });
    const learnedSkillsPromise =
      query.skillTopK && query.skillTopK > 0
        ? this.loadRelevantSkills(query)
        : this.skillRegistry.list(query.scope);

    const [sessionState, relevantMemories, learnedSkills] = await Promise.all([
      sessionStatePromise,
      semanticMemoryPromise,
      learnedSkillsPromise,
    ]);

    return {
      sessionState,
      relevantMemories,
      learnedSkills,
    };
  }

  private async loadRelevantSkills(query: MemorySnapshotQuery): Promise<SkillDefinition[]> {
    const matches = await this.memoryStore.query({
      scope: query.scope,
      namespace: "skill",
      queryText: query.queryText,
      topK: query.skillTopK ?? 0,
      ...(query.minSkillScore !== undefined ? { minScore: query.minSkillScore } : {}),
    });

    const skillIds = [
      ...new Set(
        matches
          .map((record) => record.attributes.skillId)
          .filter((value): value is string => typeof value === "string" && value.length > 0),
      ),
    ];
    if (!skillIds.length) {
      return this.skillRegistry.list(query.scope);
    }

    const resolved = await Promise.all(
      skillIds.map(async (skillId) => this.skillRegistry.get(query.scope, skillId)),
    );
    return resolved.filter((skill): skill is SkillDefinition => Boolean(skill));
  }
}

/** Coordinates writes to session state and long-lived semantic memory. */
export class PersistentMemoryCoordinator {
  /** Creates a coordinator that persists both session checkpoints and semantic memory. */
  constructor(
    private readonly sessionStateStore: SessionStateStore,
    private readonly memoryStore: MemoryStore,
  ) {}

  /** Writes a durable semantic or skill memory record. */
  async remember(write: PersistentMemoryWrite): Promise<void> {
    const record: MemoryRecord = {
      id: write.id,
      scope: write.scope,
      namespace: write.namespace,
      text: write.text,
      attributes: pruneUndefined(write.attributes),
      createdAt: write.createdAt,
      ...(write.expiresAt ? { expiresAt: write.expiresAt } : {}),
      ...(write.embeddingRef ? { embeddingRef: write.embeddingRef } : {}),
    };
    await this.memoryStore.write([record]);
  }

  /** Updates session state with the latest checkpoint for cross-session continuity. */
  async checkpoint(
    scope: TenantScope,
    sessionId: SessionId,
    checkpoint: SessionCheckpoint,
  ): Promise<void> {
    await this.sessionStateStore.patch(scope, sessionId, {
      lastCheckpoint: {
        summary: checkpoint.summary,
        updatedAt: checkpoint.updatedAt,
        agentId: checkpoint.agentId,
        runId: checkpoint.runId,
        metadata: checkpoint.metadata,
      },
    });
  }
}

/** Production memory store using namespace isolation over a vector index. */
export class ScopedMemoryStore implements MemoryStore {
  /** Creates a memory store that namespaces records per tenant/workspace/project. */
  constructor(private readonly client: VectorStoreClient) {}

  /** Writes memory records into the configured vector backend. */
  async write(records: MemoryRecord[]): Promise<void> {
    if (!records.length) {
      return;
    }

    const documents = records.map((record) => ({
      id: record.id,
      namespace: toMemoryNamespace(record.scope, record.namespace),
      content: record.text ?? serializeAttributes(record.attributes),
      metadata: {
        ...record.attributes,
        createdAt: record.createdAt,
        expiresAt: record.expiresAt,
        embeddingRef: record.embeddingRef,
        namespace: record.namespace,
        tenantId: record.scope.tenantId,
        workspaceId: record.scope.workspaceId,
        teamId: record.scope.teamId,
        projectId: record.scope.projectId,
        environment: record.scope.environment,
      },
    }));

    await this.client.upsert(documents);
  }

  /** Queries semantic memory from the configured vector backend. */
  async query(query: MemoryQuery): Promise<MemoryRecord[]> {
    const matches = await this.client.query({
      namespace: toMemoryNamespace(query.scope, query.namespace),
      queryText: query.queryText,
      topK: query.topK,
      ...(query.minScore !== undefined ? { minScore: query.minScore } : {}),
      ...(query.filters ? { filter: query.filters } : {}),
    });

    return matches.map((match) => {
      const expiresAt = optionalString(match.metadata.expiresAt);
      const embeddingRef = optionalString(match.metadata.embeddingRef);

      const record: MemoryRecord = {
        id: match.id,
        scope: query.scope,
        namespace: query.namespace,
        text: match.content,
        attributes: pruneUndefined(match.metadata),
        createdAt: asString(match.metadata.createdAt),
        ...(expiresAt ? { expiresAt } : {}),
        ...(embeddingRef ? { embeddingRef } : {}),
      };

      return record;
    });
  }
}

/** Production session state store using a key-value backend such as Redis. */
export class ScopedSessionStateStore implements SessionStateStore {
  /** Creates a session store that isolates state by tenant/workspace/session. */
  constructor(private readonly client: KeyValueStoreClient) {}

  /** Reads current session state or returns an empty object when absent. */
  async get(scope: TenantScope, sessionId: SessionId): Promise<JsonObject> {
    return (await this.client.get(toSessionKey(scope, sessionId))) ?? {};
  }

  /** Replaces the full session state for a session key. */
  async set(scope: TenantScope, sessionId: SessionId, state: JsonObject): Promise<void> {
    await this.client.set(toSessionKey(scope, sessionId), pruneUndefined(state));
  }

  /** Merges a partial state payload into the existing session state. */
  async patch(scope: TenantScope, sessionId: SessionId, partial: JsonObject): Promise<void> {
    const current = await this.get(scope, sessionId);
    await this.client.set(
      toSessionKey(scope, sessionId),
      deepMergeJsonObjects(current, partial),
    );
  }
}

/** Builds a stable namespace name for vector-backed memory isolation. */
export function toMemoryNamespace(
  scope: TenantScope,
  namespace: MemoryRecord["namespace"],
): string {
  return [
    "memory",
    scope.tenantId,
    scope.workspaceId,
    scope.projectId ?? "default-project",
    namespace,
  ].join(":");
}

/** Builds a stable key for session state in a key-value backend. */
export function toSessionKey(scope: TenantScope, sessionId: SessionId): string {
  return [
    "session",
    scope.tenantId,
    scope.workspaceId,
    scope.projectId ?? "default-project",
    sessionId,
  ].join(":");
}

function deepMergeJsonObjects(base: JsonObject, patch: JsonObject): JsonObject {
  const merged: JsonObject = { ...base };

  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      continue;
    }
    const current = merged[key];
    if (isJsonObject(current) && isJsonObject(value)) {
      merged[key] = deepMergeJsonObjects(current, value);
      continue;
    }
    merged[key] = value;
  }

  return pruneUndefined(merged);
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function pruneUndefined(value: JsonObject): JsonObject {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  );
}

function serializeAttributes(attributes: JsonObject): string {
  return JSON.stringify(pruneUndefined(attributes));
}

function asString(value: JsonValue | undefined): string {
  return typeof value === "string" ? value : new Date(0).toISOString();
}

function optionalString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

// TODO:
// - Add bulk delete and TTL support once the vector and KV backend contracts require it.
// - Add compression hooks for large session payloads before writing to Redis-like stores.
// - Add score-aware reranking for hybrid lexical + semantic memory retrieval.
// - Add snapshot caching for hot sessions with high fan-out orchestration.
// - REQUIRES: concrete `VectorStoreClient` and `KeyValueStoreClient` adapters for your chosen services.
