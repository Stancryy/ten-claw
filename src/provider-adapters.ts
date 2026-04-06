// File: src/provider-adapters.ts
/**
 * Concrete LLM provider adapters for OpenAI, Anthropic, Google Gemini, Groq,
 * and Ollama built around dependency-injected SDK-like clients.
 */

import type {
  JsonObject,
  LLMProvider,
  LLMRequest,
  LLMResponse,
  PromptFrame,
} from "./types";
import type {
  LLMProviderAdapter,
  LLMProviderCapabilities,
} from "./llm-gateway";

/** Minimal OpenAI Responses API client shape required by the adapter. */
export interface OpenAIResponsesClient {
  create(request: OpenAIResponsesCreateRequest): Promise<OpenAIResponsesCreateResponse>;
}

/** Minimal Anthropic Messages API client shape required by the adapter. */
export interface AnthropicMessagesClient {
  create(request: AnthropicMessagesCreateRequest): Promise<AnthropicMessagesCreateResponse>;
  countTokens?(request: AnthropicMessagesCountTokensRequest): Promise<AnthropicCountTokensResponse>;
}

/** Optional token counter used when the provider SDK lacks a native endpoint. */
export interface ProviderTokenCounter {
  countText(text: string, model: string): Promise<number>;
}

/** Shared clock abstraction for deterministic tests. */
export interface ProviderAdapterClock {
  now(): number;
}

/** Shared response content shape for OpenAI text input items. */
export interface OpenAIInputTextContent {
  type: "input_text";
  text: string;
}

/** Shared message shape for OpenAI responses requests. */
export interface OpenAIInputMessage {
  role: "system" | "user" | "assistant";
  content: OpenAIInputTextContent[];
}

/** Minimal OpenAI Responses API request used by the adapter. */
export interface OpenAIResponsesCreateRequest {
  model: string;
  input: OpenAIInputMessage[];
  temperature?: number;
  top_p?: number;
  max_output_tokens?: number;
  text?: {
    format?: {
      type: "json_object" | "text";
    };
  };
  stop?: string[];
}

/** Minimal OpenAI output text content item. */
export interface OpenAIOutputTextContent {
  type: "output_text";
  text: string;
}

/** Minimal OpenAI response output item. */
export interface OpenAIResponseOutputItem {
  type: string;
  content?: OpenAIOutputTextContent[];
}

/** Minimal OpenAI token usage shape. */
export interface OpenAIUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}

/** Minimal OpenAI Responses API response used by the adapter. */
export interface OpenAIResponsesCreateResponse {
  model?: string;
  output?: OpenAIResponseOutputItem[];
  output_text?: string;
  usage?: OpenAIUsage;
  status?: string;
}

/** Anthropic message content block. */
export interface AnthropicTextBlock {
  type: "text";
  text: string;
}

/** Anthropic message entry. */
export interface AnthropicMessage {
  role: "user" | "assistant";
  content: AnthropicTextBlock[];
}

/** Minimal Anthropic create request used by the adapter. */
export interface AnthropicMessagesCreateRequest {
  model: string;
  system?: string;
  messages: AnthropicMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens: number;
  stop_sequences?: string[];
}

