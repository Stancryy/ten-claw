// File: src/workflow-state.ts
/**
 * Durable workflow-state persistence for orchestrator run records.
 *
 * This layer intentionally avoids choosing a specific database. Instead, it
 * defines small document and index client contracts that can be implemented by
 * Redis JSON, DynamoDB, Postgres JSONB, Cosmos DB, or any similar store.
 */

import type { WorkflowRecord, WorkflowStateStore } from "./orchestrator-support";
import type {
  JsonObject,
  JsonValue,
  RunId,
  TenantScope,
  WorkflowStatus,
} from "./types";

/** Minimal document client required to persist serialized workflow records. */
export interface WorkflowStateDocumentClient {
  put(key: string, value: JsonObject): Promise<void>;
  get(key: string): Promise<JsonObject | null>;
}

/**
 * Optional sorted-index client for listing recent workflow runs.
 *
 * Scores should usually be epoch milliseconds derived from `updatedAt`.
 */
export interface WorkflowStateIndexClient {
  add(indexKey: string, member: string, score: number): Promise<void>;
  rangeDescending(indexKey: string, limit: number): Promise<string[]>;
}

/** Query shape for listing recent workflow runs within one tenant scope. */
export interface WorkflowRunQuery {
  scope: TenantScope;
  limit: number;
  status?: WorkflowStatus;
}

/** Compact workflow summary used for dashboards, notifications, and run search. */
export interface WorkflowRunSummary {
  runId: RunId;
  scope: TenantScope;
  teamId: string;
  sessionId: string;
  status: WorkflowStatus;
  currentAgentId?: string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  totalTokens: number;
  artifactCount: number;
  lastErrorCode?: string;
}

/** Optional read model for recent-run inspection and tenant-scoped dashboards. */
export class WorkflowRunReader {
  /** Creates a read helper over a workflow state store and an optional recency index. */
  constructor(
    private readonly store: WorkflowStateStore,
    private readonly indexClient?: WorkflowStateIndexClient,
  ) {}

  /** Lists recent runs for a scope, optionally filtering by workflow status. */
  async listRecent(query: WorkflowRunQuery): Promise<WorkflowRunSummary[]> {
    if (!this.indexClient) {
      throw new Error(
        "WorkflowRunReader requires an index client to list recent workflow runs.",
      );
    }

    const runIds = await this.indexClient.rangeDescending(
      toWorkflowRunsIndexKey(query.scope),
      query.status ? Math.max(query.limit * 4, query.limit) : query.limit,
    );

    const records = await Promise.all(
      runIds.map(async (runId) => this.store.get(query.scope, runId)),
    );

    return records
      .filter((record): record is WorkflowRecord => Boolean(record))
      .filter((record) => (query.status ? record.status === query.status : true))
      .slice(0, query.limit)
      .map(toWorkflowRunSummary);
  }
}

/** Production workflow state store with deterministic tenant/workspace/run keys. */
export class ScopedWorkflowStateStore implements WorkflowStateStore {
  /** Creates a workflow state store around injected document and optional index clients. */
  constructor(
    private readonly documentClient: WorkflowStateDocumentClient,
    private readonly indexClient?: WorkflowStateIndexClient,
  ) {}

  /** Persists the initial workflow record and writes a recency index entry when configured. */
  async create(record: WorkflowRecord): Promise<void> {
    await this.documentClient.put(
      toWorkflowStateKey(record.scope, record.runId),
      toWorkflowStateStorageDocument(record),
    );
    await this.indexRecord(record);
  }

  /** Loads one workflow record by tenant scope and run id. */
  async get(scope: TenantScope, runId: RunId): Promise<WorkflowRecord | null> {
    const stored = await this.documentClient.get(toWorkflowStateKey(scope, runId));
    if (!stored) {
      return null;
    }
    return fromWorkflowStateStorageDocument(stored);
  }

