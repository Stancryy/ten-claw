// File: src/llm-gateway.ts
/**
 * Unified LLM gateway with budget enforcement, provider fallback, and prompt
 * optimization.
 */

import type {
  FrameworkError,
  JsonObject,
  LLMGateway,
  LLMProvider,
  LLMRequest,
  LLMResponse,
  ModelProfile,
  PromptFrame,
} from "./types";

/** Provider-specific adapter contract used by the unified gateway. */
export interface LLMProviderAdapter {
  readonly provider: LLMProvider;
  generate(request: LLMRequest): Promise<LLMResponse>;
  countTokens?(request: Pick<LLMRequest, "modelProfile" | "prompts">): Promise<number>;
  getCapabilities?(): LLMProviderCapabilities;
}

/** Prompt optimization strategy used before token budgeting and provider calls. */
export interface PromptOptimizer {
  optimize(prompts: PromptFrame[]): PromptFrame[];
  compact(prompts: PromptFrame[], targetTokenLimit: number): PromptFrame[];
  truncate(prompts: PromptFrame[], targetTokenLimit: number): PromptFrame[];
}

/** Optional clock abstraction for deterministic latency testing. */
export interface GatewayClock {
  now(): number;
}

/** Provider capabilities used for early validation and fallback selection. */
export interface LLMProviderCapabilities {
  supportsJsonMode: boolean;
  supportsToolUse?: boolean;
  maxContextWindowTokens?: number;
}

/** Configuration for retry, timeout, and circuit behavior inside the gateway. */
export interface LLMGatewayConfig {
  providerFailureThreshold: number;
  providerCircuitOpenMs: number;
}

/** In-memory provider circuit state used to avoid repeatedly hitting failing backends. */
export interface ProviderCircuitState {
  provider: LLMProvider;
  failureCount: number;
  state: "closed" | "open";
  openedAt?: number;
  openUntil?: number;
}

/** Dependencies required by the gateway runtime. */
export interface LLMGatewayDependencies {
  adapters: Partial<Record<LLMProvider, LLMProviderAdapter>>;
  promptOptimizer?: PromptOptimizer;
  clock?: GatewayClock;
  config?: Partial<LLMGatewayConfig>;
}

/** Safe default optimizer that removes noise before expensive LLM calls. */
export class DefaultPromptOptimizer implements PromptOptimizer {
  /** Removes empty frames and exact consecutive duplicates. */
  optimize(prompts: PromptFrame[]): PromptFrame[] {
    const optimized: PromptFrame[] = [];

    for (const prompt of prompts) {
      const cleaned = {
        ...prompt,
        content: normalizeWhitespace(prompt.content),
      };
      if (!cleaned.content) {
        continue;
      }
      const previous = optimized.at(-1);
      if (
        previous &&
        previous.role === cleaned.role &&
        previous.name === cleaned.name &&
        previous.content === cleaned.content
      ) {
        continue;
      }
      optimized.push(cleaned);
    }

    return optimized;
  }

  /** Keeps the system prompt and recent context, replacing older history with a compact note. */
  compact(prompts: PromptFrame[], targetTokenLimit: number): PromptFrame[] {
    if (!prompts.length) {
      return [];
    }

    const systemPrompts = prompts.filter((prompt) => prompt.role === "system");
    const nonSystemPrompts = prompts.filter((prompt) => prompt.role !== "system");
    const keptTail = takeTailWithinBudget(nonSystemPrompts, targetTokenLimit, false);
    const omittedCount = Math.max(nonSystemPrompts.length - keptTail.length, 0);

    if (omittedCount === 0) {
      return [...systemPrompts, ...keptTail];
    }

    return [
      ...systemPrompts,
      {
        role: "assistant",
        content:
          `Budget compaction note: ${omittedCount} earlier messages were omitted. ` +
          "Use session memory and retained recent context as the source of truth.",
      },
      ...keptTail,
    ];
  }

  /** Preserves the system prompt and trims to the newest frames that fit. */
  truncate(prompts: PromptFrame[], targetTokenLimit: number): PromptFrame[] {
    if (!prompts.length) {
      return [];
    }

    const systemPrompts = prompts.filter((prompt) => prompt.role === "system");
    const nonSystemPrompts = prompts.filter((prompt) => prompt.role !== "system");
    return [...systemPrompts, ...takeTailWithinBudget(nonSystemPrompts, targetTokenLimit, true)];
  }
}

/**
 * Budget-aware gateway implementation for multi-provider LLM execution.
 */
