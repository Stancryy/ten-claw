// File: src/learning-engine.ts
/**
 * Learning Engine for automated skill extraction and routing optimization.
 * 
 * Analyzes workflow traces post-execution to:
 * - Identify high-success agent sequences
 * - Detect well-structured JSON output patterns
 * - Extract reusable skills from repeated patterns
 * - Update router scoring based on historical performance
 */

import type {
  AgentId,
  AgentResult,
  AgentRunContext,
  AgentRunRecord,
  JsonObject,
  RunId,
  SkillDefinition,
  SkillId,
  TenantScope,
  AgentRole,
  RoutingDecision,
  LearningEngine,
} from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Workflow Trace Analysis Types
// ─────────────────────────────────────────────────────────────────────────────

/** Complete workflow trace retrieved from Redis for analysis */
export interface WorkflowTrace {
  runId: RunId;
  scope: TenantScope;
  startedAt: string;
  completedAt?: string | undefined;
  status: "completed" | "failed" | "timed-out" | "cancelled";
  agentExecutions: AgentExecutionTrace[];
  routingDecisions: RoutingDecisionTrace[];
  finalOutput?: JsonObject | undefined;
  error?:
    | {
        code: string;
        message: string;
        failedAgentId?: AgentId | undefined;
      }
    | undefined;
}

/** Individual agent execution within a workflow trace */
export interface AgentExecutionTrace {
  agentId: AgentId;
  agentRole: AgentRole;
  agentName: string;
  sequenceIndex: number;
  startedAt: string;
  finishedAt?: string;
  status: "succeeded" | "failed" | "timed-out";
  input: JsonObject;
  output: AgentResult;
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  latencyMs: number;
  handoffDisposition?: string | undefined;
  nextAgentId?: AgentId;
}

/** Routing decision captured during workflow execution */
export interface RoutingDecisionTrace {
  decisionId: string;
  sequenceIndex: number;
  fromAgentId?: AgentId | undefined;
  toAgentId?: AgentId | undefined;
  strategy: string;
  reason: string;
  confidence?: number | undefined;
  recordedAt: string;
  outcome?: "succeeded" | "failed" | "re-routed";
}

// ─────────────────────────────────────────────────────────────────────────────
// Analysis Result Types
// ─────────────────────────────────────────────────────────────────────────────

/** Result of analyzing a workflow trace */
export interface WorkflowAnalysis {
  runId: RunId;
  scope: TenantScope;
  analyzedAt: string;
  agentSequenceAnalysis: AgentSequenceAnalysis;
  jsonOutputAnalysis: JsonOutputAnalysis;
  patternAnalysis: PatternAnalysis;
  suggestedSkills: LearnedSkillCandidate[];
  routingScoreUpdates: AgentRoutingScoreUpdate[];
}

/** Analysis of agent sequence success rates */
export interface AgentSequenceAnalysis {
  sequences: AgentSequence[];
  totalExecutions: number;
  successfulExecutions: number;
  failedExecutions: number;
}

/** A specific sequence of agents and its performance metrics */
export interface AgentSequence {
  agentIds: AgentId[];
  occurrenceCount: number;
  successCount: number;
  failureCount: number;
  successRate: number; // 0.0 to 1.0
  averageLatencyMs: number;
  averageTokenUsage: number;
  taskTypeHint?: string;
}

/** Analysis of JSON output quality from prompts */
export interface JsonOutputAnalysis {
  wellStructuredOutputs: WellStructuredJsonOutput[];
  malformedOutputs: MalformedJsonOutput[];
  totalJsonAttempts: number;
  successfulJsonParses: number;
  jsonParseSuccessRate: number;
}

/** A well-structured JSON output that could indicate a good prompt pattern */
export interface WellStructuredJsonOutput {
  agentId: AgentId;
  agentRole: AgentRole;
  sequenceIndex: number;
  outputKeys: string[];
  nestedDepth: number;
  arrayCount: number;
  hasConsistentTypes: boolean;
  sampleSize: number;
  promptTemplateRef?: string;
  suggestedForSkillExtraction: boolean;
}

/** A malformed JSON output for error pattern tracking */
export interface MalformedJsonOutput {
  agentId: AgentId;
  sequenceIndex: number;
  errorType: "parse-error" | "schema-mismatch" | "missing-keys" | "type-error";
  errorDetails: string;
  rawOutputPreview: string;
}

/** Analysis of repeated patterns that could become reusable skills */
export interface PatternAnalysis {
  repeatedPatterns: RepeatedPattern[];
  potentialSkills: PotentialSkill[];
}

/** A detected repeated pattern across multiple runs */
export interface RepeatedPattern {
  patternId: string;
  patternType: "agent-sequence" | "io-structure" | "handoff-trigger" | "output-format";
  description: string;
  occurrenceCount: number;
  exampleRunIds: RunId[];
  confidenceScore: number; // 0.0 to 1.0
  extractedAt: string;
}

