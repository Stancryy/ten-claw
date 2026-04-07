// File: src/types.ts
/**
 * Shared contracts for a production-grade, multi-tenant, message-passing
 * multi-agent framework. This file intentionally contains only portable
 * abstractions so every infrastructure layer can be swapped independently.
 */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue | undefined;
}

/** Unique identifier types. */
export type TenantId = string;
export type WorkspaceId = string;
export type ProjectId = string;
export type TeamId = string;
export type AgentId = string;
export type RunId = string;
export type SessionId = string;
export type SkillId = string;
export type MessageId = string;
export type NotificationId = string;
export type ProviderModelId = string;
export type TaskId = string;
export type QueueId = string;
export type WorkerId = string;
export type LeaseId = string;
export type RoutingDecisionId = string;
export type ApprovalRequestId = string;
export type ShellExecutionRequestId = string;
export type ArtifactId = string;
export type RuntimeTarget = "claude-code" | "cursor" | "openai-agents-sdk" | "custom";

/** Supported provider families for runtime model selection. */
export type LLMProvider =
  | "openai"
  | "anthropic"
  | "google-gemini"
  | "groq"
  | "ollama";

/** High-level agent archetypes used for routing and analytics. */
export type AgentRole =
  | "planner"
  | "coder"
  | "tester"
  | "reviewer"
  | "security-auditor"
  | "researcher"
  | "writer"
  | "critic"
  | "coordinator"
  | "custom";

/** Execution style used to place agents onto direct or durable runtimes. */
export type AgentExecutionMode = "sync" | "queued" | "batched";

/** Workflow coordination topology used by the orchestration runtime. */
export type WorkflowCoordinationMode = "in-process" | "event-driven" | "hybrid";

/** Queue priority applied to durable execution tasks. */
export type QueuePriority = "low" | "normal" | "high" | "critical";

/** Workflow lifecycle states. */
export type WorkflowStatus =
  | "queued"
  | "running"
  | "awaiting-approval"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed-out";

/** Agent execution states. */
export type AgentRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "timed-out"
  | "budget-exhausted"
  | "awaiting-approval"
  | "rejected";

/** Message types exchanged over the orchestration bus. */
export type MessageKind =
  | "task.created"
  | "task.enqueued"
  | "task.claimed"
  | "task.started"
  | "task.progress"
  | "task.completed"
  | "task.failed"
  | "task.released"
  | "task.retried"
  | "handoff.requested"
  | "handoff.accepted"
  | "handoff.rejected"
  | "budget.degraded"
  | "memory.write"
  | "memory.read"
  | "approval.requested"
  | "approval.resolved"
  | "notification.requested"
  | "notification.sent"
  | "security.blocked"
  | "audit.recorded";

/** Strategy when an agent approaches or exceeds its token budget. */
export type BudgetOverflowStrategy =
  | "summarize"
  | "truncate"
  | "escalate"
  | "fail";

/** Routing result categories returned by agents or policies. */
export type HandoffDisposition =
  | "complete"
  | "route"
  | "retry"
  | "escalate"
  | "await-approval"
  | "fail"
  | "noop";

/** Delivery targets supported by the notification layer. */
export type NotificationChannel = "telegram" | "discord" | "whatsapp";

/** External approval types enforced by security policy. */
export type ApprovalKind =
  | "tool-execution"
  | "secret-access"
  | "external-send"
  | "privileged-handoff";

/** Resolution status for a human approval request. */
export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired" | "cancelled";

/** Policy applied when agents request scoped secret access. */
export type SecretAccessMode = "deny" | "scoped" | "approval-required";

/** Routing strategies supported by declarative and adaptive routers. */
export type RoutingStrategy =
  | "declarative"
  | "capability-match"
  | "learned-policy"
  | "hybrid";

/** Minimal tenant-scoped identity used across all backends. */
export interface TenantScope {
  tenantId: TenantId;
  workspaceId: WorkspaceId;
  teamId?: TeamId;
  projectId?: ProjectId;
  environment?: "dev" | "staging" | "prod";
}

/** Strongly scoped reference to a multi-tenant resource owned by the platform. */
export interface ScopedResourceRef {
  scope: TenantScope;
  resourceType:
    | "workflow"
    | "session"
    | "team"
    | "agent"
    | "skill"
    | "memory-record"
    | "artifact"
    | "secret"
    | "notification-destination"
    | "queue";
  resourceId: string;
}

