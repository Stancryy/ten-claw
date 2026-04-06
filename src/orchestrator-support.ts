// File: src/orchestrator-support.ts
/**
 * Support contracts and utilities for the orchestrator layer.
 */

import type {
  AgentDefinition,
  AgentMessage,
  AgentResult,
  AgentRuntime,
  ApprovalDecision,
  ApprovalGateway,
  AuditLogger,
  FrameworkError,
  JsonObject,
  JsonValue,
  LearningEngine,
  MemoryStore,
  MessageBus,
  Notifier,
  PromptSecurityScanner,
  RouteCondition,
  RunId,
  RoutingDecision,
  SessionStateStore,
  SkillRegistry,
  TaskRouter,
  TeamDefinition,
  TenantScope,
  TokenBudget,
  TokenUsage,
  WorkflowRequest,
  WorkflowStatus,
} from "./types";

/** Durable workflow snapshot used for replay, retries, and crash recovery. */
export interface WorkflowRecord {
  runId: RunId;
  scope: TenantScope;
  team: TeamDefinition;
  request: WorkflowRequest;
  status: WorkflowStatus;
  currentAgentId?: string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  hopCount: number;
  consecutiveFailures: number;
  attemptByAgentId: Record<string, number>;
  messageHistory: AgentMessage[];
  routingDecisions: RoutingDecision[];
  artifacts: Array<{
    agentId: string;
    title: string;
    kind: string;
    mimeType: string;
    content: string;
  }>;
  tokenUsage: TokenUsage;
  pendingApprovalRequestId?: string;
  lastError?: FrameworkError;
}

/** Resolves low-code or code-defined teams at workflow start. */
export interface TeamRepository {
  get(scope: TenantScope, teamId: string): Promise<TeamDefinition | null>;
}

/** Resolves executable agent runtimes by id. */
export interface AgentRegistry {
  get(scope: TenantScope, agentId: string): Promise<AgentRuntime | null>;
}

/** Stores workflow state durably for resumability and observability. */
export interface WorkflowStateStore {
  create(record: WorkflowRecord): Promise<void>;
  get(scope: TenantScope, runId: RunId): Promise<WorkflowRecord | null>;
  update(record: WorkflowRecord): Promise<void>;
}

/** Clock abstraction for deterministic tests and replay. */
export interface Clock {
  now(): Date;
}

/** ID generation abstraction to avoid hard-coding a UUID library. */
export interface IdGenerator {
  next(prefix: string): string;
}

/** Core orchestrator tuning knobs. */
export interface OrchestratorConfig {
  autoDrive: boolean;
  memoryQueryTopK: number;
  defaultRetryAfterMs: number;
}

/** Infrastructure required by the orchestrator runtime. */
export interface OrchestratorDependencies {
  teamRepository: TeamRepository;
  agentRegistry: AgentRegistry;
  workflowStore: WorkflowStateStore;
  sessionStateStore: SessionStateStore;
  memoryStore: MemoryStore;
  skillRegistry: SkillRegistry;
  taskRouter: TaskRouter;
  messageBus: MessageBus;
  approvalGateway: ApprovalGateway;
  auditLogger: AuditLogger;
  learningEngine?: LearningEngine;
  notifiers?: Partial<Record<"telegram" | "discord" | "whatsapp", Notifier>>;
  promptSecurityScanner?: PromptSecurityScanner;
  clock?: Clock;
  ids?: IdGenerator;
  config?: Partial<OrchestratorConfig>;
}

/** Default orchestrator settings for the hybrid bus execution model. */
export const DEFAULT_ORCHESTRATOR_CONFIG: OrchestratorConfig = {
  autoDrive: true,
  memoryQueryTopK: 8,
  defaultRetryAfterMs: 1_000,
};

/**
 * Declarative router backed by `TeamDefinition.routes`.
 */
