// File: src/orchestrator.ts
/**
 * Orchestrator runtime for the multi-agent framework.
 */

import type {
  AgentDefinition,
  AgentMessage,
  AgentOrchestrator,
  AgentResult,
  AgentRunContext,
  AgentRunRecord,
  AgentRuntime,
  ApprovalRequest,
  ApprovalKind,
  AuditEvent,
  DurableTaskEnvelope,
  DurableTaskQueue,
  FrameworkError,
  HandoffDirective,
  JsonObject,
  NotificationRequest,
  QueuePriority,
  RunId,
  RoutingDecision,
  RoutingTelemetry,
  SessionId,
  TaskLease,
  TeamDefinition,
  TenantScope,
  WorkflowRequest,
  WorkflowStatus,
} from "./types";
import {
  addTokenUsage,
  approvalDecisionToPayload,
  createEmptyTokenUsage,
  DEFAULT_ORCHESTRATOR_CONFIG,
  delay,
  ensureJsonObject,
  mergeTokenBudget,
  normalizeError,
  withTimeout,
} from "./orchestrator-support";
import type {
  OrchestratorDependencies,
  WorkflowRecord,
} from "./orchestrator-support";

/**
 * Production-oriented orchestrator for the hybrid message-bus model.
 */
export class ProductionOrchestrator implements AgentOrchestrator {
  private readonly config;

  /** Creates an orchestrator with fully injected infrastructure dependencies. */
  constructor(private readonly deps: OrchestratorDependencies) {
    this.config = {
      ...DEFAULT_ORCHESTRATOR_CONFIG,
      ...deps.config,
    };
  }

  /** Starts a workflow and dispatches the entry agent. */
  async startWorkflow(request: WorkflowRequest): Promise<RunId> {
    const scopedRequest = {
      ...request,
      scope: { ...request.scope, teamId: request.teamId },
    };
    const team = await this.requireTeam(scopedRequest.scope, scopedRequest.teamId);
    const entryAgent = this.requireAgentDefinition(team, team.entryAgentId);
    const runId = this.nextId("run");
    const state: WorkflowRecord = {
      runId,
      scope: scopedRequest.scope,
      team,
      request: scopedRequest,
      status: "queued",
      currentAgentId: entryAgent.id,
      startedAt: this.nowIso(),
      updatedAt: this.nowIso(),
      hopCount: 0,
      consecutiveFailures: 0,
      attemptByAgentId: {},
      messageHistory: [],
      routingDecisions: [],
      artifacts: [],
      tokenUsage: createEmptyTokenUsage(),
    };

    const createdMessage = this.buildMessage({
      kind: "task.created",
      scope: state.scope,
      runId: state.runId,
      sessionId: scopedRequest.sessionId,
      recipientAgentId: entryAgent.id,
      payload: {
        goal: scopedRequest.goal,
        requesterId: scopedRequest.requesterId,
        teamId: team.id,
      },
    });

    state.status = "running";
    await this.deps.workflowStore.create(state);
    await this.deps.messageBus.publish(createdMessage);
    await this.recordAudit("workflow.started", state, "info", {
      entryAgentId: entryAgent.id,
      teamId: team.id,
    });

    if (this.config.autoDrive) {
      await this.handleMessage(createdMessage);
    }
    return runId;
  }

  /** Handles orchestrator-owned bus messages and advances workflow state. */
  async handleMessage(message: AgentMessage): Promise<void> {
    const state = await this.requireWorkflow(message.scope, message.runId);
    if (this.hasProcessedMessage(state, message.id) || isTerminalWorkflowStatus(state.status)) {
      return;
    }
    state.messageHistory.push(message);
    state.updatedAt = this.nowIso();
    await this.deps.workflowStore.update(state);

    switch (message.kind) {
      case "task.created":
      case "handoff.requested":
      case "task.retried":
        {
          const payload = ensureJsonObject(message.payload);
          const dispatchArgs: Parameters<typeof this.dispatchAgentExecution>[2] = {
            triggerMessage: message,
          };
          if (typeof payload.queueId === "string") {
            dispatchArgs.queueId = payload.queueId;
          }
          if (isQueuePriority(payload.priority)) {
            dispatchArgs.priority = payload.priority;
          }
          if (typeof payload.deadlineAt === "string") {
            dispatchArgs.deadlineAt = payload.deadlineAt;
          }
          if (typeof payload.retryAfterMs === "number") {
            dispatchArgs.retryAfterMs = payload.retryAfterMs;
          }
          await this.dispatchAgentExecution(state, message.recipientAgentId, dispatchArgs);
        }
        return;
      case "task.claimed":
        await this.executeClaimedTask(state, message);
        return;
      case "approval.resolved":
        await this.resumeAfterApproval(state, message);
        return;
      case "task.failed":
        await this.failWorkflow(state, {
          code: "provider-error",
          message: "Agent execution failed.",
          retryable: false,
          details: ensureJsonObject(message.payload),
        });
        return;
      default:
        return;
    }
  }

  /** Cancels an active workflow. */
  async cancelWorkflow(scope: TenantScope, runId: RunId, reason: string): Promise<void> {
    const state = await this.requireWorkflow(scope, runId);
    state.status = "cancelled";
    state.completedAt = this.nowIso();
    state.updatedAt = this.nowIso();
    state.lastError = { code: "routing-error", message: reason, retryable: false };
    await this.deps.workflowStore.update(state);
    await this.recordAudit("workflow.cancelled", state, "warn", { reason });
  }