/** Token budget applied to every agent run and optionally to a full workflow. */
export interface TokenBudget {
  maxInputTokens: number;
  maxOutputTokens: number;
  maxTotalTokens: number;
  reserveForSystem?: number;
  reserveForHandoff?: number;
  overflowStrategy: BudgetOverflowStrategy;
}

/** Result of budget enforcement after prompt optimization or degradation. */
export interface BudgetDegradationResult {
  strategy: BudgetOverflowStrategy;
  outcome: "not-needed" | "summarized" | "truncated" | "escalated" | "failed";
  estimatedInputTokensBefore: number;
  estimatedInputTokensAfter?: number;
  allowedInputTokens: number;
  reservedTokens?: number;
  notes?: string[];
}

/** Retry policy for network, provider, or validation failures. */
export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  retryableErrorCodes?: string[];
}

/** Limits used to prevent loops and runaway agent execution. */
export interface ExecutionLimits {
  maxRuntimeMs: number;
  maxHopsPerRun: number;
  maxNestedHandOffs: number;
  maxConsecutiveFailures: number;
}

/** Security controls enforced before an agent can use privileged capabilities. */
export interface SecurityPolicy {
  allowNetworkAccess: boolean;
  allowToolExecution?: boolean;
  allowShellExecution?: boolean;
  allowExternalNotifications: boolean;
  allowSkillLearning: boolean;
  shellExecutionRequiresApproval: boolean;
  requiredApprovalKinds: ApprovalKind[];
  secretScopes: string[];
  secretAccessMode?: SecretAccessMode;
  maxPromptRiskScore?: number;
  allowedRuntimeTargets?: RuntimeTarget[];
  promptInjectionDefenseProfile?: string;
}

/** Canonical audit event structure for compliance and incident review. */
export interface AuditEvent {
  id: string;
  occurredAt: string;
  scope: TenantScope;
  actorType: "user" | "agent" | "system";
  actorId: string;
  eventType: string;
  severity: "info" | "warn" | "error" | "critical";
  runId?: RunId;
  sessionId?: SessionId;
  payload: JsonObject;
}

/** Provider selection and model fallback preferences. */
export interface ModelProfile {
  provider: LLMProvider;
  model: ProviderModelId;
  temperature?: number;
  topP?: number;
  maxRetries?: number;
  timeoutMs?: number;
  contextWindowTokens?: number;
  supportsJsonMode?: boolean;
  fallbackModels?: Array<{
    provider: LLMProvider;
    model: ProviderModelId;
  }>;
}

/** Serializable description of an agent skill loaded from JSON or YAML. */
export interface SkillDefinition {
  schemaVersion: string;
  id: SkillId;
  name: string;
  version: string;
  description: string;
  tags: string[];
  role: AgentRole;
  inputSchema: JsonObject;
  outputSchema: JsonObject;
  capabilities?: string[];
  preferredRuntimeTargets?: RuntimeTarget[];
  routingHints?: string[];
  promptTemplateRef?: string;
  examples?: JsonObject[];
  securityNotes?: string[];
  metadata?: JsonObject;
}

/** Reference to a skill plus the execution mode expected by the runtime. */
export interface SkillBinding {
  skillId: SkillId;
  mode: "primary" | "supporting" | "validation";
  required: boolean;
}

/** Static agent definition that can be loaded from code or low-code team files. */
export interface AgentDefinition {
  id: AgentId;
  name: string;
  role: AgentRole;
  executionMode?: AgentExecutionMode;
  description: string;
  specializations?: string[];
  capabilityTags?: string[];
  bindings: SkillBinding[];
  systemPromptRef?: string;
  runtimeTargets?: RuntimeTarget[];
  maxConcurrency?: number;
  modelProfile: ModelProfile;
  tokenBudget: TokenBudget;
  retryPolicy: RetryPolicy;
  executionLimits: ExecutionLimits;
  securityPolicy: SecurityPolicy;
  metadata?: JsonObject;
}

/** Declarative condition used by the routing engine. */
export interface RouteCondition {
  field: string;
  operator:
    | "equals"
    | "not-equals"
    | "contains"
    | "greater-than"
    | "less-than"
    | "in";
  value: JsonValue;
}

/** Declarative route definition for handoffs between agents. */
export interface RouteDefinition {
  id: string;
  fromAgentId: AgentId | "*";
  toAgentId: AgentId;
  priority: number;
  strategy?: "first-match" | "weighted";
  weight?: number;
  conditions: RouteCondition[];
  onFailure?: AgentId;
  description?: string;
}

