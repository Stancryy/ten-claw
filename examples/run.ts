// @ts-nocheck
// File: examples/run.ts
/**
 * Main entry point script demonstrating the complete framework bootstrap.
 *
 * This script initializes:
 * 1. LLM adapters (OpenAI/Anthropic)
 * 2. Memory backends (Redis KV + Chroma Vector)
 * 3. Workflow backends (Redis Queue + Redis State)
 * 4. The Orchestrator
 * 5. A test agent runtime
 *
 * Then runs a simple "Hello World" research task.
 *
 * Usage:
 *   # With OpenAI
 *   OPENAI_API_KEY=xxx CHROMA_URL=http://localhost:8000 REDIS_URL=redis://localhost:6379 npx ts-node examples/run.ts
 *
 *   # With Anthropic
 *   ANTHROPIC_API_KEY=xxx CHROMA_URL=http://localhost:8000 REDIS_URL=redis://localhost:6379 npx ts-node examples/run.ts
 *
 * @path examples/run.ts
 */

import "dotenv/config";
import { parse as parseYaml } from "yaml";
import Redis from "ioredis";
import {
  // Bootstrap helpers
  createFrameworkRuntime,
  createPlatformAgentRuntimes,
  StaticAgentRegistry,
  // Memory backends
  RedisKVClient,
  ChromaVectorClient,
  ScopedMemoryStore,
  ScopedSessionStateStore,
  MemorySnapshotBuilder,
  PersistentMemoryCoordinator,
  // Workflow backends
  RedisTaskQueue,
  RedisWorkflowStateBackend,
  WorkflowBackendStateStoreAdapter,
  // SDK clients
  OpenAISDKClient,
  AnthropicSDKClient,
  ApproximateTokenCounter,
  // Core classes
  ProductionOrchestrator,
  DeclarativeTaskRouter,
  NotifierRegistry,
  // Platform adapters
  ClaudeCodeRuntimePlatformAdapter,
  // Skill registry
  FileSystemSkillRegistry,
  // Team repository
  FileSystemTeamRepository,
  JsonTeamDocumentCodec,
  createYamlTeamDocumentCodec,
  // Approval gateway
  CliApprovalGateway,
  // Message bus
  RedisMessageBus,
  // Audit logger
  RedisAuditLogger,
  type FrameworkRuntime,
  type WorkflowRequest,
  type TenantScope,
  type AgentDefinition,
  type AgentRuntime,
  type WorkflowStateStore,
  type WorkflowRecord,
  type LLMGateway,
  type LLMRequest,
  type LLMResponse,
  type TeamDefinition,
  type SkillRegistry,
  type ApprovalGateway,
  type AuditLogger,
  type MessageBus,
  type AgentMessage,
  type TokenUsage,
  type WorkflowStatus,
  type ApprovalDecision,
  type RunId,
  type AgentResult,
  type AgentRunContext,
  type AgentArtifact,
  type HandoffDirective,
} from "../src";

// Simple runtime for local LLMs that returns plain text instead of JSON
class SimpleTextAgentRuntime implements AgentRuntime {
  constructor(
    readonly definition: AgentDefinition,
    private llmGateway: LLMGateway
  ) {}