  private async dispatchAgentExecution(
    state: WorkflowRecord,
    agentId?: string,
    args?: {
      triggerMessage?: AgentMessage;
      priority?: QueuePriority;
      deadlineAt?: string;
      retryAfterMs?: number;
      queueId?: string;
    },
  ): Promise<void> {
    if (!agentId) {
      await this.failWorkflow(state, {
        code: "routing-error",
        message: "No recipient agent id was provided for execution.",
        retryable: false,
      });
      return;
    }

    const runtime = await this.requireAgentRuntime(state.scope, agentId);
    const compatibilityError = this.validateRuntimeCompatibility(state.team, runtime.definition);
    if (compatibilityError) {
      await this.failWorkflow(state, compatibilityError);
      return;
    }

    const durableTaskQueue = this.getDurableTaskQueue();
    if (!this.shouldUseDurableQueue(state.team, runtime.definition, durableTaskQueue)) {
      await this.executeAgent(state, agentId);
      return;
    }

    const taskArgs: NonNullable<Parameters<typeof this.buildAgentRunTask>[2]> = {};
    if (args?.triggerMessage) {
      taskArgs.triggerMessage = args.triggerMessage;
    }
    if (args?.queueId) {
      taskArgs.queueId = args.queueId;
    }
    if (args?.priority) {
      taskArgs.priority = args.priority;
    }
    if (args?.deadlineAt) {
      taskArgs.deadlineAt = args.deadlineAt;
    }
    if (typeof args?.retryAfterMs === "number" && args.retryAfterMs > 0) {
      taskArgs.availableAt = this.nowPlusMs(args.retryAfterMs);
    }
    const task = this.buildAgentRunTask(state, runtime.definition, taskArgs);
    await durableTaskQueue.enqueue(task);
    state.currentAgentId = agentId;
    state.updatedAt = this.nowIso();
    await this.deps.workflowStore.update(state);

    const messageBase = this.buildMessageArgs({
      kind: "task.enqueued",
      scope: state.scope,
      runId: state.runId,
      sessionId: state.request.sessionId,
      recipientAgentId: agentId,
      payload: {
        taskId: task.id,
        queueId: task.queueId,
        priority: task.priority,
        attempt: task.attempt,
        maxAttempts: task.maxAttempts,
        availableAt: task.availableAt,
        deadlineAt: task.deadlineAt,
      },
    });
    const enqueuedMessage = this.buildMessage(
      args?.triggerMessage?.senderAgentId
        ? { ...messageBase, senderAgentId: args.triggerMessage.senderAgentId }
        : messageBase,
    );
    await this.deps.messageBus.publish(enqueuedMessage);
    await this.recordAudit("workflow.task.enqueued", state, "info", {
      taskId: task.id,
      queueId: task.queueId,
      agentId,
      priority: task.priority,
      attempt: task.attempt,
    });

  }

  private async executeClaimedTask(state: WorkflowRecord, message: AgentMessage): Promise<void> {
    const claimed = this.parseClaimedTaskMessage(state, message);
    if (!claimed?.task.agentId) {
      await this.failWorkflow(state, {
        code: "routing-error",
        message: "Claimed task payload did not include a valid agent id.",
        retryable: false,
      });
      return;
    }

    await this.recordAudit("workflow.task.claimed", state, "info", {
      taskId: claimed.task.id,
      queueId: claimed.task.queueId,
      leaseId: claimed.lease.id,
      workerId: claimed.lease.workerId,
      agentId: claimed.task.agentId,
      attempt: claimed.task.attempt,
    });
    await this.executeAgent(state, claimed.task.agentId, claimed.task, claimed.lease);
  }

  private async executeAgent(
    state: WorkflowRecord,
    agentId?: string,
    queueTask?: DurableTaskEnvelope,
    lease?: TaskLease,
  ): Promise<void> {
    console.log(`[Orchestrator] executeAgent called for agent: ${agentId}`);
    if (!agentId) {
      console.log(`[Orchestrator] No agentId provided, failing workflow`);
      await this.failWorkflow(state, {
        code: "routing-error",
        message: "No recipient agent id was provided for execution.",
        retryable: false,
      });
      return;
    }

    const runtime = await this.requireAgentRuntime(state.scope, agentId);
    console.log(`[Orchestrator] Got runtime for agent: ${agentId}`);
    const compatibilityError = this.validateRuntimeCompatibility(state.team, runtime.definition);
    if (compatibilityError) {
      console.log(`[Orchestrator] Runtime compatibility error: ${compatibilityError.message}`);
      await this.failWorkflow(state, compatibilityError);
      return;
    }
    if (state.hopCount >= runtime.definition.executionLimits.maxHopsPerRun) {
      await this.failWorkflow(state, {
        code: "routing-error",
        message: `Workflow exceeded the hop limit for agent ${agentId}.`,
        retryable: false,
      });
      return;
    }

    state.currentAgentId = agentId;
    state.hopCount += 1;
    state.attemptByAgentId[agentId] = (state.attemptByAgentId[agentId] ?? 0) + 1;
    state.updatedAt = this.nowIso();
    await this.deps.workflowStore.update(state);
    console.log(`[Orchestrator] Publishing task.started for agent: ${agentId}`);
    await this.deps.messageBus.publish(this.buildMessage({
      kind: "task.started",
      scope: state.scope,
      runId: state.runId,
      sessionId: state.request.sessionId,
      recipientAgentId: agentId,
      payload: {
        hopCount: state.hopCount,
        taskId: queueTask?.id,
        leaseId: lease?.id,
        workerId: lease?.workerId,
      },
    }));

    console.log(`[Orchestrator] Building context for agent: ${agentId}`);
    const context = await this.buildContext(state, runtime.definition, queueTask, lease);
    console.log(`[Orchestrator] Context built, running security preflight`);
    await this.runPromptSecurityPreflight(state, context);
    const record: AgentRunRecord = {
      runId: state.runId,
      agentId,
      status: "running",
      startedAt: this.nowIso(),
      attempt: state.attemptByAgentId[agentId],
    };
    if (lease?.workerId) {
      record.workerId = lease.workerId;
    }
    if (lease?.id) {
      record.leaseId = lease.id;
    }

    try {
      console.log(`[Orchestrator] Executing agent with retry: ${agentId}`);
      const result = await this.executeWithRetry(runtime, context, record);
      console.log(`[Orchestrator] Agent execution completed: ${agentId}, status: ${result.status}`);
      const validationError = this.validateAgentResult(state, runtime.definition, result);
      if (validationError) {
        record.status = "failed";
        record.finishedAt = this.nowIso();
        record.error = validationError;
        await this.handleExecutionFailure(
          state,
          runtime.definition,
          record,
          validationError,
          queueTask,
          lease,
        );
        return;
      }
      record.status = result.status;
      record.finishedAt = this.nowIso();
      await this.handleAgentResult(
        state,
        runtime.definition,
        context,
        result,
        record,
        queueTask,
        lease,
      );
    } catch (error) {
      const frameworkError = normalizeError(error);
      console.log(`[Orchestrator] Agent execution failed: ${agentId}, error: ${frameworkError.code} - ${frameworkError.message}`);
      record.status = "failed";
      record.finishedAt = this.nowIso();
      record.error = frameworkError;
      await this.handleExecutionFailure(
        state,
        runtime.definition,
        record,
        frameworkError,
        queueTask,
        lease,
      );
    }
  }

