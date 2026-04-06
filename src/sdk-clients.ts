// File: src/sdk-clients.ts
/**
 * Concrete SDK client wrappers for OpenAI and Anthropic.
 * 
 * These implement the minimal client interfaces defined in provider-adapters.ts
 * using the official SDKs. They handle authentication, error mapping, and
 * provide real API connectivity for the LLM gateway.
 * 
 * @path src/sdk-clients.ts
 * @version 0.1.0
 */

import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import type {
  OpenAIResponsesClient,
  OpenAIResponsesCreateRequest,
  OpenAIResponsesCreateResponse,
  AnthropicMessagesClient,
  AnthropicMessagesCreateRequest,
  AnthropicMessagesCreateResponse,
  AnthropicMessagesCountTokensRequest,
  AnthropicCountTokensResponse,
  ProviderTokenCounter,
  AnthropicMessage,
} from "./provider-adapters";

// ─────────────────────────────────────────────────────────────────────────────
// OPENAI SDK CLIENT
// ─────────────────────────────────────────────────────────────────────────────

/** Configuration for the OpenAI SDK client. */
export interface OpenAIClientConfig {
  apiKey: string;
  baseURL?: string | undefined;
  timeout?: number | undefined;
  maxRetries?: number | undefined;
}

/**
 * Concrete OpenAI SDK client implementing the Responses API interface.
 * 
 * REQUIRES: OPENAI_API_KEY environment variable or explicit apiKey.
 */
export class OpenAISDKClient implements OpenAIResponsesClient {
  private client: OpenAI;

  constructor(config: OpenAIClientConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      timeout: config.timeout ?? 60000,
      maxRetries: config.maxRetries ?? 2,
    });
  }

  /**
   * Creates a response using OpenAI's Responses API.
   * Maps the minimal interface to the actual SDK calls.
   */
  async create(request: OpenAIResponsesCreateRequest): Promise<OpenAIResponsesCreateResponse> {
    try {
      // Convert our minimal request format to OpenAI SDK format
      // Build request args carefully to avoid passing undefined
      const createArgs: {
        model: string;
        input: Array<{ role: "user" | "assistant" | "system"; content: string }>;
        temperature?: number;
        top_p?: number;
        max_output_tokens?: number | null;
        text?: { format?: { type: "json_object" | "text" } };
      } = {
        model: request.model,
        input: request.input.map(msg => ({
          role: msg.role,
          content: msg.content.map(c => c.text).join(""),
        })),
      };

      if (request.temperature !== undefined) {
        createArgs.temperature = request.temperature;
      }
      if (request.top_p !== undefined) {
        createArgs.top_p = request.top_p;
      }
      if (request.max_output_tokens !== undefined) {
        createArgs.max_output_tokens = request.max_output_tokens;
      }
      if (request.text !== undefined) {
        createArgs.text = request.text;
      }

      const response = await this.client.responses.create(createArgs);

      // Map SDK response back to our interface
      return {
        model: response.model,
        output_text: response.output_text,
        output: response.output?.map((item: unknown) => {
          const outputItem = item as { content?: Array<{ type: string; text?: string }> };
          return {
            type: "message",
            content: outputItem.content?.map(c => ({
              type: "output_text" as const,
              text: c.text ?? "",
            })) ?? [],
          };
        }),
        usage: response.usage
        ? {
            input_tokens: response.usage.input_tokens,
            output_tokens: response.usage.output_tokens,
            total_tokens: response.usage.total_tokens ?? 0,
          }
        : { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        status: "completed",
      };
    } catch (error: unknown) {
      throw mapOpenAIError(error);
    }
  }
}

