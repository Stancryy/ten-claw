// File: src/vendor-adapters.ts
/**
 * Vendor bridge adapters for real Redis and BullMQ-style SDK clients.
 *
 * These wrappers isolate third-party client shapes from the core framework
 * interfaces. The concrete SDK instances are injected by the application layer.
 */

import type {
  BullLikeJob,
  BullLikeQueueClient,
  RedisLikeClient,
} from "./workflow-adapters";

/** Minimal Redis SDK surface required to back `RedisLikeClient`. */
export interface RedisSdkClient {
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    options?: {
      PX?: number;
      NX?: boolean;
    },
  ): Promise<"OK" | null>;
  del(key: string): Promise<number>;
  rPush(key: string, value: string): Promise<number>;
}

/** Minimal BullMQ job surface required by the queue bridge. */
export interface BullMqSdkJob<TPayload> {
  id?: string;
  data: TPayload;
  attemptsMade: number;
  timestamp: number;
  processedOn?: number;
  moveToCompleted(
    returnValue: unknown,
    token: string,
    fetchNext?: boolean,
  ): Promise<void>;
  moveToDelayed(timestamp: number, token?: string): Promise<void>;
}

/** Minimal BullMQ queue surface required for new job creation. */
export interface BullMqSdkQueue<TPayload> {
  add(
    name: string,
    data: TPayload,
    options?: {
      jobId?: string;
      delay?: number;
      attempts?: number;
      removeOnComplete?: boolean | number;
      removeOnFail?: boolean | number;
    },
  ): Promise<void>;
}

/** Minimal BullMQ worker surface required for reserving jobs. */
export interface BullMqSdkWorker<TPayload> {
  getNextJob(token: string): Promise<BullMqSdkJob<TPayload> | undefined>;
}

/** Runtime token factory used to lease and ack BullMQ jobs safely. */
export interface LeaseTokenFactory {
  nextToken(): string;
}

/** Configuration for the BullMQ queue bridge. */
export interface BullMqQueueBridgeConfig {
  removeOnComplete?: boolean | number;
  removeOnFail?: boolean | number;
}

/** Redis SDK bridge implementing the internal `RedisLikeClient` contract. */
export class RedisSdkClientAdapter implements RedisLikeClient {
  /** Creates a bridge around a concrete Redis SDK client. */
  constructor(private readonly client: RedisSdkClient) {}

  /** Reads a string value from Redis. */
  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  /** Writes a string value to Redis with optional TTL and NX semantics. */
  async set(
    key: string,
    value: string,
    options?: {
      ttlMs?: number;
      onlyIfAbsent?: boolean;
    },
  ): Promise<boolean> {
    const redisOptions: {
      PX?: number;
      NX?: boolean;
    } = {};
    if (options?.ttlMs !== undefined) {
      redisOptions.PX = options.ttlMs;
    }
    if (options?.onlyIfAbsent !== undefined) {
      redisOptions.NX = options.onlyIfAbsent;
    }
    const result = await this.client.set(
      key,
      value,
      Object.keys(redisOptions).length > 0 ? redisOptions : undefined,
    );
    return result === "OK";
  }

  /** Deletes a key from Redis. */
  async del(key: string): Promise<void> {
    await this.client.del(key);
  }

  /** Appends a value to a Redis list. */
  async rpush(key: string, value: string): Promise<void> {
    await this.client.rPush(key, value);
  }
}

/** BullMQ SDK bridge implementing the internal `BullLikeQueueClient` contract. */
export class BullMqQueueClientAdapter<TPayload> implements BullLikeQueueClient<TPayload> {
  private readonly tokenFactory: LeaseTokenFactory;
  private readonly config: BullMqQueueBridgeConfig;
  private readonly activeJobs = new Map<string, { job: BullMqSdkJob<TPayload>; token: string }>();

  /** Creates a bridge around concrete BullMQ queue and worker instances. */
  constructor(
    private readonly queue: BullMqSdkQueue<TPayload>,
    private readonly worker: BullMqSdkWorker<TPayload>,
    tokenFactory?: LeaseTokenFactory,
    config: BullMqQueueBridgeConfig = {},
  ) {
    this.tokenFactory = tokenFactory ?? {
      nextToken: () => `bull_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
    };
    this.config = config;
  }

  /** Adds a payload to the underlying BullMQ queue. */
  async add(
    name: string,
    payload: TPayload,
    options?: {
      jobId?: string;
      delayMs?: number;
      attempts?: number;
    },
  ): Promise<void> {
    const addOptions: {
      jobId?: string;
      delay?: number;
      attempts?: number;
      removeOnComplete?: boolean | number;
      removeOnFail?: boolean | number;
    } = {
      removeOnComplete: this.config.removeOnComplete ?? true,
      removeOnFail: this.config.removeOnFail ?? false,
    };
    if (options?.jobId) {
      addOptions.jobId = options.jobId;
    }
    if (options?.delayMs !== undefined) {
      addOptions.delay = options.delayMs;
    }
    if (options?.attempts !== undefined) {
      addOptions.attempts = options.attempts;
    }
    await this.queue.add(name, payload, addOptions);
  }

  /**
   * Reserves up to `maxJobs` jobs from the worker.
   *
   * REQUIRES: the provided worker must support `getNextJob(token)` semantics.
   */
  async reserve(workerId: string, maxJobs: number): Promise<Array<BullLikeJob<TPayload>>> {
    const jobs: Array<BullLikeJob<TPayload>> = [];

    for (let index = 0; index < maxJobs; index += 1) {
      const token = this.tokenFactory.nextToken();
      const job = await this.worker.getNextJob(token);
      if (!job) {
        break;
      }

      const jobId = this.requireJobId(job);
      this.activeJobs.set(jobId, { job, token });
      const leasedJob: BullLikeJob<TPayload> = {
        id: jobId,
        data: job.data,
        attemptsMade: job.attemptsMade,
        timestamp: job.timestamp,
      };
      if (job.processedOn !== undefined) {
        leasedJob.processedOn = job.processedOn;
      }
      jobs.push(leasedJob);
    }

    return jobs;
  }

  /** Completes an active BullMQ job using its reserved token. */
  async complete(jobId: string): Promise<void> {
    const entry = this.activeJobs.get(jobId);
    if (!entry) {
      throw new Error(`No active BullMQ job lease found for ${jobId}.`);
    }

    await entry.job.moveToCompleted("ok", entry.token, false);
    this.activeJobs.delete(jobId);
  }

  /** Delays an active BullMQ job for retry using its reserved token. */
  async retry(
    jobId: string,
    _payload: TPayload,
    options: {
      delayMs: number;
    },
  ): Promise<void> {
    const entry = this.activeJobs.get(jobId);
    if (!entry) {
      throw new Error(`No active BullMQ job lease found for ${jobId}.`);
    }

    await entry.job.moveToDelayed(Date.now() + options.delayMs, entry.token);
    this.activeJobs.delete(jobId);
  }

  private requireJobId(job: BullMqSdkJob<TPayload>): string {
    if (!job.id) {
      throw new Error("BullMQ job id is required for lease tracking.");
    }
    return job.id;
  }
}

// TODO:
// - Add BullMQ queue-scheduler wiring notes once deployment scaffolding is added.
// - Add Redis cluster/sentinel connection guidance for enterprise deployments.
// - Add stronger worker lease recovery logic if the chosen BullMQ version exposes richer lock APIs.
// - REQUIRES: concrete BullMQ `Queue` and `Worker` instances plus a real Redis SDK client.