  private async handleAgentResult(
    state: WorkflowRecord,
    agent: AgentDefinition,
    context: AgentRunContext,
    result: AgentResult,
    record: AgentRunRecord,
    queueTask?: DurableTaskEnvelope,
    lease?: TaskLease,
  ): Promise<void> {
    state.updatedAt = this.nowIso();
    state.consecutiveFailures = result.status === "succeeded" ? 0 : state.consecutiveFailures + 1;
    state.tokenUsage = addTokenUsage(state.tokenUsage, result.tokenUsage);
    state.artifacts.push(...result.artifacts.map((artifact) => ({
      agentId: agent.id,
      title: artifact.title,
      kind: artifact.kind,
      mimeType: artifact.mimeType,
      content: artifact.content,
    })));
    await this.deps.workflowStore.update(state);

    if (result.memoryWrites?.length) {
      await this.deps.memoryStore.write(result.memoryWrites);
    }
    if (result.learnedSkillCandidates?.length && agent.securityPolicy.allowSkillLearning) {
      for (const skill of result.learnedSkillCandidates) {
        await this.deps.skillRegistry.put(state.scope, skill);
      }
    }
    if (result.auditEvents?.length) {
      for (const event of result.auditEvents) {
        await this.deps.auditLogger.record(event);
      }
    }

    const completedMessage = this.buildMessage({
      kind: "task.completed",
      scope: state.scope,
      runId: state.runId,
      sessionId: state.request.sessionId,
      senderAgentId: agent.id,
      payload: {
        status: result.status,
        summary: result.summary,
        totalTokens: result.tokenUsage?.totalTokens,
        taskId: queueTask?.id,
        leaseId: lease?.id,
        budgetOutcome: result.budgetResult?.outcome,
        // Additional fields for learning analysis
        agentRole: agent.role,
        agentName: agent.name,
        output: result as unknown as JsonObject,
        tokenUsage: result.tokenUsage as unknown as JsonObject,
        latencyMs: record.finishedAt && record.startedAt 
          ? Date.parse(record.finishedAt) - Date.parse(record.startedAt)
          : 0,
      },
    });
    
    // Store in workflow history for learning analysis
    state.messageHistory.push(completedMessage);
    state.updatedAt = this.nowIso();
    await this.deps.workflowStore.update(state);
    
    await this.deps.messageBus.publish(completedMessage);

    // Record audit event for agent completion (used by LearningEngine for historical analysis)
    await this.recordAudit("workflow.agent.completed", state, result.status === "succeeded" ? "info" : "error", {
      agentId: agent.id,
      agentRole: agent.role,
      agentName: agent.name,
      status: result.status,
      summary: result.summary,
      totalTokens: result.tokenUsage?.totalTokens,
      latencyMs: record.finishedAt && record.startedAt 
        ? Date.parse(record.finishedAt) - Date.parse(record.startedAt)
        : 0,
    });

    if (result.budgetResult && result.budgetResult.outcome !== "not-needed") {
      await this.deps.messageBus.publish(this.buildMessage({
        kind: "budget.degraded",
        scope: state.scope,
        runId: state.runId,
        sessionId: state.request.sessionId,
        senderAgentId: agent.id,
        payload: {
          strategy: result.budgetResult.strategy,
          outcome: result.budgetResult.outcome,
          estimatedInputTokensBefore: result.budgetResult.estimatedInputTokensBefore,
          estimatedInputTokensAfter: result.budgetResult.estimatedInputTokensAfter,
          allowedInputTokens: result.budgetResult.allowedInputTokens,
          notes: result.budgetResult.notes,
        },
      }));
    }

    if (state.consecutiveFailures > agent.executionLimits.maxConsecutiveFailures) {
      await this.handleExecutionFailure(state, agent, record, {
        code: "routing-error",
        message: "Workflow exceeded the consecutive failure threshold.",
        retryable: false,
      }, queueTask, lease);
      return;
    }

    const terminalResultError = this.toTerminalResultError(agent, result);
    if (terminalResultError) {
      record.error = terminalResultError;
      await this.recordLearningOutcome(context, result, record);
      await this.handleExecutionFailure(state, agent, record, terminalResultError, queueTask, lease);
      return;
    }

    const routingDecision = await this.applyHandoff(state, agent, result.handoff, result);
    if (routingDecision?.id) {
      record.routingDecisionId = routingDecision.id;
      await this.recordRoutingTelemetry(state, agent, routingDecision, record, result);
    }
    await this.recordLearningOutcome(context, result, record);
    await this.ackLease(queueTask, lease, result.summary);
  }

  private async applyHandoff(
    state: WorkflowRecord,
    currentAgent: AgentDefinition,
    handoff: HandoffDirective,
    result: AgentResult,
  ): Promise<RoutingDecision | null> {
    if (handoff.disposition === "complete" || handoff.disposition === "noop") {
      await this.completeWorkflow(state, result.summary);
      return null;
    }
    if (handoff.disposition === "fail") {
      await this.failWorkflow(state, {
        code: "routing-error",
        message: handoff.reason,
        retryable: false,
      });
      return null;
    }
    if (handoff.disposition === "await-approval") {
      await this.requestApproval(state, currentAgent.id, handoff);
      return null;
    }
    if (handoff.disposition === "retry") {
      if (state.routingDecisions.length >= currentAgent.executionLimits.maxNestedHandOffs) {
        await this.failWorkflow(state, {
          code: "routing-error",
          message: `Workflow exceeded the nested handoff limit for agent ${currentAgent.id}.`,
          retryable: false,
        });
        return null;
      }
      const retryDecision = await this.recordRoutingDecision(state, {
        id: this.nextId("route"),
        strategy: state.team.routingStrategy ?? "declarative",
        selectedAgentId: currentAgent.id,
        selectedBy: "agent-directive",
        confidence: 1,
        candidates: [{
          agentId: currentAgent.id,
          score: 1,
          confidence: 1,
          reasons: ["Agent requested a retry of its current assignment."],
        }],
        reason: handoff.reason,
        metadata: {
          disposition: handoff.disposition,
          retryAfterMs: handoff.retryAfterMs,
        },
      });
      const retryMessage = this.buildMessage({
        kind: "task.retried",
        scope: state.scope,
        runId: state.runId,
        sessionId: state.request.sessionId,
        senderAgentId: currentAgent.id,
        recipientAgentId: currentAgent.id,
        payload: {
          disposition: handoff.disposition,
          reason: handoff.reason,
          retryAfterMs: handoff.retryAfterMs,
          queueId: handoff.queueId,
          priority: handoff.priority,
          deadlineAt: handoff.deadlineAt,
          routingDecisionId: retryDecision.id,
        },
      });
      await this.deps.messageBus.publish(retryMessage);
      if (this.config.autoDrive) {
        await delay(handoff.retryAfterMs ?? this.config.defaultRetryAfterMs);
        await this.handleMessage(retryMessage);
      }
      return retryDecision;
    }

    if (state.routingDecisions.length >= currentAgent.executionLimits.maxNestedHandOffs) {
      await this.failWorkflow(state, {
        code: "routing-error",
        message: `Workflow exceeded the nested handoff limit for agent ${currentAgent.id}.`,
        retryable: false,
      });
      return null;
    }

    const routingDecision = await this.resolveRoutingDecision(state, currentAgent, result);
    if (!routingDecision?.selectedAgentId) {
      await this.failWorkflow(state, {
        code: "routing-error",
        message: `No route resolved after agent ${currentAgent.id}.`,
        retryable: false,
      });
      return null;
    }

    const nextAgent = this.requireAgentDefinition(state.team, routingDecision.selectedAgentId);
    const handoffPolicyError = this.validateHandoffPolicy(state.team, currentAgent, nextAgent);
    if (handoffPolicyError) {
      await this.failWorkflow(state, handoffPolicyError);
      return null;
    }
    await this.recordRoutingDecision(state, routingDecision);

    const handoffMessage = this.buildMessage({
      kind: "handoff.requested",
      scope: state.scope,
      runId: state.runId,
      sessionId: state.request.sessionId,
      senderAgentId: currentAgent.id,
      recipientAgentId: nextAgent.id,
      payload: {
        disposition: handoff.disposition,
        reason: handoff.reason,
        routingDecisionId: routingDecision.id,
        queueId: handoff.queueId,
        priority: handoff.priority,
        deadlineAt: handoff.deadlineAt,
      },
    });
    await this.deps.messageBus.publish(handoffMessage);
    if (this.config.autoDrive) {
      await this.handleMessage(handoffMessage);
    }
    return routingDecision;
  }