/** A potential skill candidate extracted from patterns */
export interface PotentialSkill {
  patternId: string;
  proposedSkillId: SkillId;
  proposedName: string;
  description: string;
  role: AgentRole;
  inputSchema: JsonObject;
  outputSchema: JsonObject;
  sourceAgentId: AgentId;
  confidenceScore: number;
  supportingRuns: RunId[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Learned Skill Types
// ─────────────────────────────────────────────────────────────────────────────

/** A learned skill candidate ready for persistence */
export interface LearnedSkillCandidate extends SkillDefinition {
  learnedFrom: {
    runIds: RunId[];
    agentId: AgentId;
    extractedAt: string;
    confidenceScore: number;
    patternType: string;
  };
  qualityMetrics: {
    successRate: number;
    averageLatencyMs: number;
    averageTokenUsage: number;
    sampleSize: number;
  };
  approvedForUse: boolean;
  reviewStatus: "pending" | "approved" | "rejected";
}

/** Configuration for learned skill persistence */
export interface LearnedSkillPersistenceConfig {
  directory: string;
  autoApproveThreshold: number; // confidence score threshold for auto-approval
  requireReview: boolean;
  namingPrefix: string;
  versioningStrategy: "timestamp" | "semantic" | "hash";
}

/** Metadata stored with each learned skill YAML file */
export interface LearnedSkillMetadata {
  extractedAt: string;
  extractionVersion: string;
  sourceRuns: RunId[];
  confidenceScore: number;
  successRate: number;
  sampleSize: number;
  reviewedBy?: string;
  reviewedAt?: string;
  approved: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Router Scoring Types
// ─────────────────────────────────────────────────────────────────────────────

/** Update to an agent's routing score based on historical performance */
export interface AgentRoutingScoreUpdate {
  agentId: AgentId;
  agentRole: AgentRole;
  taskTypeHint?: string | undefined;
  historicalSuccessRate: number;
  averageLatencyMs: number;
  averageTokenUsage: number;
  totalExecutions: number;
  successfulExecutions: number;
  scoreDelta: number;
  newPriorityScore: number;
  calculatedAt: string;
}

/** Historical performance metrics for an agent on a specific task type */
export interface AgentHistoricalPerformance {
  agentId: AgentId;
  agentRole: AgentRole;
  taskTypeHint?: string;
  windowStart: string;
  windowEnd: string;
  totalExecutions: number;
  successfulExecutions: number;
  failedExecutions: number;
  successRate: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  averageTokenUsage: number;
  routingScore: number;
  lastUpdated: string;
}

/** Configuration for router scoring updates */
export interface RouterScoringConfig {
  lookbackWindowMs: number;
  minSampleSize: number;
  successRateWeight: number;
  latencyWeight: number;
  tokenEfficiencyWeight: number;
  recencyWeight: number;
  scoreSmoothingFactor: number; // 0.0 to 1.0 for EMA smoothing
}

/** Learning engine configuration */
export interface LearningEngineConfig {
  persistence: LearnedSkillPersistenceConfig;
  routerScoring: RouterScoringConfig;
  analysis: {
    minRunsBeforeAnalysis: number;
    patternDetectionThreshold: number;
    jsonQualityThreshold: number;
    maxSkillsPerRun: number;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Learning Engine Interface (imported from types.ts)
// ─────────────────────────────────────────────────────────────────────────────

/** Main LearningEngine interface - re-exported from types.ts for convenience */
export type { LearningEngine } from "./types";

/** Constructor dependencies for LearningEngine implementation */
export interface LearningEngineDependencies {
  config: LearningEngineConfig;
  workflowStore: WorkflowStateStore;
  skillRegistry: {
    list(scope: TenantScope): Promise<SkillDefinition[]>;
    get(scope: TenantScope, skillId: SkillId): Promise<SkillDefinition | null>;
  };
  kvClient: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
  };
  auditLogger?: {
    query(scope: TenantScope, filter?: {
      actorId?: string;
      eventType?: string;
      severity?: "info" | "warn" | "error" | "critical";
      startTime?: string;
      endTime?: string;
      count?: number;
    }): Promise<Array<{
      id: string;
      actorId: string;
      eventType: string;
      payload: Record<string, unknown>;
    }>>;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Post-Run Hook Types
// ─────────────────────────────────────────────────────────────────────────────

/** Result of the post-run learning analysis */
export interface PostRunLearningResult {
  runId: RunId;
  analysisCompleted: boolean;
  skillsExtracted: number;
  routingScoresUpdated: boolean;
  errors?: string[];
}

/** Configuration for automatic post-run analysis */
export interface PostRunLearningConfig {
  enabled: boolean;
  analyzeOnSuccess: boolean;
  analyzeOnFailure: boolean;
  maxConcurrentAnalyses: number;
  cooldownMs: number; // Minimum time between analyses for same scope
}

/** Post-run hook function signature for orchestrator integration */
export type PostRunLearningHook = (
  runId: RunId,
  scope: TenantScope,
  finalStatus: "completed" | "failed" | "timed-out" | "cancelled"
) => Promise<PostRunLearningResult>;

// ─────────────────────────────────────────────────────────────────────────────
// Pattern Detection Types
// ─────────────────────────────────────────────────────────────────────────────

/** Types of patterns the learning engine can detect */
export type PatternType = 
  | "successful-agent-sequence"
  | "efficient-handoff"
  | "well-structured-json-output"
  | "reusable-output-template"
  | "common-error-pattern"
  | "optimal-token-usage";

/** Confidence level for pattern detection */
export type ConfidenceLevel = "low" | "medium" | "high" | "very-high";

/** Detection result for a specific pattern type */
export interface PatternDetectionResult {
  patternType: PatternType;
  detected: boolean;
  confidence: ConfidenceLevel;
  confidenceScore: number;
  evidence: {
    supportingRuns: RunId[];
    counterExamples: RunId[];
    statistics: JsonObject;
  };
  recommendation?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────────────────────

import { writeFile, mkdir, readFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import type { WorkflowStateStore } from "./orchestrator-support";
import type { WorkflowRecord } from "./orchestrator-support";

/** Production implementation of the LearningEngine */
export class LearningEngineImpl implements LearningEngine {
  private readonly config: LearningEngineConfig;
  private readonly workflowStore: WorkflowStateStore;
  private readonly skillRegistry: {
    list(scope: TenantScope): Promise<SkillDefinition[]>;
    get(scope: TenantScope, skillId: SkillId): Promise<SkillDefinition | null>;
  };
  private readonly kvClient: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
  };
  private readonly auditLogger?:
    | {
        query(scope: TenantScope, filter?: {
          actorId?: string;
          eventType?: string;
          severity?: "info" | "warn" | "error" | "critical";
          startTime?: string;
          endTime?: string;
          count?: number;
        }): Promise<Array<{
          id: string;
          actorId: string;
          eventType: string;
          payload: Record<string, unknown>;
        }>>;
      }
    | undefined;

  constructor(deps: {
    config: LearningEngineConfig;
    workflowStore: WorkflowStateStore;
    skillRegistry: {
      list(scope: TenantScope): Promise<SkillDefinition[]>;
      get(scope: TenantScope, skillId: SkillId): Promise<SkillDefinition | null>;
    };
    kvClient: {
      get(key: string): Promise<string | null>;
      set(key: string, value: string): Promise<void>;
    };
    auditLogger?: {
      query(scope: TenantScope, filter?: {
        actorId?: string;
        eventType?: string;
        severity?: "info" | "warn" | "error" | "critical";
        startTime?: string;
        endTime?: string;
        count?: number;
      }): Promise<Array<{
        id: string;
        actorId: string;
        eventType: string;
        payload: Record<string, unknown>;
      }>>;
    };
  }) {
    this.config = deps.config;
    this.workflowStore = deps.workflowStore;
    this.skillRegistry = deps.skillRegistry;
    this.kvClient = deps.kvClient;
    this.auditLogger = deps.auditLogger ?? undefined;
  }

  /**
   * Analyze a completed workflow run and extract insights.
   * Fetches the workflow trace from Redis, calculates success rates,
   * validates JSON outputs against skill schemas, and generates
   * LearnedSkillCandidates for consistent patterns.
   */
  async analyze(runId: RunId, scope: TenantScope): Promise<WorkflowAnalysis> {
    const analyzedAt = new Date().toISOString();

    // 1. Fetch workflow trace from Redis
    const workflowRecord = await this.workflowStore.get(scope, runId);
    if (!workflowRecord) {
      throw new Error(`Workflow trace not found for runId: ${runId}`);
    }

    console.log(`[LearningEngine] Analyzing workflow ${runId}:`);
    console.log(`  - Message history count: ${workflowRecord.messageHistory.length}`);
    console.log(`  - Routing decisions count: ${workflowRecord.routingDecisions.length}`);
    console.log(`  - Artifacts count: ${workflowRecord.artifacts.length}`);
    
    // Debug: Show message kinds and output presence
    workflowRecord.messageHistory.forEach((msg, i) => {
      const payload = msg.payload as { output?: { structuredOutput?: unknown }; status?: string };
      console.log(`    [${i}] Message kind: ${msg.kind}, sender: ${msg.senderAgentId || 'none'}, has output: ${!!payload.output}, has structuredOutput: ${!!payload.output?.structuredOutput}`);
    });

    // Convert WorkflowRecord to WorkflowTrace format
    const trace = this.convertToWorkflowTrace(workflowRecord);

    console.log(`  - Converted agent executions: ${trace.agentExecutions.length}`);
    trace.agentExecutions.forEach((exec, i) => {
      console.log(`    [${i}] ${exec.agentId} (${exec.agentRole}): ${exec.status}`);
    });

    // 2. Calculate agent sequence analysis
    const agentSequenceAnalysis = this.analyzeAgentSequences(trace);

    console.log(`  - Detected sequences: ${agentSequenceAnalysis.sequences.length}`);
    agentSequenceAnalysis.sequences.forEach((seq, i) => {
      console.log(`    [${i}] ${seq.agentIds[0]} (${seq.taskTypeHint}): ${seq.successCount}/${seq.occurrenceCount} succeeded`);
    });

    // 3. Analyze JSON output quality
    const jsonOutputAnalysis = this.analyzeJsonOutputs(trace);

    // 4. Detect patterns and generate skill candidates
    const patternAnalysis = this.analyzePatterns(trace);

    // 5. Generate learned skill candidates from consistent patterns
    const suggestedSkills = await this.generateSkillCandidates(
      trace,
      agentSequenceAnalysis,
      jsonOutputAnalysis,
      scope
    );

    // 6. Persist candidates to skills/learned/ directory
    for (const skill of suggestedSkills) {
      await this.persistSkillCandidate(skill);
    }

    // 6. Update routing scores based on this run's analysis
    const routingScoreUpdates = await this.updateRoutingScores(scope, trace, agentSequenceAnalysis);

    return {
      runId,
      scope,
      analyzedAt,
      agentSequenceAnalysis,
      jsonOutputAnalysis,
      patternAnalysis,
      suggestedSkills,
      routingScoreUpdates,
    };
  }

  /** Convert WorkflowRecord to WorkflowTrace format for analysis */
  private convertToWorkflowTrace(record: WorkflowRecord): WorkflowTrace {
    const agentExecutions: AgentExecutionTrace[] = record.messageHistory
      .filter((msg) => msg.kind === "task.completed" || msg.kind === "task.failed")
      .map((msg, idx) => {
        const payload = msg.payload as {
          agentId?: string;
          agentRole?: AgentRole;
          agentName?: string;
          status?: string;
          output?: AgentResult;
          tokenUsage?: { inputTokens: number; outputTokens: number; totalTokens: number };
          latencyMs?: number;
        };

        const handoffDisp = (msg.payload as { handoffDisposition?: string }).handoffDisposition;

        return {
          agentId: payload.agentId || msg.senderAgentId || "unknown",
          agentRole: payload.agentRole || "custom",
          agentName: payload.agentName || payload.agentId || msg.senderAgentId || "Unknown Agent",
          sequenceIndex: idx,
          startedAt: msg.createdAt,
          finishedAt: msg.createdAt,
          status: payload.status === "succeeded" || msg.kind === "handoff.requested" ? "succeeded" : "failed",
          input: {},
          output: payload.output || ({} as AgentResult),
          tokenUsage: payload.tokenUsage || { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          latencyMs: payload.latencyMs || 0,
          handoffDisposition: handoffDisp,
        };
      });

    const routingDecisions: RoutingDecisionTrace[] = record.routingDecisions.map((dec, idx) => {
      const selectedCandidate = dec.candidates.find((c) => c.score === Math.max(...dec.candidates.map((cc) => cc.score || 0)));
      return {
        decisionId: dec.id,
        sequenceIndex: idx,
        fromAgentId: selectedCandidate?.agentId,
        toAgentId: dec.selectedAgentId,
        strategy: dec.strategy,
        reason: dec.reason,
        confidence: dec.confidence ?? undefined,
        recordedAt: record.startedAt,
        outcome: dec.selectedAgentId ? "succeeded" : "failed",
      };
    });

    return {
      runId: record.runId,
      scope: record.scope,
      startedAt: record.startedAt,
      completedAt: record.completedAt,
      status: record.status === "completed" ? "completed" : record.status === "failed" ? "failed" : "cancelled",
      agentExecutions,
      routingDecisions,
      finalOutput: record.artifacts.length > 0 ? { artifacts: record.artifacts } : undefined,
      error: record.lastError
        ? {
            code: record.lastError.code,
            message: record.lastError.message,
            failedAgentId: record.currentAgentId,
          }
        : undefined,
    };
  }

  /** Analyze agent sequences and calculate success rates */
  private analyzeAgentSequences(trace: WorkflowTrace): AgentSequenceAnalysis {
    const agentStats = new Map<
      AgentId,
      {
        total: number;
        succeeded: number;
        failed: number;
        latencies: number[];
        tokenUsages: number[];
      }
    >();

    // Aggregate stats per agent
    for (const exec of trace.agentExecutions) {
      const stats = agentStats.get(exec.agentId) || {
        total: 0,
        succeeded: 0,
        failed: 0,
        latencies: [],
        tokenUsages: [],
      };

      stats.total++;
      if (exec.status === "succeeded") {
        stats.succeeded++;
      } else {
        stats.failed++;
      }
      stats.latencies.push(exec.latencyMs);
      stats.tokenUsages.push(exec.tokenUsage.totalTokens);

      agentStats.set(exec.agentId, stats);
    }

    // Build sequences
    const sequences: AgentSequence[] = [];
    for (const [agentId, stats] of agentStats.entries()) {
      const exec = trace.agentExecutions.find((e) => e.agentId === agentId);
      if (exec) {
        sequences.push({
          agentIds: [agentId],
          occurrenceCount: stats.total,
          successCount: stats.succeeded,
          failureCount: stats.failed,
          successRate: stats.total > 0 ? stats.succeeded / stats.total : 0,
          averageLatencyMs: stats.latencies.length > 0 ? stats.latencies.reduce((a, b) => a + b, 0) / stats.latencies.length : 0,
          averageTokenUsage: stats.tokenUsages.length > 0 ? stats.tokenUsages.reduce((a, b) => a + b, 0) / stats.tokenUsages.length : 0,
          taskTypeHint: exec.agentRole,
        });
      }
    }

    const totalExecutions = trace.agentExecutions.length;
    const successfulExecutions = trace.agentExecutions.filter((e) => e.status === "succeeded").length;
    const failedExecutions = totalExecutions - successfulExecutions;

    return {
      sequences,
      totalExecutions,
      successfulExecutions,
      failedExecutions,
    };
  }

  /** Analyze JSON output quality from agent results */
  private analyzeJsonOutputs(trace: WorkflowTrace): JsonOutputAnalysis {
    const wellStructuredOutputs: WellStructuredJsonOutput[] = [];
    const malformedOutputs: MalformedJsonOutput[] = [];

    let totalJsonAttempts = 0;
    let successfulJsonParses = 0;

    console.log(`[LearningEngine] Analyzing JSON outputs for ${trace.agentExecutions.length} agent executions...`);

    for (const exec of trace.agentExecutions) {
      const output = exec.output;
      console.log(`[LearningEngine] Checking agent ${exec.agentId}: output exists=${!!output}, has structuredOutput=${!!output?.structuredOutput}`);
      
      if (!output) {
        console.log(`  -> No output, skipping`);
        continue;
      }

      // Check structuredOutput field
      const structuredOutput = output.structuredOutput;
      if (!structuredOutput) {
        console.log(`  -> No structuredOutput field, skipping`);
        continue;
      }

      console.log(`  -> Found structuredOutput with ${Object.keys(structuredOutput).length} keys`);
      totalJsonAttempts++;

      try {
        // Validate it's valid JSON-serializable
        JSON.stringify(structuredOutput);
        successfulJsonParses++;

        // Analyze structure
        const outputKeys = Object.keys(structuredOutput);
        const nestedDepth = this.calculateNestedDepth(structuredOutput);
        const arrayCount = this.countArrays(structuredOutput);
        const hasConsistentTypes = this.checkConsistentTypes(structuredOutput);
        const suggested = outputKeys.length >= 1 && hasConsistentTypes;

        console.log(`  -> Well-structured: keys=${outputKeys.length}, depth=${nestedDepth}, suggested=${suggested}`);

        wellStructuredOutputs.push({
          agentId: exec.agentId,
          agentRole: exec.agentRole,
          sequenceIndex: exec.sequenceIndex,
          outputKeys,
          nestedDepth,
          arrayCount,
          hasConsistentTypes,
          sampleSize: 1,
          suggestedForSkillExtraction: suggested,
        });
      } catch (e) {
        malformedOutputs.push({
          agentId: exec.agentId,
          sequenceIndex: exec.sequenceIndex,
          errorType: "parse-error",
          errorDetails: String(e),
          rawOutputPreview: JSON.stringify(structuredOutput).substring(0, 200),
        });
      }

      // Check artifacts for JSON content
      for (const artifact of output.artifacts || []) {
        if (artifact.kind === "json" || artifact.mimeType === "application/json") {
          totalJsonAttempts++;
          try {
            JSON.parse(artifact.content);
            successfulJsonParses++;
          } catch (e) {
            malformedOutputs.push({
              agentId: exec.agentId,
              sequenceIndex: exec.sequenceIndex,
              errorType: "parse-error",
              errorDetails: String(e),
              rawOutputPreview: artifact.content.substring(0, 200),
            });
          }
        }
      }
    }

    console.log(`[LearningEngine] JSON analysis complete: ${wellStructuredOutputs.length} well-structured, ${malformedOutputs.length} malformed`);

    const jsonParseSuccessRate = totalJsonAttempts > 0 ? successfulJsonParses / totalJsonAttempts : 0;

    return {
      wellStructuredOutputs,
      malformedOutputs,
      totalJsonAttempts,
      successfulJsonParses,
      jsonParseSuccessRate,
    };
  }

  /** Calculate nested depth of a JSON object */
  private calculateNestedDepth(obj: unknown, currentDepth = 1): number {
    if (!obj || typeof obj !== "object") {
      return currentDepth - 1;
    }

    if (Array.isArray(obj)) {
      if (obj.length === 0) return currentDepth;
      return Math.max(...obj.map((item) => this.calculateNestedDepth(item, currentDepth + 1)));
    }

    const values = Object.values(obj as Record<string, unknown>);
    if (values.length === 0) return currentDepth;
    return Math.max(...values.map((v) => this.calculateNestedDepth(v, currentDepth + 1)));
  }

  /** Count arrays in a JSON object */
  private countArrays(obj: unknown): number {
    if (!obj || typeof obj !== "object") return 0;

    if (Array.isArray(obj)) {
      return 1 + obj.reduce((sum: number, item) => sum + this.countArrays(item), 0);
    }

    return Object.values(obj as Record<string, unknown>).reduce((sum: number, v) => sum + this.countArrays(v), 0);
  }

  /** Check if object has consistent types across fields */
  private checkConsistentTypes(obj: unknown): boolean {
    if (!obj || typeof obj !== "object") return true;

    if (Array.isArray(obj)) {
      if (obj.length === 0) return true;
      const firstType = typeof obj[0];
      return obj.every((item) => typeof item === firstType);
    }

    const values = Object.values(obj as Record<string, unknown>);
    if (values.length === 0) return true;

    // Check each field has consistent type
    return values.every((v) => {
      if (v === null) return true;
      const t = typeof v;
      return t === "string" || t === "number" || t === "boolean" || (t === "object" && this.checkConsistentTypes(v));
    });
  }

  /** Analyze patterns across the workflow trace */
  private analyzePatterns(trace: WorkflowTrace): PatternAnalysis {
    const repeatedPatterns: RepeatedPattern[] = [];
    const potentialSkills: PotentialSkill[] = [];

    // Detect successful agent sequences
    const successfulAgents = trace.agentExecutions.filter((e) => e.status === "succeeded");
    if (successfulAgents.length >= 3) {
      const patternId = `successful-sequence-${successfulAgents.map((a) => a.agentRole).join("-")}`;
      repeatedPatterns.push({
        patternId,
        patternType: "agent-sequence",
        description: `Successful execution sequence with ${successfulAgents.length} agents`,
        occurrenceCount: 1,
        exampleRunIds: [trace.runId],
        confidenceScore: successfulAgents.length / trace.agentExecutions.length,
        extractedAt: new Date().toISOString(),
      });

      // Generate potential skill for each successful agent with 3+ runs
      for (const agent of successfulAgents) {
        const agentRuns = trace.agentExecutions.filter((e) => e.agentId === agent.agentId && e.status === "succeeded");
        if (agentRuns.length >= 3) {
          const outputSchemas = agentRuns.map((r) => this.inferOutputSchema(r.output?.structuredOutput));
          const consistentSchema = this.findConsistentSchema(outputSchemas.filter((s): s is JsonObject => s !== null));

          if (consistentSchema) {
            potentialSkills.push({
              patternId,
              proposedSkillId: `learned-${agent.agentRole}-${Date.now()}`,
              proposedName: `Learned ${agent.agentRole} Skill`,
              description: `Auto-generated skill for ${agent.agentRole} based on ${agentRuns.length} successful executions`,
              role: agent.agentRole,
              inputSchema: agentRuns[0]!.input ? this.inferInputSchema(agentRuns[0]!.input) : { type: "object" },
              outputSchema: consistentSchema,
              sourceAgentId: agent.agentId,
              confidenceScore: agentRuns.length / trace.agentExecutions.length,
              supportingRuns: [trace.runId],
            });
          }
        }
      }
    }

    return {
      repeatedPatterns,
      potentialSkills,
    };
  }

  /** Infer JSON schema from an object */
  private inferOutputSchema(obj: unknown): JsonObject {
    if (obj === null) return { type: "null" };
    if (typeof obj === "string") return { type: "string" };
    if (typeof obj === "number") return { type: "number" };
    if (typeof obj === "boolean") return { type: "boolean" };

    if (Array.isArray(obj)) {
      if (obj.length === 0) return { type: "array", items: {} };
      const itemSchema = this.inferOutputSchema(obj[0]);
      return { type: "array", items: itemSchema };
    }

    const properties: Record<string, JsonObject> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      properties[key] = this.inferOutputSchema(value);
    }

    return {
      type: "object",
      properties,
    };
  }

  /** Infer input schema from input object */
  private inferInputSchema(input: JsonObject): JsonObject {
    return this.inferOutputSchema(input) as JsonObject;
  }

  /**
   * Find the base skill for an agent role from existing skills.
   * Matches by role (e.g., "coder" → typescript-coding.yaml)
   */
  private async findBaseSkillForAgent(
    scope: TenantScope,
    agentRole: AgentRole,
    existingSkills: SkillDefinition[]
  ): Promise<SkillDefinition | null> {
    // Find a skill where role matches
    const baseSkill = existingSkills.find(skill => skill.role === agentRole);
    if (baseSkill) {
      console.log(`[LearningEngine] Found base skill for ${agentRole}: ${baseSkill.id}`);
    } else {
      console.log(`[LearningEngine] No base skill found for role: ${agentRole}`);
    }
    return baseSkill || null;
  }

  /**
   * Generate merged output schema using base skill schema as starting point,
   * then cross-reference with observed output to detect populated fields.
   * Fields present in base schema but not observed are marked as optional.
   * Fields present in observed output but not in base are added.
   */
  private generateMergedOutputSchema(
    baseSchema: JsonObject | undefined,
    observedOutput: unknown
  ): JsonObject {
    // If no base schema, fall back to inferring from observed output
    if (!baseSchema || baseSchema.type !== "object") {
      console.log(`[LearningEngine] No base schema available, inferring from observed output`);
      return this.inferOutputSchema(observedOutput);
    }

    const baseProps = (baseSchema.properties as Record<string, JsonObject>) || {};
    const observedObj = (observedOutput as Record<string, unknown>) || {};
    const observedKeys = Object.keys(observedObj);

    console.log(`[LearningEngine] Merging schemas - base fields: ${Object.keys(baseProps).join(', ')}, observed: ${observedKeys.join(', ')}`);

    const mergedProperties: Record<string, JsonObject> = {};

    // Process all base schema fields
    for (const [key, baseFieldSchema] of Object.entries(baseProps)) {
      const wasObserved = key in observedObj;
      
      if (wasObserved) {
        // Field was observed - use observed type but preserve base structure for nested objects
        const observedValue = observedObj[key];
        const observedType = this.inferOutputSchema(observedValue);
        
        // For objects, recursively merge; for primitives, prefer observed type
        if (baseFieldSchema.type === "object" && observedValue && typeof observedValue === "object" && !Array.isArray(observedValue)) {
          mergedProperties[key] = this.generateMergedOutputSchema(baseFieldSchema, observedValue);
        } else if (baseFieldSchema.type === "array" && Array.isArray(observedValue) && observedValue.length > 0) {
          // For arrays, merge item schemas
          const baseItemSchema = (baseFieldSchema.items as JsonObject) || { type: "object" };
          const observedItemSchema = this.inferOutputSchema(observedValue[0]);
          mergedProperties[key] = {
            ...baseFieldSchema,
            items: baseItemSchema.type === "object" 
              ? this.generateMergedOutputSchema(baseItemSchema, observedValue[0])
              : observedItemSchema
          };
        } else {
          // Use base schema but update type if observed type differs
          mergedProperties[key] = {
            ...baseFieldSchema,
            type: observedType.type || baseFieldSchema.type
          };
        }
        
        // Remove "required" marker since we observed it
        const { required, ...restSchema } = mergedProperties[key];
        mergedProperties[key] = restSchema;
      } else {
        // Field not observed - keep from base schema but mark as optional
        mergedProperties[key] = baseFieldSchema;
      }
    }

    // Add fields that were observed but not in base schema
    for (const key of observedKeys) {
      if (!(key in baseProps)) {
        console.log(`[LearningEngine] Adding observed field not in base schema: ${key}`);
        mergedProperties[key] = this.inferOutputSchema(observedObj[key]);
      }
    }

    const requiredFields = Object.keys(mergedProperties).filter(k => k in observedObj);

    return {
      type: "object",
      properties: mergedProperties,
      ...(requiredFields.length > 0 ? { required: requiredFields } : {})
    };
  }

  /** Find consistent schema across multiple schemas */
  private findConsistentSchema(schemas: JsonObject[]): JsonObject | null {
    if (schemas.length === 0) return null;
    if (schemas.length === 1) return schemas[0]!;

    // Check if all schemas have the same structure
    const first = schemas[0]!;
    const firstKeys = JSON.stringify(Object.keys(first).sort());

    const allMatch = schemas.every((s) => {
      const keys = JSON.stringify(Object.keys(s).sort());
      return keys === firstKeys;
    });

    if (allMatch) {
      return first;
    }

    // Find common subset
    const commonKeys = Object.keys(first).filter((key) => schemas.every((s) => key in s));
    if (commonKeys.length === 0) return null;

    const commonProperties: Record<string, JsonObject> = {};
    for (const key of commonKeys) {
      const keySchemas = schemas.map((s) => ((s as { properties?: Record<string, JsonObject> }).properties)?.[key] ?? s[key] as JsonObject).filter((s): s is JsonObject => s !== undefined);
      const consistent = this.findConsistentSchema(keySchemas);
      if (consistent) {
        commonProperties[key] = consistent;
      }
    }

    return {
      type: "object",
      properties: commonProperties,
    };
  }

  /**
   * Query AuditLogger for historical agent execution data across all workflows.
   * Returns the total successful execution count for an agent role.
   */
  private async getHistoricalAgentSuccessCount(
    scope: TenantScope,
    agentRole: AgentRole
  ): Promise<number> {
    if (!this.auditLogger) {
      console.log(`[LearningEngine] No audit logger available, returning 0 historical successes`);
      return 0;
    }

    try {
      // Query audit log for workflow.agent.completed events for this agent role
      // Look back 30 days for historical data
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      console.log(`[LearningEngine] Querying audit log for workflow.agent.completed events...`);
      const events = await this.auditLogger.query(scope, {
        eventType: "workflow.agent.completed",
        startTime: thirtyDaysAgo.toISOString(),
        count: 1000, // Get a large sample
      });

      console.log(`[LearningEngine] Found ${events.length} workflow.agent.completed events`);

      // Count successful executions for this agent role
      let successCount = 0;
      for (const event of events) {
        const payload = event.payload as { agentRole?: string; status?: string };
        console.log(`  - Event: agentRole=${payload.agentRole}, status=${payload.status}`);
        if (payload.agentRole === agentRole && payload.status === "succeeded") {
          successCount++;
        }
      }

      console.log(`[LearningEngine] Historical successes for ${agentRole}: ${successCount}`);
      return successCount;
    } catch (error) {
      console.warn(`[LearningEngine] Failed to query audit log: ${error}`);
      return 0;
    }
  }

  /** Generate skill candidates from analysis */
  private async generateSkillCandidates(
    trace: WorkflowTrace,
    sequenceAnalysis: AgentSequenceAnalysis,
    jsonAnalysis: JsonOutputAnalysis,
    scope: TenantScope
  ): Promise<LearnedSkillCandidate[]> {
    const candidates: LearnedSkillCandidate[] = [];

    // Get existing skills for reference
    const existingSkills = await this.skillRegistry.list(scope);

    console.log(`[LearningEngine] Analyzing ${sequenceAnalysis.sequences.length} agent sequences for skill candidates...`);

    for (const sequence of sequenceAnalysis.sequences) {
      const agentRole = sequence.taskTypeHint as AgentRole || "custom";
      
      // Query historical success count across ALL workflows (not just current)
      const historicalSuccessCount = await this.getHistoricalAgentSuccessCount(
        scope,
        agentRole
      );

      // Combine current workflow success count with historical count
      const totalSuccessCount = sequence.successCount + historicalSuccessCount;

      // Check well-structured outputs for this agent
      const wellStructured = jsonAnalysis.wellStructuredOutputs.filter(
        (o) => o.agentId === sequence.agentIds[0] && o.suggestedForSkillExtraction
      );
      
      // Debug: Show available well-structured outputs
      console.log(`  - Available well-structured outputs: ${jsonAnalysis.wellStructuredOutputs.map(o => `${o.agentId}(suggested=${o.suggestedForSkillExtraction})`).join(', ')}`);
      console.log(`  - Looking for agentId: ${sequence.agentIds[0]}`);

      // Debug logging for each agent
      const minRunsThreshold = 2; // Lowered from 3
      const minWellStructuredThreshold = 1; // Lowered from 3 to match single-execution-per-agent pattern
      
      console.log(`[LearningEngine] Agent ${agentRole}:`);
      console.log(`  - Historical success count: ${historicalSuccessCount}`);
      console.log(`  - Current workflow success count: ${sequence.successCount}`);
      console.log(`  - Total success count: ${totalSuccessCount}`);
      console.log(`  - Well-structured outputs: ${wellStructured.length}`);
      console.log(`  - Threshold check: totalSuccessCount >= ${minRunsThreshold} = ${totalSuccessCount >= minRunsThreshold}, wellStructured >= ${minWellStructuredThreshold} = ${wellStructured.length >= minWellStructuredThreshold}`);

      // Only consider agents with 2+ successful runs (across all workflows) - lowered from 3
      if (totalSuccessCount < minRunsThreshold) {
        console.log(`  -> SKIPPED: Insufficient successful runs (need ${minRunsThreshold}+)`);
        continue;
      }

      // Check if output structure is consistent - lowered from 3 to 2
      if (wellStructured.length < minWellStructuredThreshold) {
        console.log(`  -> SKIPPED: Insufficient well-structured outputs (need ${minWellStructuredThreshold}+)`);
        continue;
      }

      console.log(`  -> PASSED: Thresholds met, checking skill criteria...`);

      // Check output against existing skill schemas
      const agentExecs = trace.agentExecutions.filter(
        (e) => e.agentId === sequence.agentIds[0] && e.status === "succeeded"
      );

      const agent = agentExecs[0];
      if (!agent) continue;

      const output = agent.output?.structuredOutput;
      if (!output) continue;

      // Validate against existing skills
      let matchesExistingSkill = false;
      for (const skill of existingSkills) {
        if (this.matchesOutputSchema(output, skill.outputSchema)) {
          matchesExistingSkill = true;
          break;
        }
      }

      if (matchesExistingSkill) continue;

      // Find base skill for this agent role and merge with observed output
      const baseSkill = await this.findBaseSkillForAgent(scope, agent.agentRole, existingSkills);
      const outputSchema = this.generateMergedOutputSchema(baseSkill?.outputSchema, output);
      const inputSchema = baseSkill?.inputSchema ?? (agentExecs.length > 0 && agentExecs[0]!.input ? this.inferInputSchema(agentExecs[0]!.input) : { type: "object" });

      const candidate: LearnedSkillCandidate = {
        schemaVersion: "1.0.0",
        id: `learned-${agent.agentRole}-${Date.now()}`,
        name: `Learned ${agent.agentName} Skill`,
        version: "1.0.0",
        description: `Auto-generated skill for ${agent.agentRole} based on ${sequence.successCount} successful executions with consistent output structure`,
        tags: ["learned", "auto-generated", agent.agentRole],
        role: agent.agentRole,
        inputSchema,
        outputSchema,
        capabilities: ["learned-pattern", agent.agentRole],
        learnedFrom: {
          runIds: [trace.runId],
          agentId: agent.agentId,
          extractedAt: new Date().toISOString(),
          confidenceScore: sequence.successRate,
          patternType: "successful-agent-sequence",
        },
        qualityMetrics: {
          successRate: sequence.successRate,
          averageLatencyMs: sequence.averageLatencyMs,
          averageTokenUsage: sequence.averageTokenUsage,
          sampleSize: sequence.successCount,
        },
        approvedForUse: false,
        reviewStatus: "pending",
      };

      candidates.push(candidate);
    }

    return candidates;
  }

  /** Check if output matches a skill's output schema (basic check) */
  private matchesOutputSchema(output: unknown, schema: JsonObject): boolean {
    if (!output || typeof output !== "object") return false;

    const schemaType = schema.type;
    if (schemaType === "object") {
      const schemaProps = schema.properties as Record<string, JsonObject> | undefined;
      if (!schemaProps) return true;

      const outputObj = output as Record<string, unknown>;
      for (const [key, propSchema] of Object.entries(schemaProps)) {
        if (!(key in outputObj)) return false;
        if (!this.matchesType(outputObj[key], propSchema.type as string)) return false;
      }
      return true;
    }

    return true;
  }

  /** Check if value matches expected type */
  private matchesType(value: unknown, expectedType: string): boolean {
    if (expectedType === "string") return typeof value === "string";
    if (expectedType === "number") return typeof value === "number";
    if (expectedType === "boolean") return typeof value === "boolean";
    if (expectedType === "null") return value === null;
    if (expectedType === "array") return Array.isArray(value);
    if (expectedType === "object") return typeof value === "object" && !Array.isArray(value) && value !== null;
    return true;
  }

  /** Persist a skill candidate to YAML file */
  private async persistSkillCandidate(skill: LearnedSkillCandidate): Promise<void> {
    const learnedDir = this.config.persistence.directory;
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `${skill.role}-${timestamp}.yaml`;
    const filepath = join(learnedDir, filename);

    // Ensure directory exists
    if (!existsSync(learnedDir)) {
      await mkdir(learnedDir, { recursive: true });
    }

    // Generate YAML content
    const yaml = this.exportSkillToYaml(skill);

    // Write file
    await writeFile(filepath, yaml, "utf-8");
  }

  /** Export skill to YAML format */
  exportSkillToYaml(skill: LearnedSkillCandidate): string {
    const lines: string[] = [];

    lines.push(`schemaVersion: "${skill.schemaVersion}"`);
    lines.push(`id: "${skill.id}"`);
    lines.push(`name: "${skill.name}"`);
    lines.push(`version: "${skill.version}"`);
    lines.push(`description: "${skill.description}"`);
    lines.push(`tags:`);
    for (const tag of skill.tags) {
      lines.push(`  - "${tag}"`);
    }
    lines.push(`role: "${skill.role}"`);

    // Input schema
    lines.push(`inputSchema:`);
    lines.push(this.jsonObjectToYaml(skill.inputSchema, 2));

    // Output schema
    lines.push(`outputSchema:`);
    lines.push(this.jsonObjectToYaml(skill.outputSchema, 2));

    // Capabilities
    lines.push(`capabilities:`);
    for (const cap of skill.capabilities || []) {
      lines.push(`  - "${cap}"`);
    }

    // Learned from metadata
    lines.push(`learnedFrom:`);
    lines.push(`  runIds:`);
    for (const runId of skill.learnedFrom.runIds) {
      lines.push(`    - "${runId}"`);
    }
    lines.push(`  agentId: "${skill.learnedFrom.agentId}"`);
    lines.push(`  extractedAt: "${skill.learnedFrom.extractedAt}"`);
    lines.push(`  confidenceScore: ${skill.learnedFrom.confidenceScore.toFixed(2)}`);
    lines.push(`  patternType: "${skill.learnedFrom.patternType}"`);

    // Quality metrics
    lines.push(`qualityMetrics:`);
    lines.push(`  successRate: ${skill.qualityMetrics.successRate.toFixed(2)}`);
    lines.push(`  averageLatencyMs: ${skill.qualityMetrics.averageLatencyMs.toFixed(0)}`);
    lines.push(`  averageTokenUsage: ${skill.qualityMetrics.averageTokenUsage.toFixed(0)}`);
    lines.push(`  sampleSize: ${skill.qualityMetrics.sampleSize}`);

    // Review status
    lines.push(`approvedForUse: ${skill.approvedForUse}`);
    lines.push(`reviewStatus: "${skill.reviewStatus}"`);

    return lines.join("\n");
  }

  /** Convert JsonObject to YAML string with indentation */
  private jsonObjectToYaml(obj: JsonObject, indent: number): string {
    const spaces = " ".repeat(indent);
    const lines: string[] = [];

    for (const [key, value] of Object.entries(obj)) {
      if (value === null) {
        lines.push(`${spaces}${key}: null`);
      } else if (typeof value === "string") {
        lines.push(`${spaces}${key}: "${value}"`);
      } else if (typeof value === "number" || typeof value === "boolean") {
        lines.push(`${spaces}${key}: ${value}`);
      } else if (Array.isArray(value)) {
        lines.push(`${spaces}${key}:`);
        for (const item of value) {
          if (typeof item === "string") {
            lines.push(`${spaces}  - "${item}"`);
          } else {
            lines.push(`${spaces}  -`);
            lines.push(this.jsonObjectToYaml(item as JsonObject, indent + 4));
          }
        }
      } else if (typeof value === "object") {
        lines.push(`${spaces}${key}:`);
        lines.push(this.jsonObjectToYaml(value as JsonObject, indent + 2));
      }
    }

    return lines.join("\n");
  }

  /** Import skill from YAML (not implemented yet) */
  importSkillFromYaml(_yaml: string): LearnedSkillCandidate {
    throw new Error("importSkillFromYaml not implemented");
  }

  /** Get all learned skills for a scope (reads from directory) */
  async getLearnedSkills(scope: TenantScope): Promise<LearnedSkillCandidate[]> {
    const learnedDir = this.config.persistence.directory;

    if (!existsSync(learnedDir)) {
      return [];
    }

    // This would require fs.readdir and parsing YAML files
    // For now, return empty array
    return [];
  }

  /** Get routing scores from Redis for all agents in scope */
  async getRoutingScores(scope: TenantScope): Promise<AgentRoutingScoreUpdate[]> {
    const key = `learning:routing-scores:${scope.tenantId}:${scope.workspaceId}`;
    const data = await this.kvClient.get(key);
    if (!data) return [];
    try {
      return JSON.parse(data) as AgentRoutingScoreUpdate[];
    } catch {
      return [];
    }
  }

  /** Save routing scores to Redis */
  private async saveRoutingScores(scope: TenantScope, scores: AgentRoutingScoreUpdate[]): Promise<void> {
    const key = `learning:routing-scores:${scope.tenantId}:${scope.workspaceId}`;
    await this.kvClient.set(key, JSON.stringify(scores));
  }

  /** Calculate and update routing scores based on analysis */
  private async updateRoutingScores(
    scope: TenantScope,
    trace: WorkflowTrace,
    sequenceAnalysis: AgentSequenceAnalysis
  ): Promise<AgentRoutingScoreUpdate[]> {
    const existingScores = await this.getRoutingScores(scope);
    const now = new Date().toISOString();

    const updatedScores: AgentRoutingScoreUpdate[] = [];

    for (const sequence of sequenceAnalysis.sequences) {
      const agentId = sequence.agentIds[0]!;
      const existing = existingScores.find((s) => s.agentId === agentId);

      // Calculate weighted success rate using exponential moving average
      const alpha = this.config.routerScoring.scoreSmoothingFactor || 0.3;
      const newSuccessRate = sequence.successRate;

      let historicalSuccessRate: number;
      let totalExecutions: number;
      let successfulExecutions: number;

      if (existing) {
        historicalSuccessRate = alpha * newSuccessRate + (1 - alpha) * existing.historicalSuccessRate;
        totalExecutions = existing.totalExecutions + sequence.occurrenceCount;
        successfulExecutions = existing.successfulExecutions + sequence.successCount;
      } else {
        historicalSuccessRate = newSuccessRate;
        totalExecutions = sequence.occurrenceCount;
        successfulExecutions = sequence.successCount;
      }

      // Calculate priority score (0-100)
      // Weight: success rate (60%), token efficiency (20%), speed (20%)
      const tokenEfficiency = Math.max(0, 1 - sequence.averageTokenUsage / 10000); // Normalize to 0-1
      const speedScore = Math.max(0, 1 - sequence.averageLatencyMs / 60000); // Normalize to 0-1
      const priorityScore = Math.round(
        historicalSuccessRate * 60 + tokenEfficiency * 20 + speedScore * 20
      );

      const update: AgentRoutingScoreUpdate = {
        agentId,
        agentRole: sequence.taskTypeHint as AgentRole || "custom",
        taskTypeHint: sequence.taskTypeHint,
        historicalSuccessRate: Math.round(historicalSuccessRate * 100) / 100,
        averageLatencyMs: Math.round(sequence.averageLatencyMs),
        averageTokenUsage: Math.round(sequence.averageTokenUsage),
        totalExecutions,
        successfulExecutions,
        scoreDelta: existing ? priorityScore - existing.newPriorityScore : priorityScore,
        newPriorityScore: priorityScore,
        calculatedAt: now,
      };

      updatedScores.push(update);
    }

    // Merge with existing scores for agents not in this run
    const mergedScores = [...updatedScores];
    for (const existing of existingScores) {
      if (!updatedScores.find((u) => u.agentId === existing.agentId)) {
        mergedScores.push(existing);
      }
    }

    await this.saveRoutingScores(scope, mergedScores);
    return updatedScores;
  }

  /** Get agent performance (not implemented in this version) */
  async getAgentPerformance(
    _scope: TenantScope,
    _agentId: AgentId,
    _taskTypeHint?: string
  ): Promise<AgentHistoricalPerformance | null> {
    return null;
  }

  /** Approve a skill (not implemented in this version) */
  async approveSkill(_scope: TenantScope, _skillId: SkillId, _reviewerId: string): Promise<void> {
    throw new Error("approveSkill not implemented");
  }

  /** Reject a skill (not implemented in this version) */
  async rejectSkill(_scope: TenantScope, _skillId: SkillId, _reviewerId: string, _reason: string): Promise<void> {
    throw new Error("rejectSkill not implemented");
  }

  /** Record a single agent run (stub implementation for interface compliance) */
  async recordRun(
    _context: AgentRunContext,
    _result: AgentResult,
    _record: AgentRunRecord,
  ): Promise<void> {
    // Stub implementation - recording is handled via analyze() method
    return;
  }

  /** Suggest skill candidates (delegates to getLearnedSkills for interface compliance) */
  async suggestSkillCandidates(scope: TenantScope): Promise<SkillDefinition[]> {
    const learnedSkills = await this.getLearnedSkills(scope);
    return learnedSkills.map(skill => ({
      schemaVersion: skill.schemaVersion,
      id: skill.id,
      name: skill.name,
      version: skill.version,
      description: skill.description,
      tags: skill.tags,
      role: skill.role,
      inputSchema: skill.inputSchema,
      outputSchema: skill.outputSchema,
      capabilities: skill.capabilities ?? [],
    }));
  }

  /** Get skill candidates (not implemented in this version) */
  async getSkillCandidates(_scope: TenantScope, _minConfidence?: number): Promise<LearnedSkillCandidate[]> {
    return [];
  }
}