/** Minimal Anthropic create response used by the adapter. */
export interface AnthropicMessagesCreateResponse {
  model: string;
  content: AnthropicTextBlock[];
  stop_reason?: "end_turn" | "max_tokens" | "stop_sequence" | "tool_use";
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

/** Minimal Anthropic count-tokens request used by the adapter. */
export interface AnthropicMessagesCountTokensRequest {
  model: string;
  system?: string;
  messages: AnthropicMessage[];
}

/** Minimal Anthropic token-count response. */
export interface AnthropicCountTokensResponse {
  input_tokens: number;
}

/** Dependencies required by the OpenAI provider adapter. */
export interface OpenAIProviderAdapterDependencies {
  client: OpenAIResponsesClient;
  tokenCounter?: ProviderTokenCounter;
  clock?: ProviderAdapterClock;
}

/** Dependencies required by the Anthropic provider adapter. */
export interface AnthropicProviderAdapterDependencies {
  client: AnthropicMessagesClient;
  tokenCounter?: ProviderTokenCounter;
  clock?: ProviderAdapterClock;
}

/** Minimal Gemini generate-content client shape required by the adapter. */
export interface GeminiGenerateContentClient {
  generateContent(request: GeminiGenerateContentRequest): Promise<GeminiGenerateContentResponse>;
  countTokens?(request: GeminiCountTokensRequest): Promise<GeminiCountTokensResponse>;
}

/** Minimal Gemini content part used for text prompts and replies. */
export interface GeminiTextPart {
  text: string;
}

/** Minimal Gemini content entry. */
export interface GeminiContent {
  role: "user" | "model";
  parts: GeminiTextPart[];
}

/** Minimal Gemini system instruction payload. */
export interface GeminiSystemInstruction {
  parts: GeminiTextPart[];
}

/** Minimal Gemini generation config used by the adapter. */
export interface GeminiGenerationConfig {
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
  stopSequences?: string[];
  responseMimeType?: "text/plain" | "application/json";
}

/** Minimal Gemini generate-content request used by the adapter. */
export interface GeminiGenerateContentRequest {
  model: string;
  systemInstruction?: GeminiSystemInstruction;
  contents: GeminiContent[];
  generationConfig?: GeminiGenerationConfig;
}

/** Minimal Gemini candidate content shape. */
export interface GeminiCandidate {
  content?: {
    parts?: GeminiTextPart[];
  };
  finishReason?: string;
}

/** Minimal Gemini usage metadata shape. */
export interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
}

/** Minimal Gemini generate-content response used by the adapter. */
export interface GeminiGenerateContentResponse {
  model?: string;
  candidates?: GeminiCandidate[];
  usageMetadata?: GeminiUsageMetadata;
}

/** Minimal Gemini count-tokens request. */
export interface GeminiCountTokensRequest {
  model: string;
  systemInstruction?: GeminiSystemInstruction;
  contents: GeminiContent[];
}

/** Minimal Gemini count-tokens response. */
export interface GeminiCountTokensResponse {
  totalTokens?: number;
}

/** Dependencies required by the Gemini provider adapter. */
export interface GeminiProviderAdapterDependencies {
  client: GeminiGenerateContentClient;
  tokenCounter?: ProviderTokenCounter;
  clock?: ProviderAdapterClock;
}

/** Minimal Groq chat-completions client shape required by the adapter. */
export interface GroqChatCompletionsClient {
  create(request: GroqChatCompletionsCreateRequest): Promise<GroqChatCompletionsCreateResponse>;
}

/** Minimal Groq message entry used by the adapter. */
export interface GroqChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Minimal Groq chat-completions request used by the adapter. */
export interface GroqChatCompletionsCreateRequest {
  model: string;
  messages: GroqChatMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: string[];
  response_format?: {
    type: "json_object" | "text";
  };
}

/** Minimal Groq chat response choice. */
export interface GroqChatChoice {
  message?: {
    content?: string;
  };
  finish_reason?: string;
}

/** Minimal Groq usage shape. */
export interface GroqUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

/** Minimal Groq chat-completions response used by the adapter. */
export interface GroqChatCompletionsCreateResponse {
  model?: string;
  choices?: GroqChatChoice[];
  usage?: GroqUsage;
}

/** Dependencies required by the Groq provider adapter. */
export interface GroqProviderAdapterDependencies {
  client: GroqChatCompletionsClient;
  tokenCounter?: ProviderTokenCounter;
  clock?: ProviderAdapterClock;
}

/** Minimal Ollama chat client shape required by the adapter. */
export interface OllamaChatClient {
  chat(request: OllamaChatRequest): Promise<OllamaChatResponse>;
}

/** Minimal Ollama chat message entry. */
export interface OllamaChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Minimal Ollama generation options. */
export interface OllamaChatOptions {
  temperature?: number;
  top_p?: number;
  num_predict?: number;
  stop?: string[];
}

/** Minimal Ollama chat request used by the adapter. */
export interface OllamaChatRequest {
  model: string;
  messages: OllamaChatMessage[];
  stream: false;
  format?: "json";
  options?: OllamaChatOptions;
}