  /** Replaces the stored workflow record and refreshes the recency index entry. */
  async update(record: WorkflowRecord): Promise<void> {
    await this.documentClient.put(
      toWorkflowStateKey(record.scope, record.runId),
      toWorkflowStateStorageDocument(record),
    );
    await this.indexRecord(record);
  }

  private async indexRecord(record: WorkflowRecord): Promise<void> {
    if (!this.indexClient) {
      return;
    }
    await this.indexClient.add(
      toWorkflowRunsIndexKey(record.scope),
      record.runId,
      Date.parse(record.updatedAt),
    );
  }
}

/** Builds the canonical storage key for a workflow run record. */
export function toWorkflowStateKey(scope: TenantScope, runId: RunId): string {
  return [
    "workflow",
    scope.tenantId,
    scope.workspaceId,
    scope.projectId ?? "default-project",
    runId,
  ].join(":");
}

/** Builds the canonical sorted-index key for recent workflow runs. */
export function toWorkflowRunsIndexKey(scope: TenantScope): string {
  return [
    "workflow-index",
    scope.tenantId,
    scope.workspaceId,
    scope.projectId ?? "default-project",
    "recent",
  ].join(":");
}

/** Converts a workflow record into a document-store-safe JSON object. */
export function toWorkflowStateStorageDocument(record: WorkflowRecord): JsonObject {
  return {
    schemaVersion: "1.0.0",
    runId: record.runId,
    scope: record.scope as unknown as JsonValue,
    team: record.team as unknown as JsonValue,
    request: record.request as unknown as JsonValue,
    status: record.status,
    currentAgentId: record.currentAgentId,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    completedAt: record.completedAt,
    hopCount: record.hopCount,
    consecutiveFailures: record.consecutiveFailures,
    attemptByAgentId: record.attemptByAgentId as unknown as JsonValue,
    messageHistory: record.messageHistory as unknown as JsonValue,
    routingDecisions: record.routingDecisions as unknown as JsonValue,
    artifacts: record.artifacts as unknown as JsonValue,
    tokenUsage: record.tokenUsage as unknown as JsonValue,
    pendingApprovalRequestId: record.pendingApprovalRequestId,
    lastError: record.lastError as unknown as JsonValue,
  };
}

/** Converts a persisted document back into a typed workflow record. */
export function fromWorkflowStateStorageDocument(document: JsonObject): WorkflowRecord {
  validateWorkflowStateStorageDocument(document);

  const record: WorkflowRecord = {
    runId: asRequiredString(document.runId, "runId"),
    scope: asJsonObject(document.scope, "scope") as unknown as TenantScope,
    team: asJsonObject(document.team, "team") as unknown as WorkflowRecord["team"],
    request: asJsonObject(document.request, "request") as unknown as WorkflowRecord["request"],
    status: asWorkflowStatus(document.status),
    startedAt: asRequiredString(document.startedAt, "startedAt"),
    updatedAt: asRequiredString(document.updatedAt, "updatedAt"),
    hopCount: asRequiredNumber(document.hopCount, "hopCount"),
    consecutiveFailures: asRequiredNumber(
      document.consecutiveFailures,
      "consecutiveFailures",
    ),
    attemptByAgentId: asStringNumberRecord(document.attemptByAgentId, "attemptByAgentId"),
    messageHistory: asJsonArray(
      document.messageHistory,
      "messageHistory",
    ) as unknown as WorkflowRecord["messageHistory"],
    routingDecisions: asJsonArray(
      document.routingDecisions,
      "routingDecisions",
    ) as unknown as WorkflowRecord["routingDecisions"],
    artifacts: asJsonArray(document.artifacts, "artifacts") as unknown as WorkflowRecord["artifacts"],
    tokenUsage: asJsonObject(document.tokenUsage, "tokenUsage") as unknown as WorkflowRecord["tokenUsage"],
  };
  const currentAgentId = asOptionalString(document.currentAgentId);
  if (currentAgentId) {
    record.currentAgentId = currentAgentId;
  }
  const completedAt = asOptionalString(document.completedAt);
  if (completedAt) {
    record.completedAt = completedAt;
  }
  const pendingApprovalRequestId = asOptionalString(document.pendingApprovalRequestId);
  if (pendingApprovalRequestId) {
    record.pendingApprovalRequestId = pendingApprovalRequestId;
  }
  if (document.lastError) {
    record.lastError = asJsonObject(
      document.lastError,
      "lastError",
    ) as unknown as NonNullable<WorkflowRecord["lastError"]>;
  }
  return record;
}

