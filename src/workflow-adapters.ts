// File: src/workflow-adapters.ts
/**
 * Backend-facing workflow adapter implementations for Redis-style storage and
 * BullMQ-style queue execution without leaking vendor packages into the core.
 */

import type {
  CircuitBreakerState,
  CircuitBreakerStore,
  DeadLetterEntry,
  DeadLetterStore,
  IdempotencyStore,
  WorkflowTask,
  WorkflowTaskLease,
  WorkflowTaskQueue,
  WorkflowTaskRetry,
} from "./workflow-engine";

/** Minimal Redis-like client contract required by the workflow adapters. */
export interface RedisLikeClient {
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    options?: {
      ttlMs?: number;
      onlyIfAbsent?: boolean;
    },
  ): Promise<boolean>;
  del(key: string): Promise<void>;
  rpush(key: string, value: string): Promise<void>;
}

/** Minimal BullMQ-style job representation. */
export interface BullLikeJob<TPayload> {
  id: string;
  data: TPayload;
  attemptsMade: number;
  timestamp: number;
  processedOn?: number;
}

/** Minimal BullMQ-style queue contract used by the workflow task adapter. */
export interface BullLikeQueueClient<TPayload> {
  add(
    name: string,
    payload: TPayload,
    options?: {
      jobId?: string;
      delayMs?: number;
      attempts?: number;
    },
  ): Promise<void>;
  reserve(workerId: string, maxJobs: number): Promise<Array<BullLikeJob<TPayload>>>;
  complete(jobId: string): Promise<void>;
  retry(
    jobId: string,
    payload: TPayload,
    options: {
      delayMs: number;
    },
  ): Promise<void>;
}

/** Keyspace configuration for Redis-backed workflow stores. */
export interface WorkflowRedisKeyConfig {
  idempotencyPrefix: string;
  circuitPrefix: string;
  deadLetterKey: string;
}

/** Configuration for Redis-backed idempotency markers. */
export interface RedisIdempotencyStoreConfig {
  ttlMs: number;
  keys?: Partial<WorkflowRedisKeyConfig>;
}

/** Configuration for Redis-backed circuit breaker state. */
export interface RedisCircuitBreakerStoreConfig {
  ttlMs: number;
  keys?: Partial<WorkflowRedisKeyConfig>;
}

/** Configuration for Redis-backed dead-letter storage. */
export interface RedisDeadLetterStoreConfig {
  maxEntryAgeMs?: number;
  keys?: Partial<WorkflowRedisKeyConfig>;
}

const DEFAULT_KEYS: WorkflowRedisKeyConfig = {
  idempotencyPrefix: "workflow:idempotency",
  circuitPrefix: "workflow:circuit",
  deadLetterKey: "workflow:dead-letter",
};

/** BullMQ-style queue adapter implementing the core `WorkflowTaskQueue` contract. */
export class BullQueueWorkflowTaskQueue implements WorkflowTaskQueue {
  /** Creates a queue adapter around a BullMQ-style client. */
  constructor(private readonly client: BullLikeQueueClient<WorkflowTask>) {}

  /** Adds one workflow task to the queue. */
  async enqueue(task: WorkflowTask): Promise<void> {
    await this.client.add(task.kind, task, {
      jobId: task.id,
      delayMs: computeDelayMs(task.availableAt),
      attempts: task.maxAttempts,
    });
  }

  /** Adds many workflow tasks to the queue. */
  async enqueueBatch(tasks: WorkflowTask[]): Promise<void> {
    for (const task of tasks) {
      await this.enqueue(task);
    }
  }

  /** Reserves available tasks for a worker. */
  async reserve(workerId: string, maxTasks: number): Promise<WorkflowTaskLease[]> {
    const jobs = await this.client.reserve(workerId, maxTasks);
    return jobs.map((job) => ({
      leaseId: job.id,
      task: job.data,
      workerId,
      leasedAt: new Date(job.processedOn ?? Date.now()).toISOString(),
    }));
  }

  /** Acknowledges a successfully handled task. */
  async acknowledge(lease: WorkflowTaskLease): Promise<void> {
    await this.client.complete(lease.leaseId);
  }