/** Minimal Ollama chat response used by the adapter. */
export interface OllamaChatResponse {
  model?: string;
  message?: {
    content?: string;
  };
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

/** Dependencies required by the Ollama provider adapter. */
export interface OllamaProviderAdapterDependencies {
  client: OllamaChatClient;
  tokenCounter?: ProviderTokenCounter;
  clock?: ProviderAdapterClock;
}

/** OpenAI adapter that maps the unified request into the Responses API. */
export class OpenAIProviderAdapter implements LLMProviderAdapter {
  /** Fixed provider identifier for this adapter. */
  readonly provider: LLMProvider = "openai";

  private readonly clock: ProviderAdapterClock;

  /** Creates an OpenAI adapter around an injected Responses API client. */
  constructor(private readonly deps: OpenAIProviderAdapterDependencies) {
    this.clock = deps.clock ?? {
      now: () => Date.now(),
    };
  }

  /** Advertises provider capability hints to the unified gateway. */
  getCapabilities(): LLMProviderCapabilities {
    return {
      supportsJsonMode: true,
    };
  }

  /** Executes one generation request against OpenAI Responses. */
  async generate(request: LLMRequest): Promise<LLMResponse> {
    const startedAt = this.clock.now();
    const createRequest: OpenAIResponsesCreateRequest = {
      model: request.modelProfile.model,
      input: toOpenAIInputMessages(request.prompts),
      max_output_tokens: request.maxOutputTokens,
      text: request.responseFormat === "json"
        ? { format: { type: "json_object" } }
        : { format: { type: "text" } },
    };
    if (request.modelProfile.temperature !== undefined) {
      createRequest.temperature = request.modelProfile.temperature;
    }
    if (request.modelProfile.topP !== undefined) {
      createRequest.top_p = request.modelProfile.topP;
    }
    if (request.stopSequences?.length) {
      createRequest.stop = request.stopSequences;
    }

    const response = await this.deps.client.create(createRequest);
    const outputText = response.output_text || flattenOpenAIOutput(response.output ?? []);
    const usage = response.usage ?? {};

    return {
      provider: this.provider,
      model: response.model ?? request.modelProfile.model,
      outputText,
      finishReason: mapOpenAIFinishReason(response.status),
      tokenUsage: {
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
        totalTokens:
          usage.total_tokens ??
          (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
      },
      latencyMs: this.clock.now() - startedAt,
    };
  }

  /** Counts prompt tokens using an injected token counter when available. */
  async countTokens(
    request: Pick<LLMRequest, "modelProfile" | "prompts">,
  ): Promise<number> {
    if (!this.deps.tokenCounter) {
      throw new Error(
        "OpenAIProviderAdapter requires an injected token counter when native counting is unavailable.",
      );
    }
    return this.deps.tokenCounter.countText(
      stringifyPromptFrames(request.prompts),
      request.modelProfile.model,
    );
  }
}

/** Anthropic adapter that maps the unified request into the Messages API. */
export class AnthropicProviderAdapter implements LLMProviderAdapter {
  /** Fixed provider identifier for this adapter. */
  readonly provider: LLMProvider = "anthropic";

  private readonly clock: ProviderAdapterClock;

  /** Creates an Anthropic adapter around an injected Messages API client. */
  constructor(private readonly deps: AnthropicProviderAdapterDependencies) {
    this.clock = deps.clock ?? {
      now: () => Date.now(),
    };
  }

  /** Advertises provider capability hints to the unified gateway. */
  getCapabilities(): LLMProviderCapabilities {
    return {
      supportsJsonMode: false,
    };
  }

  /** Executes one generation request against Anthropic Messages. */
  async generate(request: LLMRequest): Promise<LLMResponse> {
    const startedAt = this.clock.now();
    const anthropicRequest = toAnthropicRequest(request);
    const response = await this.deps.client.create(anthropicRequest);
    const outputText = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    const inputTokens = response.usage?.input_tokens ?? 0;
    const outputTokens = response.usage?.output_tokens ?? 0;

    return {
      provider: this.provider,
      model: response.model,
      outputText,
      finishReason: mapAnthropicFinishReason(response.stop_reason),
      tokenUsage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
      },
      latencyMs: this.clock.now() - startedAt,
    };
  }