/** Low-code team definition that can be stored in YAML and loaded at runtime. */
export interface TeamDefinition {
  schemaVersion: string;
  id: TeamId;
  name: string;
  description: string;
  entryAgentId: AgentId;
  runtimeTarget?: RuntimeTarget;
  routingStrategy?: RoutingStrategy;
  coordinationMode?: WorkflowCoordinationMode;
  queueId?: QueueId;
  maxParallelTasks?: number;
  workspaceTags?: string[];
  agents: AgentDefinition[];
  routes: RouteDefinition[];
  notifications?: NotificationSubscription[];
  defaultTokenBudget?: TokenBudget;
  metadata?: JsonObject;
}

/** User request entering the platform boundary. */
export interface WorkflowRequest {
  scope: TenantScope;
  teamId: TeamId;
  sessionId: SessionId;
  requesterId: string;
  goal: string;
  input: JsonObject;
  priority?: QueuePriority;
  constraints?: JsonObject;
  tokenBudget?: Partial<TokenBudget>;
  metadata?: JsonObject;
}

/** Durable execution envelope used by the hybrid orchestrator worker queue. */
export interface DurableTaskEnvelope<TPayload extends JsonValue | JsonObject = JsonObject> {
  id: TaskId;
  kind: "agent-run" | "notification" | "learning-update" | "approval-followup";
  queueId: QueueId;
  scope: TenantScope;
  runId: RunId;
  sessionId: SessionId;
  agentId?: AgentId;
  createdAt: string;
  availableAt?: string;
  deadlineAt?: string;
  dedupeKey?: string;
  priority: QueuePriority;
  attempt: number;
  maxAttempts: number;
  payload: TPayload;
}

/** Worker lease over a durable task to support retries and idempotent acks. */
export interface TaskLease {
  id: LeaseId;
  taskId: TaskId;
  queueId: QueueId;
  workerId: WorkerId;
  claimedAt: string;
  heartbeatAt?: string;
  expiresAt: string;
  attempt: number;
}

/** Message envelope exchanged over the internal bus. */
export interface AgentMessage<TPayload extends JsonValue | JsonObject = JsonObject> {
  id: MessageId;
  kind: MessageKind;
  scope: TenantScope;
  runId: RunId;
  sessionId: SessionId;
  senderAgentId?: AgentId;
  recipientAgentId?: AgentId;
  correlationId?: MessageId;
  createdAt: string;
  payload: TPayload;
}

/** Artifact emitted by an agent and persisted for later reuse or delivery. */
export interface AgentArtifact {
  id: ArtifactId;
  kind: "text" | "json" | "markdown" | "code" | "report" | "citation";
  title: string;
  mimeType: string;
  content: string;
  metadata?: JsonObject;
}

/** Explicit next-step signal used for orchestrated handoffs. */
export interface HandoffDirective {
  disposition: HandoffDisposition;
  targetAgentId?: AgentId;
  reason: string;
  retryAfterMs?: number;
  approvalKind?: ApprovalKind;
  queueId?: QueueId;
  priority?: QueuePriority;
  deadlineAt?: string;
  routeMetadata?: JsonObject;
}

/** Ranked routing signal emitted by agents or learning subsystems. */
export interface RoutingSignal {
  candidateAgentId?: AgentId;
  reason: string;
  score?: number;
  metadata?: JsonObject;
}

/** Contract all agents must return to the orchestrator. */
export interface AgentResult {
  status: AgentRunStatus;
  summary: string;
  confidence?: number;
  structuredOutput: JsonObject;
  artifacts: AgentArtifact[];
  handoff: HandoffDirective;
  tokenUsage?: TokenUsage;
  budgetResult?: BudgetDegradationResult;
  validationIssues?: string[];
  routingSignals?: RoutingSignal[];
  learnedSkillCandidates?: SkillDefinition[];
  memoryWrites?: MemoryRecord[];
  auditEvents?: AuditEvent[];
}

/** Fully materialized context delivered to a running agent. */
export interface AgentRunContext {
  scope: TenantScope;
  runId: RunId;
  sessionId: SessionId;
  team: TeamDefinition;
  agent: AgentDefinition;
  request: WorkflowRequest;
  messageHistory: AgentMessage[];
  memory: MemorySnapshot;
  tokenBudget: TokenBudget;
  hopIndex: number;
  queueTask?: DurableTaskEnvelope;
  lease?: TaskLease;
}

