// File: src/backend-registry.ts
/**
 * Registry and resolver helpers for workflow backend factories.
 *
 * This layer keeps DI registration separate from concrete backend
 * implementations while making it easy to bridge named backends into the
 * orchestrator-facing `WorkflowStateStore`.
 */

import type { WorkflowStateStore } from "./orchestrator-support";
import {
  WorkflowBackendRunReader,
  WorkflowBackendStateStoreAdapter,
} from "./workflow-backend-adapter";
import type {
  BackendFactory,
  WorkflowStateBackend,
} from "./workflow-backend";
import type {
  JsonObject,
  TenantScope,
} from "./types";

/** One named backend registration stored in the registry. */
export interface BackendRegistration<
  TBackend extends WorkflowStateBackend = WorkflowStateBackend,
  TConfig extends JsonObject = JsonObject,
> {
  name: string;
  factory: BackendFactory<TBackend, TConfig>;
  description?: string;
}

/** Request used to resolve a named backend factory at runtime. */
export interface BackendResolutionRequest<TConfig extends JsonObject = JsonObject> {
  name: string;
  scope?: TenantScope;
  config?: TConfig;
}

/** Fully materialized workflow persistence bundle resolved from a named backend. */
export interface ResolvedWorkflowPersistence {
  backend: WorkflowStateBackend;
  workflowStore: WorkflowStateStore;
  runReader: WorkflowBackendRunReader;
}

/** In-memory registry for named workflow backend factory registrations. */
export class WorkflowBackendRegistry {
  private readonly registrations = new Map<string, BackendRegistration>();

  /** Creates a registry from an optional initial set of backend registrations. */
  constructor(registrations: BackendRegistration[] = []) {
    for (const registration of registrations) {
      this.register(registration);
    }
  }

  /** Registers or replaces a backend factory by name. */
  register(registration: BackendRegistration): void {
    this.registrations.set(registration.name, registration);
  }

  /** Returns one registration by name. */
  get(name: string): BackendRegistration | undefined {
    return this.registrations.get(name);
  }

  /** Lists all currently registered backends. */
  list(): BackendRegistration[] {
    return [...this.registrations.values()];
  }

  /** Resolves a named backend instance using the stored factory registration. */
  async resolve(request: BackendResolutionRequest): Promise<WorkflowStateBackend> {
    const registration = this.registrations.get(request.name);
    if (!registration) {
      throw new Error(`Workflow backend "${request.name}" is not registered.`);
    }

    return registration.factory({
      ...(request.scope ? { scope: request.scope } : {}),
      ...(request.config ? { config: request.config } : {}),
    });
  }
}

/** Resolves a named backend and bridges it into the orchestrator workflow store shape. */
export async function resolveWorkflowPersistence(
  registry: WorkflowBackendRegistry,
  request: BackendResolutionRequest,
): Promise<ResolvedWorkflowPersistence> {
  const backend = await registry.resolve(request);

  return {
    backend,
    workflowStore: new WorkflowBackendStateStoreAdapter(backend),
    runReader: new WorkflowBackendRunReader(backend),
  };
}

/** Convenience helper for creating a registry from a plain registration list. */
export function createWorkflowBackendRegistry(
  registrations: BackendRegistration[] = [],
): WorkflowBackendRegistry {
  return new WorkflowBackendRegistry(registrations);
}

// TODO:
// - Add scoped fallback resolution so workspaces can override tenant-level backend defaults.
// - Add backend capability descriptors for transactions, TTL, and list-query support.
// - Add lazy singleton caching for backend factories that should only initialize once per process.
// - REQUIRES: concrete `BackendFactory` registrations supplied by the application bootstrap layer.
