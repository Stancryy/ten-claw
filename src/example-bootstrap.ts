// File: src/example-bootstrap.ts
/**
 * End-to-end bootstrap example for loading a low-code team, shared skills,
 * runtime adapters, memory, and notification channels using only injected
 * production dependencies.
 */

import {
  createFrameworkRuntime,
  createPlatformAgentRuntimes,
  type FrameworkRuntime,
} from "./bootstrap";
import {
  MemorySnapshotBuilder,
  PersistentMemoryCoordinator,
  ScopedMemoryStore,
  ScopedSessionStateStore,
  type KeyValueStoreClient,
  type VectorStoreClient,
} from "./memory";
import {
  DiscordNotifier,
  TelegramNotifier,
  WhatsAppNotifier,
  type DiscordNotifierConfig,
  type TelegramNotifierConfig,
  type WhatsAppNotifierConfig,
} from "./notifiers";
import type { WorkflowStateStore } from "./orchestrator-support";
import {
  ClaudeCodeRuntimePlatformAdapter,
  CursorRuntimePlatformAdapter,
  OpenAIAgentsSdkRuntimePlatformAdapter,
  type PromptTemplateLoader,
} from "./runtime-platforms";
import {
  CompositeSkillRegistry,
  FileSystemSkillSource,
  JsonSkillDocumentCodec,
  SkillMemoryIndexer,
  createYamlSkillDocumentCodec,
  type SkillPersistenceStore,
} from "./skills";
import {
  FileSystemTeamRepository,
  JsonTeamDocumentCodec,
  createYamlTeamDocumentCodec,
} from "./teams";
import type {
  ApprovalGateway,
  AuditLogger,
  LLMGateway,
  LearningEngine,
  MessageBus,
  PromptSecurityScanner,
  RuntimePlatformAdapter,
  SecretProvider,
  TeamDefinition,
  TenantScope,
} from "./types";

/** Optional notifier configuration bundle for one workspace runtime. */
export interface ExampleNotifierConfig {
  telegram?: TelegramNotifierConfig;
  discord?: DiscordNotifierConfig;
  whatsapp?: WhatsAppNotifierConfig;
}

/** Filesystem roots used by the bootstrap example. */
export interface ExamplePathConfig {
  teamsRootDirectory: string;
  skillsRootDirectory: string;
}

/** Injected production dependencies required by the example factory. */
export interface ExampleRuntimeFactoryDependencies {
  scope: TenantScope;
  teamId: string;
  parseYaml: (content: string) => unknown;
  llmGateway: LLMGateway;
  promptTemplateLoader: PromptTemplateLoader;
  vectorClient: VectorStoreClient;
  keyValueClient: KeyValueStoreClient;
  learnedSkillStore: SkillPersistenceStore;
  workflowStore: WorkflowStateStore;
  messageBus: MessageBus;
  approvalGateway: ApprovalGateway;
  auditLogger: AuditLogger;
  secretProvider: SecretProvider;
  learningEngine?: LearningEngine;
  promptSecurityScanner?: PromptSecurityScanner;
  notifiers?: ExampleNotifierConfig;
  paths?: Partial<ExamplePathConfig>;
}

/** Materialized objects created by the example bootstrap flow. */
export interface ExampleRuntimeBundle {
  runtime: FrameworkRuntime;
  team: TeamDefinition;
  memorySnapshotBuilder: MemorySnapshotBuilder;
  memoryCoordinator: PersistentMemoryCoordinator;
}