  private async requestApproval(
    state: WorkflowRecord,
    agentId: string,
    handoff: HandoffDirective,
  ): Promise<void> {
    const lastMessageId = state.messageHistory.at(-1)?.id;
    const request: ApprovalRequest = {
      id: this.nextId("approval"),
      scope: state.scope,
      kind: handoff.approvalKind ?? "privileged-handoff",
      requestedByAgentId: agentId,
      reason: handoff.reason,
      payload: handoff.routeMetadata ?? {},
      createdAt: this.nowIso(),
      status: "pending",
      ...(lastMessageId ? { correlationId: lastMessageId } : {}),
    };
    state.status = "awaiting-approval";
    state.pendingApprovalRequestId = request.id;
    state.updatedAt = this.nowIso();
    await this.deps.workflowStore.update(state);
    await this.recordAudit("workflow.approval.requested", state, "warn", {
      approvalRequestId: request.id,
      requestedByAgentId: agentId,
      kind: request.kind,
      reason: request.reason,
    });

    await this.deps.messageBus.publish(this.buildMessage({
      kind: "approval.requested",
      scope: state.scope,
      runId: state.runId,
      sessionId: state.request.sessionId,
      senderAgentId: agentId,
      payload: {
        approvalRequestId: request.id,
        kind: request.kind,
        reason: request.reason,
      },
    }));

    const decision = await this.deps.approvalGateway.requestApproval(request);
    const resolvedMessage = this.buildMessage({
      kind: "approval.resolved",
      scope: state.scope,
      runId: state.runId,
      sessionId: state.request.sessionId,
      senderAgentId: agentId,
      payload: approvalDecisionToPayload(decision),
    });
    await this.deps.messageBus.publish(resolvedMessage);
    if (this.config.autoDrive) {
      await this.handleMessage(resolvedMessage);
    }
  }

  private async resumeAfterApproval(state: WorkflowRecord, message: AgentMessage): Promise<void> {
    const payload = ensureJsonObject(message.payload);
    if (
      state.status !== "awaiting-approval" ||
      typeof payload.requestId !== "string" ||
      payload.requestId !== state.pendingApprovalRequestId
    ) {
      return;
    }
    await this.recordAudit("workflow.approval.resolved", state, "info", payload);
    if (payload.approved !== true || !state.currentAgentId) {
      await this.failWorkflow(state, {
        code: "approval-rejected",
        message: "Privileged action was rejected by the human approver.",
        retryable: false,
        details: payload,
      });
      return;
    }
    state.status = "running";
    delete state.pendingApprovalRequestId;
    state.updatedAt = this.nowIso();
    await this.deps.workflowStore.update(state);
    await this.dispatchAgentExecution(state, state.currentAgentId, {
      triggerMessage: message,
    });
  }

  private async executeWithRetry(
    runtime: AgentRuntime,
    context: AgentRunContext,
    record: AgentRunRecord,
  ): Promise<AgentResult> {
    const policy = runtime.definition.retryPolicy;
    let attempts = 0;
    let delayMs = policy.baseDelayMs;

    while (attempts < policy.maxAttempts) {
      attempts += 1;
      try {
        // No fixed timeout - the runtime (e.g., LM Studio streaming) handles its own timeout/idle detection
        console.log(`[Orchestrator] Calling runtime.execute() without fixed timeout (attempt ${attempts}/${policy.maxAttempts})`);
        return await runtime.execute(context);
      } catch (error) {
        record.error = normalizeError(error);
        if (!record.error.retryable || attempts >= policy.maxAttempts) {
          throw record.error;
        }
        await delay(delayMs);
        delayMs = Math.min(Math.round(delayMs * policy.backoffMultiplier), policy.maxDelayMs);
      }
    }

    throw {
      code: "provider-error",
      message: "Agent execution failed without a captured error.",
      retryable: false,
    } satisfies FrameworkError;
  }

  private async buildContext(
    state: WorkflowRecord,
    agent: AgentDefinition,
    queueTask?: DurableTaskEnvelope,
    lease?: TaskLease,
  ): Promise<AgentRunContext> {
    const [sessionState, relevantMemories, learnedSkills] = await Promise.all([
      this.deps.sessionStateStore.get(state.scope, state.request.sessionId),
      this.deps.memoryStore.query({
        scope: state.scope,
        namespace: "semantic",
        queryText: state.request.goal,
        topK: this.config.memoryQueryTopK,
      }),
      this.deps.skillRegistry.list(state.scope),
    ]);

    return {
      scope: state.scope,
      runId: state.runId,
      sessionId: state.request.sessionId,
      team: state.team,
      agent,
      request: state.request,
      messageHistory: state.messageHistory,
      memory: { sessionState, relevantMemories, learnedSkills },
      tokenBudget: mergeTokenBudget(
        agent.tokenBudget,
        state.team.defaultTokenBudget,
        state.request.tokenBudget,
      ),
      hopIndex: state.hopCount,
      ...(queueTask ? { queueTask } : {}),
      ...(lease ? { lease } : {}),
    };
  }