export class BudgetAwareLLMGateway implements LLMGateway {
  private readonly promptOptimizer: PromptOptimizer;
  private readonly clock: GatewayClock;
  private readonly config: LLMGatewayConfig;
  private readonly providerCircuits = new Map<LLMProvider, ProviderCircuitState>();

  /** Creates a gateway with injected provider adapters and optimization policies. */
  constructor(private readonly deps: LLMGatewayDependencies) {
    this.promptOptimizer = deps.promptOptimizer ?? new DefaultPromptOptimizer();
    this.clock = deps.clock ?? { now: () => Date.now() };
    this.config = {
      providerFailureThreshold: 3,
      providerCircuitOpenMs: 30_000,
      ...deps.config,
    };
  }

  /** Counts prompt tokens using a provider-native counter when available. */
  async countTokens(request: Pick<LLMRequest, "modelProfile" | "prompts">): Promise<number> {
    const adapter = this.requireAdapter(request.modelProfile.provider);
    if (adapter.countTokens) {
      return adapter.countTokens(request);
    }
    return estimatePromptTokens(request.prompts);
  }

  /** Generates a response with fallback routing and token-budget enforcement. */
  async generate(request: LLMRequest): Promise<LLMResponse> {
    const models = expandModelFallbacks(request.modelProfile);
    let lastError: FrameworkError | null = null;

    for (const modelProfile of models) {
      if (this.isProviderCircuitOpen(modelProfile.provider)) {
        lastError = {
          code: "provider-error",
          message: `Provider circuit is open for ${modelProfile.provider}.`,
          retryable: true,
          details: {
            provider: modelProfile.provider,
          },
        };
        continue;
      }
      const maxAttempts = Math.max((modelProfile.maxRetries ?? 0) + 1, 1);

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          const prepared = await this.prepareRequestForModel(request, modelProfile);
          const adapter = this.requireAdapter(modelProfile.provider);
          validateProviderCapabilities(adapter, prepared);
          const startedAt = this.clock.now();
          console.log(`[LLM Gateway] Calling ${modelProfile.provider}/${modelProfile.model}...`);
          const response = await withTimeout(
            adapter.generate(prepared),
            modelProfile.timeoutMs,
          );
          console.log(`[LLM Gateway] Raw response from ${modelProfile.provider}:`);
          console.log(`  Provider: ${response.provider}`);
          console.log(`  Model: ${response.model}`);
          console.log(`  Output text (first 500 chars): ${response.outputText?.substring(0, 500)}`);
          console.log(`  Latency: ${response.latencyMs}ms`);
          console.log(`  Tokens: ${JSON.stringify(response.tokenUsage)}`);
          const completed = finalizeResponse(response, prepared, this.clock.now() - startedAt);
          const validated = validateStructuredResponse(completed, prepared.responseFormat);
          this.resetProviderCircuit(modelProfile.provider);
          return validated;
        } catch (error) {
          lastError = normalizeGatewayError(error);
          this.recordProviderFailure(modelProfile.provider, lastError);
          if (!lastError.retryable || attempt >= maxAttempts) {
            break;
          }
        }
      }
    }

    throw (
      lastError ?? {
        code: "provider-error",
        message: "No LLM provider produced a successful response.",
        retryable: false,
      }
    );
  }

  private async prepareRequestForModel(
    request: LLMRequest,
    modelProfile: ModelProfile,
  ): Promise<LLMRequest> {
    const optimizedPrompts = this.promptOptimizer.optimize(request.prompts);
    const targetMaxOutput = Math.min(
      request.maxOutputTokens,
      request.budget.maxOutputTokens,
      request.budget.maxTotalTokens,
    );
    if (targetMaxOutput <= 0) {
      throw budgetError("Token budget leaves no room for output tokens.");
    }

    let prepared: LLMRequest = {
      ...request,
      modelProfile,
      prompts: optimizedPrompts,
      maxOutputTokens: targetMaxOutput,
    };

    let inputTokens = await this.countTokens({
      modelProfile,
      prompts: prepared.prompts,
    });
    const allowedInputTokens = Math.max(
      Math.min(
        request.budget.maxInputTokens,
        request.budget.maxTotalTokens -
          prepared.maxOutputTokens -
          (request.budget.reserveForSystem ?? 0) -
          (request.budget.reserveForHandoff ?? 0),
      ),
      0,
    );

    if (inputTokens <= allowedInputTokens) {
      ensureContextWindow(prepared, inputTokens);
      return prepared;
    }

    switch (request.budget.overflowStrategy) {
      case "summarize":
        prepared = {
          ...prepared,
          prompts: this.promptOptimizer.compact(prepared.prompts, allowedInputTokens),
        };
        break;
      case "truncate":
        prepared = {
          ...prepared,
          prompts: this.promptOptimizer.truncate(prepared.prompts, allowedInputTokens),
        };
        break;
      case "escalate":
      case "fail":
        throw budgetError(
          `Input prompt budget exceeded for model ${modelProfile.provider}/${modelProfile.model}.`,
          {
            inputTokens,
            allowedInputTokens,
            strategy: request.budget.overflowStrategy,
          },
        );
    }

    inputTokens = await this.countTokens({
      modelProfile,
      prompts: prepared.prompts,
    });
    if (inputTokens > allowedInputTokens) {
      throw budgetError(
        `Prompt could not be reduced to fit the configured budget for ${modelProfile.provider}/${modelProfile.model}.`,
        {
          inputTokens,
          allowedInputTokens,
          strategy: request.budget.overflowStrategy,
        },
      );
    }

    ensureContextWindow(prepared, inputTokens);
    return prepared;
  }

  private requireAdapter(provider: LLMProvider): LLMProviderAdapter {
    const adapter = this.deps.adapters[provider];
    if (!adapter) {
      throw {
        code: "provider-error",
        message: `No LLM adapter is registered for provider ${provider}.`,
        retryable: false,
      } satisfies FrameworkError;
    }
    return adapter;
  }

  private isProviderCircuitOpen(provider: LLMProvider): boolean {
    const state = this.providerCircuits.get(provider);
    if (!state || state.state !== "open" || !state.openUntil) {
      return false;
    }
    if (state.openUntil <= this.clock.now()) {
      this.providerCircuits.set(provider, {
        provider,
        failureCount: 0,
        state: "closed",
      });
      return false;
    }
    return true;
  }

  private resetProviderCircuit(provider: LLMProvider): void {
    this.providerCircuits.set(provider, {
      provider,
      failureCount: 0,
      state: "closed",
    });
  }

  private recordProviderFailure(provider: LLMProvider, error: FrameworkError): void {
    if (!error.retryable) {
      return;
    }

    const current = this.providerCircuits.get(provider);
    const failureCount = (current?.failureCount ?? 0) + 1;
    if (failureCount < this.config.providerFailureThreshold) {
      this.providerCircuits.set(provider, {
        provider,
        failureCount,
        state: "closed",
      });
      return;
    }

    this.providerCircuits.set(provider, {
      provider,
      failureCount,
      state: "open",
      openedAt: this.clock.now(),
      openUntil: this.clock.now() + this.config.providerCircuitOpenMs,
    });
  }
}