export class DeclarativeTaskRouter implements TaskRouter {
  /** Resolves the next agent from an explicit target or route conditions. */
  async resolveNextAgent(args: {
    team: TeamDefinition;
    currentAgent: AgentDefinition;
    result: AgentResult;
    request: WorkflowRequest;
  }): Promise<AgentDefinition | null> {
    if (args.result.handoff.targetAgentId) {
      return args.team.agents.find((agent) => agent.id === args.result.handoff.targetAgentId) ?? null;
    }

    const route = [...args.team.routes]
      .sort((left, right) => right.priority - left.priority)
      .find((candidate) => {
        const sourceMatches =
          candidate.fromAgentId === "*" || candidate.fromAgentId === args.currentAgent.id;
        return sourceMatches && candidate.conditions.every((condition) => this.matches(condition, args));
      });

    return route
      ? args.team.agents.find((agent) => agent.id === route.toAgentId) ?? null
      : null;
  }

  private matches(
    condition: RouteCondition,
    args: {
      result: AgentResult;
      request: WorkflowRequest;
    },
  ): boolean {
    return evaluateCondition(condition, {
      request: args.request as unknown as JsonObject,
      result: args.result as unknown as JsonObject,
      handoff: args.result.handoff as unknown as JsonObject,
    } as JsonObject);
  }
}

/** Merges agent, team, and request token budgets in precedence order. */
export function mergeTokenBudget(
  agentBudget: TokenBudget,
  teamBudget?: TokenBudget,
  requestBudget?: Partial<TokenBudget>,
): TokenBudget {
  return {
    ...agentBudget,
    ...teamBudget,
    ...requestBudget,
    overflowStrategy:
      requestBudget?.overflowStrategy ??
      teamBudget?.overflowStrategy ??
      agentBudget.overflowStrategy,
  };
}

/** Creates an empty token-usage accumulator for one workflow. */
export function createEmptyTokenUsage(): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachedInputTokens: 0,
  };
}

/** Adds incremental token usage to a workflow-level accumulator. */
export function addTokenUsage(current: TokenUsage, delta?: TokenUsage): TokenUsage {
  if (!delta) {
    return current;
  }

  return {
    inputTokens: current.inputTokens + delta.inputTokens,
    outputTokens: current.outputTokens + delta.outputTokens,
    totalTokens: current.totalTokens + delta.totalTokens,
    cachedInputTokens: (current.cachedInputTokens ?? 0) + (delta.cachedInputTokens ?? 0),
  };
}

/** Converts approval decisions into message-safe JSON payloads. */
export function approvalDecisionToPayload(decision: ApprovalDecision): JsonObject {
  return {
    requestId: decision.requestId,
    approved: decision.approved,
    approverId: decision.approverId,
    decidedAt: decision.decidedAt,
    comment: decision.comment,
  };
}

/** Normalizes unknown values to plain JSON objects. */
export function ensureJsonObject(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as JsonObject;
}

/** Normalizes thrown values into framework-native errors. */
export function normalizeError(error: unknown): FrameworkError {
  if (isFrameworkError(error)) {
    return error;
  }
  if (error instanceof Error && error.message === "Operation timed out.") {
    return { code: "timeout", message: error.message, retryable: true };
  }
  return {
    code: "provider-error",
    message: error instanceof Error ? error.message : "Unknown orchestrator error.",
    retryable: true,
  };
}

/** Sleeps for the requested delay. */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Rejects a promise if it does not settle within `timeoutMs`. */
export function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Operation timed out.")), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function evaluateCondition(condition: RouteCondition, source: JsonObject): boolean {
  const actual = readPath(source, condition.field);
  const expected = condition.value;

  switch (condition.operator) {
    case "equals":
      return actual === expected;
    case "not-equals":
      return actual !== expected;
    case "contains":
      return Array.isArray(actual)
        ? actual.includes(expected)
        : String(actual).includes(String(expected));
    case "greater-than":
      return Number(actual) > Number(expected);
    case "less-than":
      return Number(actual) < Number(expected);
    case "in":
      return Array.isArray(expected)
        ? expected.includes((actual ?? null) as JsonValue)
        : false;
    default:
      return false;
  }
}

function readPath(source: JsonObject, path: string): unknown {
  return path.split(".").reduce<unknown>((value, segment) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }
    return (value as Record<string, unknown>)[segment];
  }, source);
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
// - Add route precompilation for large teams with hundreds of agents.
// - Add richer error classes with provider metadata and trace correlation.
// - Add bounded jitter to retry delays for high-concurrency deployments.
// - Add adaptive router implementations that combine declarative, capability, and learned policies.