  private async completeWorkflow(state: WorkflowRecord, summary: string): Promise<void> {
    state.status = "completed";
    delete state.pendingApprovalRequestId;
    state.updatedAt = this.nowIso();
    state.completedAt = this.nowIso();
    await this.deps.workflowStore.update(state);
    await this.recordAudit("workflow.completed", state, "info", {
      summary,
      totalTokens: state.tokenUsage.totalTokens,
      routingDecisionCount: state.routingDecisions.length,
    });
    await this.sendNotifications(state, "completed", summary);
    
    // Trigger post-run learning analysis
    await this.runPostRunLearning(state.runId, state.scope, "completed");
  }

  /**
   * Post-run learning hook - triggers analyze() after workflow completion.
   * Runs asynchronously to not block workflow completion.
   */
  private async runPostRunLearning(
    runId: RunId,
    scope: TenantScope,
    finalStatus: "completed" | "failed" | "timed-out" | "cancelled"
  ): Promise<void> {
    if (!this.deps.learningEngine) {
      return;
    }

    // Only analyze on completion or failure (skip if manually cancelled early)
    if (finalStatus !== "completed" && finalStatus !== "failed" && finalStatus !== "timed-out") {
      return;
    }

    try {
      console.log(`[Orchestrator] Triggering post-run learning analysis for ${runId}...`);
      const analysis = await this.deps.learningEngine.analyze(runId, scope);
      console.log(`[Orchestrator] Learning analysis complete: ${analysis.suggestedSkills.length} skills suggested, ${analysis.routingScoreUpdates.length} routing scores updated`);
    } catch (error) {
      // Log error but don't fail the workflow - learning is best-effort
      console.error(`[Orchestrator] Post-run learning analysis failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async failWorkflow(state: WorkflowRecord, error: FrameworkError): Promise<void> {
    state.status = error.code === "timeout" ? "timed-out" : "failed";
    delete state.pendingApprovalRequestId;
    state.lastError = error;
    state.updatedAt = this.nowIso();
    state.completedAt = this.nowIso();
    await this.deps.workflowStore.update(state);
    await this.recordAudit("workflow.failed", state, "error", {
      code: error.code,
      message: error.message,
      totalTokens: state.tokenUsage.totalTokens,
      routingDecisionCount: state.routingDecisions.length,
    });
    await this.sendNotifications(state, state.status, error.message);
    
    // Trigger post-run learning analysis even on failure (for learning from failures)
    await this.runPostRunLearning(state.runId, state.scope, state.status);
  }

  private async resolveRoutingDecision(
    state: WorkflowRecord,
    currentAgent: AgentDefinition,
    result: AgentResult,
  ): Promise<RoutingDecision | null> {
    const strategy = state.team.routingStrategy ?? "declarative";
    const startedAtMs = this.nowMs();
    if (
      strategy !== "declarative" &&
      this.deps.learningEngine?.suggestRoutingDecision &&
      result.routingSignals?.length
    ) {
      const learnedDecision = await this.deps.learningEngine.suggestRoutingDecision(
        state.scope,
        state.team,
        result.routingSignals,
      );
      if (
        learnedDecision?.selectedAgentId &&
        state.team.agents.some((agent) => agent.id === learnedDecision.selectedAgentId)
      ) {
        return {
          ...learnedDecision,
          selectedBy: learnedDecision.selectedBy ?? "learned-policy",
          decisionLatencyMs: learnedDecision.decisionLatencyMs ?? this.nowMs() - startedAtMs,
        };
      }
    }

    const nextAgent = await this.deps.taskRouter.resolveNextAgent({
      team: state.team,
      currentAgent,
      result,
      request: state.request,
    });
    if (!nextAgent) {
      return null;
    }

    return {
      id: this.nextId("route"),
      strategy,
      selectedAgentId: nextAgent.id,
      selectedBy: result.handoff.targetAgentId ? "agent-directive" : "task-router",
      confidence: result.confidence ?? 1,
      decisionLatencyMs: this.nowMs() - startedAtMs,
      candidates: [{
        agentId: nextAgent.id,
        score: 1,
        confidence: result.confidence ?? 1,
        reasons: ["Resolved by the configured task router."],
      }],
      reason: result.handoff.reason,
      metadata: {
        disposition: result.handoff.disposition,
      },
    };
  }

  private async recordRoutingDecision(
    state: WorkflowRecord,
    routingDecision: RoutingDecision,
  ): Promise<RoutingDecision> {
    state.routingDecisions.push(routingDecision);
    state.updatedAt = this.nowIso();
    await this.deps.workflowStore.update(state);
    await this.recordAudit("workflow.routed", state, "info", {
      routingDecisionId: routingDecision.id,
      strategy: routingDecision.strategy,
      selectedAgentId: routingDecision.selectedAgentId,
      reason: routingDecision.reason,
    });
    return routingDecision;
  }

  private async recordLearningOutcome(
    context: AgentRunContext,
    result: AgentResult,
    record: AgentRunRecord,
  ): Promise<void> {
    if (!this.deps.learningEngine) {
      return;
    }
    await this.deps.learningEngine.recordRun(context, result, record);
  }

  private async recordRoutingTelemetry(
    state: WorkflowRecord,
    currentAgent: AgentDefinition,
    routingDecision: RoutingDecision,
    record: AgentRunRecord,
    result: AgentResult,
  ): Promise<void> {
    if (!this.deps.learningEngine?.recordRoutingTelemetry) {
      return;
    }

    const telemetry: RoutingTelemetry = {
      decisionId: routingDecision.id,
      scope: state.scope,
      runId: state.runId,
      currentAgentId: currentAgent.id,
      selectedAgentId: routingDecision.selectedAgentId ?? "",
      strategy: routingDecision.strategy,
      recordedAt: this.nowIso(),
      candidateCount: routingDecision.candidates.length,
      confidence: routingDecision.confidence ?? 1,
      estimatedLatencyMs: routingDecision.candidates[0]?.estimatedLatencyMs ?? 0,
      estimatedCostUsd: routingDecision.candidates[0]?.estimatedCostUsd ?? 0,
      actualLatencyMs: this.computeRecordLatencyMs(record) ?? 0,
      actualTokenUsage: result.tokenUsage ?? { totalTokens: 0, inputTokens: 0, outputTokens: 0 },
      outcome:
        result.status === "timed-out"
          ? "timed-out"
          : result.status === "failed"
            ? "failed"
            : "succeeded",
      feedbackTags: result.validationIssues ?? [],
      metadata: {
        selectedBy: routingDecision.selectedBy,
        reason: routingDecision.reason,
      },
    };
    await this.deps.learningEngine.recordRoutingTelemetry(telemetry);
  }

  private async handleExecutionFailure(
    state: WorkflowRecord,
    agent: AgentDefinition,
    record: AgentRunRecord,
    error: FrameworkError,
    queueTask?: DurableTaskEnvelope,
    lease?: TaskLease,
  ): Promise<void> {
    if (queueTask && lease && error.retryable && queueTask.attempt < queueTask.maxAttempts) {
      await this.releaseLease(queueTask, lease, {
        retryAt: this.nowPlusMs(agent.retryPolicy.baseDelayMs),
        reason: error.message,
      });
      await this.deps.messageBus.publish(this.buildMessage({
        kind: "task.retried",
        scope: state.scope,
        runId: state.runId,
        sessionId: state.request.sessionId,
        recipientAgentId: agent.id,
        payload: {
          taskId: queueTask.id,
          queueId: queueTask.queueId,
          leaseId: lease.id,
          reason: error.message,
          attempt: queueTask.attempt,
          maxAttempts: queueTask.maxAttempts,
        },
      }));
      await this.recordAudit("workflow.task.released", state, "warn", {
        taskId: queueTask.id,
        queueId: queueTask.queueId,
        leaseId: lease.id,
        retryAt: this.nowPlusMs(agent.retryPolicy.baseDelayMs),
        reason: error.message,
      });
      return;
    }

    if (queueTask && lease) {
      await this.releaseLease(queueTask, lease, {
        reason: error.message,
      });
      await this.deps.messageBus.publish(this.buildMessage({
        kind: "task.failed",
        scope: state.scope,
        runId: state.runId,
        sessionId: state.request.sessionId,
        recipientAgentId: agent.id,
        payload: {
          taskId: queueTask.id,
          queueId: queueTask.queueId,
          leaseId: lease.id,
          attempt: queueTask.attempt,
          maxAttempts: queueTask.maxAttempts,
          code: error.code,
          message: error.message,
        },
      }));
    }

    await this.failWorkflow(state, error);
  }

  private async ackLease(
    queueTask?: DurableTaskEnvelope,
    lease?: TaskLease,
    summary?: string,
  ): Promise<void> {
    const durableTaskQueue = this.getDurableTaskQueue();
    if (!durableTaskQueue || !queueTask || !lease) {
      return;
    }
    await durableTaskQueue.ack({
      leaseId: lease.id,
      taskId: queueTask.id,
      acknowledgedAt: this.nowIso(),
      ...(summary ? { summary } : {}),
    });
  }

  private async releaseLease(
    queueTask: DurableTaskEnvelope,
    lease: TaskLease,
    args?: {
      retryAt?: string;
      reason?: string;
    },
  ): Promise<void> {
    const durableTaskQueue = this.getDurableTaskQueue();
    if (!durableTaskQueue) {
      return;
    }
    await durableTaskQueue.release({
      leaseId: lease.id,
      taskId: queueTask.id,
      releasedAt: this.nowIso(),
      ...(args?.retryAt ? { retryAt: args.retryAt } : {}),
      ...(args?.reason ? { reason: args.reason } : {}),
    });
  }

  private getDurableTaskQueue(): DurableTaskQueue | undefined {
    const deps = this.deps as OrchestratorDependencies & {
      durableTaskQueue?: DurableTaskQueue;
    };
    return deps.durableTaskQueue;
  }

  private shouldUseDurableQueue(
    team: TeamDefinition,
    agent: AgentDefinition,
    durableTaskQueue?: DurableTaskQueue,
  ): durableTaskQueue is DurableTaskQueue {
    if (!durableTaskQueue) {
      return false;
    }
    const coordinationMode = team.coordinationMode ?? "hybrid";
    return coordinationMode === "hybrid" || agent.executionMode === "queued" || agent.executionMode === "batched";
  }

  private buildAgentRunTask(
    state: WorkflowRecord,
    agent: AgentDefinition,
    args?: {
      queueId?: string;
      priority?: QueuePriority;
      deadlineAt?: string;
      availableAt?: string;
      triggerMessage?: AgentMessage;
    },
  ): DurableTaskEnvelope {
    return {
      id: this.nextId("task"),
      kind: "agent-run",
      queueId: args?.queueId ?? state.team.queueId ?? `queue:${state.team.id}`,
      scope: state.scope,
      runId: state.runId,
      sessionId: state.request.sessionId,
      agentId: agent.id,
      createdAt: this.nowIso(),
      ...(args?.availableAt ? { availableAt: args.availableAt } : {}),
      ...(args?.deadlineAt ? { deadlineAt: args.deadlineAt } : {}),
      dedupeKey: `${state.runId}:${agent.id}:${state.attemptByAgentId[agent.id] ?? 0}`,
      priority: args?.priority ?? state.request.priority ?? "normal",
      attempt: this.nextQueuedAttempt(state, agent.id),
      maxAttempts: Math.max(agent.retryPolicy.maxAttempts, 1),
      payload: {
        triggerMessageId: args?.triggerMessage?.id,
        triggerKind: args?.triggerMessage?.kind,
        hopIndex: state.hopCount + 1,
      },
    };
  }

  private parseClaimedTaskMessage(
    state: WorkflowRecord,
    message: AgentMessage,
  ): { task: DurableTaskEnvelope; lease: TaskLease } | null {
    const payload = ensureJsonObject(message.payload);
    const taskId = typeof payload.taskId === "string" ? payload.taskId : undefined;
    const queueId = typeof payload.queueId === "string" ? payload.queueId : state.team.queueId ?? `queue:${state.team.id}`;
    const agentId =
      typeof payload.agentId === "string"
        ? payload.agentId
        : message.recipientAgentId;
    const leaseId = typeof payload.leaseId === "string" ? payload.leaseId : undefined;
    const workerId = typeof payload.workerId === "string" ? payload.workerId : "worker-unknown";
    if (!taskId || !agentId || !leaseId) {
      return null;
    }

    const attempt = typeof payload.attempt === "number" ? payload.attempt : 1;
    const task: DurableTaskEnvelope = {
      id: taskId,
      kind: "agent-run",
      queueId,
      scope: state.scope,
      runId: state.runId,
      sessionId: state.request.sessionId,
      agentId,
      createdAt: typeof payload.createdAt === "string" ? payload.createdAt : message.createdAt,
      ...(typeof payload.availableAt === "string" ? { availableAt: payload.availableAt } : {}),
      ...(typeof payload.deadlineAt === "string" ? { deadlineAt: payload.deadlineAt } : {}),
      ...(typeof payload.dedupeKey === "string" ? { dedupeKey: payload.dedupeKey } : {}),
      priority: (isQueuePriority(payload.priority as unknown) ? payload.priority : "normal") as QueuePriority,
      attempt,
      maxAttempts: typeof payload.maxAttempts === "number" ? payload.maxAttempts : 1,
      payload: ensureJsonObject(payload.taskPayload),
    };
    const lease: TaskLease = {
      id: leaseId,
      taskId,
      queueId,
      workerId,
      claimedAt: typeof payload.claimedAt === "string" ? payload.claimedAt : message.createdAt,
      ...(typeof payload.heartbeatAt === "string" ? { heartbeatAt: payload.heartbeatAt } : {}),
      expiresAt: typeof payload.expiresAt === "string" ? payload.expiresAt : this.nowPlusMs(60_000),
      attempt,
    };

    return { task, lease };
  }

  private nextQueuedAttempt(state: WorkflowRecord, agentId: string): number {
    return (state.attemptByAgentId[agentId] ?? 0) + 1;
  }

  private computeRecordLatencyMs(record: AgentRunRecord): number | undefined {
    if (!record.finishedAt) {
      return undefined;
    }
    return Math.max(Date.parse(record.finishedAt) - Date.parse(record.startedAt), 0);
  }

  private validateRuntimeCompatibility(
    team: TeamDefinition,
    agent: AgentDefinition,
  ): FrameworkError | null {
    if (
      team.runtimeTarget &&
      agent.runtimeTargets?.length &&
      !agent.runtimeTargets.includes(team.runtimeTarget)
    ) {
      return {
        code: "routing-error",
        message:
          `Agent ${agent.id} does not support team runtime target ${team.runtimeTarget}.`,
        retryable: false,
      };
    }
    return null;
  }

  private validateHandoffPolicy(
    team: TeamDefinition,
    currentAgent: AgentDefinition,
    nextAgent: AgentDefinition,
  ): FrameworkError | null {
    const nextTargets = nextAgent.runtimeTargets?.length
      ? nextAgent.runtimeTargets
      : team.runtimeTarget
        ? [team.runtimeTarget]
        : [];
    if (
      currentAgent.securityPolicy.allowedRuntimeTargets?.length &&
      nextTargets.length > 0 &&
      !nextTargets.some((target) =>
        currentAgent.securityPolicy.allowedRuntimeTargets?.includes(target)
      )
    ) {
      return {
        code: "security-policy-violation",
        message:
          `Agent ${currentAgent.id} is not allowed to hand off work to runtime targets used by ${nextAgent.id}.`,
        retryable: false,
      };
    }
    return null;
  }

  private validateAgentResult(
    state: WorkflowRecord,
    agent: AgentDefinition,
    result: AgentResult,
  ): FrameworkError | null {
    if (!result || typeof result !== "object") {
      return {
        code: "malformed-output",
        message: `Agent ${agent.id} returned an empty or non-object result.`,
        retryable: true,
      };
    }
    if (!result.summary || typeof result.summary !== "string") {
      return {
        code: "malformed-output",
        message: `Agent ${agent.id} returned a result without a valid summary.`,
        retryable: true,
      };
    }
    if (
      !result.structuredOutput ||
      typeof result.structuredOutput !== "object" ||
      Array.isArray(result.structuredOutput)
    ) {
      return {
        code: "malformed-output",
        message: `Agent ${agent.id} returned a result without a valid structured output object.`,
        retryable: true,
      };
    }
    if (!isKnownHandoffDisposition(result.handoff?.disposition)) {
      return {
        code: "malformed-output",
        message: `Agent ${agent.id} returned an unsupported handoff disposition.`,
        retryable: true,
      };
    }
    if (!result.handoff.reason || typeof result.handoff.reason !== "string") {
      return {
        code: "malformed-output",
        message: `Agent ${agent.id} returned a handoff without a reason.`,
        retryable: true,
      };
    }
    if (result.status === "queued" || result.status === "running") {
      return {
        code: "malformed-output",
        message: `Agent ${agent.id} returned non-terminal status ${result.status}.`,
        retryable: true,
      };
    }
    if (result.status === "awaiting-approval" && result.handoff.disposition !== "await-approval") {
      return {
        code: "malformed-output",
        message:
          `Agent ${agent.id} returned status awaiting-approval without an await-approval handoff.`,
        retryable: true,
      };
    }
    if (
      result.memoryWrites?.some((record) => !sameTenantScope(record.scope, state.scope)) ||
      result.auditEvents?.some((event) => !sameTenantScope(event.scope, state.scope))
    ) {
      return {
        code: "security-policy-violation",
        message:
          `Agent ${agent.id} attempted to emit data outside its assigned tenant scope.`,
        retryable: false,
      };
    }
    return null;
  }

  private toTerminalResultError(
    agent: AgentDefinition,
    result: AgentResult,
  ): FrameworkError | null {
    switch (result.status) {
      case "failed":
        return {
          code: "provider-error",
          message: result.summary || `Agent ${agent.id} reported failure.`,
          retryable: false,
          details: {
            agentId: agent.id,
          },
        };
      case "timed-out":
        return {
          code: "timeout",
          message: result.summary || `Agent ${agent.id} timed out.`,
          retryable: true,
          details: {
            agentId: agent.id,
          },
        };
      case "rejected":
        return {
          code: "approval-rejected",
          message: result.summary || `Agent ${agent.id} was rejected.`,
          retryable: false,
          details: {
            agentId: agent.id,
          },
        };
      case "budget-exhausted":
        return result.handoff.disposition === "route" ||
          result.handoff.disposition === "retry" ||
          result.handoff.disposition === "await-approval" ||
          result.handoff.disposition === "escalate"
          ? null
          : {
              code: "budget-exhausted",
              message: result.summary || `Agent ${agent.id} exhausted its token budget.`,
              retryable: false,
              details: {
                agentId: agent.id,
              },
            };
      default:
        return null;
    }
  }

  private async runPromptSecurityPreflight(
    state: WorkflowRecord,
    context: AgentRunContext,
  ): Promise<void> {
    if (!this.deps.promptSecurityScanner) {
      return;
    }

    const scanResult = await this.deps.promptSecurityScanner.scan({
      scope: context.scope,
      agentId: context.agent.id,
      policy: context.agent.securityPolicy,
      prompts: [
        {
          role: "system",
          content: `Team=${context.team.id}; Agent=${context.agent.id}; Role=${context.agent.role}`,
        },
        {
          role: "user",
          content:
            `Goal: ${context.request.goal}\n` +
            `Input: ${safeStringifyJson(context.request.input)}`,
        },
      ],
      metadata: {
        runId: context.runId,
        sessionId: context.sessionId,
        hopIndex: context.hopIndex,
      },
    });
    const maxPromptRiskScore = context.agent.securityPolicy.maxPromptRiskScore;
    await this.recordAudit("workflow.security.preflight", state, "info", {
      agentId: context.agent.id,
      allowed: scanResult.allowed,
      riskScore: scanResult.riskScore,
      findings: scanResult.findings.map((finding) => ({
        category: finding.category,
        severity: finding.severity,
        message: finding.message,
      })),
    });

    if (
      scanResult.allowed !== true ||
      (
        typeof maxPromptRiskScore === "number" &&
        scanResult.riskScore > maxPromptRiskScore
      )
    ) {
      throw {
        code: "security-policy-violation",
        message:
          `Prompt security preflight rejected execution for agent ${context.agent.id}.`,
        retryable: false,
        details: {
          riskScore: scanResult.riskScore,
          maxPromptRiskScore,
        },
      } satisfies FrameworkError;
    }
  }

  private async sendNotifications(
    state: WorkflowRecord,
    status: WorkflowStatus,
    body: string,
  ): Promise<void> {
    const subscriptions = state.team.notifications?.filter((item) => item.onStatuses.includes(status));
    if (!subscriptions?.length || !this.deps.notifiers) {
      return;
    }

    for (const subscription of subscriptions) {
      const notifier = this.deps.notifiers[subscription.channel];
      if (!notifier) {
        continue;
      }
      const request: NotificationRequest = {
        id: this.nextId("notify"),
        scope: state.scope,
        channel: subscription.channel,
        destination: subscription.destinationRef,
        title: `Workflow ${status}`,
        body,
        runId: state.runId,
      };
      await notifier.send(request);
    }
  }

  private async recordAudit(
    eventType: string,
    state: WorkflowRecord,
    severity: AuditEvent["severity"],
    payload: JsonObject,
  ): Promise<void> {
    await this.deps.auditLogger.record({
      id: this.nextId("audit"),
      occurredAt: this.nowIso(),
      scope: state.scope,
      actorType: "system",
      actorId: "orchestrator",
      eventType,
      severity,
      runId: state.runId,
      sessionId: state.request.sessionId,
      payload,
    });
  }

  private async requireWorkflow(scope: TenantScope, runId: RunId): Promise<WorkflowRecord> {
    const state = await this.deps.workflowStore.get(scope, runId);
    if (!state) {
      throw new Error(`Workflow ${runId} was not found.`);
    }
    return state;
  }

  private async requireTeam(scope: TenantScope, teamId: string): Promise<TeamDefinition> {
    const team = await this.deps.teamRepository.get(scope, teamId);
    if (!team) {
      throw new Error(`Team ${teamId} was not found.`);
    }
    return team;
  }

  private requireAgentDefinition(team: TeamDefinition, agentId: string): AgentDefinition {
    const agent = team.agents.find((item) => item.id === agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} is not declared in team ${team.id}.`);
    }
    return agent;
  }