/** Maps OpenAI SDK errors to framework error types. */
function mapOpenAIError(error: unknown): Error {
  if (error instanceof OpenAI.APIError) {
    const status = error.status;
    const message = error.message;
    
    if (status === 401) {
      return new Error(`OpenAI authentication failed: ${message}`);
    }
    if (status === 429) {
      return new Error(`OpenAI rate limit exceeded: ${message}`);
    }
    if (status === 500 || status === 502 || status === 503) {
      return new Error(`OpenAI server error (${status}): ${message}`);
    }
    return new Error(`OpenAI API error (${status}): ${message}`);
  }
  
  if (error instanceof Error) {
    return error;
  }
  
  return new Error(`Unknown OpenAI error: ${String(error)}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// ANTHROPIC SDK CLIENT
// ─────────────────────────────────────────────────────────────────────────────

/** Configuration for the Anthropic SDK client. */
export interface AnthropicClientConfig {
  apiKey: string;
  baseURL?: string | undefined;
  timeout?: number | undefined;
  maxRetries?: number | undefined;
}

/**
 * Concrete Anthropic SDK client implementing the Messages API interface.
 * 
 * REQUIRES: ANTHROPIC_API_KEY environment variable or explicit apiKey.
 */
export class AnthropicSDKClient implements AnthropicMessagesClient {
  private client: Anthropic;

  constructor(config: AnthropicClientConfig) {
    this.client = new Anthropic({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      timeout: config.timeout ?? 60000,
      maxRetries: config.maxRetries ?? 2,
    });
  }

  /**
   * Creates a message using Anthropic's Messages API.
   */
  async create(request: AnthropicMessagesCreateRequest): Promise<AnthropicMessagesCreateResponse> {
    try {
      // Build request args carefully to avoid passing undefined for optional fields
      const createArgs: {
        model: string;
        messages: AnthropicMessage[];
        max_tokens: number;
        system?: string;
        temperature?: number;
        top_p?: number;
        stop_sequences?: string[];
      } = {
        model: request.model,
        messages: request.messages,
        max_tokens: request.max_tokens,
      };

      if (request.system) {
        createArgs.system = request.system;
      }
      if (request.temperature !== undefined) {
        createArgs.temperature = request.temperature;
      }
      if (request.top_p !== undefined) {
        createArgs.top_p = request.top_p;
      }
      if (request.stop_sequences && request.stop_sequences.length > 0) {
        createArgs.stop_sequences = request.stop_sequences;
      }

      const response = await this.client.messages.create(createArgs);

      return {
        model: response.model,
        content: response.content
          .filter((block: { type: string; text?: string }): block is { type: "text"; text: string } => block.type === "text")
          .map((block: { type: "text"; text: string }) => ({
            type: "text" as const,
            text: block.text,
          })),
        stop_reason: response.stop_reason as AnthropicMessagesCreateResponse["stop_reason"] ?? "end_turn",
        usage: response.usage
          ? {
              input_tokens: response.usage.input_tokens,
              output_tokens: response.usage.output_tokens,
            }
          : { input_tokens: 0, output_tokens: 0 },
      };
    } catch (error: unknown) {
      throw mapAnthropicError(error);
    }
  }

  /**
   * Counts tokens using Anthropic's native token counting endpoint.
   */
  async countTokens(request: AnthropicMessagesCountTokensRequest): Promise<AnthropicCountTokensResponse> {
    try {
      const countArgs: {
        model: string;
        messages: AnthropicMessage[];
        system?: string;
      } = {
        model: request.model,
        messages: request.messages,
      };
      
      if (request.system) {
        countArgs.system = request.system;
      }
      
      const response = await this.client.messages.countTokens(countArgs);

      return {
        input_tokens: response.input_tokens,
      };
    } catch (error: unknown) {
      throw mapAnthropicError(error);
    }
  }
}

/** Maps Anthropic SDK errors to framework error types. */
function mapAnthropicError(error: unknown): Error {
  if (error instanceof Anthropic.APIError) {
    const status = error.status;
    const message = error.message;
    
    if (status === 401) {
      return new Error(`Anthropic authentication failed: ${message}`);
    }
    if (status === 429) {
      return new Error(`Anthropic rate limit exceeded: ${message}`);
    }
    if (status === 500 || status === 502 || status === 503) {
      return new Error(`Anthropic server error (${status}): ${message}`);
    }
    if (status === 413) {
      return new Error(`Anthropic request too large: ${message}`);
    }
    return new Error(`Anthropic API error (${status}): ${message}`);
  }
  
  if (error instanceof Error) {
    return error;
  }
  
  return new Error(`Unknown Anthropic error: ${String(error)}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// TOKEN COUNTERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Simple approximation token counter.
 * Uses 4 characters per token approximation.
 * 
 * TODO: Replace with TiktokenCounter for accurate OpenAI token counting.
 * Currently using approximate counting due to ESM/CJS compatibility constraints.
 */
export class ApproximateTokenCounter implements ProviderTokenCounter {
  async countText(text: string, _model: string): Promise<number> {
    return Math.ceil(text.length / 4);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// FACTORY FUNCTIONS
// ─────────────────────────────────────────────────────────────────────────────

/** 
 * Creates a configured OpenAI SDK client from environment variables.
 * REQUIRES: process.env.OPENAI_API_KEY
 */
export function createOpenAIClientFromEnv(): OpenAISDKClient {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY environment variable is required");
  }

  return new OpenAISDKClient({
    apiKey,
    baseURL: process.env.OPENAI_BASE_URL,
    timeout: process.env.OPENAI_TIMEOUT_MS ? parseInt(process.env.OPENAI_TIMEOUT_MS, 10) : undefined,
    maxRetries: process.env.OPENAI_MAX_RETRIES ? parseInt(process.env.OPENAI_MAX_RETRIES, 10) : undefined,
  });
}

/**
 * Creates a configured Anthropic SDK client from environment variables.
 * REQUIRES: process.env.ANTHROPIC_API_KEY
 */
export function createAnthropicClientFromEnv(): AnthropicSDKClient {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY environment variable is required");
  }

  return new AnthropicSDKClient({
    apiKey,
    baseURL: process.env.ANTHROPIC_BASE_URL,
    timeout: process.env.ANTHROPIC_TIMEOUT_MS ? parseInt(process.env.ANTHROPIC_TIMEOUT_MS, 10) : undefined,
    maxRetries: process.env.ANTHROPIC_MAX_RETRIES ? parseInt(process.env.ANTHROPIC_MAX_RETRIES, 10) : undefined,
  });
}

// TODO:
// - Add request/response logging hooks for debugging
// - Add retry metrics and circuit breaker integration
// - Add streaming support once the gateway contract supports it
// - Add request ID tracking for correlation with provider logs
// - Consider adding batch request support for high-throughput scenarios
