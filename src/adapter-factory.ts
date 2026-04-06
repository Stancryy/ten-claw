// File: src/adapter-factory.ts
/**
 * Factory and registry for creating provider adapter instances with
 * concrete SDK clients wired in.
 * 
 * This module simplifies the bootstrap process by providing ready-to-use
 * adapter configurations for the LLM gateway.
 * 
 * @path src/adapter-factory.ts
 * @version 0.1.0
 */

import type { LLMProviderAdapter, LLMGatewayDependencies } from "./llm-gateway";
import type { LLMProvider } from "./types";
import {
  OpenAIProviderAdapter,
  AnthropicProviderAdapter,
  type OpenAIProviderAdapterDependencies,
  type AnthropicProviderAdapterDependencies,
} from "./provider-adapters";
import {
  OpenAISDKClient,
  AnthropicSDKClient,
  ApproximateTokenCounter,
  type OpenAIClientConfig,
  type AnthropicClientConfig,
} from "./sdk-clients";

// ─────────────────────────────────────────────────────────────────────────────
// ADAPTER REGISTRY
// ─────────────────────────────────────────────────────────────────────────────

/** 
 * Registry holding all configured provider adapters.
 * Used by the LLM gateway to route requests to the appropriate provider.
 */
export class ProviderAdapterRegistry {
  private adapters = new Map<LLMProvider, LLMProviderAdapter>();

  /** Registers an adapter for a specific provider. */
  register(provider: LLMProvider, adapter: LLMProviderAdapter): void {
    this.adapters.set(provider, adapter);
  }

  /** Gets an adapter for the specified provider. */
  get(provider: LLMProvider): LLMProviderAdapter | undefined {
    return this.adapters.get(provider);
  }

  /** Gets all registered adapters as a partial record for the gateway. */
  getAllAdapters(): Partial<Record<LLMProvider, LLMProviderAdapter>> {
    const result: Partial<Record<LLMProvider, LLMProviderAdapter>> = {};
    for (const [provider, adapter] of this.adapters) {
      result[provider] = adapter;
    }
    return result;
  }

  /** Lists all registered provider names. */
  listProviders(): LLMProvider[] {
    return Array.from(this.adapters.keys());
  }