  private async requireAgentRuntime(scope: TenantScope, agentId: string): Promise<AgentRuntime> {
    const runtime = await this.deps.agentRegistry.get(scope, agentId);
    if (!runtime) {
      throw new Error(`Agent runtime ${agentId} is not registered.`);
    }
    return runtime;
  }

  private hasProcessedMessage(state: WorkflowRecord, messageId: string): boolean {
    return state.messageHistory.some((message) => message.id === messageId);
  }

  private buildMessage(args: {
    kind: AgentMessage["kind"];
    scope: TenantScope;
    runId: RunId;
    sessionId: SessionId;
    senderAgentId?: string;
    recipientAgentId?: string;
    payload: JsonObject;
  }): AgentMessage {
    const message: AgentMessage = {
      id: this.nextId("msg"),
      kind: args.kind,
      scope: args.scope,
      runId: args.runId,
      sessionId: args.sessionId,
      createdAt: this.nowIso(),
      payload: args.payload,
    };

    if (args.senderAgentId) {
      message.senderAgentId = args.senderAgentId;
    }
    if (args.recipientAgentId) {
      message.recipientAgentId = args.recipientAgentId;
    }

    return message;
  }


  private nextId(prefix: string): string {
    if (this.deps.ids) {
      return this.deps.ids.next(prefix);
    }
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }

  private nowMs(): number {
    const now = this.deps.clock?.now();
    return typeof now === "number" ? now : Date.now();
  }

  private nowPlusMs(ms: number): string {
    const now = this.nowMs();
    return new Date(now + ms).toISOString();
  }

  private nowIso(): string {
    return new Date(this.nowMs()).toISOString();
  }

  private buildMessageArgs(
    args: {
      kind: AgentMessage["kind"];
      scope: TenantScope;
      runId: RunId;
      sessionId: SessionId;
      senderAgentId?: string;
      recipientAgentId?: string;
      payload: JsonObject;
    },
  ): {
    kind: AgentMessage["kind"];
    scope: TenantScope;
    runId: RunId;
    sessionId: SessionId;
    senderAgentId?: string;
    recipientAgentId?: string;
    payload: JsonObject;
  } {
    return args;
  }
}

function safeStringifyJson(value: JsonObject): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "{}";
  }
}

function isQueuePriority(value: unknown): value is QueuePriority {
  return value === "low" || value === "normal" || value === "high" || value === "critical";
}

function isTerminalWorkflowStatus(status: WorkflowStatus): boolean {
  return status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "timed-out";
}

function isKnownHandoffDisposition(value: HandoffDirective["disposition"] | undefined): boolean {
  return value === "complete" ||
    value === "route" ||
    value === "retry" ||
    value === "escalate" ||
    value === "await-approval" ||
    value === "fail" ||
    value === "noop";
}

function sameTenantScope(left: TenantScope, right: TenantScope): boolean {
  return left.tenantId === right.tenantId &&
    left.workspaceId === right.workspaceId &&
    left.teamId === right.teamId &&
    left.projectId === right.projectId &&
    left.environment === right.environment;
}

// TODO:
// - Add bounded parallel fan-out/fan-in execution for teams that branch.
// - Persist per-hop token usage and latency histograms once the LLM gateway is integrated.
// - Add dead-letter handling for poison messages and malformed agent payloads.
// - Move prompt-security sanitization into runtime-platform adapters once prompts are fully materialized there.