/** Expands a model profile into ordered primary and fallback candidates. */
export function expandModelFallbacks(modelProfile: ModelProfile): ModelProfile[] {
  const fallbacks =
    modelProfile.fallbackModels?.map((fallback) => ({
      ...modelProfile,
      provider: fallback.provider,
      model: fallback.model,
      fallbackModels: [],
    })) ?? [];

  return [modelProfile, ...fallbacks];
}

/** Heuristic token estimator used when a provider adapter lacks native counting. */
export function estimatePromptTokens(prompts: PromptFrame[]): number {
  return prompts.reduce((total, prompt) => total + estimateTextTokens(prompt.content) + 6, 0);
}

/** Heuristic text token estimator tuned for rough preflight budgeting. */
export function estimateTextTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function finalizeResponse(
  response: LLMResponse,
  request: LLMRequest,
  measuredLatencyMs: number,
): LLMResponse {
  const latencyMs = response.latencyMs > 0 ? response.latencyMs : measuredLatencyMs;
  const totalTokens =
    response.tokenUsage.totalTokens ||
    response.tokenUsage.inputTokens + response.tokenUsage.outputTokens;
  const inputTokens = response.tokenUsage.inputTokens;
  const outputTokens = response.tokenUsage.outputTokens;

  if (inputTokens > request.budget.maxInputTokens) {
    throw budgetError("Provider response exceeded the configured input token budget.", {
      inputTokens,
      maxInputTokens: request.budget.maxInputTokens,
      provider: response.provider,
      model: response.model,
    });
  }

  if (outputTokens > request.maxOutputTokens || outputTokens > request.budget.maxOutputTokens) {
    throw budgetError("Provider response exceeded the configured output token budget.", {
      outputTokens,
      maxOutputTokens: Math.min(request.maxOutputTokens, request.budget.maxOutputTokens),
      provider: response.provider,
      model: response.model,
    });
  }

  if (totalTokens > request.budget.maxTotalTokens) {
    throw budgetError("Provider response exceeded the configured total token budget.", {
      totalTokens,
      maxTotalTokens: request.budget.maxTotalTokens,
      provider: response.provider,
      model: response.model,
    });
  }

  return {
    ...response,
    latencyMs,
    tokenUsage: {
      ...response.tokenUsage,
      totalTokens,
    },
  };
}