/** Record of one agent execution used for replay and self-optimization. */
export interface AgentRunRecord {
  runId: RunId;
  agentId: AgentId;
  status: AgentRunStatus;
  startedAt: string;
  finishedAt?: string;
  attempt: number;
  workerId?: WorkerId;
  leaseId?: LeaseId;
  routingDecisionId?: RoutingDecisionId;
  tokenUsage?: TokenUsage;
  error?: FrameworkError;
}

/** Memory entry persisted to vector or key-value storage. */
export interface MemoryRecord {
  id: string;
  scope: TenantScope;
  namespace: "session" | "semantic" | "skill" | "audit";
  text?: string;
  attributes: JsonObject;
  embeddingRef?: string;
  createdAt: string;
  expiresAt?: string;
}

/** Query parameters for vector-backed or hybrid memory retrieval. */
export interface MemoryQuery {
  scope: TenantScope;
  namespace: MemoryRecord["namespace"];
  queryText: string;
  topK: number;
  minScore?: number;
  filters?: JsonObject;
}

/** Materialized view of memory supplied to agents at runtime. */
export interface MemorySnapshot {
  sessionState: JsonObject;
  relevantMemories: MemoryRecord[];
  learnedSkills: SkillDefinition[];
}

/** Token accounting returned by provider adapters. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens?: number;
}

/** Normalized prompt frame passed into a provider adapter. */
export interface PromptFrame {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
}

/** Request passed to prompt-security defenses before provider execution. */
export interface PromptSecurityScanRequest {
  scope: TenantScope;
  agentId?: AgentId;
  prompts: PromptFrame[];
  policy: SecurityPolicy;
  metadata?: JsonObject;
}

/** One prompt-security finding emitted by a defense engine. */
export interface PromptSecurityFinding {
  category:
    | "prompt-injection"
    | "data-exfiltration"
    | "tool-escalation"
    | "secret-request"
    | "policy-violation";
  severity: "info" | "warn" | "error" | "critical";
  message: string;
  span?: {
    start: number;
    end: number;
  };
}

/** Result of prompt scanning used to allow, redact, or block execution. */
export interface PromptSecurityScanResult {
  allowed: boolean;
  riskScore: number;
  sanitizedPrompts?: PromptFrame[];
  findings: PromptSecurityFinding[];
}

/** Provider-agnostic generation request. */
export interface LLMRequest {
  scope: TenantScope;
  modelProfile: ModelProfile;
  prompts: PromptFrame[];
  responseFormat?: "text" | "json";
  maxOutputTokens: number;
  stopSequences?: string[];
  budget: TokenBudget;
  metadata?: JsonObject;
}

/** Provider-agnostic generation response. */
export interface LLMResponse {
  provider: LLMProvider;
  model: ProviderModelId;
  outputText: string;
  structuredOutput?: JsonObject;
  finishReason: "stop" | "length" | "content-filter" | "error";
  tokenUsage: TokenUsage;
  latencyMs: number;
  budgetResult?: BudgetDegradationResult;
}

/** Typed framework error with retry and fallback hints. */
export interface FrameworkError {
  code:
    | "timeout"
    | "provider-error"
    | "validation-error"
    | "routing-error"
    | "budget-exhausted"
    | "security-policy-violation"
    | "approval-required"
    | "approval-rejected"
    | "malformed-output";
  message: string;
  retryable: boolean;
  details?: JsonObject;
}

/** Ranked route candidate resolved by a capability- or policy-based router. */
export interface RoutingCandidate {
  agentId: AgentId;
  score: number;
  confidence?: number;
  reasons: string[];
  estimatedLatencyMs?: number;
  estimatedInputTokens?: number;
  estimatedOutputTokens?: number;
  estimatedCostUsd?: number;
  metadata?: JsonObject;
}

/** Router decision envelope captured for replay, audit, and learning. */
export interface RoutingDecision {
  id: RoutingDecisionId;
  strategy: RoutingStrategy;
  selectedAgentId?: AgentId;
  candidates: RoutingCandidate[];
  reason: string;
  selectedBy?: "task-router" | "route-rule" | "learned-policy" | "agent-directive" | "human";
  confidence?: number;
  policyVersion?: string;
  decisionLatencyMs?: number;
  metadata?: JsonObject;
}