  /** Counts prompt tokens using Anthropic native support or an injected fallback. */
  async countTokens(
    request: Pick<LLMRequest, "modelProfile" | "prompts">,
  ): Promise<number> {
    const tokenCountRequest = toAnthropicCountTokensRequest(request);
    if (this.deps.client.countTokens) {
      const response = await this.deps.client.countTokens(tokenCountRequest);
      return response.input_tokens;
    }
    if (!this.deps.tokenCounter) {
      throw new Error(
        "AnthropicProviderAdapter requires either `client.countTokens` or an injected token counter.",
      );
    }
    return this.deps.tokenCounter.countText(
      stringifyPromptFrames(request.prompts),
      request.modelProfile.model,
    );
  }
}

/** Gemini adapter that maps the unified request into the Generative Content API shape. */
export class GeminiProviderAdapter implements LLMProviderAdapter {
  /** Fixed provider identifier for this adapter. */
  readonly provider: LLMProvider = "google-gemini";

  private readonly clock: ProviderAdapterClock;

  /** Creates a Gemini adapter around an injected generate-content client. */
  constructor(private readonly deps: GeminiProviderAdapterDependencies) {
    this.clock = deps.clock ?? {
      now: () => Date.now(),
    };
  }

  /** Advertises provider capability hints to the unified gateway. */
  getCapabilities(): LLMProviderCapabilities {
    return {
      supportsJsonMode: true,
    };
  }

  /** Executes one generation request against Gemini. */
  async generate(request: LLMRequest): Promise<LLMResponse> {
    const startedAt = this.clock.now();
    const geminiRequest = toGeminiRequest(request);
    const response = await this.deps.client.generateContent(geminiRequest);
    const outputText = flattenGeminiCandidates(response.candidates ?? []);
    const usage = response.usageMetadata ?? {};

    return {
      provider: this.provider,
      model: response.model ?? request.modelProfile.model,
      outputText,
      finishReason: mapGeminiFinishReason(response.candidates?.[0]?.finishReason),
      tokenUsage: {
        inputTokens: usage.promptTokenCount ?? 0,
        outputTokens: usage.candidatesTokenCount ?? 0,
        totalTokens:
          usage.totalTokenCount ??
          (usage.promptTokenCount ?? 0) + (usage.candidatesTokenCount ?? 0),
      },
      latencyMs: this.clock.now() - startedAt,
    };
  }

  /** Counts prompt tokens using Gemini native support or an injected fallback. */
  async countTokens(
    request: Pick<LLMRequest, "modelProfile" | "prompts">,
  ): Promise<number> {
    const tokenCountRequest = toGeminiCountTokensRequest(request);
    if (this.deps.client.countTokens) {
      const response = await this.deps.client.countTokens(tokenCountRequest);
      return response.totalTokens ?? 0;
    }
    if (!this.deps.tokenCounter) {
      throw new Error(
        "GeminiProviderAdapter requires either `client.countTokens` or an injected token counter.",
      );
    }
    return this.deps.tokenCounter.countText(
      stringifyPromptFrames(request.prompts),
      request.modelProfile.model,
    );
  }
}

/** Groq adapter that maps the unified request into an OpenAI-compatible chat-completions shape. */
export class GroqProviderAdapter implements LLMProviderAdapter {
  /** Fixed provider identifier for this adapter. */
  readonly provider: LLMProvider = "groq";

  private readonly clock: ProviderAdapterClock;

  /** Creates a Groq adapter around an injected chat-completions client. */
  constructor(private readonly deps: GroqProviderAdapterDependencies) {
    this.clock = deps.clock ?? {
      now: () => Date.now(),
    };
  }

  /** Advertises provider capability hints to the unified gateway. */
  getCapabilities(): LLMProviderCapabilities {
    return {
      supportsJsonMode: true,
    };
  }

