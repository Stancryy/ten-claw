# TenClaw

TypeScript framework for multi-agent team orchestration, focused on production readiness, multi-tenant isolation, hybrid memory, declarative/learned routing, and multi-provider LLM integration.

## Overview

TenClaw organizes workflows of specialized agents (for example: `planner`, `coder`, `reviewer`, `tester`, `security-auditor`) and content pipelines (`researcher`, `writer`, `editor`) through:

- message-based orchestration with typed handoff;
- persistent workflow state and semantic memory;
- YAML/JSON skill registry with support for learned skills;
- LLM gateway with token budgeting, fallback, and circuit breaker;
- human approvals, audit logging, and notifications (Telegram/Discord/WhatsApp);
- decoupled bootstrap interfaces for plugging in real infrastructure.

## Core Features

- **Production orchestrator**: `ProductionOrchestrator` controls the full workflow lifecycle (`queued`, `running`, `awaiting-approval`, `completed`, `failed`, `timed-out`, `cancelled`).
- **Explicit agent handoff**: driven by `AgentResult.handoff.disposition` (`route`, `retry`, `complete`, `await-approval`, etc.).
- **Declarative + learned routing**: `DeclarativeTaskRouter` with `team.yaml` rules and `LearningEngine` suggestions.
- **Hybrid memory**: KV session state (`SessionStateStore`) + vector memory (`MemoryStore`) + skill indexing.
- **Versionable file-based skills**: libraries under `skills/` with learned skills under `skills/learned/`.
- **Multi-provider LLM integration**: OpenAI, Anthropic, Google Gemini, Groq, and Ollama via adapters.
- **Durable execution infrastructure**: modules for durable queues, workflow engine, idempotency, DLQ, and circuit breaker.
- **Observability and compliance**: Redis Streams audit logging and human approval trail.

## Architecture (Summary)

```text
Team YAML + Skills YAML/JSON
        |
        v
ProductionOrchestrator
  |-> TeamRepository / AgentRegistry
  |-> TaskRouter (declarative + learned hints)
  |-> WorkflowStateStore
  |-> SessionStateStore + MemoryStore + SkillRegistry
  |-> MessageBus / DurableTaskQueue
  |-> ApprovalGateway / AuditLogger / Notifiers
  |-> LearningEngine (optional)
        |
        v
PlatformAgentRuntime -> RuntimePlatformAdapter -> LLMGateway -> ProviderAdapters
```

## Technologies

- **Language and build**
  - TypeScript 5 (`strict: true`)
  - Node.js `>=20`
- **LLM/AI**
  - `openai`
  - `@anthropic-ai/sdk`
  - adapters for Gemini, Groq, and Ollama
  - `js-tiktoken` (token approximation/counting)
- **Persistence and memory**
  - `ioredis` (state/streams/queue)
  - `chromadb` + `chromadb-default-embed` (vectors)
- **Config and serialization**
  - `dotenv`
  - `yaml`
- **Local infrastructure**
  - `docker-compose` with Redis and ChromaDB

## Prerequisites

- Node.js 20+
- npm
- Docker + Docker Compose (for `infra:up`)

## Installation

```bash
npm install
```

Build and type check:

```bash
npm run build
npm run typecheck
```

## Configuration

1. Copy `.env.example` to `.env`.
2. Fill in credentials for the LLM providers you want to use.
3. Start local infrastructure:

```bash
npm run infra:up
```

Important variables:

- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `LLM_PROVIDER` (`openai`, `anthropic`, `lmstudio`, `ollama`)
- `OPENAI_BASE_URL` (optional for compatible endpoints)
- `REDIS_URL`
- `CHROMA_URL`
- `TEAM_ID` (for example: `dev-team`, `business-team`)
- `TEAMS_ROOT`, `SKILLS_ROOT`

## Usage

### Main demo

```bash
npm run demo
```

The `examples/run.ts` script:

- loads `.env`;
- initializes Redis + Chroma;
- loads a team (`dev-team` or `business-team`);
- assembles runtime/orchestrator;
- executes the full end-to-end workflow;
- optionally sends Telegram notifications.

### Provider adapter test

```bash
npx ts-node examples/test-providers.ts
```

## API Example

### Start a workflow

```ts
import { ProductionOrchestrator, type WorkflowRequest } from "./src";

const request: WorkflowRequest = {
  scope: { tenantId: "demo-tenant", workspaceId: "demo-workspace", environment: "dev" },
  teamId: "dev-team",
  sessionId: "session-001",
  requesterId: "user-123",
  goal: "Create an email validator with tests",
  input: { language: "typescript" },
};

const runId = await orchestrator.startWorkflow(request);
```

### Build runtime from backend registry

```ts
import {
  createFrameworkRuntimeFromBackendRegistry,
  createWorkflowBackendRegistry,
} from "./src";
```

## Directory Structure