  async execute(context: AgentRunContext): Promise<AgentResult> {
    const systemPrompt = context.agent.systemPrompt || "You are a helpful assistant.";
    const userPrompt = `Task: ${context.request.goal}`;
    
    const response = await this.llmGateway.generate({
      scope: context.scope,
      modelProfile: context.agent.modelProfile,
      prompts: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      responseFormat: "text",
      maxOutputTokens: context.tokenBudget.maxOutputTokens,
      budget: context.tokenBudget,
      metadata: {
        runId: context.runId,
        agentId: context.agent.id,
      },
    });

    // Create a simple artifact from the text response
    const artifact: AgentArtifact = {
      id: `artifact_${Date.now()}`,
      kind: "text",
      title: "Response",
      mimeType: "text/plain",
      content: response.outputText,
    };

    const handoff: HandoffDirective = {
      disposition: "complete",
      reason: "Task completed successfully.",
    };

    return {
      status: "succeeded",
      summary: response.outputText.substring(0, 200),
      structuredOutput: { response: response.outputText },
      artifacts: [artifact],
      handoff,
      tokenUsage: response.tokenUsage,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CONFIGURATION
// ─────────────────────────────────────────────────────────────────────────────

const CONFIG = {
  // LLM Provider selection
  provider: (process.env.LLM_PROVIDER as "openai" | "anthropic" | "lmstudio" | "ollama") ?? "openai",

  // Redis configuration
  redis: {
    url: process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
    host: process.env.REDIS_HOST,
    port: process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT, 10) : undefined,
    password: process.env.REDIS_PASSWORD,
  },

  // Chroma configuration
  chroma: {
    url: process.env.CHROMA_URL ?? "http://127.0.0.1:8000",
  },

  // Tenant scope for this run
  scope: {
    tenantId: process.env.TENANT_ID ?? "demo-tenant",
    workspaceId: process.env.WORKSPACE_ID ?? "demo-workspace",
    projectId: process.env.PROJECT_ID ?? "demo-project",
    environment: (process.env.ENVIRONMENT as "dev" | "staging" | "prod") ?? "dev",
  } as TenantScope,

  // Team and paths
  teamId: process.env.TEAM_ID ?? "dev-team",
  paths: {
    teamsRoot: process.env.TEAMS_ROOT ?? "./teams",
    skillsRoot: process.env.SKILLS_ROOT ?? "./skills",
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// BOOTSTRAP HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/** Creates LLM gateway based on provider configuration. */
function createLLMGateway() {
  switch (CONFIG.provider) {
    case "anthropic": {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        throw new Error("ANTHROPIC_API_KEY environment variable is required");
      }
      const client = new AnthropicSDKClient({ apiKey });
      return {
        generate: async (request: unknown) => {
          // Simplified adapter - in production use full adapter pattern
          const response = await client.create({
            model: (request as { modelProfile: { providerModelId: string } }).modelProfile.providerModelId,
            messages: (request as { prompts: Array<{ role: string; content: string }> }).prompts.map(p => ({
              role: p.role as "user" | "assistant",
              content: p.content,
            })),
            max_tokens: (request as { maxOutputTokens: number }).maxOutputTokens,
          });
          return {
            provider: "anthropic" as const,
            model: response.model,
            outputText: response.content.map(c => c.text).join(""),
            finishReason: "stop" as const,
            tokenUsage: {
              inputTokens: response.usage.input_tokens,
              outputTokens: response.usage.output_tokens,
              totalTokens: response.usage.input_tokens + response.usage.output_tokens,
            },
            latencyMs: 0,
          };
        },
        countTokens: async (request: unknown) => {
          const counter = new ApproximateTokenCounter();
          const prompts = (request as { prompts: Array<{ content: string }> }).prompts;
          const total = await Promise.all(
            prompts.map(p => counter.countText(p.content, "claude-3"))
          );
          return total.reduce((a, b) => a + b, 0);
        },
      };
    }

    case "lmstudio": {
      // LM Studio exposes an OpenAI-compatible API, usually on port 1234
      const apiKey = process.env.OPENAI_API_KEY ?? "lm-studio";
      const baseURL = process.env.OPENAI_BASE_URL ?? "http://localhost:1234/v1";
      const client = new OpenAISDKClient({ apiKey, baseURL });
      return {
        generate: async (request: unknown) => {
          const req = request as { modelProfile: { providerModelId?: string; model?: string }; prompts: Array<{ role: string; content: string }>; maxOutputTokens: number };
          // Support both 'providerModelId' (AgentDefinition type) and 'model' (team YAML format)
          const modelId = req.modelProfile.providerModelId ?? req.modelProfile.model ?? "local-model";
          const response = await client.create({
            model: modelId,
            input: req.prompts.map(p => ({
              role: p.role as "user" | "assistant" | "system",
              content: [{ type: "text" as const, text: p.content }],
            })),
            max_output_tokens: req.maxOutputTokens,
          });
          return {
            provider: "openai" as const, // Uses openai adapter under the hood
            model: response.model,
            outputText: response.output_text,
            finishReason: "stop" as const,
            tokenUsage: {
              inputTokens: response.usage?.input_tokens ?? 0,
              outputTokens: response.usage?.output_tokens ?? 0,
              totalTokens: response.usage?.total_tokens ?? 0,
            },
            latencyMs: 0,
          };
        },
        countTokens: async (request: unknown) => {
          const counter = new ApproximateTokenCounter();
          const prompts = (request as { prompts: Array<{ content: string }> }).prompts;
          const total = await Promise.all(
            prompts.map(p => counter.countText(p.content, "gpt-4"))
          );
          return total.reduce((a, b) => a + b, 0);
        },
      };
    }

    case "ollama": {
      const baseURL = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
      return {
        generate: async (request: unknown) => {
          const body = {
            model: (request as { modelProfile: { providerModelId: string } }).modelProfile.providerModelId,
            messages: (request as { prompts: Array<{ role: string; content: string }> }).prompts.map(p => ({
              role: p.role,
              content: p.content,
            })),
            stream: false,
          };
          
          const res = await fetch(`${baseURL}/api/chat`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
          
          if (!res.ok) {
            throw new Error(`Ollama API error: ${res.statusText}`);
          }
          
          const response = await res.json() as any;
          return {
            provider: "ollama" as const,
            model: response.model,
            outputText: response.message?.content ?? "",
            finishReason: "stop" as const,
            tokenUsage: {
              inputTokens: response.prompt_eval_count ?? 0,
              outputTokens: response.eval_count ?? 0,
              totalTokens: (response.prompt_eval_count ?? 0) + (response.eval_count ?? 0),
            },
            latencyMs: 0,
          };
        },
        countTokens: async (request: unknown) => {
          const counter = new ApproximateTokenCounter();
          const prompts = (request as { prompts: Array<{ content: string }> }).prompts;
          const total = await Promise.all(
            prompts.map(p => counter.countText(p.content, "llama-3"))
          );
          return total.reduce((a, b) => a + b, 0);
        },
      };
    }

    case "openai":
    default: {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        throw new Error("OPENAI_API_KEY environment variable is required");
      }
      const client = new OpenAISDKClient({ apiKey, baseURL: process.env.OPENAI_BASE_URL });
      return {
        generate: async (request: unknown) => {
          const response = await client.create({
            model: (request as { modelProfile: { providerModelId: string } }).modelProfile.providerModelId,
            input: (request as { prompts: Array<{ role: string; content: string }> }).prompts.map(p => ({
              role: p.role as "user" | "assistant" | "system",
              content: [{ type: "text" as const, text: p.content }],
            })),
            max_output_tokens: (request as { maxOutputTokens: number }).maxOutputTokens,
          });
          return {
            provider: "openai" as const,
            model: response.model,
            outputText: response.output_text,
            finishReason: "stop" as const,
            tokenUsage: {
              inputTokens: response.usage.input_tokens,
              outputTokens: response.usage.output_tokens,
              totalTokens: response.usage.total_tokens,
            },
            latencyMs: 0,
          };
        },
        countTokens: async (request: unknown) => {
          const counter = new ApproximateTokenCounter();
          const prompts = (request as { prompts: Array<{ content: string }> }).prompts;
          const total = await Promise.all(
            prompts.map(p => counter.countText(p.content, "gpt-4"))
          );
          return total.reduce((a, b) => a + b, 0);
        },
      };
    }
  }
}

/** Creates a Redis client from configuration. */
async function createRedisClient(): Promise<{
  kv: RedisKVClient;
  close: () => Promise<void>;
}> {
  const kv = new RedisKVClient({
    host: "127.0.0.1",
    port: 6379,
    password: CONFIG.redis.password,
  });

  return {
    kv,
    close: async () => {
      await kv.disconnect();
    },
  };
}

/** Creates a Chroma client from configuration. */
async function createChromaClient(): Promise<{
  vector: ChromaVectorClient;
}> {
  const vector = new ChromaVectorClient({ url: CONFIG.chroma.url });
  return { vector };
}

/** Creates a simple "Hello World" agent definition for testing. */
function createHelloWorldAgent(): AgentDefinition {
  return {
    id: "hello-world-agent",
    name: "Hello World Agent",
    role: "coder",
    description: "A simple agent that responds with a friendly greeting and can perform basic research tasks.",
    capabilities: ["text-generation", "research"],
    modelProfile: {
      provider: CONFIG.provider,
      providerModelId: CONFIG.provider === "openai" ? "gpt-4o-mini" : "claude-3-haiku-20240307",
      temperature: 0.7,
      maxOutputTokens: 1000,
    },
    executionLimits: {
      maxRuntimeMs: 30000,
      maxHopsPerRun: 10,
      maxNestedHandOffs: 5,
      maxConsecutiveFailures: 3,
    },
    tokenBudget: {
      maxInputTokens: 4000,
      maxOutputTokens: 1000,
      maxTotalTokens: 5000,
      overflowStrategy: "summarize" as const,
    },
    retryPolicy: {
      maxAttempts: 3,
      initialRetryDelayMs: 1000,
      maxRetryDelayMs: 10000,
      backoffMultiplier: 2,
      retryableErrorCodes: ["timeout", "provider-error"],
    },
    securityPolicy: {
      allowBlockedSkills: false,
      allowedToolCategories: ["read"],
      allowFileSystemReads: true,
      allowFileSystemWrites: false,
      allowNetworkRequests: false,
      allowCodeExecution: false,
      approvalRequiredFor: [],
    },
    bindings: [],
    systemPrompt: `You are a helpful AI assistant. When given a task:
1. Respond with a friendly greeting
2. Provide a concise, accurate response
3. If asked to research, provide a brief summary of findings`,
  };
}

/** Creates a simple "Research" agent definition for testing. */
function createResearchAgent(): AgentDefinition {
  return {
    id: "research-agent",
    name: "Research Agent",
    role: "researcher",
    description: "An agent specialized in conducting quick research and summarizing findings.",
    capabilities: ["research", "summarization", "analysis"],
    modelProfile: {
      provider: CONFIG.provider,
      providerModelId: CONFIG.provider === "openai" ? "gpt-4o" : "claude-3-sonnet-20240229",
      temperature: 0.5,
      maxOutputTokens: 2000,
    },
    executionLimits: {
      maxRuntimeMs: 60000,
      maxHopsPerRun: 15,
      maxNestedHandOffs: 8,
      maxConsecutiveFailures: 3,
    },
    tokenBudget: {
      maxInputTokens: 8000,
      maxOutputTokens: 2000,
      maxTotalTokens: 10000,
      overflowStrategy: "summarize" as const,
    },
    retryPolicy: {
      maxAttempts: 3,
      initialRetryDelayMs: 1000,
      maxRetryDelayMs: 10000,
      backoffMultiplier: 2,
      retryableErrorCodes: ["timeout", "provider-error"],
    },
    securityPolicy: {
      allowBlockedSkills: false,
      allowedToolCategories: ["read"],
      allowFileSystemReads: true,
      allowFileSystemWrites: false,
      allowNetworkRequests: false,
      allowCodeExecution: false,
      approvalRequiredFor: [],
    },
    bindings: [],
    systemPrompt: `You are a research assistant. Your job is to:
1. Analyze the user's research question
2. Provide a well-structured response with key findings
3. Cite sources or reasoning where applicable
4. Keep responses informative but concise`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("=".repeat(60));
  console.log("TenClaw Framework - Bootstrap Demo");
  console.log("=".repeat(60));
  console.log();

  // Validate environment
  const isLocalProvider = CONFIG.provider === "lmstudio" || CONFIG.provider === "ollama";
  if (!isLocalProvider && !process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY) {
    console.error("Error: OPENAI_API_KEY or ANTHROPIC_API_KEY environment variable is required for cloud providers");
    console.error();
    console.error("Usage:");
    console.error("  OPENAI_API_KEY=xxx npx ts-node examples/run.ts");
    console.error("  ANTHROPIC_API_KEY=xxx LLM_PROVIDER=anthropic npx ts-node examples/run.ts");
    console.error("  LLM_PROVIDER=lmstudio npx ts-node examples/run.ts");
    process.exit(1);
  }

  console.log("Configuration:");
  console.log(`  Provider: ${CONFIG.provider}`);
  console.log(`  Redis: ${CONFIG.redis.url}`);
  console.log(`  Chroma: ${CONFIG.chroma.url}`);
  console.log(`  Tenant: ${CONFIG.scope.tenantId}`);
  console.log(`  Workspace: ${CONFIG.scope.workspaceId}`);
  console.log();

  try {
    // ─────────────────────────────────────────────────────────────────────────
    // Step 1: Initialize Memory Backends
    // ─────────────────────────────────────────────────────────────────────────
    console.log("[1/5] Initializing Memory Backends...");
    const { kv: kvClient, close: closeRedis } = await createRedisClient();
    const { vector: vectorClient } = await createChromaClient();

    const memoryStore = new ScopedMemoryStore(vectorClient);
    const sessionStateStore = new ScopedSessionStateStore(kvClient);
    const memorySnapshotBuilder = new MemorySnapshotBuilder(
      sessionStateStore,
      memoryStore,
      // Simplified skill registry - in production use CompositeSkillRegistry
      {
        list: async () => [],
        get: async () => null,
        put: async () => {},
      }
    );
    const memoryCoordinator = new PersistentMemoryCoordinator(
      sessionStateStore,
      memoryStore
    );
    console.log("      Memory backends initialized ✓");

    // ─────────────────────────────────────────────────────────────────────────
    // Step 2: Initialize Workflow Backends
    // ─────────────────────────────────────────────────────────────────────────
    console.log("[2/5] Initializing Workflow Backends...");
    // Cast Redis client to interface expected by workflow backends
    const redisClient = await kvClient.getRawClient();
    console.log("CLIENT EXPIRE TYPE:", typeof redisClient.expire);
    console.log("CLIENT PROPERTIES:", Object.keys(redisClient));
    const taskQueue = new RedisTaskQueue({
      client: redisClient,
      keyPrefix: "tenclaw:queue",
    });
    const workflowBackend = new RedisWorkflowStateBackend({
      client: redisClient,
      keyPrefix: "tenclaw:workflow",
    });
    console.log("      Workflow backends initialized ✓");

    // ─────────────────────────────────────────────────────────────────────────
    // Step 3: Initialize LLM Gateway
    // ─────────────────────────────────────────────────────────────────────────
    console.log("[3/5] Initializing LLM Gateway...");
    const llmGateway = createLLMGateway();
    console.log("      LLM Gateway initialized ✓");

    // ─────────────────────────────────────────────────────────────────────────
    // Step 4: Create Agent Runtimes and Orchestrator
    // ─────────────────────────────────────────────────────────────────────────
    console.log("[4/5] Creating Agent Runtimes and Orchestrator...");

    const skillRegistry = new FileSystemSkillRegistry({
      rootDirectory: CONFIG.paths.skillsRoot + "/dev",
      parseYaml,
    });

    const teamRepository = new FileSystemTeamRepository(
      { rootDirectory: CONFIG.paths.teamsRoot },
      [
        new JsonTeamDocumentCodec(),
        createYamlTeamDocumentCodec(parseYaml),
      ],
      skillRegistry,
    );

    // Load team from filesystem and create agent runtimes
    const team = await teamRepository.get(CONFIG.scope, CONFIG.teamId);
    if (!team) {
      throw new Error(`Team "${CONFIG.teamId}" not found in ${CONFIG.paths.teamsRoot}`);
    }
    console.log(`      Loaded team: ${team.name} (${team.agents.length} agents) ✓`);

    // Create agent runtimes from team agents
    let agentRuntimes: AgentRuntime[];
    
    if (CONFIG.provider === "lmstudio" || CONFIG.provider === "ollama") {
      // Local LLMs use simple text runtime (no JSON mode required)
      agentRuntimes = team.agents.map(
        (agent) => new SimpleTextAgentRuntime(agent as AgentDefinition, llmGateway)
      );
    } else {
      // Cloud providers use standard platform adapter with JSON mode
      const platformAdapter = new ClaudeCodeRuntimePlatformAdapter();
      agentRuntimes = createPlatformAgentRuntimes({
        agents: team.agents as AgentDefinition[],
        platformAdapter,
        runtimeDependencies: {
          llmGateway,
          platformAdapter,
          promptTemplateLoader: async () => "",
        },
      });
    }

    const agentRegistry = new StaticAgentRegistry(agentRuntimes);
    const notifierRegistry = new NotifierRegistry();

    // Create workflow state store wrapper around Redis backend
    const workflowStateStore = new WorkflowBackendStateStoreAdapter(workflowBackend);

    const orchestrator = new ProductionOrchestrator({
      teamRepository,
      agentRegistry,
      workflowStore: workflowStateStore,
      sessionStateStore,
      memoryStore,
      skillRegistry,
      taskRouter: new DeclarativeTaskRouter(),
      messageBus: new RedisMessageBus({
        client: redisClient,
        keyPrefix: "tenclaw",
        maxStreamLength: 10_000,
      }),
      approvalGateway: new CliApprovalGateway({ timeoutMs: 60_000 }),
      auditLogger: new RedisAuditLogger({
        client: redisClient,
        keyPrefix: "tenclaw",
        maxStreamLength: 100_000,
      }),
    });

    const runtime: FrameworkRuntime = {
      agentRegistry,
      notifierRegistry,
      orchestrator,
    };
    console.log("      Orchestrator ready ✓");

    // ─────────────────────────────────────────────────────────────────────────
    // Step 5: Run Test Tasks
    // ─────────────────────────────────────────────────────────────────────────
    console.log("[5/5] Running Test Tasks...");
    console.log();

    // Test 1: Hello World
    console.log("─".repeat(60));
    console.log("Test 1: Hello World Task");
    console.log("─".repeat(60));

    const helloRequest: any = {
      requesterId: `req-${Date.now()}`,
      scope: CONFIG.scope,
      teamId: CONFIG.teamId,
      sessionId: `sess-${Date.now()}`,
      goal: "Say hello and introduce yourself briefly",
      input: {},
    };

    console.log("Starting workflow...");
    const helloRunId = await orchestrator.startWorkflow(helloRequest);
    console.log(`Run ID: ${helloRunId}`);

    // Wait a moment for completion (in real scenario, this would poll or use callbacks)
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Check result
    const helloRun = await workflowStateStore.get(CONFIG.scope, helloRunId);
    console.log(`Status: ${helloRun?.status}`);
    if (helloRun?.lastError) {
      console.log(`Error: ${JSON.stringify(helloRun.lastError, null, 2)}`);
    }
    if (helloRun?.result) {
      console.log(`Result: ${JSON.stringify(helloRun.result, null, 2)}`);
    }

    console.log();

    // Test 2: Research Task
    console.log("─".repeat(60));
    console.log("Test 2: Research Task");
    console.log("─".repeat(60));

    const researchRequest: any = {
      requesterId: `req-${Date.now()}`,
      scope: CONFIG.scope,
      teamId: CONFIG.teamId,
      sessionId: `sess-${Date.now()}`,
      goal: "What are the key benefits of multi-agent AI systems? Provide a brief summary.",
      input: {},
    };

    console.log("Starting workflow...");
    const researchRunId = await orchestrator.startWorkflow(researchRequest);
    console.log(`Run ID: ${researchRunId}`);

    // Wait a moment for completion
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Check result
    const researchRun = await workflowStateStore.get(CONFIG.scope, researchRunId);
    console.log(`Status: ${researchRun?.status}`);
    if (researchRun?.lastError) {
      console.log(`Error: ${JSON.stringify(researchRun.lastError, null, 2)}`);
    }
    if (researchRun?.result) {
      console.log(`Result: ${JSON.stringify(researchRun.result, null, 2)}`);
    }

    console.log();
    console.log("=".repeat(60));
    console.log("Demo completed successfully!");
    console.log("=".repeat(60));

    // Cleanup
    await closeRedis();
    process.exit(0);

  } catch (error) {
    console.error();
    console.error("Error during bootstrap:");
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

// Run main
main();
