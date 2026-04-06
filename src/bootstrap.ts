// File: src/bootstrap.ts
/**
 * Bootstrap helpers for assembling the framework runtime from injected
 * repositories, adapters, registries, and agent implementations.
 */

import {
  type BackendResolutionRequest,
  type ResolvedWorkflowPersistence,
  type WorkflowBackendRegistry,
  resolveWorkflowPersistence,
} from "./backend-registry";
import { ProductionOrchestrator } from "./orchestrator";
import { DeclarativeTaskRouter } from "./orchestrator-support";
import { NotifierRegistry } from "./notifiers";
import {
  PlatformAgentRuntime,
  type PlatformAgentRuntimeDependencies,
} from "./runtime-platforms";
import type { Notifier } from "./types";
import type { AgentRuntime, AgentOrchestrator } from "./types";
import type {
  AgentRegistry,
  OrchestratorDependencies,
  OrchestratorConfig,
  TeamRepository,
  WorkflowStateStore,
} from "./orchestrator-support";
import type {
  ApprovalGateway,
  AuditLogger,
  LearningEngine,
  MemoryStore,
  MessageBus,
  PromptSecurityScanner,
  RuntimePlatformAdapter,
  SessionStateStore,
  SkillRegistry,
  TenantScope,
} from "./types";

/** Registers executable agent runtimes by id for orchestrator lookup. */
export class StaticAgentRegistry implements AgentRegistry {
  private readonly runtimes = new Map<string, AgentRuntime>();

  /** Creates a registry from a set of concrete agent runtime implementations. */
  constructor(agentRuntimes: AgentRuntime[] = []) {
    for (const runtime of agentRuntimes) {
      this.register(runtime);
    }
  }

  /** Registers or replaces an agent runtime using its declared id. */
  register(runtime: AgentRuntime): void {
    this.runtimes.set(runtime.definition.id, runtime);
  }

  /** Resolves an agent runtime by id. */
  async get(_: TenantScope, agentId: string): Promise<AgentRuntime | null> {
    return this.runtimes.get(agentId) ?? null;
  }
}

/** Input dependencies required to assemble a working orchestrator runtime. */
export interface FrameworkBootstrapDependencies {
  teamRepository: TeamRepository;
  workflowStore: WorkflowStateStore;
  sessionStateStore: SessionStateStore;
  memoryStore: MemoryStore;
  skillRegistry: SkillRegistry;
  messageBus: MessageBus;
  approvalGateway: ApprovalGateway;
  auditLogger: AuditLogger;
  agentRuntimes: AgentRuntime[];
  learningEngine?: LearningEngine;
  promptSecurityScanner?: PromptSecurityScanner;
  notifiers?: Notifier[];
  config?: Partial<OrchestratorConfig>;
}

/** Materialized runtime bundle returned by the bootstrap helper. */
export interface FrameworkRuntime {
  agentRegistry: StaticAgentRegistry;
  notifierRegistry: NotifierRegistry;
  orchestrator: AgentOrchestrator;
}

/** Bootstrap input that resolves workflow storage from a named backend registration. */
export interface BackendResolvedFrameworkBootstrapDependencies extends Omit<
  FrameworkBootstrapDependencies,
  "workflowStore"
> {
  workflowPersistence: ResolvedWorkflowPersistence;
}

/** Creates the orchestrator dependency graph from injected infrastructure. */
export function createOrchestratorDependencies(
  deps: FrameworkBootstrapDependencies,
): OrchestratorDependencies {
  const agentRegistry = new StaticAgentRegistry(deps.agentRuntimes);
  const notifierRegistry = new NotifierRegistry();

  for (const notifier of deps.notifiers ?? []) {
    notifierRegistry.register(notifier);
  }

  return {
    teamRepository: deps.teamRepository,
    agentRegistry,
    workflowStore: deps.workflowStore,
    sessionStateStore: deps.sessionStateStore,
    memoryStore: deps.memoryStore,
    skillRegistry: deps.skillRegistry,
    taskRouter: new DeclarativeTaskRouter(),
    messageBus: deps.messageBus,
    approvalGateway: deps.approvalGateway,
    auditLogger: deps.auditLogger,
    ...(deps.learningEngine ? { learningEngine: deps.learningEngine } : {}),
    ...(deps.promptSecurityScanner ? { promptSecurityScanner: deps.promptSecurityScanner } : {}),
    ...(
      Object.keys(notifierRegistry.toRecord()).length > 0
        ? { notifiers: notifierRegistry.toRecord() }
        : {}
    ),
    ...(deps.config ? { config: deps.config } : {}),
  };
}

/** Assembles a ready-to-use framework runtime from concrete dependencies. */
export function createFrameworkRuntime(
  deps: FrameworkBootstrapDependencies,
): FrameworkRuntime {
  const agentRegistry = new StaticAgentRegistry(deps.agentRuntimes);
  const notifierRegistry = new NotifierRegistry();

  for (const notifier of deps.notifiers ?? []) {
    notifierRegistry.register(notifier);
  }

  const orchestratorDeps = createOrchestratorDependencies(deps);
  const orchestrator = new ProductionOrchestrator({
    ...orchestratorDeps,
    agentRegistry,
  });

  return {
    agentRegistry,
    notifierRegistry,
    orchestrator,
  };
}

/** Assembles a framework runtime when workflow persistence is already resolved from a backend. */
export function createFrameworkRuntimeFromResolvedBackend(
  deps: BackendResolvedFrameworkBootstrapDependencies,
): FrameworkRuntime {
  return createFrameworkRuntime({
    ...deps,
    workflowStore: deps.workflowPersistence.workflowStore,
  });
}

/** Resolves a named workflow backend and assembles a framework runtime from it. */
export async function createFrameworkRuntimeFromBackendRegistry(args: {
  backendRegistry: WorkflowBackendRegistry;
  backend: BackendResolutionRequest;
  framework: Omit<FrameworkBootstrapDependencies, "workflowStore">;
}): Promise<{
  runtime: FrameworkRuntime;
  workflowPersistence: ResolvedWorkflowPersistence;
}> {
  const workflowPersistence = await resolveWorkflowPersistence(
    args.backendRegistry,
    args.backend,
  );

  return {
    runtime: createFrameworkRuntime({
      ...args.framework,
      workflowStore: workflowPersistence.workflowStore,
    }),
    workflowPersistence,
  };
}

/** Utility for wiring notifiers into a registry incrementally. */
export function createNotifierRegistry(notifiers: Notifier[] = []): NotifierRegistry {
  const registry = new NotifierRegistry();
  for (const notifier of notifiers) {
    registry.register(notifier);
  }
  return registry;
}

/** Builds one generic LLM-backed runtime per agent using the supplied platform adapter. */
export function createPlatformAgentRuntimes(args: {
  agents: AgentRuntime["definition"][];
  platformAdapter: RuntimePlatformAdapter;
  runtimeDependencies: PlatformAgentRuntimeDependencies;
}): AgentRuntime[] {
  return args.agents.map(
    (definition) =>
      new PlatformAgentRuntime(definition, {
        ...args.runtimeDependencies,
        platformAdapter: args.platformAdapter,
      }),
  );
}

// TODO:
// - Add bootstrap helpers for provider adapter registration once concrete SDK adapters exist.
// - Add a runtime health-check surface for verifying secrets, providers, memory, and notifications.
// - Add workspace-scoped bootstrap policies for multi-tenant deployment presets.
// - REQUIRES: concrete workflow store or workflow backend registrations, message bus, approval gateway, audit logger, and agent runtime implementations.