function validateProviderCapabilities(
  adapter: LLMProviderAdapter,
  request: LLMRequest,
): void {
  const capabilities = adapter.getCapabilities?.();
  if (!capabilities) {
    return;
  }

  if (request.responseFormat === "json" && request.modelProfile.supportsJsonMode === true) {
    if (!capabilities.supportsJsonMode) {
      throw {
        code: "provider-error",
        message:
          `Provider ${request.modelProfile.provider} does not support native JSON mode for model ${request.modelProfile.model}.`,
        retryable: false,
      } satisfies FrameworkError;
    }
  }
}

function ensureContextWindow(request: LLMRequest, inputTokens: number): void {
  const contextWindowTokens = request.modelProfile.contextWindowTokens;
  if (!contextWindowTokens) {
    return;
  }

  const projectedTotal = inputTokens + request.maxOutputTokens;
  if (projectedTotal > contextWindowTokens) {
    throw {
      code: "budget-exhausted",
      message:
        `Prompt and output budget exceed the context window for ${request.modelProfile.provider}/${request.modelProfile.model}.`,
      retryable: false,
      details: {
        inputTokens,
        maxOutputTokens: request.maxOutputTokens,
        contextWindowTokens,
        provider: request.modelProfile.provider,
        model: request.modelProfile.model,
      },
    } satisfies FrameworkError;
  }
}

function validateStructuredResponse(
  response: LLMResponse,
  responseFormat: LLMRequest["responseFormat"],
): LLMResponse {
  if (responseFormat !== "json" || response.structuredOutput) {
    return response;
  }

  try {
    return {
      ...response,
      structuredOutput: JSON.parse(response.outputText) as JsonObject,
    };
  } catch {
    throw {
      code: "malformed-output",
      message: "Provider returned non-JSON content for a JSON response request.",
      retryable: true,
      details: {
        provider: response.provider,
        model: response.model,
      },
    } satisfies FrameworkError;
  }
}

function normalizeGatewayError(error: unknown): FrameworkError {
  if (isFrameworkError(error)) {
    return error;
  }
  if (error instanceof Error && error.message.toLowerCase().includes("timeout")) {
    return {
      code: "timeout",
      message: error.message,
      retryable: true,
    };
  }
  return {
    code: "provider-error",
    message: error instanceof Error ? error.message : "Unknown LLM gateway error.",
    retryable: true,
  };
}

function budgetError(message: string, details?: JsonObject): FrameworkError {
  return {
    code: "budget-exhausted",
    message,
    retryable: false,
    ...(details ? { details } : {}),
  };
}

function isFrameworkError(value: unknown): value is FrameworkError {
  return Boolean(
    value &&
      typeof value === "object" &&
      "code" in value &&
      "message" in value &&
      "retryable" in value,
  );
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
}

function takeTailWithinBudget(
  prompts: PromptFrame[],
  targetTokenLimit: number,
  hardTrim: boolean,
): PromptFrame[] {
  const kept: PromptFrame[] = [];
  let runningTokens = 0;

  for (let index = prompts.length - 1; index >= 0; index -= 1) {
    const prompt = prompts[index];
    if (!prompt) {
      continue;
    }
    const estimated = estimateTextTokens(prompt.content) + 6;
    if (runningTokens + estimated > targetTokenLimit) {
      if (hardTrim && kept.length === 0 && targetTokenLimit > 0) {
        kept.unshift({ ...prompt, content: trimToEstimatedTokens(prompt.content, targetTokenLimit) });
      }
      break;
    }
    kept.unshift(prompt);
    runningTokens += estimated;
  }

  return kept;
}

function trimToEstimatedTokens(text: string, targetTokenLimit: number): string {
  const maxCharacters = Math.max(targetTokenLimit * 4, 32);
  if (text.length <= maxCharacters) {
    return text;
  }
  return `${text.slice(-maxCharacters)}`;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs?: number): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) {
    return promise;
  }

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`LLM provider request timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

// TODO:
// - Add streaming support and partial token accounting for long-running generations.
// - Add provider capability descriptors for tool use, image input, and prompt caching.
// - Add distributed circuit state for multi-process deployments that share the same providers.
// - REQUIRES: concrete `LLMProviderAdapter` implementations for OpenAI, Anthropic, Gemini, Groq, and Ollama.
