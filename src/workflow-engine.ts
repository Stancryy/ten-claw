// File: src/workflow-engine.ts
/**
 * Durable workflow execution infrastructure with at-least-once delivery,
 * idempotent step handling, dead-letter routing, and per-agent circuit breaking.
 */

import type {
  AgentMessage,
  AgentOrchestrator,
  FrameworkError,
  JsonObject,
  MessageBus,
  RunId,
  TenantScope,
  WorkflowRequest,
} from "./types";

/** Queue task kinds handled by the workflow engine. */
export type WorkflowTaskKind = "agent-message" | "cancel-workflow";

/** Circuit breaker state for one agent or task execution key. */
export interface CircuitBreakerState {
  key: string;
  state: "closed" | "open";
  failureCount: number;
  lastFailureAt?: string;
  openUntil?: string;
}

/** Dead-letter envelope persisted for manual inspection or replay. */
export interface DeadLetterEntry {
  task: WorkflowTask;
  failedAt: string;
  error: FrameworkError;
}

/** Queue payload for an agent message delivery task. */
export interface AgentMessageTaskPayload {
  message: AgentMessage;
}

/** Queue payload for a workflow cancellation task. */
export interface CancelWorkflowTaskPayload {
  scope: TenantScope;
  runId: RunId;
  reason: string;
}

/** Durable task envelope stored in the queue backend. */
export interface WorkflowTask {
  id: string;
  kind: WorkflowTaskKind;
  scope: TenantScope;
  runId?: RunId;
  idempotencyKey: string;
  attempt: number;
  maxAttempts: number;
  createdAt: string;
  availableAt: string;
  payload: AgentMessageTaskPayload | CancelWorkflowTaskPayload;
}

/** Reserved task plus lease metadata from the queue backend. */
export interface WorkflowTaskLease {
  leaseId: string;
  task: WorkflowTask;
  workerId: string;
  leasedAt: string;
}

/** Retry metadata used when rescheduling failed tasks. */
export interface WorkflowTaskRetry {
  availableAt: string;
  error: FrameworkError;
}

/** Backoff strategy for task retries. */
export interface BackoffPolicy {
  baseDelayMs: number;
  maxDelayMs: number;
  multiplier: number;
}

/** Circuit breaker thresholds applied per task execution key. */
export interface CircuitBreakerPolicy {
  failureThreshold: number;
  openDurationMs: number;
}

/** Id generation abstraction for task envelopes. */
export interface WorkflowEngineIdGenerator {
  next(prefix: string): string;
}

/** Optional clock abstraction for deterministic tests. */
export interface WorkflowEngineClock {
  now(): Date;
}

/** Queue backend contract suitable for BullMQ-like implementations. */
export interface WorkflowTaskQueue {
  enqueue(task: WorkflowTask): Promise<void>;
  enqueueBatch(tasks: WorkflowTask[]): Promise<void>;
  reserve(workerId: string, maxTasks: number): Promise<WorkflowTaskLease[]>;
  acknowledge(lease: WorkflowTaskLease): Promise<void>;
  reschedule(lease: WorkflowTaskLease, retry: WorkflowTaskRetry): Promise<void>;
}

/** Durable dead-letter storage for permanently failed tasks. */
export interface DeadLetterStore {
  write(entry: DeadLetterEntry): Promise<void>;
}

/** Idempotency store used to guard at-least-once task execution. */
export interface IdempotencyStore {
  hasCompleted(key: string): Promise<boolean>;
  markCompleted(key: string): Promise<void>;
}

/** Circuit breaker state store used per agent or task execution key. */
export interface CircuitBreakerStore {
  get(key: string): Promise<CircuitBreakerState | null>;
  put(state: CircuitBreakerState): Promise<void>;
  reset(key: string): Promise<void>;
}

/** Function that resolves which circuit breaker bucket a task belongs to. */
export interface CircuitKeyResolver {
  resolve(task: WorkflowTask): string;
}

/** Execution control plane contract for durable workflow processing. */
export interface WorkflowEngine {
  startWorkflow(request: WorkflowRequest): Promise<RunId>;
  enqueueCancellation(scope: TenantScope, runId: RunId, reason: string): Promise<void>;
  drainAvailable(maxTasks?: number): Promise<number>;
}

/** Configuration for queue-backed workflow execution. */
export interface QueueDrivenWorkflowEngineConfig {
  workerId: string;
  reserveBatchSize: number;
  defaultMaxAttempts: number;
  backoff: BackoffPolicy;
  circuitBreaker: CircuitBreakerPolicy;
}

/** Configuration for the message bus that writes agent messages into the queue. */
export interface QueueBackedMessageBusConfig {
  defaultMaxAttempts: number;
}

