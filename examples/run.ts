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
  // Notifier
  TelegramNotifier,
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
    console.log(`[SimpleTextAgentRuntime] Executing agent: ${context.agent.id}`);
    const systemPrompt = context.agent.systemPrompt || "You are a helpful assistant.";
    const userPrompt = `Task: ${context.request.goal}`;
    
    console.log(`[SimpleTextAgentRuntime] Calling LLM gateway for agent: ${context.agent.id}`);
    console.log(`[SimpleTextAgentRuntime] Model: ${context.agent.modelProfile.provider}/${context.agent.modelProfile.model}`);
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
    console.log(`[SimpleTextAgentRuntime] Got response from LLM, output length: ${response.outputText?.length ?? 0}`);

    // Create a simple artifact from the text response
    const artifact: AgentArtifact = {
      id: `artifact_${Date.now()}`,
      kind: "text",
      title: "Response",
      mimeType: "text/plain",
      content: response.outputText,
    };

    // Determine handoff based on team and agent role
    // Dev team: all route except security-auditor completes
    // Business team: researcher → writer → editor → complete
    let handoffDisposition: "route" | "complete" | "retry" = "route";
    if (context.agent.id === "security-auditor" || context.agent.id === "editor") {
      handoffDisposition = "complete";
    }
    
    const handoff: HandoffDirective = {
      disposition: handoffDisposition,
      reason: handoffDisposition === "complete" 
        ? "Task complete. Workflow finished."
        : "Task completed, routing to next agent in pipeline.",
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
  // Team selection (dev or business) - map to full team IDs
  teamId: (() => {
    const team = process.env.TEAM ?? "dev";
    if (team === "dev" || team === "dev-team") return "dev-team";
    if (team === "business" || team === "business-team") return "business-team";
    return team;
  })(),
  
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
      console.log(`[LLM Gateway] LM Studio configured at ${baseURL}`);
      const client = new OpenAISDKClient({ apiKey, baseURL });
      return {
        generate: async (request: unknown) => {
          const req = request as { modelProfile: { providerModelId?: string; model?: string }; prompts: Array<{ role: string; content: string }>; maxOutputTokens: number };
          const modelId = "local-model";
          console.log(`[LLM Gateway] Calling LM Studio with streaming (model hint: ${modelId})`);
          console.log(`[LLM Gateway] Prompts: ${req.prompts.length} messages`);

          // Use fetch directly for streaming support
          const response = await fetch(`${baseURL}/chat/completions`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              model: modelId,
              messages: req.prompts.map(p => ({
                role: p.role,
                content: p.content,
              })),
              max_tokens: req.maxOutputTokens,
              stream: true,
            }),
          });

          if (!response.ok) {
            throw new Error(`LM Studio API error: ${response.status} ${response.statusText}`);
          }

          if (!response.body) {
            throw new Error("No response body available for streaming");
          }

          // Handle streaming with idle timeout
          const IDLE_TIMEOUT_MS = 30000; // 30 seconds idle timeout
          let outputText = "";
          let lastTokenTime = Date.now();
          let streamEnded = false;

          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";

          try {
            while (!streamEnded) {
              const now = Date.now();
              const idleElapsed = now - lastTokenTime;

              // Check idle timeout - cancel if no tokens for 30 seconds
              if (idleElapsed > IDLE_TIMEOUT_MS) {
                console.log(`[LLM Gateway] Idle timeout reached (${idleElapsed}ms), cancelling stream`);
                reader.cancel("Idle timeout - no tokens received");
                break;
              }

              // Read with idle timeout using Promise.race
              const idleTimer = new Promise<never>((_, reject) => {
                setTimeout(() => reject(new Error("IDLE_TIMEOUT")), IDLE_TIMEOUT_MS - idleElapsed);
              });

              const result = await Promise.race([
                reader.read(),
                idleTimer,
              ]).catch((err) => {
                if (err.message === "IDLE_TIMEOUT") {
                  return { done: false, value: undefined, idleTimedOut: true };
                }
                throw err;
              }) as { done: boolean; value?: Uint8Array; idleTimedOut?: boolean };

              if (result.idleTimedOut) {
                console.log(`[LLM Gateway] Idle timeout during read (${IDLE_TIMEOUT_MS}ms), cancelling stream`);
                reader.cancel("Idle timeout - no tokens received during read");
                break;
              }

              const { done, value } = result;

              if (done) {
                streamEnded = true;
                break;
              }

              if (value) {
                buffer += decoder.decode(value, { stream: true });
                lastTokenTime = Date.now();

                // Parse SSE format: data: {...}
                const lines = buffer.split("\n");
                buffer = lines.pop() || ""; // Keep incomplete line in buffer

                for (const line of lines) {
                  const trimmed = line.trim();
                  if (trimmed.startsWith("data: ")) {
                    const data = trimmed.slice(6);
                    if (data === "[DONE]") {
                      streamEnded = true;
                      break;
                    }
                    try {
                      const parsed = JSON.parse(data);
                      const content = parsed.choices?.[0]?.delta?.content;
                      if (content) {
                        outputText += content;
                      }
                      if (parsed.choices?.[0]?.finish_reason) {
                        streamEnded = true;
                        break;
                      }
                    } catch (e) {
                      // Ignore parse errors for malformed chunks
                    }
                  }
                }
              }
            }
          } catch (error) {
            console.error(`[LLM Gateway] Stream error: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
          } finally {
            reader.releaseLock();
          }

          console.log(`[LLM Gateway] Stream complete, total output length: ${outputText.length}`);
          console.log(`[LLM Gateway] Response preview: ${outputText.substring(0, 200)}...`);

          return {
            provider: "openai" as const,
            model: modelId,
            outputText,
            finishReason: streamEnded ? "stop" : "length",
            tokenUsage: {
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
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
      rootDirectory: `${CONFIG.paths.skillsRoot}/${CONFIG.teamId === "business-team" ? "business" : "dev"}`,
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

    // Conditionally register Telegram notifier if credentials are available
    const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
    const telegramChatId = process.env.TELEGRAM_CHAT_ID;
    if (telegramBotToken && telegramChatId) {
      notifierRegistry.register(
        new TelegramNotifier({
          botToken: telegramBotToken,
          defaultChatId: telegramChatId,
        })
      );
      console.log("      Telegram notifier registered ✓");
    } else {
      console.log("      Telegram notifier skipped (TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set) ⚠");
    }

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

    // Determine task based on team
    const isBusinessTeam = CONFIG.teamId === "business-team";
    const taskTitle = isBusinessTeam ? "Business Article: Market Trends" : "Email Validator with Jest Tests";
    const taskGoal = isBusinessTeam 
      ? "Research and write a comprehensive article on emerging AI trends in business automation for 2026"
      : "Create a TypeScript function that validates an email address using regex, with unit tests using Jest";
    const taskInput = isBusinessTeam
      ? {
          requirements: [
            "Research current AI automation trends in business",
            "Identify 3-5 key emerging technologies",
            "Analyze business impact and adoption rates",
            "Write a 1000-word article suitable for business executives",
            "Include recommendations for business leaders"
          ],
          constraints: [
            "Tone: Professional but accessible",
            "Target audience: C-suite executives",
            "Include credible sources",
            "Focus on practical business applications"
          ]
        }
      : {
          requirements: [
            "Function name: isValidEmail(email: string): boolean",
            "Must validate email format using regex",
            "Must handle edge cases (empty string, null, undefined)",
            "Include comprehensive Jest unit tests",
            "Tests should cover valid emails, invalid emails, and edge cases"
          ],
          constraints: [
            "TypeScript with strict typing",
            "Jest for testing framework",
            "No external validation libraries - pure regex"
          ]
        };

    console.log("[5/5] Running Task...");
    console.log();
    console.log("─".repeat(60));
    console.log(`Task: ${taskTitle}`);
    console.log(`Team: ${isBusinessTeam ? "Business Content Team" : "Development Delivery Team"}`);
    console.log("─".repeat(60));

    const task: any = {
      requesterId: `req-${Date.now()}`,
      scope: CONFIG.scope,
      teamId: CONFIG.teamId,
      sessionId: `sess-${Date.now()}`,
      goal: taskGoal,
      input: taskInput,
    };

    console.log(`Starting workflow with ${team.name}...`);
    console.log(`  Team: ${team.name} (${team.agents.map(a => a.name).join(" → ")})`);
    console.log(`  Goal: ${task.goal}`);
    console.log();

    const runId = await orchestrator.startWorkflow(task);
    console.log(`Run ID: ${runId}`);
    console.log();

    // Poll for completion with agent output display
    let isComplete = false;
    let attempts = 0;
    const maxAttempts = 150; // 300 seconds (5 minutes) total timeout

    while (!isComplete && attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      const run = await workflowStateStore.get(CONFIG.scope, runId);
      if (!run) continue;

      // Log current status every 5 attempts (10 seconds)
      if (attempts % 5 === 0) {
        const lastAgent = run.agentOutputs?.length > 0 
          ? run.agentOutputs[run.agentOutputs.length - 1]?.agentName 
          : "starting";
        console.log(`  [Poll ${attempts}/${maxAttempts}] Status: ${run.status}, Last agent: ${lastAgent}`);
      }

      // Display agent outputs as they become available
      if (run.agentOutputs && run.agentOutputs.length > 0) {
        for (const output of run.agentOutputs) {
          console.log(`\n[${output.agentName}] ${output.action || "Response"}:`);
          console.log(`  ${output.content || output.summary || JSON.stringify(output.result, null, 2).substring(0, 500)}`);
        }
        // Clear displayed outputs to avoid duplication
        run.agentOutputs = [];
      }

      if (run.status === "completed" || run.status === "failed") {
        isComplete = true;
        console.log(`\nStatus: ${run.status}`);
        
        if (run.result) {
          console.log("\nFinal Result:");
          console.log(JSON.stringify(run.result, null, 2));
        }
        
        if (run.lastError) {
          console.log(`\nError: ${JSON.stringify(run.lastError, null, 2)}`);
        }

        // Send Telegram notification
        const telegramNotifier = notifierRegistry.get("telegram");
        if (telegramNotifier && run) {
          try {
            await telegramNotifier.send({
              id: `notif-${Date.now()}`,
              scope: CONFIG.scope,
              channel: "telegram",
              destination: process.env.TELEGRAM_CHAT_ID ?? "",
              title: `Task ${run.status === "completed" ? "Completed" : "Failed"}: ${taskTitle}`,
              body: `Status: ${run.status}\n\nTeam: ${team.name}\nAgents: ${team.agents.map(a => a.name).join(", ")}`,
              runId: runId,
            });
            console.log("\nTelegram notification sent ✓");
          } catch (notifError) {
            console.error("Telegram notification failed:", notifError instanceof Error ? notifError.message : String(notifError));
          }
        }
      }
      
      attempts++;
    }

    if (!isComplete) {
      console.log("\nWorkflow still running after max polling attempts...");
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
