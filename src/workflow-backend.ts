// File: src/workflow-backend.ts
/**
 * Backend-agnostic workflow persistence contracts for dependency injection.
 *
 * This file intentionally contains only interfaces and types. It does not pick
 * or implement any concrete database or storage engine.
 */

import type {
  JsonObject,
  JsonValue,
  RunId,
  TenantScope,
} from "./types";

/** Minimal lifecycle states tracked by the generic workflow backend contract. */
export type WorkflowRunStatus = "pending" | "running" | "completed" | "failed";

/** Serializable workflow run record stored by a backend implementation. */
export interface WorkflowRunRecord {
  runId: RunId;
  agentType: string;
  status: WorkflowRunStatus;
  payload: JsonObject;
  result?: JsonValue;
  retryCount: number;
  createdAt: string;
  updatedAt: string;
}

/** Generic backend contract for durable workflow run persistence. */
export interface WorkflowStateBackend {
  /**
   * Saves a newly created workflow run for the provided tenant scope.
   *
   * Implementations should treat this as a create/insert operation and may
   * reject duplicate `runId` values within the same scope.
   */
  saveRun(scope: TenantScope, record: WorkflowRunRecord): Promise<void>;

  /** Loads a workflow run by tenant scope and run id. */
  getRun(scope: TenantScope, runId: RunId): Promise<WorkflowRunRecord | null>;

  /**
   * Updates only the status-oriented fields of a workflow run.
   *
   * `patch` is intentionally narrow so runtimes can change status, retry
   * counters, results, and timestamps without rewriting the full record.
   */
  updateRunStatus(
    scope: TenantScope,
    runId: RunId,
    patch: {
      status: WorkflowRunStatus;
      result?: JsonValue;
      retryCount?: number;
      updatedAt: string;
    },
  ): Promise<void>;

  /** Lists workflow runs for one agent type within the provided tenant scope. */
  listRunsByAgent(
    scope: TenantScope,
    agentType: string,
    options?: {
      limit?: number;
      status?: WorkflowRunStatus;
    },
  ): Promise<WorkflowRunRecord[]>;

  /** Permanently deletes a workflow run by tenant scope and run id. */
  deleteRun(scope: TenantScope, runId: RunId): Promise<void>;
}

/**
 * Factory contract for runtime DI registration of workflow backends.
 *
 * The caller owns how factories are registered or resolved. This type only
 * standardizes the shape expected by bootstrap layers.
 */
export type BackendFactory<
  TBackend extends WorkflowStateBackend = WorkflowStateBackend,
  TConfig extends JsonObject = JsonObject,
> = (args: {
  scope?: TenantScope;
  config?: TConfig;
}) => Promise<TBackend> | TBackend;

// TODO:
// - Add optimistic concurrency fields if workflow backends need compare-and-swap semantics.
// - Add cursor-based list pagination once dashboard and audit surfaces are finalized.
// - Add typed backend capability metadata for transactions, TTL, and secondary indexes.
// - REQUIRES: a concrete backend implementation plus DI registration in the runtime bootstrap layer.