  /** Checks if an adapter is registered for a provider. */
  has(provider: LLMProvider): boolean {
    return this.adapters.has(provider);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// FACTORY FUNCTIONS
// ─────────────────────────────────────────────────────────────────────────────

/** Configuration for creating a fully wired OpenAI adapter. */
export interface OpenAIAdapterFactoryConfig {
  apiKey: string;
  baseURL?: string | undefined;
  timeout?: number | undefined;
  maxRetries?: number | undefined;
  enableTokenCounter?: boolean | undefined;
}

/** Configuration for creating a fully wired Anthropic adapter. */
export interface AnthropicAdapterFactoryConfig {
  apiKey: string;
  baseURL?: string | undefined;
  timeout?: number | undefined;
  maxRetries?: number | undefined;
  enableTokenCounter?: boolean | undefined;
}

/**
 * Creates a fully wired OpenAI provider adapter with SDK client and token counter.
 * 
 * @param config - Configuration for the OpenAI client and adapter
 * @returns Ready-to-use OpenAI provider adapter
 * 
 * REQUIRES: Valid OpenAI API key
 */
export function createOpenAIAdapter(
  config: OpenAIAdapterFactoryConfig,
): OpenAIProviderAdapter {
  const clientConfig: OpenAIClientConfig = {
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    timeout: config.timeout,
    maxRetries: config.maxRetries,
  };

  const client = new OpenAISDKClient(clientConfig);

  const deps: OpenAIProviderAdapterDependencies = {
    client,
    tokenCounter: new ApproximateTokenCounter(),
  };

  return new OpenAIProviderAdapter(deps);
}

/**
 * Creates a fully wired Anthropic provider adapter with SDK client and token counter.
 * 
 * @param config - Configuration for the Anthropic client and adapter
 * @returns Ready-to-use Anthropic provider adapter
 * 
 * REQUIRES: Valid Anthropic API key
 */
export function createAnthropicAdapter(
  config: AnthropicAdapterFactoryConfig,
): AnthropicProviderAdapter {
  const clientConfig: AnthropicClientConfig = {
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    timeout: config.timeout,
    maxRetries: config.maxRetries,
  };

  const client = new AnthropicSDKClient(clientConfig);

  const deps: AnthropicProviderAdapterDependencies = {
    client,
    ...(config.enableTokenCounter !== false
      ? {} // Anthropic has native token counting
      : { tokenCounter: new ApproximateTokenCounter() }),
  };

  return new AnthropicProviderAdapter(deps);
}

// ─────────────────────────────────────────────────────────────────────────────
// ENVIRONMENT-BASED FACTORIES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a registry with OpenAI and Anthropic adapters from environment variables.
 * 
 * Environment variables used:
 * - OPENAI_API_KEY: Required for OpenAI adapter
 * - OPENAI_BASE_URL: Optional custom base URL
 * - OPENAI_TIMEOUT_MS: Optional timeout in milliseconds
 * - OPENAI_MAX_RETRIES: Optional retry count
 * 
 * - ANTHROPIC_API_KEY: Required for Anthropic adapter
 * - ANTHROPIC_BASE_URL: Optional custom base URL
 * - ANTHROPIC_TIMEOUT_MS: Optional timeout in milliseconds
 * - ANTHROPIC_MAX_RETRIES: Optional retry count
 * 
 * @returns Object containing the registry and gateway dependencies
 * @throws Error if required environment variables are missing
 */
export function createRegistryFromEnv(): {
  registry: ProviderAdapterRegistry;
  gatewayDeps: LLMGatewayDependencies;
} {
  const registry = new ProviderAdapterRegistry();

  // Register OpenAI if API key is available
  const openaiApiKey = process.env.OPENAI_API_KEY;
  if (openaiApiKey) {
    const openaiAdapter = createOpenAIAdapter({
      apiKey: openaiApiKey,
      baseURL: process.env.OPENAI_BASE_URL,
      timeout: process.env.OPENAI_TIMEOUT_MS
        ? parseInt(process.env.OPENAI_TIMEOUT_MS, 10)
        : undefined,
      maxRetries: process.env.OPENAI_MAX_RETRIES
        ? parseInt(process.env.OPENAI_MAX_RETRIES, 10)
        : undefined,
    });
    registry.register("openai", openaiAdapter);
  }

  // Register Anthropic if API key is available
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicApiKey) {
    const anthropicAdapter = createAnthropicAdapter({
      apiKey: anthropicApiKey,
      baseURL: process.env.ANTHROPIC_BASE_URL,
      timeout: process.env.ANTHROPIC_TIMEOUT_MS
        ? parseInt(process.env.ANTHROPIC_TIMEOUT_MS, 10)
        : undefined,
      maxRetries: process.env.ANTHROPIC_MAX_RETRIES
        ? parseInt(process.env.ANTHROPIC_MAX_RETRIES, 10)
        : undefined,
    });
    registry.register("anthropic", anthropicAdapter);
  }

  const gatewayDeps: LLMGatewayDependencies = {
    adapters: registry.getAllAdapters(),
    config: {
      providerFailureThreshold: 3,
      providerCircuitOpenMs: 30000,
    },
  };

  return { registry, gatewayDeps };
}

/**
 * Convenience function to check if required environment variables are set.
 * 
 * @returns Object indicating which providers are available
 */
export function checkProviderAvailability(): {
  openai: boolean;
  anthropic: boolean;
  missing: string[];
} {
  const missing: string[] = [];
  const openai = !!process.env.OPENAI_API_KEY;
  const anthropic = !!process.env.ANTHROPIC_API_KEY;

  if (!openai) {
    missing.push("OPENAI_API_KEY");
  }
  if (!anthropic) {
    missing.push("ANTHROPIC_API_KEY");
  }

  return { openai, anthropic, missing };
}

// ─────────────────────────────────────────────────────────────────────────────
// BOOTSTRAP HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Quick-start function that creates a fully configured LLM gateway
 * with all available providers from environment variables.
 * 
 * @returns Configured gateway dependencies ready for the orchestrator
 * @throws Error if no providers are configured
 */
export function bootstrapLLMGateway(): LLMGatewayDependencies {
  const { openai, anthropic, missing } = checkProviderAvailability();

  if (!openai && !anthropic) {
    throw new Error(
      `No LLM providers configured. Missing environment variables: ${missing.join(", ")}. ` +
      "Please set at least one provider API key."
    );
  }

  const { gatewayDeps } = createRegistryFromEnv();
  return gatewayDeps;
}

// TODO:
// - Add Gemini, Groq, and Ollama factory functions
// - Add support for Azure OpenAI endpoints
// - Add credential rotation and refresh logic for long-running processes
// - Add provider health checking before registration
// - Add metrics collection for adapter performance
