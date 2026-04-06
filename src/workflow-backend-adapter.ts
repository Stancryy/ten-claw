// File: src/workflow-backend-adapter.ts
/**
 * Adapter layer that bridges the generic `WorkflowStateBackend` contract to the
 * orchestrator-facing `WorkflowStateStore`.
 *
 * The generic backend contract is intentionally narrower than `WorkflowStateStore`.
 * To preserve the full workflow snapshot, this adapter serializes the complete
 * `WorkflowRecord` into the backend payload and emulates full-record updates by
 * replacing the stored run via `deleteRun` + `saveRun`.
 */

import type { WorkflowRecord, WorkflowStateStore } from "./orchestrator-support";
import type {
  WorkflowRunRecord,
  WorkflowRunStatus,
  WorkflowStateBackend,
} from "./workflow-backend";
import type {
  JsonObject,
  JsonValue,
  RunId,
  TenantScope,
  WorkflowStatus,
} from "./types";

/** Stable payload version used when embedding workflow snapshots in backend records. */
export const WORKFLOW_BACKEND_PAYLOAD_VERSION = "1.0.0";

/** Compact run summary projected from the generic workflow backend model. */
export interface BackendWorkflowRunSummary {
  runId: RunId;
  agentType: string;
  status: WorkflowRunStatus;
  retryCount: number;
  createdAt: string;
  updatedAt: string;
}

/** Read helper over `WorkflowStateBackend` for agent-oriented run inspection. */
export class WorkflowBackendRunReader {
  /** Creates a reader over a generic workflow backend. */
  constructor(private readonly backend: WorkflowStateBackend) {}

  /** Lists runs for a given agent type and maps them into compact summaries. */
  async listByAgent(args: {
    scope: TenantScope;
    agentType: string;
    limit?: number;
    status?: WorkflowRunStatus;
  }): Promise<BackendWorkflowRunSummary[]> {
    const options: {
      limit?: number;
      status?: WorkflowRunStatus;
    } = {};
    if (args.limit !== undefined) {
      options.limit = args.limit;
    }
    if (args.status !== undefined) {
      options.status = args.status;
    }
    const runs = await this.backend.listRunsByAgent(
      args.scope,
      args.agentType,
      Object.keys(options).length > 0 ? options : undefined,
    );

    return runs.map((run) => ({
      runId: run.runId,
      agentType: run.agentType,
      status: run.status,
      retryCount: run.retryCount,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    }));
  }
}

/** Bridges the generic backend contract into the orchestrator's workflow-state store. */
export class WorkflowBackendStateStoreAdapter implements WorkflowStateStore {
  /** Creates an adapter over a generic workflow backend. */
  constructor(private readonly backend: WorkflowStateBackend) {}

  /** Creates a new workflow run in the generic backend. */
  async create(record: WorkflowRecord): Promise<void> {
    await this.backend.saveRun(record.scope, toBackendWorkflowRunRecord(record));
  }

  /** Loads and rehydrates a workflow record from the generic backend. */
  async get(scope: TenantScope, runId: RunId): Promise<WorkflowRecord | null> {
    const record = await this.backend.getRun(scope, runId);
    if (!record) {
      return null;
    }
    return fromBackendWorkflowRunRecord(record, scope);
  }

  /**
   * Replaces an existing workflow run snapshot in the generic backend.
   *
   * The generic backend interface does not expose a full-record replace method,
   * so this adapter emulates one by deleting and re-saving the run.
   */
  async update(record: WorkflowRecord): Promise<void> {
    await this.backend.deleteRun(record.scope, record.runId);
    await this.backend.saveRun(record.scope, toBackendWorkflowRunRecord(record));
  }
}

/** Converts a full orchestrator workflow record into the generic backend record shape. */
export function toBackendWorkflowRunRecord(record: WorkflowRecord): WorkflowRunRecord {
  const result: WorkflowRunRecord = {
    runId: record.runId,
    agentType: record.currentAgentId ?? record.team.entryAgentId,
    status: toBackendWorkflowRunStatus(record.status),
    payload: {
      schemaVersion: WORKFLOW_BACKEND_PAYLOAD_VERSION,
      workflowRecord: toSerializableWorkflowRecord(record),
    },
    retryCount: totalRetryCount(record),
    createdAt: record.startedAt,
    updatedAt: record.updatedAt,
  };
  const runResult = buildBackendRunResult(record);
  if (runResult !== undefined) {
    result.result = runResult;
  }
  return result;
}

/** Rehydrates a full orchestrator workflow record from the generic backend record shape. */
export function fromBackendWorkflowRunRecord(
  record: WorkflowRunRecord,
  scope: TenantScope,
): WorkflowRecord {
  const workflowRecord = record.payload.workflowRecord;
  if (!workflowRecord || typeof workflowRecord !== "object" || Array.isArray(workflowRecord)) {
    throw new Error(
      `Workflow backend run ${record.runId} is missing an embedded workflowRecord payload.`,
    );
  }

  const rehydrated = workflowRecord as unknown as WorkflowRecord;
  return {
    ...rehydrated,
    scope,
    runId: record.runId,
    status: toFrameworkWorkflowStatus(record.status, rehydrated.status),
    currentAgentId: record.agentType,
    startedAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/** Converts framework workflow status into the generic backend lifecycle status. */
export function toBackendWorkflowRunStatus(status: WorkflowStatus): WorkflowRunStatus {
  switch (status) {
    case "queued":
      return "pending";
    case "running":
    case "awaiting-approval":
      return "running";
    case "completed":
      return "completed";
    case "failed":
    case "cancelled":
    case "timed-out":
      return "failed";
    default:
      return "failed";
  }
}

/** Converts generic backend status into framework workflow status, preserving richer payload state when possible. */
export function toFrameworkWorkflowStatus(
  status: WorkflowRunStatus,
  fallback?: WorkflowStatus,
): WorkflowStatus {
  switch (status) {
    case "pending":
      return "queued";
    case "running":
      return fallback === "awaiting-approval" ? "awaiting-approval" : "running";
    case "completed":
      return "completed";
    case "failed":
      return fallback === "cancelled" || fallback === "timed-out" ? fallback : "failed";
    default:
      return "failed";
  }
}

function buildBackendRunResult(record: WorkflowRecord): JsonValue | undefined {
  if (record.status !== "completed" && record.status !== "failed" && record.status !== "timed-out") {
    return undefined;
  }

  return {
    artifactCount: record.artifacts.length,
    totalTokens: record.tokenUsage.totalTokens,
    lastError: record.lastError
      ? ({
          code: record.lastError.code,
          message: record.lastError.message,
          retryable: record.lastError.retryable,
          details: record.lastError.details,
        } as unknown as JsonValue)
      : undefined,
    completedAt: record.completedAt ?? null,
  } satisfies JsonObject;
}

function totalRetryCount(record: WorkflowRecord): number {
  return Object.values(record.attemptByAgentId).reduce(
    (sum, attempts) => sum + Math.max(attempts - 1, 0),
    0,
  );
}

function toSerializableWorkflowRecord(record: WorkflowRecord): JsonObject {
  return record as unknown as JsonObject;
}

// TODO:
// - Add optimistic concurrency support once `WorkflowStateBackend` exposes compare-and-swap semantics.
// - Add a partial-update optimization path if the backend interface gains full-record replace support.
// - Add schema validation for the embedded workflow payload before rehydration.
// - REQUIRES: a concrete `WorkflowStateBackend` implementation registered via DI in the bootstrap layer.
