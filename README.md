<!-- File: README.md -->
# Multi-Agent Framework

Production-oriented TypeScript framework for orchestrating specialized agents with:

- hybrid message-passing orchestration
- vector memory plus key-value session state
- serializable JSON/YAML skills
- multi-provider LLM routing with token budgets and fallbacks
- low-code team definitions
- enterprise approval, audit, and notification hooks

## Architecture Overview

```text
+--------------------+      +------------------------+      +----------------------+
| Team YAML / JSON   | ---> | ProductionOrchestrator | ---> | RuntimePlatformAdapter|
| skills/*.yaml      |      | task routing + handoff |      | Claude/Cursor/Agents |
+--------------------+      +-----------+------------+      +-----------+----------+
                                          |                               |
                                          v                               v
                               +---------------------+         +---------------------+
                               | Message Bus / Queue |         | BudgetAwareLLMGateway|
                               | immutable messages  |         | optimize + fallback |
                               +----------+----------+         +----------+----------+
                                          |                               |
                                          v                               v
                               +---------------------+         +----------------------+
                               | Workflow Store      |         | Provider Adapters    |
                               | run state + replay  |         | OpenAI/Anthropic/    |
                               +---------------------+         | Gemini/Groq/Ollama   |
                                                               +----------------------+

+----------------------+     +----------------------+      +----------------------+
| Session State Store  | <-> | Memory Snapshot      | <--> | Vector Memory Store  |
| Redis-like KV        |     | session + semantic   |      | semantic + skill mem |
+----------------------+     +----------------------+      +----------------------+

+----------------------+     +----------------------+      +----------------------+
| Skill Registry       | --> | Learning Engine      | -->  | Notification Adapters|
| Git + learned store  |     | routing + skill learn|      | Telegram/Discord/WA |
+----------------------+     +----------------------+      +----------------------+
```

## Design Notes

### Core Layers

1. `src/types.ts`
   Defines the minimal swappable contracts for orchestrator, memory, skills, LLM gateway, approvals, audit, notifiers, and runtime platforms.
2. `src/orchestrator.ts`
   Owns workflow lifecycle, retry boundaries, message emission, handoff control, approval pauses, and completion/failure notifications.
3. `src/memory.ts` and `src/skills.ts`
   Split persistence between cheap session state, semantic memory, and learned skill storage so retrieval stays fast while long-term storage remains controllable.
4. `src/llm-gateway.ts` and `src/provider-adapters.ts`
   Enforce token budgets, prompt compaction, provider fallback, and circuit protection behind one normalized provider interface.
5. `src/notifiers/index.ts`
   Delivers final outputs through channel adapters without leaking provider-specific APIs into orchestration logic.

### Handoff Protocol

- Agents return a canonical `AgentResult`.
- `AgentResult.handoff.disposition` drives the next step: `complete`, `route`, `retry`, `await-approval`, `fail`, or `noop`.
- `targetAgentId` is optional; if absent, the router resolves the next agent from low-code route rules or learned routing signals.
- Artifacts, memory writes, audit events, and learned skill candidates are packaged with the same result envelope so the orchestrator can persist them atomically per hop.

### Persistent Data Model

- Session continuity uses `SessionStateStore` for cheap mutable per-session state such as checkpoints and approval context.
- Cross-session recall uses `MemoryStore` with `MemoryRecord` documents in `semantic`, `skill`, `session`, and `audit` namespaces.
- Skill definitions remain serializable YAML/JSON in Git, while learned skills are stored separately and optionally indexed back into semantic memory for retrieval.
- Tenant isolation is enforced through `TenantScope` keys on teams, memory namespaces, session keys, workflow records, audit events, and notifications.

### Failure Strategy