  /** Executes one generation request against Groq. */
  async generate(request: LLMRequest): Promise<LLMResponse> {
    const startedAt = this.clock.now();
    const createRequest: GroqChatCompletionsCreateRequest = {
      model: request.modelProfile.model,
      messages: toGroqChatMessages(request.prompts),
      max_tokens: request.maxOutputTokens,
      response_format: request.responseFormat === "json"
        ? { type: "json_object" }
        : { type: "text" },
    };
    if (request.modelProfile.temperature !== undefined) {
      createRequest.temperature = request.modelProfile.temperature;
    }
    if (request.modelProfile.topP !== undefined) {
      createRequest.top_p = request.modelProfile.topP;
    }
    if (request.stopSequences?.length) {
      createRequest.stop = request.stopSequences;
    }

    const response = await this.deps.client.create(createRequest);
    const choice = response.choices?.[0];
    const usage = response.usage ?? {};

    return {
      provider: this.provider,
      model: response.model ?? request.modelProfile.model,
      outputText: choice?.message?.content ?? "",
      finishReason: mapGroqFinishReason(choice?.finish_reason),
      tokenUsage: {
        inputTokens: usage.prompt_tokens ?? 0,
        outputTokens: usage.completion_tokens ?? 0,
        totalTokens:
          usage.total_tokens ??
          (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0),
      },
      latencyMs: this.clock.now() - startedAt,
    };
  }

  /** Counts prompt tokens using an injected token counter when native counting is unavailable. */
  async countTokens(
    request: Pick<LLMRequest, "modelProfile" | "prompts">,
  ): Promise<number> {
    if (!this.deps.tokenCounter) {
      throw new Error(
        "GroqProviderAdapter requires an injected token counter when native counting is unavailable.",
      );
    }
    return this.deps.tokenCounter.countText(
      stringifyPromptFrames(request.prompts),
      request.modelProfile.model,
    );
  }
}

/** Ollama adapter that maps the unified request into the Ollama chat API shape. */
export class OllamaProviderAdapter implements LLMProviderAdapter {
  /** Fixed provider identifier for this adapter. */
  readonly provider: LLMProvider = "ollama";

  private readonly clock: ProviderAdapterClock;

  /** Creates an Ollama adapter around an injected chat client. */
  constructor(private readonly deps: OllamaProviderAdapterDependencies) {
    this.clock = deps.clock ?? {
      now: () => Date.now(),
    };
  }

  /** Advertises provider capability hints to the unified gateway. */
  getCapabilities(): LLMProviderCapabilities {
    return {
      supportsJsonMode: true,
    };
  }

  /** Executes one generation request against Ollama chat. */
  async generate(request: LLMRequest): Promise<LLMResponse> {
    const startedAt = this.clock.now();
    const chatRequest: OllamaChatRequest = {
      model: request.modelProfile.model,
      messages: toOllamaChatMessages(request.prompts),
      stream: false,
    };
    if (request.responseFormat === "json") {
      chatRequest.format = "json";
    }
    const options = buildOllamaChatOptions(request);
    if (options) {
      chatRequest.options = options;
    }

    const response = await this.deps.client.chat(chatRequest);
    const inputTokens = response.prompt_eval_count ?? 0;
    const outputTokens = response.eval_count ?? 0;

    return {
      provider: this.provider,
      model: response.model ?? request.modelProfile.model,
      outputText: response.message?.content ?? "",
      finishReason: mapOllamaFinishReason(response.done_reason),
      tokenUsage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
      },
      latencyMs: this.clock.now() - startedAt,
    };
  }

  /** Counts prompt tokens using an injected token counter when native counting is unavailable. */
  async countTokens(
    request: Pick<LLMRequest, "modelProfile" | "prompts">,
  ): Promise<number> {
    if (!this.deps.tokenCounter) {
      throw new Error(
        "OllamaProviderAdapter requires an injected token counter when native counting is unavailable.",
      );
    }
    return this.deps.tokenCounter.countText(
      stringifyPromptFrames(request.prompts),
      request.modelProfile.model,
    );
  }
}