/** Default circuit-key resolver based on recipient agent id or task kind. */
export class DefaultCircuitKeyResolver implements CircuitKeyResolver {
  /** Resolves a stable circuit key for a workflow task. */
  resolve(task: WorkflowTask): string {
    if (task.kind === "agent-message") {
      const payload = task.payload as AgentMessageTaskPayload;
      return payload.message.recipientAgentId ?? `${task.kind}:system`;
    }
    return `${task.kind}:system`;
  }
}

/** Message bus implementation that publishes immutable agent messages into a queue. */
export class QueueBackedMessageBus implements MessageBus {
  private readonly clock: WorkflowEngineClock;
  private readonly ids: WorkflowEngineIdGenerator;

  /** Creates a message bus that converts agent messages into durable queue tasks. */
  constructor(
    private readonly queue: WorkflowTaskQueue,
    private readonly config: QueueBackedMessageBusConfig,
    ids?: WorkflowEngineIdGenerator,
    clock?: WorkflowEngineClock,
  ) {
    this.ids = ids ?? {
      next: (prefix: string) =>
        `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
    };
    this.clock = clock ?? {
      now: () => new Date(),
    };
  }

  /** Enqueues one agent message for durable delivery. */
  async publish(message: AgentMessage): Promise<void> {
    await this.queue.enqueue(this.toTask(message));
  }

  /** Enqueues many agent messages for durable delivery. */
  async publishBatch(messages: AgentMessage[]): Promise<void> {
    await this.queue.enqueueBatch(messages.map((message) => this.toTask(message)));
  }

  private toTask(message: AgentMessage): WorkflowTask {
    return {
      id: this.ids.next("task"),
      kind: "agent-message",
      scope: message.scope,
      runId: message.runId,
      idempotencyKey: `message:${message.id}`,
      attempt: 0,
      maxAttempts: this.config.defaultMaxAttempts,
      createdAt: this.clock.now().toISOString(),
      availableAt: this.clock.now().toISOString(),
      payload: {
        message,
      },
    };
  }
}

/**
 * Queue-driven engine that executes orchestrator tasks with at-least-once
 * delivery, idempotency, dead-letter routing, retry backoff, and circuit
 * breaker protection.
 */
export class QueueDrivenWorkflowEngine implements WorkflowEngine {
  private readonly clock: WorkflowEngineClock;
  private readonly ids: WorkflowEngineIdGenerator;
  private readonly circuitKeyResolver: CircuitKeyResolver;

  /** Creates a durable workflow engine around a queue and an orchestrator. */
  constructor(
    private readonly orchestrator: AgentOrchestrator,
    private readonly queue: WorkflowTaskQueue,
    private readonly deadLetterStore: DeadLetterStore,
    private readonly idempotencyStore: IdempotencyStore,
    private readonly circuitBreakerStore: CircuitBreakerStore,
    private readonly config: QueueDrivenWorkflowEngineConfig,
    circuitKeyResolver: CircuitKeyResolver = new DefaultCircuitKeyResolver(),
    ids?: WorkflowEngineIdGenerator,
    clock?: WorkflowEngineClock,
  ) {
    this.circuitKeyResolver = circuitKeyResolver;
    this.ids = ids ?? {
      next: (prefix: string) =>
        `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
    };
    this.clock = clock ?? {
      now: () => new Date(),
    };
  }

  /**
   * Starts a workflow by delegating to the orchestrator.
   *
   * This assumes the orchestrator is configured with `autoDrive: false` and a
   * `QueueBackedMessageBus`, so the emitted `task.created` message is consumed
   * asynchronously by this engine.
   */
  async startWorkflow(request: WorkflowRequest): Promise<RunId> {
    return this.orchestrator.startWorkflow(request);
  }

  /** Enqueues a durable cancellation task. */
  async enqueueCancellation(
    scope: TenantScope,
    runId: RunId,
    reason: string,
  ): Promise<void> {
    await this.queue.enqueue({
      id: this.ids.next("task"),
      kind: "cancel-workflow",
      scope,
      runId,
      idempotencyKey: `cancel:${runId}:${reason}`,
      attempt: 0,
      maxAttempts: this.config.defaultMaxAttempts,
      createdAt: this.nowIso(),
      availableAt: this.nowIso(),
      payload: {
        scope,
        runId,
        reason,
      },
    });
  }

  /** Reserves and processes up to `maxTasks` currently available queue tasks. */
  async drainAvailable(maxTasks = this.config.reserveBatchSize): Promise<number> {
    const leases = await this.queue.reserve(this.config.workerId, maxTasks);
    let processed = 0;

    for (const lease of leases) {
      await this.processLease(lease);
      processed += 1;
    }

    return processed;
  }