```text
ten-claw/
  src/                  # Framework core (orchestration, types, adapters, backends)
  examples/             # Demo and provider test scripts
  teams/                # Team definitions (YAML)
  skills/               # Skills by domain (dev/business/shared/learned)
  prompts/              # Prompts by agent role
  CONTRIBUTING.md       # Contribution guide
  LICENSE               # MIT license
  docker-compose.yml    # Local Redis + ChromaDB
  .env.example          # Environment template
```

## API Reference (Main Modules)

Public surface is exported by `src/index.ts`.

- `types.ts`
  - core contracts (`WorkflowRequest`, `AgentResult`, `SkillDefinition`, `LLMRequest`, `MemoryStore`, etc.).
- `orchestrator.ts`
  - `ProductionOrchestrator`.
- `orchestrator-support.ts`
  - `WorkflowRecord`, `DeclarativeTaskRouter`, budget/error helpers.
- `bootstrap.ts`
  - `createFrameworkRuntime`, `createFrameworkRuntimeFromBackendRegistry`, `StaticAgentRegistry`.
- `llm-gateway.ts`
  - `BudgetAwareLLMGateway`, `DefaultPromptOptimizer`.
- `provider-adapters.ts`
  - `OpenAIProviderAdapter`, `AnthropicProviderAdapter`, `GeminiProviderAdapter`, `GroqProviderAdapter`, `OllamaProviderAdapter`.
- `sdk-clients.ts`
  - `OpenAISDKClient`, `AnthropicSDKClient`, `ApproximateTokenCounter`.
- `memory.ts`
  - `ScopedMemoryStore`, `ScopedSessionStateStore`, `MemorySnapshotBuilder`, `PersistentMemoryCoordinator`.
- `memory-backends.ts`
  - `RedisKVClient`, `ChromaVectorClient`.
- `skills.ts`
  - `CompositeSkillRegistry`, `FileSystemSkillSource`, `FileSystemSkillRegistry`, `SkillMemoryIndexer`.
- `teams.ts`
  - `FileSystemTeamRepository`, JSON/YAML codecs.
- `workflow-state.ts`
  - `ScopedWorkflowStateStore`, `WorkflowRunReader`.
- `workflow-backend.ts` / `workflow-backend-adapter.ts` / `backend-registry.ts`
  - generic backend contract and bridge to `WorkflowStateStore`.
- `workflow-engine.ts` / `workflow-adapters.ts` / `vendor-adapters.ts` / `workflow-backends.ts`
  - durable engine/queue, idempotency/circuit breaker stores, and Redis/Bull-like integrations.
- `notifiers/`
  - `TelegramNotifier`, `DiscordNotifier`, `WhatsAppNotifier`, `NotifierRegistry`.
- `approval-gateway.ts`
  - `CliApprovalGateway` (interactive CLI approval).
- `audit-logger.ts`
  - `RedisAuditLogger`.
- `learning-engine.ts`
  - `LearningEngineImpl` (pattern extraction, learned skills, routing score updates).

## Included Teams and Skills

- **Teams**
  - `teams/dev-team.yaml`: 5-agent pipeline (`planner -> coder -> reviewer -> tester -> security-auditor`).
  - `teams/business-team.yaml`: 3-agent pipeline (`researcher -> writer -> editor`).
- **Prompts**
  - detailed prompts per role in `prompts/dev/` and `prompts/business/`.
- **Skills**
  - `skills/dev`: planning, TypeScript coding, code review, testing, security audit.
  - `skills/business`: research, writing, and editing.
  - `skills/shared`: reusable generic skills across scenarios.
  - `skills/learned`: auto-generated skills from the learning engine (pending review/approval).

## Current State and Limitations

- There are TODOs in the codebase for production completion (for example: DLQ replay, stronger schema validation, LLM streaming, health checks, and complete adapters for some scenarios).
- Some modules are partially implemented in the durable flow (`ack/release` are simplified in `RedisTaskQueue`).
- `LearningEngineImpl` still has unimplemented methods (`approveSkill`, `rejectSkill`, YAML import).
- Telegram notifier implementation overlaps between `src/notifiers/index.ts` and `src/notifiers/telegram.ts`.
- License inconsistency: `LICENSE` is MIT, but `package.json` currently declares `"license": "UNLICENSED"`.

## Dependencies

Dependencies are defined in `package.json`.

- **runtime**: `openai`, `@anthropic-ai/sdk`, `ioredis`, `chromadb`, `yaml`, `dotenv`, `js-tiktoken`
- **dev**: `typescript`, `@types/node`

## Contributing

See `CONTRIBUTING.md`.

Recommended flow:

1. Fork and create a feature branch.
2. Run `npm install`.
3. Run `npm run typecheck` and `npm run build`.
4. Validate demo flow (`npm run demo`) when applicable.
5. Open a PR with clear description and impact.

## License

This project includes an MIT license in the `LICENSE` file.

## Suggested Short-Term Roadmap

- finalize the durable queue layer (`ack/release`, DLQ, replay);
- unify Telegram notifier implementation;
- complete pending learning engine APIs;
- align `package.json` license metadata with the `LICENSE` file;
- add automated tests for critical modules (workflow/backends/LLM gateway).