/** Post-decision telemetry used to train routing and detect regressions over time. */
export interface RoutingTelemetry {
  decisionId: RoutingDecisionId;
  scope: TenantScope;
  runId: RunId;
  currentAgentId: AgentId;
  selectedAgentId?: AgentId;
  strategy: RoutingStrategy;
  recordedAt: string;
  candidateCount: number;
  confidence?: number;
  estimatedLatencyMs?: number;
  estimatedCostUsd?: number;
  actualLatencyMs?: number;
  actualTokenUsage?: TokenUsage;
  outcome?: "succeeded" | "failed" | "re-routed" | "timed-out" | "cancelled";
  feedbackTags?: string[];
  metadata?: JsonObject;
}

/** Notification request emitted by orchestrator or completion workflows. */
export interface NotificationRequest {
  id: NotificationId;
  scope: TenantScope;
  channel: NotificationChannel;
  destination: string;
  title: string;
  body: string;
  runId?: RunId;
  metadata?: JsonObject;
}

/** Declarative notification subscription stored in team definitions. */
export interface NotificationSubscription {
  channel: NotificationChannel;
  destinationRef: string;
  onStatuses: WorkflowStatus[];
}

/** Approval request raised before a privileged action executes. */
export interface ApprovalRequest {
  id: ApprovalRequestId;
  scope: TenantScope;
  kind: ApprovalKind;
  requestedByAgentId: AgentId;
  reason: string;
  payload: JsonObject;
  createdAt: string;
  status?: ApprovalStatus;
  correlationId?: MessageId;
  expiresAt?: string;
  riskScore?: number;
  metadata?: JsonObject;
}

/** Approval resolution stored for audit and replay. */
export interface ApprovalDecision {
  requestId: ApprovalRequestId;
  approved: boolean;
  approverId: string;
  decidedAt: string;
  status?: ApprovalStatus;
  comment?: string;
}

/** Human-gated shell execution request that must never bypass approval. */
export interface ShellExecutionRequest {
  id: ShellExecutionRequestId;
  scope: TenantScope;
  requestedByAgentId: AgentId;
  command: string;
  cwd?: string;
  reason: string;
  createdAt: string;
  timeoutMs?: number;
  correlationId?: MessageId;
  environmentAllowList?: string[];
  metadata?: JsonObject;
}

/** Result returned after a human approves or rejects shell execution. */
export interface ShellExecutionDecision {
  requestId: ShellExecutionRequestId;
  approved: boolean;
  approverId: string;
  decidedAt: string;
  status?: ApprovalStatus;
  comment?: string;
}

/** Core orchestrator contract that owns workflow lifecycle and handoffs. */
export interface AgentOrchestrator {
  startWorkflow(request: WorkflowRequest): Promise<RunId>;
  handleMessage(message: AgentMessage): Promise<void>;
  cancelWorkflow(scope: TenantScope, runId: RunId, reason: string): Promise<void>;
}

/** Runtime contract implemented by every executable agent specialization. */
export interface AgentRuntime {
  readonly definition: AgentDefinition;
  execute(context: AgentRunContext): Promise<AgentResult>;
}

/** Policy engine that decides the next agent during handoff. */
export interface TaskRouter {
  resolveNextAgent(args: {
    team: TeamDefinition;
    currentAgent: AgentDefinition;
    result: AgentResult;
    request: WorkflowRequest;
  }): Promise<AgentDefinition | null>;
}

/** Durable message transport used by the hybrid coordination model. */
export interface MessageBus {
  publish(message: AgentMessage): Promise<void>;
  publishBatch(messages: AgentMessage[]): Promise<void>;
}

/** Claim request used by hybrid workers to poll or reserve durable tasks. */
export interface TaskClaimRequest {
  queueId: QueueId;
  workerId: WorkerId;
  maxTasks: number;
  leaseMs: number;
  waitMs?: number;
  supportedRuntimeTargets?: RuntimeTarget[];
  supportedAgentIds?: AgentId[];
}

/** Ack payload recorded after a durable task is processed successfully. */
export interface TaskAck {
  leaseId: LeaseId;
  taskId: TaskId;
  acknowledgedAt: string;
  summary?: string;
}

/** Release payload used to retry or dead-letter a durable task after failure. */
export interface TaskRelease {
  leaseId: LeaseId;
  taskId: TaskId;
  releasedAt: string;
  retryAt?: string;
  reason?: string;
}