  private async processLease(lease: WorkflowTaskLease): Promise<void> {
    const { task } = lease;
    if (await this.idempotencyStore.hasCompleted(task.idempotencyKey)) {
      await this.queue.acknowledge(lease);
      return;
    }

    const circuitKey = this.circuitKeyResolver.resolve(task);
    const circuitState = await this.circuitBreakerStore.get(circuitKey);
    if (isCircuitOpen(circuitState, this.clock.now())) {
      await this.queue.reschedule(lease, {
        availableAt: circuitState?.openUntil ?? this.nowIso(),
        error: {
          code: "provider-error",
          message: `Circuit breaker is open for ${circuitKey}.`,
          retryable: true,
        },
      });
      return;
    }

    try {
      await this.dispatchTask(task);
      await this.idempotencyStore.markCompleted(task.idempotencyKey);
      await this.queue.acknowledge(lease);
      await this.circuitBreakerStore.reset(circuitKey);
    } catch (error) {
      const normalizedError = normalizeWorkflowEngineError(error);
      const nextFailureCount = (circuitState?.failureCount ?? 0) + 1;
      await this.updateCircuitBreaker(circuitKey, nextFailureCount);

      if (task.attempt + 1 >= task.maxAttempts) {
        await this.deadLetterStore.write({
          task,
          failedAt: this.nowIso(),
          error: normalizedError,
        });
        await this.queue.acknowledge(lease);
        return;
      }

      await this.queue.reschedule(lease, {
        availableAt: new Date(
          this.clock.now().getTime() + computeBackoffDelay(task.attempt + 1, this.config.backoff),
        ).toISOString(),
        error: normalizedError,
      });
    }
  }

  private async dispatchTask(task: WorkflowTask): Promise<void> {
    switch (task.kind) {
      case "agent-message":
        await this.orchestrator.handleMessage(
          (task.payload as AgentMessageTaskPayload).message,
        );
        return;
      case "cancel-workflow": {
        const payload = task.payload as CancelWorkflowTaskPayload;
        await this.orchestrator.cancelWorkflow(payload.scope, payload.runId, payload.reason);
        return;
      }
      default:
        throw {
          code: "routing-error",
          message: `Unsupported workflow task kind: ${String(task.kind)}.`,
          retryable: false,
        } satisfies FrameworkError;
    }
  }

  private async updateCircuitBreaker(key: string, failureCount: number): Promise<void> {
    if (failureCount < this.config.circuitBreaker.failureThreshold) {
      await this.circuitBreakerStore.put({
        key,
        state: "closed",
        failureCount,
        lastFailureAt: this.nowIso(),
      });
      return;
    }

    await this.circuitBreakerStore.put({
      key,
      state: "open",
      failureCount,
      lastFailureAt: this.nowIso(),
      openUntil: new Date(
        this.clock.now().getTime() + this.config.circuitBreaker.openDurationMs,
      ).toISOString(),
    });
  }

  private nowIso(): string {
    return this.clock.now().toISOString();
  }
}

/** Calculates exponential retry delay for a task attempt. */
export function computeBackoffDelay(attempt: number, policy: BackoffPolicy): number {
  if (attempt <= 0) {
    return policy.baseDelayMs;
  }
  const delay = policy.baseDelayMs * Math.pow(policy.multiplier, attempt - 1);
  return Math.min(delay, policy.maxDelayMs);
}

function isCircuitOpen(
  state: CircuitBreakerState | null,
  now: Date,
): boolean {
  return Boolean(
    state &&
      state.state === "open" &&
      state.openUntil &&
      new Date(state.openUntil).getTime() > now.getTime(),
  );
}

function normalizeWorkflowEngineError(error: unknown): FrameworkError {
  if (isFrameworkError(error)) {
    return error;
  }
  if (error instanceof Error && error.message.toLowerCase().includes("timeout")) {
    return {
      code: "timeout",
      message: error.message,
      retryable: true,
    };
  }
  return {
    code: "provider-error",
    message: error instanceof Error ? error.message : "Unknown workflow engine error.",
    retryable: true,
  };
}

function isFrameworkError(value: unknown): value is FrameworkError {
  return Boolean(
    value &&
      typeof value === "object" &&
      "code" in value &&
      "message" in value &&
      "retryable" in value,
  );
}

// TODO:
// - Add a BullMQ adapter that implements `WorkflowTaskQueue` without leaking BullMQ types into the core layer.
// - Add a Redis-backed `IdempotencyStore` and `CircuitBreakerStore` implementation for multi-worker deployments.
// - Add workflow replay helpers that can re-enqueue dead-letter entries after operator review.
// - Add queue metrics hooks for lag, throughput, retries, dead-letter volume, and circuit breaker activity.
