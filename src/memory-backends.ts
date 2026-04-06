// File: src/memory-backends.ts
/**
 * Concrete memory backend implementations for Redis (KV) and Chroma (Vector).
 *
 * These implement the pluggable client interfaces defined in memory.ts
 * using the official SDKs. They handle authentication, error mapping,
 * and provide real connectivity for session state and semantic memory.
 *
 * @path src/memory-backends.ts
 * @version 0.1.0
 */

import type {
  VectorDocument,
  VectorQueryMatch,
  VectorStoreClient,
  KeyValueStoreClient,
} from "./memory";
import type { JsonObject } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// REDIS (KV) CLIENT
// ─────────────────────────────────────────────────────────────────────────────

/** Configuration for the Redis KV client. */
export interface RedisClientConfig {
  url?: string | undefined;
  host?: string | undefined;
  port?: number | undefined;
  password?: string | undefined;
  username?: string | undefined;
  db?: number | undefined;
  tls?: boolean | undefined;
  connectTimeout?: number | undefined;
  commandTimeout?: number | undefined;
  retryMaxDelay?: number | undefined;
  maxRetriesPerRequest?: number | undefined;
  enableOfflineQueue?: boolean | undefined;
  enableReadyCheck?: boolean | undefined;
}

/** Redis client interface (minimal subset for our use case). */
interface RedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<string | null>;
  ping(): Promise<string>;
  disconnect(): Promise<void>;
}

/** Loads the ioredis module dynamically to avoid hard dependency. */
async function loadRedis(): Promise<unknown> {
  try {
    return await import("ioredis");
  } catch (error) {
    throw new Error(
      `Failed to load ioredis. Please install it: npm install ioredis\n${error}`
    );
  }
}

/**
 * Concrete Redis client implementing the KeyValueStoreClient interface.
 *
 * REQUIRES: ioredis package installed.
 * REQUIRES: REDIS_URL environment variable or explicit config.
 */
export class RedisKVClient implements KeyValueStoreClient {
  private client: RedisClient | null = null;
  private connecting: Promise<void> | null = null;

  constructor(private readonly config: RedisClientConfig) {}

  public async getRawClient(): Promise<any> {
    return this.ensureConnected();
  }

  /** Lazily initializes the Redis connection. */
  private async ensureConnected(): Promise<RedisClient> {
    if (this.client) {
      return this.client;
    }

    if (this.connecting) {
      await this.connecting;
      if (this.client) return this.client;
    }

    this.connecting = this.connect();
    await this.connecting;
    this.connecting = null;

    if (!this.client) {
      throw new Error("Redis connection failed");
    }

    return this.client;
  }

  private async connect(): Promise<void> {
    const Redis = await loadRedis();

    const client = new (Redis as { default: new (config: Record<string, unknown>) => RedisClient }).default({
      host: this.config.host,
      port: this.config.port,
      password: this.config.password,
      username: this.config.username,
      db: this.config.db,
      tls: this.config.tls,
      connectTimeout: this.config.connectTimeout ?? 10000,
      commandTimeout: this.config.commandTimeout ?? 5000,
      retryMaxDelay: this.config.retryMaxDelay ?? 5000,
      maxRetriesPerRequest: this.config.maxRetriesPerRequest ?? 3,
      enableOfflineQueue: this.config.enableOfflineQueue ?? true,
      enableReadyCheck: this.config.enableReadyCheck ?? true,
      lazyConnect: true,
      showFriendlyErrorStack: process.env.NODE_ENV !== "production",
    });

    // Test connection
    await client.ping();

    this.client = client as RedisClient;
  }

  /**
   * Retrieves a JSON value from Redis by key.
   * Returns null if the key doesn't exist.
   */
  async get(key: string): Promise<JsonObject | null> {
    const client = await this.ensureConnected();

    try {
      const value = await client.get(key);

      if (value === null) {
        return null;
      }

      return parseJsonSafe(value);
    } catch (error) {
      throw mapRedisError(error, `Failed to get key: ${key}`);
    }
  }