  /** Reschedules a failed task with updated attempt count and availability time. */
  async reschedule(lease: WorkflowTaskLease, retry: WorkflowTaskRetry): Promise<void> {
    const nextTask: WorkflowTask = {
      ...lease.task,
      attempt: lease.task.attempt + 1,
      availableAt: retry.availableAt,
    };

    await this.client.retry(lease.leaseId, nextTask, {
      delayMs: computeDelayMs(retry.availableAt),
    });
  }
}

/** Redis-backed idempotency markers for at-least-once workflow processing. */
export class RedisIdempotencyStore implements IdempotencyStore {
  private readonly keys: WorkflowRedisKeyConfig;

  /** Creates a Redis-backed idempotency store. */
  constructor(
    private readonly client: RedisLikeClient,
    private readonly config: RedisIdempotencyStoreConfig,
  ) {
    this.keys = {
      ...DEFAULT_KEYS,
      ...config.keys,
    };
  }

  /** Checks whether an idempotency marker has already been written. */
  async hasCompleted(key: string): Promise<boolean> {
    return (await this.client.get(this.toKey(key))) !== null;
  }

  /** Marks an idempotency key as completed with a TTL for replay safety. */
  async markCompleted(key: string): Promise<void> {
    await this.client.set(this.toKey(key), "1", {
      ttlMs: this.config.ttlMs,
    });
  }

  private toKey(key: string): string {
    return `${this.keys.idempotencyPrefix}:${key}`;
  }
}

/** Redis-backed circuit breaker state store for multi-worker deployments. */
export class RedisCircuitBreakerStore implements CircuitBreakerStore {
  private readonly keys: WorkflowRedisKeyConfig;

  /** Creates a Redis-backed circuit breaker state store. */
  constructor(
    private readonly client: RedisLikeClient,
    private readonly config: RedisCircuitBreakerStoreConfig,
  ) {
    this.keys = {
      ...DEFAULT_KEYS,
      ...config.keys,
    };
  }

  /** Reads circuit breaker state for one execution bucket. */
  async get(key: string): Promise<CircuitBreakerState | null> {
    const value = await this.client.get(this.toKey(key));
    if (!value) {
      return null;
    }
    return JSON.parse(value) as CircuitBreakerState;
  }

  /** Persists circuit breaker state with TTL to avoid stale keys. */
  async put(state: CircuitBreakerState): Promise<void> {
    const ttlMs = this.config.ttlMs;
    await this.client.set(this.toKey(state.key), JSON.stringify(state), {
      ttlMs,
    });
  }

  /** Removes a circuit breaker state entry after successful execution recovery. */
  async reset(key: string): Promise<void> {
    await this.client.del(this.toKey(key));
  }

  private toKey(key: string): string {
    return `${this.keys.circuitPrefix}:${key}`;
  }
}

/** Redis-backed append-only dead-letter store for failed workflow tasks. */
export class RedisDeadLetterStore implements DeadLetterStore {
  private readonly keys: WorkflowRedisKeyConfig;

  /** Creates a Redis-backed dead-letter store. */
  constructor(
    private readonly client: RedisLikeClient,
    private readonly config: RedisDeadLetterStoreConfig = {},
  ) {
    this.keys = {
      ...DEFAULT_KEYS,
      ...config.keys,
    };
  }

  /** Appends a dead-letter entry to the configured Redis list key. */
  async write(entry: DeadLetterEntry): Promise<void> {
    await this.client.rpush(
      this.keys.deadLetterKey,
      JSON.stringify({
        ...entry,
        expiresAt: this.config.maxEntryAgeMs
          ? new Date(Date.now() + this.config.maxEntryAgeMs).toISOString()
          : undefined,
      }),
    );
  }
}

/** Calculates queue delay in milliseconds from an ISO timestamp. */
export function computeDelayMs(availableAt: string): number {
  return Math.max(new Date(availableAt).getTime() - Date.now(), 0);
}

// TODO:
// - Add concrete BullMQ bindings that map `BullQueueWorkflowTaskQueue` to real BullMQ workers and jobs.
// - Add Redis pipeline/batch support for higher-throughput idempotency and circuit updates.
// - Add dead-letter replay helpers that parse and re-enqueue `RedisDeadLetterStore` entries.
// - REQUIRES: concrete `RedisLikeClient` and `BullLikeQueueClient` adapters backed by your deployment libraries.
