// File: src/runtime-platforms.ts
/**
 * Runtime platform adapters and a generic LLM-backed agent runtime for Claude
 * Code, Cursor, and OpenAI Agents SDK targets.
 */

import type {
  AgentArtifact,
  AgentDefinition,
  AgentResult,
  AgentRunContext,
  AgentRunStatus,
  AgentRuntime,
  ApprovalKind,
  JsonObject,
  JsonValue,
  LLMGateway,
  PromptFrame,
  RuntimePlatformAdapter,
  RuntimeTarget,
} from "./types";

/** Loads prompt assets referenced by `systemPromptRef`. */
export interface PromptTemplateLoader {
  load(ref: string): Promise<string>;
}

/** Optional prompt-template source backed by an in-memory map. */
export class InMemoryPromptTemplateLoader implements PromptTemplateLoader {
  /** Creates a template loader from a prompt-ref to prompt-text map. */
  constructor(private readonly prompts: Record<string, string>) {}

  /** Loads one prompt by reference. */
  async load(ref: string): Promise<string> {
    const prompt = this.prompts[ref];
    if (!prompt) {
      throw new Error(`Prompt template "${ref}" was not found.`);
    }
    return prompt;
  }
}

/** Dependencies required by the generic LLM-backed agent runtime. */
export interface PlatformAgentRuntimeDependencies {
  llmGateway: LLMGateway;
  platformAdapter: RuntimePlatformAdapter;
  promptTemplateLoader?: PromptTemplateLoader;
}

/**
 * Generic agent runtime that delegates prompt/result shaping to a platform
 * adapter while using the unified LLM gateway for execution.
 */
export class PlatformAgentRuntime implements AgentRuntime {
  /** Creates a runtime for one agent definition and one runtime target. */
  constructor(
    readonly definition: AgentDefinition,
    private readonly deps: PlatformAgentRuntimeDependencies,
  ) {}

  /** Executes the agent via the configured platform adapter and LLM gateway. */
  async execute(context: AgentRunContext): Promise<AgentResult> {
    this.ensurePlatformCompatibility(context.agent, this.deps.platformAdapter.target);
    const promptFrames = await this.buildPrompts(context);
    const response = await this.deps.llmGateway.generate({
      scope: context.scope,
      modelProfile: context.agent.modelProfile,
      prompts: promptFrames,
      responseFormat: "json",
      maxOutputTokens: context.tokenBudget.maxOutputTokens,
      budget: context.tokenBudget,
      metadata: {
        runId: context.runId,
        sessionId: context.sessionId,
        agentId: context.agent.id,
        runtimeTarget: this.deps.platformAdapter.target,
      },
    });

    return this.deps.platformAdapter.normalizeResult({
      context,
      response,
    });
  }

  private async buildPrompts(context: AgentRunContext): Promise<PromptFrame[]> {
    const promptFrames: PromptFrame[] = [];
    const promptTemplate = context.agent.systemPromptRef
      ? await this.deps.promptTemplateLoader?.load(context.agent.systemPromptRef)
      : undefined;
    const adapterSystemPrompt = await this.deps.platformAdapter.buildSystemPrompt(context);
    const systemContent = [promptTemplate, adapterSystemPrompt]
      .filter((value): value is string => Boolean(value))
      .join("\n\n");

    promptFrames.push({
      role: "system",
      content: systemContent || buildFallbackSystemPrompt(context),
      name: context.agent.name,
    });
    promptFrames.push({
      role: "user",
      content: await this.deps.platformAdapter.buildUserPrompt(context),
      name: context.request.requesterId,
    });

    return promptFrames;
  }

  private ensurePlatformCompatibility(agent: AgentDefinition, target: RuntimeTarget): void {
    if (agent.runtimeTargets?.length && !agent.runtimeTargets.includes(target)) {
      throw new Error(
        `Agent ${agent.id} does not support runtime target ${target}.`,
      );
    }
  }
}

/** Base adapter that emits a structured JSON result envelope. */
abstract class BaseJsonRuntimePlatformAdapter implements RuntimePlatformAdapter {
  /** Target runtime represented by this adapter. */
  abstract readonly target: RuntimeTarget;

  /** Adapter-specific operating rules that shape prompt instructions. */
  protected abstract readonly runtimeGuidance: string;