- LLM timeout: retried according to the agent retry policy and then failed over through gateway model fallback.
- Agent loop or runaway handoff: blocked by hop, nested handoff, runtime, and consecutive failure limits.
- Malformed model output: normalized into a framework error, retried when safe, and escalated to workflow failure if retries are exhausted.
- Prompt injection or privileged action risk: blocked during security preflight or routed to human approval before execution.
- Provider instability: isolated with per-provider circuit breaking in the gateway and optional queue-level circuit breaking in `src/workflow-engine.ts`.

## Implemented Layers

- Shared contracts: `src/types.ts`
- Orchestration runtime: `src/orchestrator.ts`
- Orchestrator support contracts: `src/orchestrator-support.ts`
- Memory layer: `src/memory.ts`
- Skill registry: `src/skills.ts`
- Team repository: `src/teams.ts`
- Workflow state persistence: `src/workflow-state.ts`
- Generic workflow backend contracts: `src/workflow-backend.ts`
- Generic-backend to orchestrator-store bridge: `src/workflow-backend-adapter.ts`
- Backend registry and DI resolution: `src/backend-registry.ts`
- LLM gateway: `src/llm-gateway.ts`
- Concrete provider adapters: `src/provider-adapters.ts` (`OpenAI`, `Anthropic`, `Google Gemini`, `Groq`, `Ollama`)
- Runtime platform adapters: `src/runtime-platforms.ts`
- Bootstrap helpers: `src/bootstrap.ts`
- End-to-end bootstrap example: `src/example-bootstrap.ts`
- Notification adapters: `src/notifiers/index.ts`
- Example team: `teams/dev-team.yaml`

## Install

This repository currently provides the framework core and integration contracts.
You still need to add your concrete infrastructure adapters.

Install dependencies:

```bash
npm install
```

Build and typecheck:

```bash
npm run build
npm run typecheck
```

Bundled package dependency:

```bash
npm install yaml
```

Provider and backend adapters you will wire separately:

- OpenAI / Anthropic / Gemini / Groq / Ollama SDK or HTTP clients
- Redis-compatible key-value client
- Vector store client for Chroma, Pinecone, or another backend

## Configure

1. Use or extend the concrete provider adapters in `src/provider-adapters.ts` for `OpenAI`, `Anthropic`, `Google Gemini`, `Groq`, and `Ollama`.
2. Create a vector adapter implementing `VectorStoreClient` from `src/memory.ts`.
3. Create a key-value adapter implementing `KeyValueStoreClient` from `src/memory.ts`.
4. Create a learned-skill persistence adapter implementing `SkillPersistenceStore` from `src/skills.ts`.
5. Create a team repository with `FileSystemTeamRepository` from `src/teams.ts` and a real YAML parser.
6. Choose either the generic backend interface in `src/workflow-backend.ts` or the orchestrator-facing persistence wrapper in `src/workflow-state.ts`. If you start with the generic backend, register a `BackendFactory` in `src/backend-registry.ts` and bridge it into the orchestrator using `WorkflowBackendStateStoreAdapter` from `src/workflow-backend-adapter.ts`.
7. Provide a secret source implementing `SecretProvider` from `src/types.ts`.
8. Choose a runtime platform adapter from `src/runtime-platforms.ts` for `Claude Code`, `Cursor`, or `OpenAI Agents SDK`.
9. Register `TelegramNotifier`, `DiscordNotifier`, or `WhatsAppNotifier` with real channel secrets and destination resolution if `destinationRef` is symbolic.

## Run First Team