/** Projects a compact summary from a full workflow record. */
export function toWorkflowRunSummary(record: WorkflowRecord): WorkflowRunSummary {
  const summary: WorkflowRunSummary = {
    runId: record.runId,
    scope: record.scope,
    teamId: record.request.teamId,
    sessionId: record.request.sessionId,
    status: record.status,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    totalTokens: record.tokenUsage.totalTokens,
    artifactCount: record.artifacts.length,
  };
  if (record.currentAgentId) {
    summary.currentAgentId = record.currentAgentId;
  }
  if (record.completedAt) {
    summary.completedAt = record.completedAt;
  }
  if (record.lastError?.code) {
    summary.lastErrorCode = record.lastError.code;
  }
  return summary;
}

function validateWorkflowStateStorageDocument(document: JsonObject): void {
  const requiredFields = [
    "runId",
    "scope",
    "team",
    "request",
    "status",
    "startedAt",
    "updatedAt",
    "hopCount",
    "consecutiveFailures",
    "attemptByAgentId",
    "messageHistory",
    "routingDecisions",
    "artifacts",
    "tokenUsage",
  ] as const;

  for (const field of requiredFields) {
    if (document[field] === undefined) {
      throw new Error(`Workflow state document is missing required field "${field}".`);
    }
  }
}

function asJsonObject(value: JsonValue | undefined, field: string): JsonObject {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value;
  }
  throw new Error(`Workflow state field "${field}" must be a JSON object.`);
}

function asJsonArray(value: JsonValue | undefined, field: string): JsonValue[] {
  if (Array.isArray(value)) {
    return value;
  }
  throw new Error(`Workflow state field "${field}" must be a JSON array.`);
}

function asRequiredString(value: JsonValue | undefined, field: string): string {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  throw new Error(`Workflow state field "${field}" must be a non-empty string.`);
}

function asOptionalString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asRequiredNumber(value: JsonValue | undefined, field: string): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  throw new Error(`Workflow state field "${field}" must be a finite number.`);
}

function asStringNumberRecord(value: JsonValue | undefined, field: string): Record<string, number> {
  const object = asJsonObject(value, field);
  const entries = Object.entries(object);
  const result: Record<string, number> = {};

  for (const [key, entry] of entries) {
    if (typeof entry !== "number" || !Number.isFinite(entry)) {
      throw new Error(`Workflow state field "${field}.${key}" must be a finite number.`);
    }
    result[key] = entry;
  }

  return result;
}

function asWorkflowStatus(value: JsonValue | undefined): WorkflowStatus {
  switch (value) {
    case "queued":
    case "running":
    case "awaiting-approval":
    case "completed":
    case "failed":
    case "cancelled":
    case "timed-out":
      return value;
    default:
      throw new Error(`Workflow state field "status" contains an unsupported status.`);
  }
}

// TODO:
// - Add optimistic concurrency metadata for multi-writer workflow updates in distributed deployments.
// - Add secondary indexes for status, team, and session queries once the storage backend contract requires them.
// - Add archival and compaction hooks for long-lived workflows with very large message histories.
// - REQUIRES: concrete `WorkflowStateDocumentClient` and optional `WorkflowStateIndexClient` adapters for your chosen database.