/** Durable queue contract used by the hybrid coordination model. */
export interface DurableTaskQueue {
  enqueue(task: DurableTaskEnvelope): Promise<void>;
  enqueueBatch(tasks: DurableTaskEnvelope[]): Promise<void>;
  claim(request: TaskClaimRequest): Promise<Array<{
    task: DurableTaskEnvelope;
    lease: TaskLease;
  }>>;
  ack(ack: TaskAck): Promise<void>;
  release(release: TaskRelease): Promise<void>;
  renewLease(leaseId: LeaseId, extendsByMs: number): Promise<TaskLease>;
}

/** Vector or hybrid memory backend for semantic recall across sessions. */
export interface MemoryStore {
  write(records: MemoryRecord[]): Promise<void>;
  query(query: MemoryQuery): Promise<MemoryRecord[]>;
}

/** Key-value session store for workflow-local and cross-session state. */
export interface SessionStateStore {
  get(scope: TenantScope, sessionId: SessionId): Promise<JsonObject>;
  set(scope: TenantScope, sessionId: SessionId, state: JsonObject): Promise<void>;
  patch(scope: TenantScope, sessionId: SessionId, partial: JsonObject): Promise<void>;
}

/** Skill registry for loading, resolving, and persisting learned skills. */
export interface SkillRegistry {
  list(scope: TenantScope): Promise<SkillDefinition[]>;
  get(scope: TenantScope, skillId: SkillId): Promise<SkillDefinition | null>;
  put(scope: TenantScope, skill: SkillDefinition): Promise<void>;
}

/** Unified provider gateway with token budgeting and fallback enforcement. */
export interface LLMGateway {
  generate(request: LLMRequest): Promise<LLMResponse>;
  countTokens(request: Pick<LLMRequest, "modelProfile" | "prompts">): Promise<number>;
}

/** Optional learning subsystem that extracts skills and updates routing hints. */
export interface LearningEngine {
  analyze(runId: RunId, scope: TenantScope): Promise<{
    suggestedSkills: unknown[];
    routingScoreUpdates: unknown[];
  }>;
  recordRun(
    context: AgentRunContext,
    result: AgentResult,
    record: AgentRunRecord,
  ): Promise<void>;
  suggestSkillCandidates(scope: TenantScope): Promise<SkillDefinition[]>;
  recordRoutingTelemetry?(telemetry: RoutingTelemetry): Promise<void>;
  suggestRoutingDecision?(
    scope: TenantScope,
    team: TeamDefinition,
    signals: RoutingSignal[],
  ): Promise<RoutingDecision | null>;
}

/** Human-in-the-loop gateway for privileged actions. */
export interface ApprovalGateway {
  requestApproval(request: ApprovalRequest): Promise<ApprovalDecision>;
}

/** Defense layer that scans prompts before provider execution. */
export interface PromptSecurityScanner {
  scan(request: PromptSecurityScanRequest): Promise<PromptSecurityScanResult>;
}

/** Secure secret resolver used by provider and notifier adapters. */
export interface SecretProvider {
  getSecret(scope: TenantScope, key: string): Promise<string>;
}

/** Human-gated shell executor that never runs commands without approval. */
export interface ShellExecutionGateway {
  requestExecution(request: ShellExecutionRequest): Promise<ShellExecutionDecision>;
}

/** Audit sink for immutable security and compliance events. */
export interface AuditLogger {
  record(event: AuditEvent): Promise<void>;
}

/** Notification adapter contract implemented per delivery channel. */
export interface Notifier {
  readonly channel: NotificationChannel;
  send(request: NotificationRequest): Promise<void>;
}

/** Host-platform adapter for Claude Code, Cursor, or OpenAI Agents SDK. */
export interface RuntimePlatformAdapter {
  readonly target: RuntimeTarget;
  buildSystemPrompt(context: AgentRunContext): Promise<string>;
  buildUserPrompt(context: AgentRunContext): Promise<string>;
  normalizeResult(args: {
    context: AgentRunContext;
    response: LLMResponse;
  }): Promise<AgentResult>;
}

// TODO:
// - Add JSON schema typing helpers for stronger validation of skill I/O contracts.
// - Add trace/span identifiers once the telemetry layer is implemented.
// - Add provider capability descriptors for tool use, JSON mode, and streaming.
// - Add typed policy hooks for prompt-injection scanning and DLP enforcement.
// - Add workload and queue-depth telemetry types for adaptive routing at 100+ agent scale.
// - Add explicit dead-letter queue contracts and replay controls for poison task recovery.