  /** Builds the system prompt for the target runtime. */
  async buildSystemPrompt(context: AgentRunContext): Promise<string> {
    return [
      `You are ${context.agent.name}, a ${context.agent.role} agent running inside ${this.target}.`,
      this.runtimeGuidance,
      "Return a single JSON object with keys: status, summary, structuredOutput, artifacts, handoff, validationIssues.",
      "Never return markdown fences, prose before JSON, or shell commands.",
      `Respect max token budget and keep the output within ${context.tokenBudget.maxOutputTokens} output tokens.`,
      `Security: shell execution requires human approval=${String(context.agent.securityPolicy.shellExecutionRequiresApproval)}.`,
    ].join("\n");
  }

  /** Builds the user prompt carrying the current task context. */
  async buildUserPrompt(context: AgentRunContext): Promise<string> {
    return [
      `Goal: ${context.request.goal}`,
      `Agent ID: ${context.agent.id}`,
      `Team ID: ${context.team.id}`,
      `Hop Index: ${String(context.hopIndex)}`,
      `Request Input: ${safeStringify(context.request.input)}`,
      `Request Constraints: ${safeStringify(context.request.constraints ?? {})}`,
      `Session State: ${safeStringify(context.memory.sessionState)}`,
      `Relevant Memories: ${serializeMemoryContext(context)}`,
      `Available Skills: ${serializeSkillContext(context)}`,
      `Recent Messages: ${serializeMessages(context)}`,
    ].join("\n\n");
  }

  /** Normalizes the provider response into the canonical `AgentResult`. */
  async normalizeResult(args: {
    context: AgentRunContext;
    response: {
      outputText: string;
      structuredOutput?: JsonObject;
      tokenUsage: {
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
        cachedInputTokens?: number;
      };
    };
  }): Promise<AgentResult> {
    const raw = parseRuntimeEnvelope(args.response.structuredOutput, args.response.outputText);
    return {
      status: coerceStatus(raw.status),
      summary: coerceString(raw.summary, "No summary provided."),
      structuredOutput: coerceJsonObject(raw.structuredOutput),
      artifacts: coerceArtifacts(raw.artifacts),
      handoff: coerceHandoff(raw.handoff, args.context),
      validationIssues: coerceStringArray(raw.validationIssues),
      tokenUsage: args.response.tokenUsage,
    };
  }
}

/** Runtime adapter tuned for Claude Code-style task execution. */
export class ClaudeCodeRuntimePlatformAdapter extends BaseJsonRuntimePlatformAdapter {
  readonly target = "claude-code" as const;
  protected readonly runtimeGuidance =
    "Optimize for precise implementation planning, code-safe edits, and concise reasoning artifacts.";
}

/** Runtime adapter tuned for Cursor-driven coding and review workflows. */
export class CursorRuntimePlatformAdapter extends BaseJsonRuntimePlatformAdapter {
  readonly target = "cursor" as const;
  protected readonly runtimeGuidance =
    "Optimize for editor-centric assistance, code diffs, review notes, and short actionable handoffs.";
}

/** Runtime adapter tuned for OpenAI Agents SDK orchestration. */
export class OpenAIAgentsSdkRuntimePlatformAdapter extends BaseJsonRuntimePlatformAdapter {
  readonly target = "openai-agents-sdk" as const;
  protected readonly runtimeGuidance =
    "Optimize for agent-tool orchestration with clear structured outputs, explicit failure states, and deterministic handoff directives.";
}

/** Creates one platform adapter per supported runtime target. */
export function createDefaultRuntimePlatformAdapters(): RuntimePlatformAdapter[] {
  return [
    new ClaudeCodeRuntimePlatformAdapter(),
    new CursorRuntimePlatformAdapter(),
    new OpenAIAgentsSdkRuntimePlatformAdapter(),
  ];
}

function buildFallbackSystemPrompt(context: AgentRunContext): string {
  return [
    `You are ${context.agent.name}.`,
    `Role: ${context.agent.role}.`,
    `Description: ${context.agent.description}.`,
  ].join("\n");
}

function serializeMemoryContext(context: AgentRunContext): string {
  if (!context.memory.relevantMemories.length) {
    return "[]";
  }

  return safeStringify(
    context.memory.relevantMemories.slice(0, 8).map((record) => ({
      id: record.id,
      namespace: record.namespace,
      text: record.text,
      attributes: record.attributes,
    })),
  );
}

function serializeSkillContext(context: AgentRunContext): string {
  if (!context.memory.learnedSkills.length) {
    return "[]";
  }

  return safeStringify(
    context.memory.learnedSkills.slice(0, 12).map((skill) => ({
      id: skill.id,
      role: skill.role,
      name: skill.name,
      tags: skill.tags,
      capabilities: skill.capabilities,
    })),
  );
}