Load the example [dev-team.yaml](file:///c:/Users/maexg/Desktop/tenClaw/teams/dev-team.yaml) and wire it into the orchestrator. A full assembly reference now lives in [example-bootstrap.ts](file:///c:/Users/maexg/Desktop/tenClaw/src/example-bootstrap.ts):

```ts
import { createExampleRuntime } from "./src/example-bootstrap";

// REQUIRES:
// - concrete LLM provider adapters or the injected SDK clients expected by `src/provider-adapters.ts`
// - prompt assets and real prompt-template loading
// - concrete workflow store, message bus, approval gateway, audit logger, and secret provider
// - concrete vector and key-value clients
// - a real YAML parser, e.g. `parse` from `yaml`
```

Example bootstrap shape:

```ts
const { runtime, team } = await createExampleRuntime({
  scope: {
    tenantId: "tenant-acme",
    workspaceId: "workspace-core-platform",
  },
  teamId: "dev-team",
  parseYaml,
  llmGateway,
  promptTemplateLoader,
  vectorClient,
  keyValueClient: kvClient,
  learnedSkillStore,
  workflowStore,
  messageBus,
  approvalGateway,
  auditLogger,
  secretProvider,
  notifiers: {
    telegram: {
      botTokenSecretKey: "TELEGRAM_BOT_TOKEN",
    },
  },
});
```

You can also import the framework from the public package barrel:

```ts
import {
  ProductionOrchestrator,
  BudgetAwareLLMGateway,
  createFrameworkRuntime,
  createWorkflowBackendRegistry,
} from "./dist";
```

Start a workflow with a tenant-scoped request:

```ts
const runId = await orchestrator.startWorkflow({
  scope: {
    tenantId: "tenant-acme",
    workspaceId: "workspace-core-platform",
    environment: "dev",
  },
  teamId: "dev-team",
  sessionId: "session-001",
  requesterId: "user-123",
  goal: "Add retry-aware Telegram delivery to the notification layer",
  input: {
    repository: "tenClaw",
  },
});
```

Resolve workflow persistence from a named backend factory:

```ts
import {
  createFrameworkRuntimeFromBackendRegistry,
} from "./src/bootstrap";
import { createWorkflowBackendRegistry } from "./src/backend-registry";

const backendRegistry = createWorkflowBackendRegistry([
  {
    name: "primary-workflow-backend",
    factory: ({ scope, config }) => {
      // REQUIRES: return a concrete WorkflowStateBackend implementation.
      throw new Error(`Not implemented for ${scope?.tenantId ?? "default"} scope.`);
    },
  },
]);

const { runtime, workflowPersistence } = await createFrameworkRuntimeFromBackendRegistry({
  backendRegistry,
  backend: {
    name: "primary-workflow-backend",
    scope: {
      tenantId: "tenant-acme",
      workspaceId: "workspace-core-platform",
    },
  },
  framework: {
    teamRepository,
    sessionStateStore,
    memoryStore,
    skillRegistry,
    messageBus,
    approvalGateway,
    auditLogger,
    agentRuntimes,
  },
});
```

## Execution Model

- The orchestrator owns workflow state and emits immutable bus messages.
- Agents communicate by returning `AgentResult` plus a typed `handoff`.
- Memory is split between session state and semantic recall.
- Skills are loaded from disk and merged with learned runtime skills.
- The LLM gateway enforces token budgets before and after provider calls.
- Runtime adapters normalize prompt and result handling for `Claude Code`, `Cursor`, and `OpenAI Agents SDK`.
- External shell execution still requires explicit human approval.

## Current Gaps

- Provider adapter wrappers are present, but concrete SDK or HTTP client instances and credentials still need to be supplied.
- Concrete vector and key-value backends are not wired yet.
- Concrete workflow-state document/index backends are not wired yet.
- Concrete host-native SDK transport bindings are not wired yet.
- Team prompt assets and skill documents are not added yet.
- Durable workflow store and message bus implementations are not added yet.

## Next Recommended Step

Implement remaining production adapters for:

- `Gemini`, `Groq`, and `Ollama`
- Redis for session state
- Chroma or Pinecone for semantic memory
- filesystem or database-backed team repository
- Telegram / Discord / WhatsApp channel credentials and destination resolvers

<!-- TODO:
- Add package metadata and scripts once the repo bootstrapping layer is added.
- Add a full bootstrap example that instantiates repositories, adapters, and agents.
- Add deployment notes for Claude Code CLI, Cursor, and OpenAI Agents SDK adapters.
-->