  /**
   * Stores a JSON value in Redis by key.
   */
  async set(key: string, value: JsonObject): Promise<void> {
    const client = await this.ensureConnected();

    try {
      const serialized = JSON.stringify(value);
      await client.set(key, serialized);
    } catch (error) {
      throw mapRedisError(error, `Failed to set key: ${key}`);
    }
  }

  /**
   * Closes the Redis connection gracefully.
   */
  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.disconnect();
      this.client = null;
    }
  }
}

/** Parses JSON safely with fallback to null on error. */
function parseJsonSafe(value: string): JsonObject | null {
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as JsonObject;
    }
    return { value: parsed };
  } catch {
    return null;
  }
}

/** Maps Redis errors to framework error types. */
function mapRedisError(error: unknown, context: string): Error {
  const message = error instanceof Error ? error.message : String(error);

  // ioredis specific error patterns
  if (message.includes("ECONNREFUSED")) {
    return new Error(`${context}: Redis connection refused. Check host/port. ${message}`);
  }
  if (message.includes("ETIMEDOUT") || message.includes("timeout")) {
    return new Error(`${context}: Redis operation timed out. ${message}`);
  }
  if (message.includes("WRONGPASS") || message.includes("NOAUTH")) {
    return new Error(`${context}: Redis authentication failed. ${message}`);
  }
  if (message.includes("READONLY")) {
    return new Error(`${context}: Redis is in read-only mode. ${message}`);
  }

  return new Error(`${context}: ${message}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// CHROMA (VECTOR) CLIENT
// ─────────────────────────────────────────────────────────────────────────────

/** Configuration for the Chroma vector client. */
export interface ChromaClientConfig {
  url?: string | undefined;
  tenant?: string | undefined;
  database?: string | undefined;
  apiKey?: string | undefined;
  authToken?: string | undefined;
  timeout?: number | undefined;
  maxRetries?: number | undefined;
}

/** Chroma collection interface (minimal subset for our use case). */
interface ChromaCollection {
  upsert(params: {
    ids: string[];
    documents: string[];
    metadatas: Record<string, unknown>[];
  }): Promise<void>;
  query(params: {
    queryTexts: string[];
    nResults: number;
    where?: Record<string, unknown>;
  }): Promise<{
    ids: string[][];
    documents: string[][];
    metadatas: Record<string, unknown>[][];
    distances: number[][];
  }>;
}

/** Loads the chromadb module dynamically to avoid hard dependency. */
async function loadChroma(): Promise<unknown> {
  try {
    return await import("chromadb");
  } catch (error) {
    throw new Error(
      `Failed to load chromadb. Please install it: npm install chromadb\n${error}`
    );
  }
}

/**
 * Concrete Chroma client implementing the VectorStoreClient interface.
 *
 * REQUIRES: chromadb package installed.
 * REQUIRES: CHROMA_URL environment variable or explicit config.
 */
export class ChromaVectorClient implements VectorStoreClient {
  private client: { getOrCreateCollection(params: { name: string }): Promise<ChromaCollection> } | null = null;
  private collections: Map<string, ChromaCollection> = new Map();
  private connecting: Promise<void> | null = null;

  constructor(private readonly config: ChromaClientConfig) {}

  /** Lazily initializes the Chroma connection. */
  private async ensureConnected(): Promise<{
    getOrCreateCollection(params: { name: string }): Promise<ChromaCollection>;
  }> {
    if (this.client) {
      return this.client;
    }

    if (this.connecting) {
      await this.connecting;
      if (this.client) return this.client;
    }

    this.connecting = this.connect();
    await this.connecting;
    this.connecting = null;

    if (!this.client) {
      throw new Error("Chroma connection failed");
    }

    return this.client;
  }

  private async connect(): Promise<void> {
    const chromadb = await loadChroma();

    const authConfig: { provider?: string; credentials?: string } = {};
    if (this.config.apiKey) {
      authConfig.provider = "token";
      authConfig.credentials = this.config.apiKey;
    }

    const client = new (chromadb as { ChromaClient: new (config: Record<string, unknown>) => { listCollections(): Promise<unknown[]>; getOrCreateCollection(params: { name: string }): Promise<ChromaCollection> } }).ChromaClient({
      path: this.config.url,
      tenant: this.config.tenant,
      database: this.config.database,
      auth: authConfig.provider ? authConfig : undefined,
    });

    // Test connection by listing collections
    await client.listCollections();

    this.client = client as unknown as {
      getOrCreateCollection(params: { name: string }): Promise<ChromaCollection>;
    };
  }

  /** Gets or creates a collection for the given namespace. */
  private async getCollection(namespace: string): Promise<ChromaCollection> {
    const cached = this.collections.get(namespace);
    if (cached) {
      return cached;
    }

    const client = await this.ensureConnected();

    // Sanitize namespace for Chroma collection name (alphanumeric, hyphens, underscores only)
    const sanitizedNamespace = namespace.replace(/[^a-zA-Z0-9_-]/g, "_");
    const collectionName = `memory_${sanitizedNamespace}`;

    try {
      const collection = await client.getOrCreateCollection({ name: collectionName });
      this.collections.set(namespace, collection);
      return collection;
    } catch (error) {
      throw mapChromaError(error, `Failed to get collection: ${collectionName}`);
    }
  }

  /**
   * Upserts documents into the Chroma vector index.
   * Each document is stored in a collection named after its namespace.
   */
  async upsert(documents: VectorDocument[]): Promise<void> {
    if (!documents.length) {
      return;
    }

    // Group documents by namespace
    const byNamespace = new Map<string, VectorDocument[]>();
    for (const doc of documents) {
      const group = byNamespace.get(doc.namespace) ?? [];
      group.push(doc);
      byNamespace.set(doc.namespace, group);
    }

    // Upsert per namespace
    for (const [namespace, docs] of byNamespace) {
      const collection = await this.getCollection(namespace);

      try {
        await collection.upsert({
          ids: docs.map((d) => d.id),
          documents: docs.map((d) => d.content),
          metadatas: docs.map((d) => ({
            ...d.metadata,
            _originalId: d.id,
            _namespace: d.namespace,
          })),
        });
      } catch (error) {
        throw mapChromaError(error, `Failed to upsert ${docs.length} documents to ${namespace}`);
      }
    }
  }

  /**
   * Queries the Chroma vector index for similar documents.
   */
  async query(args: {
    namespace: string;
    queryText: string;
    topK: number;
    minScore?: number;
    filter?: JsonObject;
  }): Promise<VectorQueryMatch[]> {
    const collection = await this.getCollection(args.namespace);

    try {
      const results = await collection.query({
        queryTexts: [args.queryText],
        nResults: args.topK,
        ...(args.filter ? { where: args.filter as Record<string, unknown> } : {}),
      });

      const matches: VectorQueryMatch[] = [];

      // Chroma returns arrays per query, we only have one query
      const ids = results.ids[0] ?? [];
      const documents = results.documents[0] ?? [];
      const metadatas = results.metadatas[0] ?? [];
      const distances = results.distances[0] ?? [];

      for (let i = 0; i < ids.length; i++) {
        const score = distances[i];

        // Chroma returns L2 distance by default (lower is better)
        // Convert to similarity score (0-1) if needed, but for now pass through
        // User can configure minScore accordingly
        if (args.minScore !== undefined && score !== undefined && score > args.minScore) {
          continue;
        }

        const match: VectorQueryMatch = {
          id: ids[i] ?? "",
          content: documents[i] ?? "",
          metadata: (metadatas[i] as JsonObject) ?? {},
        };
        if (score !== undefined) {
          match.score = score;
        }
        matches.push(match);
      }

      return matches;
    } catch (error) {
      throw mapChromaError(error, `Failed to query namespace: ${args.namespace}`);
    }
  }

  /**
   * Clears the collection cache. Useful for testing or when collections are modified externally.
   */
  clearCache(): void {
    this.collections.clear();
  }
}

/** Maps Chroma errors to framework error types. */
function mapChromaError(error: unknown, context: string): Error {
  const message = error instanceof Error ? error.message : String(error);

  if (message.includes("ECONNREFUSED") || message.includes("fetch failed")) {
    return new Error(`${context}: Chroma connection failed. Check URL and server status. ${message}`);
  }
  if (message.includes("404") || message.includes("NotFound")) {
    return new Error(`${context}: Chroma collection or resource not found. ${message}`);
  }
  if (message.includes("401") || message.includes("Unauthorized")) {
    return new Error(`${context}: Chroma authentication failed. Check API key. ${message}`);
  }
  if (message.includes("429") || message.includes("Too Many Requests")) {
    return new Error(`${context}: Chroma rate limit exceeded. ${message}`);
  }

  return new Error(`${context}: ${message}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// FACTORY FUNCTIONS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a configured Redis KV client from environment variables.
 *
 * REQUIRES: process.env.REDIS_URL or process.env.REDIS_HOST
 */
export function createRedisClientFromEnv(): RedisKVClient {
  const url = process.env.REDIS_URL;

  if (url) {
    return new RedisKVClient({ url });
  }

  const host = process.env.REDIS_HOST;
  const port = process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT, 10) : undefined;
  const password = process.env.REDIS_PASSWORD;
  const username = process.env.REDIS_USERNAME;
  const db = process.env.REDIS_DB ? parseInt(process.env.REDIS_DB, 10) : undefined;
  const tls = process.env.REDIS_TLS === "true";

  if (!host) {
    throw new Error(
      "Redis configuration missing. Set REDIS_URL or REDIS_HOST environment variable."
    );
  }

  return new RedisKVClient({
    host,
    port: port ?? 6379,
    password,
    username,
    db: db ?? 0,
    tls,
    connectTimeout: process.env.REDIS_CONNECT_TIMEOUT_MS
      ? parseInt(process.env.REDIS_CONNECT_TIMEOUT_MS, 10)
      : undefined,
    commandTimeout: process.env.REDIS_COMMAND_TIMEOUT_MS
      ? parseInt(process.env.REDIS_COMMAND_TIMEOUT_MS, 10)
      : undefined,
  });
}

/**
 * Creates a configured Chroma vector client from environment variables.
 *
 * REQUIRES: process.env.CHROMA_URL
 */
export function createChromaClientFromEnv(): ChromaVectorClient {
  const url = process.env.CHROMA_URL;

  if (!url) {
    throw new Error(
      "CHROMA_URL environment variable is required for Chroma vector client"
    );
  }

  return new ChromaVectorClient({
    url,
    tenant: process.env.CHROMA_TENANT,
    database: process.env.CHROMA_DATABASE,
    apiKey: process.env.CHROMA_API_KEY,
    authToken: process.env.CHROMA_AUTH_TOKEN,
    timeout: process.env.CHROMA_TIMEOUT_MS
      ? parseInt(process.env.CHROMA_TIMEOUT_MS, 10)
      : undefined,
    maxRetries: process.env.CHROMA_MAX_RETRIES
      ? parseInt(process.env.CHROMA_MAX_RETRIES, 10)
      : undefined,
  });
}

// TODO:
// - Add batch size limits and chunking for large upserts
// - Add TTL support for Redis keys via EXPIRE commands
// - Add connection pooling metrics and health checks
// - Add circuit breaker patterns for both backends
// - Add request/response logging for debugging
// - Consider adding Redis Cluster mode support for production scaling