function serializeMessages(context: AgentRunContext): string {
  if (!context.messageHistory.length) {
    return "[]";
  }

  return safeStringify(
    context.messageHistory.slice(-8).map((message) => ({
      kind: message.kind,
      senderAgentId: message.senderAgentId,
      recipientAgentId: message.recipientAgentId,
      payload: message.payload,
    })),
  );
}

function parseRuntimeEnvelope(
  structuredOutput: JsonObject | undefined,
  outputText: string,
): JsonObject {
  if (structuredOutput) {
    return structuredOutput;
  }

  try {
    const parsed = JSON.parse(outputText) as JsonValue;
    return coerceJsonObject(parsed);
  } catch {
    return {
      status: "failed",
      summary: "Runtime adapter could not parse the provider JSON envelope.",
      structuredOutput: {
        rawText: outputText,
      },
      artifacts: [],
      handoff: {
        disposition: "fail",
        reason: "Provider returned malformed JSON output.",
      },
      validationIssues: ["Malformed JSON envelope returned by provider."],
    };
  }
}

function coerceStatus(value: JsonValue | undefined): AgentRunStatus {
  switch (value) {
    case "queued":
    case "running":
    case "succeeded":
    case "failed":
    case "timed-out":
    case "budget-exhausted":
    case "awaiting-approval":
    case "rejected":
      return value;
    default:
      return "succeeded";
  }
}

function coerceJsonObject(value: JsonValue | undefined): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function coerceString(value: JsonValue | undefined, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function coerceStringArray(value: JsonValue | undefined): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

function coerceArtifacts(value: JsonValue | undefined): AgentArtifact[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((artifact, index) => {
      const item = coerceJsonObject(artifact);
      const content = item.content;
      if (typeof content !== "string") {
        return null;
      }
      const result: AgentArtifact = {
        id: coerceString(item.id, `artifact_${index + 1}`),
        kind: coerceArtifactKind(item.kind),
        title: coerceString(item.title, `Artifact ${index + 1}`),
        mimeType: coerceString(item.mimeType, "text/plain"),
        content,
      };
      const metadata = coerceOptionalJsonObject(item.metadata);
      if (metadata) {
        result.metadata = metadata;
      }
      return result;
    })
    .filter((artifact): artifact is AgentArtifact => artifact !== null);
}

function coerceArtifactKind(value: JsonValue | undefined): AgentArtifact["kind"] {
  switch (value) {
    case "text":
    case "json":
    case "markdown":
    case "code":
    case "report":
    case "citation":
      return value;
    default:
      return "text";
  }
}

function coerceHandoff(value: JsonValue | undefined, context: AgentRunContext): AgentResult["handoff"] {
  const handoff = coerceJsonObject(value);
  const disposition = handoff.disposition;
  const approvalKind = handoff.approvalKind;
  const result: AgentResult["handoff"] = {
    disposition:
      disposition === "complete" ||
      disposition === "route" ||
      disposition === "retry" ||
      disposition === "escalate" ||
      disposition === "await-approval" ||
      disposition === "fail" ||
      disposition === "noop"
        ? disposition
        : "complete",
    reason: coerceString(handoff.reason, `Completed by ${context.agent.id}.`),
  };
  if (typeof handoff.targetAgentId === "string") {
    result.targetAgentId = handoff.targetAgentId;
  }
  if (typeof handoff.retryAfterMs === "number") {
    result.retryAfterMs = handoff.retryAfterMs;
  }
  const normalizedApprovalKind = coerceApprovalKind(approvalKind);
  if (normalizedApprovalKind) {
    result.approvalKind = normalizedApprovalKind;
  }
  const routeMetadata = coerceOptionalJsonObject(handoff.routeMetadata);
  if (routeMetadata) {
    result.routeMetadata = routeMetadata;
  }
  return result;
}

function coerceApprovalKind(value: JsonValue | undefined): ApprovalKind | undefined {
  switch (value) {
    case "tool-execution":
    case "secret-access":
    case "external-send":
    case "privileged-handoff":
      return value;
    default:
      return undefined;
  }
}

function coerceOptionalJsonObject(value: JsonValue | undefined): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : undefined;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "{}";
  }
}

// TODO:
// - Add runtime adapters that consume native Claude Code, Cursor, or Agents SDK tool-call envelopes directly.
// - Add schema-aware validation of `structuredOutput` and `handoff` against skill output contracts.
// - Add prompt-template rendering variables instead of concatenating raw context strings.
// - REQUIRES: concrete prompt assets and, where needed, provider adapters that supply native JSON mode.