function toOpenAIInputMessages(prompts: PromptFrame[]): OpenAIInputMessage[] {
  return prompts
    .filter((prompt) => prompt.role !== "tool")
    .map((prompt): OpenAIInputMessage => ({
      role:
        prompt.role === "system"
          ? "system"
          : prompt.role === "assistant"
            ? "assistant"
            : "user",
      content: [{
        type: "input_text",
        text: prompt.content,
      }],
    }));
}

function toGeminiRequest(request: LLMRequest): GeminiGenerateContentRequest {
  const systemInstructionText = request.prompts
    .filter((prompt) => prompt.role === "system")
    .map((prompt) => prompt.content)
    .join("\n\n");
  const generationConfig = buildGeminiGenerationConfig(request);

  const contents = request.prompts
    .filter((prompt) => prompt.role !== "system" && prompt.role !== "tool")
    .map((prompt): GeminiContent => ({
      role: prompt.role === "assistant" ? "model" : "user",
      parts: [{
        text: prompt.content,
      }],
    }));

  return {
    model: request.modelProfile.model,
    contents,
    ...(systemInstructionText
      ? {
          systemInstruction: {
            parts: [{
              text: systemInstructionText,
            }],
          },
        }
      : {}),
    ...(generationConfig ? { generationConfig } : {}),
  };
}

function toGeminiCountTokensRequest(
  request: Pick<LLMRequest, "modelProfile" | "prompts">,
): GeminiCountTokensRequest {
  const systemInstructionText = request.prompts
    .filter((prompt) => prompt.role === "system")
    .map((prompt) => prompt.content)
    .join("\n\n");

  const contents = request.prompts
    .filter((prompt) => prompt.role !== "system" && prompt.role !== "tool")
    .map((prompt): GeminiContent => ({
      role: prompt.role === "assistant" ? "model" : "user",
      parts: [{
        text: prompt.content,
      }],
    }));

  return {
    model: request.modelProfile.model,
    contents,
    ...(systemInstructionText
      ? {
          systemInstruction: {
            parts: [{
              text: systemInstructionText,
            }],
          },
        }
      : {}),
  };
}

function buildGeminiGenerationConfig(request: LLMRequest): GeminiGenerationConfig | undefined {
  const config: GeminiGenerationConfig = {};

  if (request.modelProfile.temperature !== undefined) {
    config.temperature = request.modelProfile.temperature;
  }
  if (request.modelProfile.topP !== undefined) {
    config.topP = request.modelProfile.topP;
  }
  if (request.maxOutputTokens > 0) {
    config.maxOutputTokens = request.maxOutputTokens;
  }
  if (request.stopSequences?.length) {
    config.stopSequences = request.stopSequences;
  }
  if (request.responseFormat === "json") {
    config.responseMimeType = "application/json";
  }

  return Object.keys(config).length > 0 ? config : undefined;
}

function flattenGeminiCandidates(candidates: GeminiCandidate[]): string {
  return candidates
    .flatMap((candidate) => candidate.content?.parts ?? [])
    .map((part) => part.text)
    .join("");
}

function flattenOpenAIOutput(output: OpenAIResponseOutputItem[]): string {
  return output
    .flatMap((item) => item.content ?? [])
    .filter((item) => item.type === "output_text")
    .map((item) => item.text)
    .join("");
}

function toGroqChatMessages(prompts: PromptFrame[]): GroqChatMessage[] {
  return prompts
    .filter((prompt) => prompt.role !== "tool")
    .map((prompt): GroqChatMessage => ({
      role:
        prompt.role === "system"
          ? "system"
          : prompt.role === "assistant"
            ? "assistant"
            : "user",
      content: prompt.content,
    }));
}

function toOllamaChatMessages(prompts: PromptFrame[]): OllamaChatMessage[] {
  return prompts
    .filter((prompt) => prompt.role !== "tool")
    .map((prompt): OllamaChatMessage => ({
      role:
        prompt.role === "system"
          ? "system"
          : prompt.role === "assistant"
            ? "assistant"
            : "user",
      content: prompt.content,
    }));
}

