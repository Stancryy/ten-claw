// File: examples/test-providers.ts
/**
 * Example test script for OpenAI and Anthropic provider adapters.
 * 
 * This script demonstrates how to:
 * 1. Create provider adapters from environment variables
 * 2. Send test requests to both OpenAI and Anthropic
 * 3. Verify token counting and response handling
 * 
 * Run with:
 *   OPENAI_API_KEY=sk-xxx ANTHROPIC_API_KEY=sk-ant-xxx npx ts-node examples/test-providers.ts
 * 
 * @path examples/test-providers.ts
 * @version 0.1.0
 */

import {
  createOpenAIAdapter,
  createAnthropicAdapter,
  checkProviderAvailability,
} from "../src/adapter-factory";
import { BudgetAwareLLMGateway } from "../src/llm-gateway";
import type { LLMRequest, TenantScope } from "../src/types";

// Test configuration
const TEST_SCOPE: TenantScope = {
  tenantId: "test-tenant",
  workspaceId: "test-workspace",
};

const TEST_PROMPT = "Explain the concept of recursion in programming in one sentence.";

async function testOpenAI(): Promise<void> {
  console.log("\n🧪 Testing OpenAI Provider...");
  
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.log("⚠️  Skipping OpenAI test - OPENAI_API_KEY not set");
    return;
  }

  try {
    const adapter = createOpenAIAdapter({
      apiKey,
      enableTokenCounter: true,
    });

    const request: LLMRequest = {
      scope: TEST_SCOPE,
      modelProfile: {
        provider: "openai",
        model: "gpt-4o-mini",
        temperature: 0.7,
        maxRetries: 1,
        timeoutMs: 30000,
      },
      prompts: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: TEST_PROMPT },
      ],
      maxOutputTokens: 150,
      budget: {
        maxInputTokens: 1000,
        maxOutputTokens: 150,
        maxTotalTokens: 1150,
        overflowStrategy: "truncate",
      },
    };

    console.log("📤 Sending request to OpenAI...");
    const startTime = Date.now();
    const response = await adapter.generate(request);
    const latency = Date.now() - startTime;

    console.log("✅ OpenAI Response:");
    console.log(`   Model: ${response.model}`);
    console.log(`   Latency: ${latency}ms`);
    console.log(`   Tokens: ${response.tokenUsage.totalTokens} (${response.tokenUsage.inputTokens} in, ${response.tokenUsage.outputTokens} out)`);
    console.log(`   Finish reason: ${response.finishReason}`);
    console.log(`   Output: ${response.outputText.slice(0, 100)}...`);
    
  } catch (error) {
    console.error("❌ OpenAI test failed:", error instanceof Error ? error.message : String(error));
  }
}

async function testAnthropic(): Promise<void> {
  console.log("\n🧪 Testing Anthropic Provider...");
  
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.log("⚠️  Skipping Anthropic test - ANTHROPIC_API_KEY not set");
    return;
  }

  try {
    const adapter = createAnthropicAdapter({
      apiKey,
      enableTokenCounter: true,
    });

    const request: LLMRequest = {
      scope: TEST_SCOPE,
      modelProfile: {
        provider: "anthropic",
        model: "claude-3-5-sonnet-20241022",
        temperature: 0.7,
        maxRetries: 1,
        timeoutMs: 30000,
      },
      prompts: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: TEST_PROMPT },
      ],
      maxOutputTokens: 150,
      budget: {
        maxInputTokens: 1000,
        maxOutputTokens: 150,
        maxTotalTokens: 1150,
        overflowStrategy: "truncate",
      },
    };

    console.log("📤 Sending request to Anthropic...");
    const startTime = Date.now();
    const response = await adapter.generate(request);
    const latency = Date.now() - startTime;

    console.log("✅ Anthropic Response:");
    console.log(`   Model: ${response.model}`);
    console.log(`   Latency: ${latency}ms`);
    console.log(`   Tokens: ${response.tokenUsage.totalTokens} (${response.tokenUsage.inputTokens} in, ${response.tokenUsage.outputTokens} out)`);
    console.log(`   Finish reason: ${response.finishReason}`);
    console.log(`   Output: ${response.outputText.slice(0, 100)}...`);
    
  } catch (error) {
    console.error("❌ Anthropic test failed:", error instanceof Error ? error.message : String(error));
  }
}

async function testLLMGateway(): Promise<void> {
  console.log("\n🧪 Testing LLM Gateway with Multiple Providers...");
  
  const { registry, gatewayDeps } = await import("../src/adapter-factory").then(m => m.createRegistryFromEnv());
  
  if (registry.listProviders().length === 0) {
    console.log("⚠️  No providers configured for gateway test");
    return;
  }

  try {
    const gateway = new BudgetAwareLLMGateway(gatewayDeps);

    const request: LLMRequest = {
      scope: TEST_SCOPE,
      modelProfile: {
        provider: registry.listProviders()[0],
        model: registry.listProviders()[0] === "openai" ? "gpt-4o-mini" : "claude-3-5-sonnet-20241022",
        temperature: 0.7,
      },
      prompts: [
        { role: "user", content: "What is 2+2?" },
      ],
      maxOutputTokens: 50,
      budget: {
        maxInputTokens: 100,
        maxOutputTokens: 50,
        maxTotalTokens: 150,
        overflowStrategy: "truncate",
      },
    };

    console.log(`📤 Sending request via gateway (provider: ${request.modelProfile.provider})...`);
    const response = await gateway.generate(request);

    console.log("✅ Gateway Response:");
    console.log(`   Provider: ${response.provider}`);
    console.log(`   Model: ${response.model}`);
    console.log(`   Tokens: ${response.tokenUsage.totalTokens}`);
    console.log(`   Output: ${response.outputText.slice(0, 50)}...`);
    
  } catch (error) {
    console.error("❌ Gateway test failed:", error instanceof Error ? error.message : String(error));
  }
}

async function main(): Promise<void> {
  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║       Multi-Agent Framework - Provider Adapter Tests       ║");
  console.log("╚════════════════════════════════════════════════════════════╝");

  // Check provider availability
  const availability = checkProviderAvailability();
  console.log("\n📋 Provider Availability:");
  console.log(`   OpenAI: ${availability.openai ? "✅" : "❌"}`);
  console.log(`   Anthropic: ${availability.anthropic ? "✅" : "❌"}`);
  
  if (availability.missing.length > 0) {
    console.log(`   Missing: ${availability.missing.join(", ")}`);
  }

  // Run tests
  await testOpenAI();
  await testAnthropic();
  await testLLMGateway();

  console.log("\n════════════════════════════════════════════════════════════");
  console.log("Test run complete!");
  console.log("════════════════════════════════════════════════════════════\n");
}

// Run if executed directly
if (require.main === module) {
  main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
}

export { main, testOpenAI, testAnthropic, testLLMGateway };