/** Creates a fully wired framework runtime around a filesystem-backed team and skill library. */
export async function createExampleRuntime(
  deps: ExampleRuntimeFactoryDependencies,
): Promise<ExampleRuntimeBundle> {
  const paths = {
    teamsRootDirectory: "teams",
    skillsRootDirectory: "skills",
    ...deps.paths,
  };
  const memoryStore = new ScopedMemoryStore(deps.vectorClient);
  const sessionStateStore = new ScopedSessionStateStore(deps.keyValueClient);
  const skillRegistry = new CompositeSkillRegistry(
    new FileSystemSkillSource(
      { rootDirectory: paths.skillsRootDirectory },
      [
        new JsonSkillDocumentCodec(),
        createYamlSkillDocumentCodec(deps.parseYaml),
      ],
    ),
    deps.learnedSkillStore,
    new SkillMemoryIndexer(memoryStore),
  );
  const teamRepository = new FileSystemTeamRepository(
    { rootDirectory: paths.teamsRootDirectory },
    [
      new JsonTeamDocumentCodec(),
      createYamlTeamDocumentCodec(deps.parseYaml),
    ],
    skillRegistry,
  );
  const team = await requireTeam(teamRepository, deps.scope, deps.teamId);
  const platformAdapter = selectRuntimePlatformAdapter(team.runtimeTarget ?? "claude-code");
  const agentRuntimes = createPlatformAgentRuntimes({
    agents: team.agents,
    platformAdapter,
    runtimeDependencies: {
      llmGateway: deps.llmGateway,
      platformAdapter,
      promptTemplateLoader: deps.promptTemplateLoader,
    },
  });
  const runtime = createFrameworkRuntime({
    teamRepository,
    workflowStore: deps.workflowStore,
    sessionStateStore,
    memoryStore,
    skillRegistry,
    messageBus: deps.messageBus,
    approvalGateway: deps.approvalGateway,
    auditLogger: deps.auditLogger,
    ...(deps.learningEngine ? { learningEngine: deps.learningEngine } : {}),
    ...(deps.promptSecurityScanner ? { promptSecurityScanner: deps.promptSecurityScanner } : {}),
    agentRuntimes,
    notifiers: buildConfiguredNotifiers(deps.secretProvider, deps.notifiers),
  });

  return {
    runtime,
    team,
    memorySnapshotBuilder: new MemorySnapshotBuilder(
      sessionStateStore,
      memoryStore,
      skillRegistry,
    ),
    memoryCoordinator: new PersistentMemoryCoordinator(
      sessionStateStore,
      memoryStore,
    ),
  };
}

function selectRuntimePlatformAdapter(target: RuntimePlatformAdapter["target"]): RuntimePlatformAdapter {
  switch (target) {
    case "claude-code":
      return new ClaudeCodeRuntimePlatformAdapter();
    case "cursor":
      return new CursorRuntimePlatformAdapter();
    case "openai-agents-sdk":
      return new OpenAIAgentsSdkRuntimePlatformAdapter();
    case "custom":
      throw new Error(
        'Custom runtime targets require a caller-supplied `RuntimePlatformAdapter`.',
      );
    default:
      throw new Error(`Unsupported runtime target: ${String(target)}.`);
  }
}

function buildConfiguredNotifiers(
  secretProvider: SecretProvider,
  config?: ExampleNotifierConfig,
) {
  const notifiers = [];

  if (config?.telegram) {
    notifiers.push(
      new TelegramNotifier(
        secretProvider,
        undefined,
        undefined,
        config.telegram,
      ),
    );
  }
  if (config?.discord) {
    notifiers.push(
      new DiscordNotifier(
        secretProvider,
        undefined,
        config.discord,
      ),
    );
  }
  if (config?.whatsapp) {
    notifiers.push(
      new WhatsAppNotifier(
        secretProvider,
        undefined,
        undefined,
        config.whatsapp,
      ),
    );
  }

  return notifiers;
}

async function requireTeam(
  repository: FileSystemTeamRepository,
  scope: TenantScope,
  teamId: string,
): Promise<TeamDefinition> {
  const team = await repository.get(scope, teamId);
  if (!team) {
    throw new Error(`Team ${teamId} was not found in the configured team repository.`);
  }
  return team;
}

// TODO:
// - Add a variant that accepts a caller-supplied `RuntimePlatformAdapter` for `custom` targets.
// - Add bootstrap health checks that verify provider, memory, skill, and notifier readiness.
// - Add prompt asset discovery rooted in the workspace instead of requiring an injected loader.
// - REQUIRES: concrete LLM provider adapters, workflow store, message bus, approval gateway, audit logger, secret provider, and persistence clients.