function buildOllamaChatOptions(request: LLMRequest): OllamaChatOptions | undefined {
  const options: OllamaChatOptions = {};

  if (request.modelProfile.temperature !== undefined) {
    options.temperature = request.modelProfile.temperature;
  }
  if (request.modelProfile.topP !== undefined) {
    options.top_p = request.modelProfile.topP;
  }
  if (request.maxOutputTokens > 0) {
    options.num_predict = request.maxOutputTokens;
  }
  if (request.stopSequences?.length) {
    options.stop = request.stopSequences;
  }

  return Object.keys(options).length > 0 ? options : undefined;
}

function toAnthropicRequest(request: LLMRequest): AnthropicMessagesCreateRequest {
  const system = request.prompts
    .filter((prompt) => prompt.role === "system")
    .map((prompt) => prompt.content)
    .join("\n\n");
  const messages = request.prompts
    .filter((prompt) => prompt.role !== "system" && prompt.role !== "tool")
    .map((prompt): AnthropicMessage => ({
      role: prompt.role === "assistant" ? "assistant" : "user",
      content: [{
        type: "text" as const,
        text: prompt.content,
      }],
    }));

  const result: AnthropicMessagesCreateRequest = {
    model: request.modelProfile.model,
    messages,
    max_tokens: request.maxOutputTokens,
  };
  if (system) {
    result.system = system;
  }
  if (request.modelProfile.temperature !== undefined) {
    result.temperature = request.modelProfile.temperature;
  }
  if (request.modelProfile.topP !== undefined) {
    result.top_p = request.modelProfile.topP;
  }
  if (request.stopSequences?.length) {
    result.stop_sequences = request.stopSequences;
  }
  return result;
}

function toAnthropicCountTokensRequest(
  request: Pick<LLMRequest, "modelProfile" | "prompts">,
): AnthropicMessagesCountTokensRequest {
  const system = request.prompts
    .filter((prompt) => prompt.role === "system")
    .map((prompt) => prompt.content)
    .join("\n\n");
  const messages = request.prompts
    .filter((prompt) => prompt.role !== "system" && prompt.role !== "tool")
    .map((prompt): AnthropicMessage => ({
      role: prompt.role === "assistant" ? "assistant" : "user",
      content: [{
        type: "text" as const,
        text: prompt.content,
      }],
    }));

  const result: AnthropicMessagesCountTokensRequest = {
    model: request.modelProfile.model,
    messages,
  };
  if (system) {
    result.system = system;
  }
  return result;
}

function mapOpenAIFinishReason(status?: string): LLMResponse["finishReason"] {
  switch (status) {
    case "completed":
      return "stop";
    case "incomplete":
      return "length";
    default:
      return "stop";
  }
}

function mapGeminiFinishReason(finishReason?: string): LLMResponse["finishReason"] {
  switch (finishReason) {
    case "MAX_TOKENS":
      return "length";
    case "SAFETY":
      return "content-filter";
    case "STOP":
    default:
      return "stop";
  }
}

function mapAnthropicFinishReason(
  stopReason?: AnthropicMessagesCreateResponse["stop_reason"],
): LLMResponse["finishReason"] {
  switch (stopReason) {
    case "max_tokens":
      return "length";
    case "end_turn":
    case "stop_sequence":
    case "tool_use":
    default:
      return "stop";
  }
}

function mapGroqFinishReason(finishReason?: string): LLMResponse["finishReason"] {
  switch (finishReason) {
    case "length":
      return "length";
    case "content_filter":
      return "content-filter";
    case "stop":
    default:
      return "stop";
  }
}

function mapOllamaFinishReason(doneReason?: string): LLMResponse["finishReason"] {
  switch (doneReason) {
    case "length":
      return "length";
    case "stop":
    default:
      return "stop";
  }
}

function stringifyPromptFrames(prompts: PromptFrame[]): string {
  return prompts
    .map((prompt) => `${prompt.role.toUpperCase()}: ${prompt.content}`)
    .join("\n\n");
}

// TODO:
// - Add request/response schema validation against the exact SDK versions used in production.
// - Add streaming support once the unified gateway exposes a streaming contract.
// - Add richer finish-reason mapping once exact provider SDK surfaces are finalized.
// - REQUIRES: concrete OpenAI, Anthropic, Gemini, Groq, and Ollama clients plus real credentials and, where needed, tokenizer support.
