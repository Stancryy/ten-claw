// File: src/dashboard/server.ts
/**
 * Dashboard HTTP server for TenClaw monitoring.
 * 
 * Provides:
 * - Static HTML UI at /
 * - SSE endpoint at /events for real-time updates (3s polling)
 * - REST API for dashboard metrics
 * 
 * Stack: Express, Server-Sent Events, Redis polling
 * Port: 3000
 */

import * as http from "node:http";
import Redis from "ioredis";
import type { RedisAuditLogger } from "../audit-logger.js";
import type { RedisMessageBus } from "../message-bus.js";
import type { FileSystemSkillRegistry } from "../skills.js";
import type { LearningEngineImpl } from "../learning-engine.js";

// Dashboard configuration
interface DashboardConfig {
  port: number;
  redisUrl: string;
  pollIntervalMs: number;
  keyPrefix: string;
  auditLogger: RedisAuditLogger;
  messageBus: RedisMessageBus;
  skillRegistry: FileSystemSkillRegistry;
  learningEngine?: LearningEngineImpl;
}

// SSE client connection
interface SSEClient {
  id: string;
  response: http.ServerResponse;
  lastPing: number;
}

// Dashboard state cache
interface DashboardState {
  activeRuns: ActiveRun[];
  recentWorkflows: WorkflowSummary[];
  agentStats: AgentStats[];
  learnedSkills: LearnedSkillInfo[];
  recentAuditEvents: AuditEventSummary[];
  lastUpdated: string;
}

interface ActiveRun {
  runId: string;
  sessionId: string;
  teamId: string;
  currentAgentId?: string;
  status: string;
  startedAt: string;
  durationMs: number;
}

interface WorkflowSummary {
  runId: string;
  teamId: string;
  status: string;
  startedAt: string;
  completedAt: string | undefined;
  durationMs: number;
  agentCount: number;
}

interface AgentStats {
  agentId: string;
  role: string;
  totalRuns: number;
  successfulRuns: number;
  failedRuns: number;
  successRate: number;
  averageLatencyMs: number;
}

interface LearnedSkillInfo {
  id: string;
  name: string;
  role: string;
  version: string;
  confidenceScore: number;
  extractedAt: string;
  approved: boolean;
}

interface AuditEventSummary {
  id: string;
  occurredAt: string;
  actorType: string;
  actorId: string;
  eventType: string;
  severity: string;
  runId: string | undefined;
}

/** Dashboard HTTP server with SSE support */
export class DashboardServer {
  private server: http.Server | null = null;
  private redis: Redis | null = null;
  private clients: Map<string, SSEClient> = new Map();
  private config: DashboardConfig;
  private state: DashboardState;
  private pollTimer: NodeJS.Timeout | null = null;
  private clientCounter = 0;

  constructor(config: DashboardConfig) {
    this.config = {
      ...config,
      port: config.port ?? 3000,
      pollIntervalMs: config.pollIntervalMs ?? 3000,
      keyPrefix: config.keyPrefix ?? "tenclaw",
    };

    this.state = {
      activeRuns: [],
      recentWorkflows: [],
      agentStats: [],
      learnedSkills: [],
      recentAuditEvents: [],
      lastUpdated: new Date().toISOString(),
    };
  }

  /** Start the dashboard server */
  async start(): Promise<void> {
    // Initialize Redis client
    this.redis = new Redis(this.config.redisUrl);
    this.redis.on("error", (err: Error) => {
      console.error("[Dashboard] Redis error:", err.message);
    });

    // Create HTTP server
    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res);
    });

    // Start polling
    this.startPolling();

    // Start server
    return new Promise((resolve, reject) => {
      this.server!.listen(this.config.port, () => {
        console.log(`[Dashboard] Server running on http://localhost:${this.config.port}`);
        console.log(`[Dashboard] SSE endpoint: http://localhost:${this.config.port}/events`);
        resolve();
      });

      this.server!.on("error", reject);
    });
  }

  /** Stop the dashboard server */
  async stop(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    // Close all SSE connections
    for (const client of Array.from(this.clients.values())) {
      client.response.end();
    }
    this.clients.clear();

    // Close Redis connection
    await this.redis?.quit();

    // Close HTTP server
    return new Promise((resolve) => {
      this.server?.close(() => {
        console.log("[Dashboard] Server stopped");
        resolve();
      });
    });
  }

  /** Handle HTTP requests */
  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://localhost:${this.config.port}`);
    const pathname = url.pathname;

    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      // SSE endpoint
      if (pathname === "/events" && req.method === "GET") {
        await this.handleSSE(req, res);
        return;
      }

      // API endpoints
      if (pathname === "/api/state" && req.method === "GET") {
        await this.handleAPIState(res);
        return;
      }

      if (pathname === "/api/active-runs" && req.method === "GET") {
        await this.handleAPIActiveRuns(res);
        return;
      }

      if (pathname === "/api/workflows" && req.method === "GET") {
        await this.handleAPIWorkflows(res);
        return;
      }

      if (pathname === "/api/agent-stats" && req.method === "GET") {
        await this.handleAPIAgentStats(res);
        return;
      }

      if (pathname === "/api/skills" && req.method === "GET") {
        await this.handleAPISkills(res);
        return;
      }

      if (pathname === "/api/audit-log" && req.method === "GET") {
        await this.handleAPIAuditLog(res);
        return;
      }

      // Health check
      if (pathname === "/health" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", timestamp: new Date().toISOString() }));
        return;
      }

      // Cleanup stale runs endpoint
      if (pathname === "/api/cleanup-stale-runs" && req.method === "POST") {
        await this.handleCleanupStaleRuns(res);
        return;
      }

      // Static HTML UI
      if (pathname === "/" || pathname === "/index.html") {
        await this.handleStaticHTML(res);
        return;
      }

      // 404
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    } catch (error) {
      console.error("[Dashboard] Request error:", error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error" }));
    }
  }

  /** Handle SSE connection */
  private async handleSSE(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const clientId = `client-${++this.clientCounter}`;

    // SSE headers
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });

    // Send initial state
    res.write(`id: ${Date.now()}\n`);
    res.write(`event: connected\n`);
    res.write(`data: ${JSON.stringify({ clientId, state: this.state })}\n\n`);

    // Store client
    const client: SSEClient = {
      id: clientId,
      response: res,
      lastPing: Date.now(),
    };
    this.clients.set(clientId, client);

    // Handle disconnect
    req.on("close", () => {
      this.clients.delete(clientId);
      console.log(`[Dashboard] SSE client ${clientId} disconnected`);
    });

    // Send heartbeat every 30s to keep connection alive
    const heartbeat = setInterval(() => {
      if (!this.clients.has(clientId)) {
        clearInterval(heartbeat);
        return;
      }
      res.write(`: heartbeat\n\n`);
    }, 30000);

    console.log(`[Dashboard] SSE client ${clientId} connected (${this.clients.size} total)`);
  }

  /** Broadcast state update to all connected clients */
  private broadcastUpdate(): void {
    const data = JSON.stringify(this.state);
    const message = `id: ${Date.now()}\nevent: update\ndata: ${data}\n\n`;

    for (const client of Array.from(this.clients.values())) {
      try {
        client.response.write(message);
      } catch (err) {
        // Client disconnected
        this.clients.delete(client.id);
      }
    }
  }

  /** Infer team name from agent type */
  private inferTeamFromAgent(agentType: string | undefined): string {
    if (!agentType) return "Unknown";
    
    // Dev team agents
    const devAgents = ["planner", "coder", "reviewer", "tester", "security-auditor"];
    if (devAgents.includes(agentType)) {
      return "Development Delivery Team";
    }
    
    // Business team agents
    const businessAgents = ["researcher", "writer", "editor"];
    if (businessAgents.includes(agentType)) {
      return "Business Content Team";
    }
    
    return "Unknown";
  }

  /** Count how many different agents have processed this run */
  private async countAgentsForRun(runId: string): Promise<number> {
    if (!this.redis) return 0;
    
    try {
      // Get all agent index keys and check which ones contain this runId
      const pattern = `${this.config.keyPrefix}:workflow:index:agent:*`;
      const keys: string[] = [];
      let cursor = "0";

      do {
        const result = await this.redis.scan(cursor, "MATCH", pattern, "COUNT", 100);
        cursor = result[0];
        keys.push(...result[1]);
      } while (cursor !== "0");

      let count = 0;
      for (const key of keys) {
        // Skip invalid agents
        const agentId = key.split(":").pop();
        if (!agentId || agentId === "default" || agentId === "hello-world-agent") continue;
        
        // Check if runId exists in this agent's sorted set
        const rank = await this.redis.zrank(key, runId);
        if (rank !== null) {
          count++;
        }
      }
      
      return count;
    } catch {
      return 0;
    }
  }

  /** Start polling Redis for updates */
  private startPolling(): void {
    // Initial poll
    this.pollState();

    // Periodic polling
    this.pollTimer = setInterval(() => {
      this.pollState();
    }, this.config.pollIntervalMs);
  }

  /** Poll Redis for current state */
  private async pollState(): Promise<void> {
    if (!this.redis) return;

    try {
      const [
        activeRuns,
        recentWorkflows,
        agentStats,
        learnedSkills,
        recentAuditEvents,
      ] = await Promise.all([
        this.fetchActiveRuns(),
        this.fetchRecentWorkflows(),
        this.fetchAgentStats(),
        this.fetchLearnedSkills(),
        this.fetchRecentAuditEvents(),
      ]);

      this.state = {
        activeRuns,
        recentWorkflows,
        agentStats,
        learnedSkills,
        recentAuditEvents,
        lastUpdated: new Date().toISOString(),
      };

      // Broadcast to all clients
      this.broadcastUpdate();
    } catch (error) {
      console.error("[Dashboard] Poll error:", error);
    }
  }

  /** Fetch active runs from Redis */
  private async fetchActiveRuns(): Promise<ActiveRun[]> {
    if (!this.redis) return [];

    try {
      // Scan for workflow run keys: tenclaw:workflow:runs:{tenant}:{workspace}:{project}:{runId}
      const pattern = `${this.config.keyPrefix}:workflow:runs:*`;
      const keys: string[] = [];
      let cursor = "0";

      do {
        const result = await this.redis.scan(cursor, "MATCH", pattern, "COUNT", 100);
        cursor = result[0];
        keys.push(...result[1]);
      } while (cursor !== "0");

      const runs: ActiveRun[] = [];

      for (const key of keys.slice(0, 50)) { // Limit to 50 most recent
        const stateData = await this.redis.get(key);

        if (stateData) {
          try {
            const state = JSON.parse(stateData);
            
            // Only include running workflows as "active"
            if (state.status !== "running" && state.status !== "queued" && state.status !== "awaiting-approval") {
              continue;
            }

            const startedAt = new Date(state.createdAt ?? Date.now());
            const durationMs = Date.now() - startedAt.getTime();

            // Use agentType as current agent and infer team from agent type
            const currentAgentId = state.agentType ?? "unknown";
            const teamId = this.inferTeamFromAgent(currentAgentId);

            runs.push({
              runId: state.runId ?? key.split(":").pop() ?? "unknown",
              sessionId: state.request?.sessionId ?? state.scope?.sessionId ?? "unknown",
              teamId,
              currentAgentId,
              status: state.status ?? "running",
              startedAt: startedAt.toISOString(),
              durationMs,
            });
          } catch {
            // Invalid state data, skip
          }
        }
      }

      return runs.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()).slice(0, 20);
    } catch (error) {
      console.error("[Dashboard] Error fetching active runs:", error);
      return [];
    }
  }

  /** Fetch recent workflows from Redis */
  private async fetchRecentWorkflows(): Promise<WorkflowSummary[]> {
    if (!this.redis) return [];

    try {
      // Scan for workflow run keys: tenclaw:workflow:runs:{tenant}:{workspace}:{project}:{runId}
      const pattern = `${this.config.keyPrefix}:workflow:runs:*`;
      const keys: string[] = [];
      let cursor = "0";

      do {
        const result = await this.redis.scan(cursor, "MATCH", pattern, "COUNT", 100);
        cursor = result[0];
        keys.push(...result[1]);
      } while (cursor !== "0");

      const workflows: WorkflowSummary[] = [];

      // Sort keys by the embedded timestamp in runId (run_{timestamp}_...)
      const sortedKeys = keys.sort((a, b) => {
        const tsA = a.match(/run_(\d+)_/)?.[1] ?? "0";
        const tsB = b.match(/run_(\d+)_/)?.[1] ?? "0";
        return parseInt(tsB) - parseInt(tsA);
      }).slice(0, 20);

      for (const key of sortedKeys) {
        const stateData = await this.redis.get(key);

        if (stateData) {
          try {
            const state = JSON.parse(stateData);
            const startedAt = new Date(state.createdAt ?? Date.now());
            const completedAtDate: Date | undefined = state.updatedAt && state.status === "completed" ? new Date(state.updatedAt) : undefined;
            const durationMs = completedAtDate
              ? completedAtDate.getTime() - startedAt.getTime()
              : Date.now() - startedAt.getTime();

            // Count agents from hopCount or estimate from agent index
            let agentCount = state.hopCount ?? 0;
            if (agentCount === 0) {
              // Fallback: count unique agents that have this runId in their index
              agentCount = await this.countAgentsForRun(state.runId);
            }

            // Infer team from agentType
            const teamId = this.inferTeamFromAgent(state.agentType);

            workflows.push({
              runId: state.runId ?? key.split(":").pop() ?? "unknown",
              teamId,
              status: state.status ?? "unknown",
              startedAt: startedAt.toISOString(),
              completedAt: completedAtDate?.toISOString(),
              durationMs,
              agentCount,
            });
          } catch {
            // Invalid state data, skip
          }
        }
      }

      return workflows;
    } catch (error) {
      console.error("[Dashboard] Error fetching workflows:", error);
      return [];
    }
  }

  /** Fetch agent statistics from Redis workflow index */
  private async fetchAgentStats(): Promise<AgentStats[]> {
    if (!this.redis) return [];

    try {
      // Get agent index keys: tenclaw:workflow:index:agent:{tenant}:{workspace}:{project}:{agentId}
      const pattern = `${this.config.keyPrefix}:workflow:index:agent:*`;
      const keys: string[] = [];
      let cursor = "0";

      do {
        const result = await this.redis.scan(cursor, "MATCH", pattern, "COUNT", 100);
        cursor = result[0];
        keys.push(...result[1]);
      } while (cursor !== "0");

      const stats: AgentStats[] = [];

      // Define valid agents that are part of teams
      const validAgents = [
        // Dev team
        "planner", "coder", "reviewer", "tester", "security-auditor",
        // Business team
        "researcher", "writer", "editor"
      ];

      for (const key of keys) {
        // Extract agentId from key: ...:agent:{tenant}:{workspace}:{project}:{agentId}
        const parts = key.split(":");
        const agentId = parts[parts.length - 1];
        
        if (!agentId || agentId === "default") continue;
        
        // Filter: only show agents that are part of defined teams
        if (!validAgents.includes(agentId)) continue;

        // Get run count from sorted set
        const runCount = await this.redis.zcard(key);
        
        if (runCount > 0) {
          // Get run IDs from sorted set
          const runIds = await this.redis.zrange(key, 0, -1);
          
          let successful = 0;
          let failed = 0;
          
          // Check status of each run
          for (const runId of runIds) {
            // Build workflow key: tenclaw:workflow:runs:{tenant}:{workspace}:{project}:{runId}
            const workflowKey = key.replace("workflow:index:agent:", "workflow:runs:").replace(`:${agentId}`, `:${runId}`);
            const stateData = await this.redis.get(workflowKey);
            
            if (stateData) {
              try {
                const state = JSON.parse(stateData);
                if (state.status === "completed" || state.status === "succeeded") {
                  successful++;
                } else if (state.status === "failed" || state.status === "error") {
                  failed++;
                }
              } catch {
                // Invalid data, skip
              }
            }
          }

          // Infer role from agentId
          const roleMatch = agentId.match(/^(planner|coder|reviewer|tester|security-auditor|researcher|writer|editor)/);
          const role = roleMatch && roleMatch[1] ? roleMatch[1] : "custom";

          stats.push({
            agentId: agentId as string,
            role,
            totalRuns: runCount,
            successfulRuns: successful,
            failedRuns: failed,
            successRate: runCount > 0 ? successful / runCount : 0,
            averageLatencyMs: 0, // Not available in this data structure
          });
        }
      }

      return stats.sort((a, b) => b.totalRuns - a.totalRuns);
    } catch (error) {
      console.error("[Dashboard] Error fetching agent stats:", error);
      return [];
    }
  }

  /** Fetch learned skills */
  private async fetchLearnedSkills(): Promise<LearnedSkillInfo[]> {
    try {
      // Try to get from skills/approved/ directory via skillRegistry
      const scope = { tenantId: "default", workspaceId: "default" };
      const skills = await this.config.skillRegistry.list(scope);

      // Filter for learned skills (those with learned metadata)
      return skills
        .filter((s) => s.metadata?.learned || s.id.startsWith("learned-"))
        .map((s) => ({
          id: s.id,
          name: s.name,
          role: s.role,
          version: s.version,
          confidenceScore: (s.metadata?.confidenceScore as number) ?? 0,
          extractedAt: (s.metadata?.extractedAt as string) ?? new Date().toISOString(),
          approved: (s.metadata?.approved as boolean) ?? false,
        }))
        .slice(0, 50);
    } catch (error) {
      console.error("[Dashboard] Error fetching learned skills:", error);
      return [];
    }
  }

  /** Fetch recent audit events - uses correct tenant/workspace scope */
  private async fetchRecentAuditEvents(): Promise<AuditEventSummary[]> {
    try {
      // Use the actual tenant/workspace from Redis data
      const scope = { tenantId: "demo-tenant", workspaceId: "demo-workspace" };
      const events = await this.config.auditLogger.query(scope, {
        count: 20,
      });

      return events.map((e) => ({
        id: e.id,
        occurredAt: e.occurredAt,
        actorType: e.actorType,
        actorId: e.actorId,
        eventType: e.eventType,
        severity: e.severity,
        runId: e.runId ?? undefined,
      }));
    } catch (error: any) {
      console.error("[Dashboard] Error fetching audit events:", error);
      return [];
    }
  }

  // API handlers

  private async handleAPIState(res: http.ServerResponse): Promise<void> {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(this.state));
  }

  private async handleAPIActiveRuns(res: http.ServerResponse): Promise<void> {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ runs: this.state.activeRuns }));
  }

  private async handleAPIWorkflows(res: http.ServerResponse): Promise<void> {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ workflows: this.state.recentWorkflows }));
  }

  private async handleAPIAgentStats(res: http.ServerResponse): Promise<void> {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ agents: this.state.agentStats }));
  }

  private async handleAPISkills(res: http.ServerResponse): Promise<void> {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ skills: this.state.learnedSkills }));
  }

  private async handleAPIAuditLog(res: http.ServerResponse): Promise<void> {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ events: this.state.recentAuditEvents }));
  }

  /** Cleanup stale runs - mark runs older than 1 hour as timed-out */
  private async handleCleanupStaleRuns(res: http.ServerResponse): Promise<void> {
    if (!this.redis) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Redis not available" }));
      return;
    }

    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    let cleaned = 0;
    let errors = 0;

    try {
      // Scan for all workflow run keys
      const pattern = `${this.config.keyPrefix}:workflow:runs:*`;
      const keys: string[] = [];
      let cursor = "0";

      do {
        const result = await this.redis.scan(cursor, "MATCH", pattern, "COUNT", 100);
        cursor = result[0];
        keys.push(...result[1]);
      } while (cursor !== "0");

      for (const key of keys) {
        try {
          const stateData = await this.redis.get(key);
          if (!stateData) continue;

          const state = JSON.parse(stateData);
          
          // Check if run is stuck in running/queued status and older than 1 hour
          const isStuck = state.status === "running" || state.status === "queued" || state.status === "awaiting-approval";
          const startedAt = new Date(state.startedAt ?? state.createdAt ?? Date.now()).getTime();
          
          if (isStuck && startedAt < oneHourAgo) {
            // Mark as timed-out
            state.status = "timed-out";
            state.completedAt = new Date().toISOString();
            state.error = "Run timed out after 1 hour";
            
            await this.redis.set(key, JSON.stringify(state));
            cleaned++;
            console.log(`[Dashboard] Marked stale run as timed-out: ${state.runId}`);
          }
        } catch (err) {
          errors++;
          console.error(`[Dashboard] Error cleaning up run at key ${key}:`, err);
        }
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ 
        success: true, 
        cleaned,
        errors,
        message: `Cleaned up ${cleaned} stale runs${errors > 0 ? `, ${errors} errors` : ""}` 
      }));
    } catch (error) {
      console.error("[Dashboard] Error in cleanup:", error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Cleanup failed", details: String(error) }));
    }
  }

  /** Serve the static HTML dashboard UI */
  private async handleStaticHTML(res: http.ServerResponse): Promise<void> {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>TenClaw Dashboard</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0f172a;
      color: #e2e8f0;
      min-height: 100vh;
    }
    .header {
      background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%);
      padding: 1.5rem 2rem;
      border-bottom: 1px solid #334155;
    }
    .header h1 {
      font-size: 1.75rem;
      font-weight: 600;
      color: #f8fafc;
    }
    .header .subtitle {
      color: #94a3b8;
      font-size: 0.875rem;
      margin-top: 0.25rem;
    }
    .status {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      font-size: 0.875rem;
      color: #94a3b8;
    }
    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #22c55e;
      animation: pulse 2s infinite;
    }
    .status-dot.disconnected {
      background: #ef4444;
      animation: none;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }
    .container {
      max-width: 1400px;
      margin: 0 auto;
      padding: 2rem;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      gap: 1.5rem;
    }
    .card {
      background: #1e293b;
      border-radius: 0.75rem;
      border: 1px solid #334155;
      overflow: hidden;
    }
    .card-header {
      padding: 1rem 1.25rem;
      border-bottom: 1px solid #334155;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .card-title {
      font-size: 1rem;
      font-weight: 600;
      color: #f1f5f9;
    }
    .card-badge {
      background: #3b82f6;
      color: white;
      font-size: 0.75rem;
      font-weight: 500;
      padding: 0.25rem 0.5rem;
      border-radius: 9999px;
    }
    .card-body {
      padding: 1rem 1.25rem;
      max-height: 400px;
      overflow-y: auto;
    }
    .empty-state {
      text-align: center;
      padding: 2rem;
      color: #64748b;
      font-size: 0.875rem;
    }
    .list-item {
      padding: 0.75rem;
      background: #0f172a;
      border-radius: 0.5rem;
      margin-bottom: 0.5rem;
      border: 1px solid #334155;
    }
    .list-item:last-child {
      margin-bottom: 0;
    }
    .item-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 0.25rem;
    }
    .item-title {
      font-weight: 500;
      color: #f1f5f9;
      font-size: 0.875rem;
    }
    .item-meta {
      font-size: 0.75rem;
      color: #94a3b8;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      font-size: 0.75rem;
      font-weight: 500;
      padding: 0.125rem 0.375rem;
      border-radius: 0.25rem;
    }
    .badge-running { background: #3b82f6; color: white; }
    .badge-completed { background: #22c55e; color: white; }
    .badge-failed { background: #ef4444; color: white; }
    .badge-pending { background: #f59e0b; color: white; }
    .badge-info { background: #64748b; color: white; }
    .badge-warn { background: #f59e0b; color: white; }
    .badge-error { background: #ef4444; color: white; }
    .badge-critical { background: #7f1d1d; color: white; }
    .stats-row {
      display: flex;
      gap: 1rem;
      margin-top: 0.5rem;
    }
    .stat {
      text-align: center;
    }
    .stat-value {
      font-size: 1.25rem;
      font-weight: 600;
      color: #f8fafc;
    }
    .stat-label {
      font-size: 0.625rem;
      color: #64748b;
      text-transform: uppercase;
    }
    .progress-bar {
      height: 4px;
      background: #334155;
      border-radius: 2px;
      margin-top: 0.5rem;
      overflow: hidden;
    }
    .progress-fill {
      height: 100%;
      background: #22c55e;
      transition: width 0.3s ease;
    }
    .progress-fill.warning {
      background: #f59e0b;
    }
    .progress-fill.danger {
      background: #ef4444;
    }
    .agent-card {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      padding: 0.75rem;
      background: #0f172a;
      border-radius: 0.5rem;
      margin-bottom: 0.5rem;
    }
    .agent-avatar {
      width: 2rem;
      height: 2rem;
      border-radius: 50%;
      background: linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 0.75rem;
      font-weight: 600;
      color: white;
    }
    .agent-info {
      flex: 1;
    }
    .agent-name {
      font-weight: 500;
      color: #f1f5f9;
      font-size: 0.875rem;
    }
    .agent-role {
      font-size: 0.75rem;
      color: #94a3b8;
    }
    .agent-success {
      text-align: right;
    }
    .agent-success-value {
      font-size: 1rem;
      font-weight: 600;
    }
    .agent-success-value.high { color: #22c55e; }
    .agent-success-value.medium { color: #f59e0b; }
    .agent-success-value.low { color: #ef4444; }
    .timestamp {
      font-size: 0.75rem;
      color: #64748b;
      font-variant-numeric: tabular-nums;
    }
    .skill-tag {
      display: inline-flex;
      align-items: center;
      gap: 0.25rem;
      font-size: 0.75rem;
      background: #0f172a;
      padding: 0.25rem 0.5rem;
      border-radius: 0.25rem;
      border: 1px solid #334155;
    }
    .skill-approved {
      color: #22c55e;
    }
    .skill-pending {
      color: #f59e0b;
    }
    ::-webkit-scrollbar {
      width: 6px;
    }
    ::-webkit-scrollbar-track {
      background: #0f172a;
    }
    ::-webkit-scrollbar-thumb {
      background: #475569;
      border-radius: 3px;
    }
  </style>
</head>
<body>
  <header class="header">
    <div style="display: flex; justify-content: space-between; align-items: center;">
      <div>
        <h1>TenClaw Dashboard</h1>
        <div class="subtitle">Multi-Agent Framework Monitor v1.5.0</div>
      </div>
      <div class="status">
        <span class="status-dot" id="status-dot"></span>
        <span id="status-text">Connecting...</span>
        <span style="margin-left: 1rem;" id="last-updated">—</span>
      </div>
    </div>
  </header>

  <main class="container">
    <div class="grid">
      <!-- Active Runs -->
      <div class="card">
        <div class="card-header">
          <span class="card-title">Active Runs</span>
          <span class="card-badge" id="active-count">0</span>
        </div>
        <div class="card-body" id="active-runs">
          <div class="empty-state">No active runs</div>
        </div>
      </div>

      <!-- Recent Workflows -->
      <div class="card">
        <div class="card-header">
          <span class="card-title">Recent Workflows</span>
          <span class="card-badge" id="workflow-count">0</span>
        </div>
        <div class="card-body" id="workflows">
          <div class="empty-state">No recent workflows</div>
        </div>
      </div>

      <!-- Agent Success Rates -->
      <div class="card">
        <div class="card-header">
          <span class="card-title">Success Rate by Agent</span>
          <span class="card-badge" id="agent-count">0</span>
        </div>
        <div class="card-body" id="agent-stats">
          <div class="empty-state">No agent data</div>
        </div>
      </div>

      <!-- Learned Skills -->
      <div class="card">
        <div class="card-header">
          <span class="card-title">Learned Skills</span>
          <span class="card-badge" id="skill-count">0</span>
        </div>
        <div class="card-body" id="skills">
          <div class="empty-state">No learned skills</div>
        </div>
      </div>

      <!-- Audit Log -->
      <div class="card" style="grid-column: span 2;">
        <div class="card-header">
          <span class="card-title">Recent Audit Log</span>
          <span class="card-badge" id="audit-count">0</span>
        </div>
        <div class="card-body" id="audit-log">
          <div class="empty-state">No audit events</div>
        </div>
      </div>
    </div>
  </main>

  <script>
    const statusDot = document.getElementById('status-dot');
    const statusText = document.getElementById('status-text');
    const lastUpdated = document.getElementById('last-updated');
    const activeCount = document.getElementById('active-count');
    const workflowCount = document.getElementById('workflow-count');
    const agentCount = document.getElementById('agent-count');
    const skillCount = document.getElementById('skill-count');
    const auditCount = document.getElementById('audit-count');

    function formatDuration(ms) {
      if (ms < 1000) return ms + 'ms';
      if (ms < 60000) return Math.floor(ms / 1000) + 's';
      return Math.floor(ms / 60000) + 'm ' + Math.floor((ms % 60000) / 1000) + 's';
    }

    function formatTime(iso) {
      const d = new Date(iso);
      return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }

    function getStatusBadge(status) {
      const map = {
        'running': 'badge-running',
        'completed': 'badge-completed',
        'failed': 'badge-failed',
        'succeeded': 'badge-completed',
        'queued': 'badge-pending',
        'awaiting-approval': 'badge-pending',
        'cancelled': 'badge-error'
      };
      return map[status] || 'badge-info';
    }

    function getSeverityBadge(sev) {
      const map = {
        'info': 'badge-info',
        'warn': 'badge-warn',
        'error': 'badge-error',
        'critical': 'badge-critical'
      };
      return map[sev] || 'badge-info';
    }

    function updateActiveRuns(runs) {
      activeCount.textContent = runs.length;
      const container = document.getElementById('active-runs');
      if (runs.length === 0) {
        container.innerHTML = '<div class="empty-state">No active runs</div>';
        return;
      }
      container.innerHTML = runs.map(r => \`
        <div class="list-item">
          <div class="item-header">
            <span class="item-title">\${r.runId.slice(0, 12)}</span>
            <span class="badge \${getStatusBadge(r.status)}">\${r.status}</span>
          </div>
          <div class="item-meta">
            Team: \${r.teamId} · Agent: \${r.currentAgentId || '—'}
          </div>
          <div class="item-meta" style="margin-top: 0.25rem;">
            ⏱ \${formatDuration(r.durationMs)} · Started: \${formatTime(r.startedAt)}
          </div>
        </div>
      \`).join('');
    }

    function updateWorkflows(workflows) {
      workflowCount.textContent = workflows.length;
      const container = document.getElementById('workflows');
      if (workflows.length === 0) {
        container.innerHTML = '<div class="empty-state">No recent workflows</div>';
        return;
      }
      container.innerHTML = workflows.map(w => \`
        <div class="list-item">
          <div class="item-header">
            <span class="item-title">\${w.runId.slice(0, 12)}</span>
            <span class="badge \${getStatusBadge(w.status)}">\${w.status}</span>
          </div>
          <div class="item-meta">
            Team: \${w.teamId} · \${w.agentCount} agents
          </div>
          <div class="item-meta" style="margin-top: 0.25rem;">
            ⏱ \${formatDuration(w.durationMs)} · Started: \${formatTime(w.startedAt)}
          </div>
        </div>
      \`).join('');
    }

    function updateAgentStats(agents) {
      agentCount.textContent = agents.length;
      const container = document.getElementById('agent-stats');
      if (agents.length === 0) {
        container.innerHTML = '<div class="empty-state">No agent data</div>';
        return;
      }
      container.innerHTML = agents.map(a => {
        const successClass = a.successRate >= 0.8 ? 'high' : a.successRate >= 0.5 ? 'medium' : 'low';
        const progressClass = a.successRate >= 0.8 ? '' : a.successRate >= 0.5 ? 'warning' : 'danger';
        return \`
        <div class="agent-card">
          <div class="agent-avatar">\${a.agentId.slice(0, 2).toUpperCase()}</div>
          <div class="agent-info">
            <div class="agent-name">\${a.agentId}</div>
            <div class="agent-role">\${a.role} · \${a.totalRuns} runs</div>
          </div>
          <div class="agent-success">
            <div class="agent-success-value \${successClass}">\${(a.successRate * 100).toFixed(0)}%</div>
            <div class="progress-bar">
              <div class="progress-fill \${progressClass}" style="width: \${a.successRate * 100}%"></div>
            </div>
          </div>
        </div>
      \`;}).join('');
    }

    function updateSkills(skills) {
      skillCount.textContent = skills.length;
      const container = document.getElementById('skills');
      if (skills.length === 0) {
        container.innerHTML = '<div class="empty-state">No learned skills</div>';
        return;
      }
      container.innerHTML = skills.map(s => \`
        <div class="list-item">
          <div class="item-header">
            <span class="item-title">\${s.name}</span>
            <span class="skill-tag \${s.approved ? 'skill-approved' : 'skill-pending'}">
              \${s.approved ? '✓ approved' : '⏳ pending'}
            </span>
          </div>
          <div class="item-meta">
            Role: \${s.role} · v\${s.version}
          </div>
          <div class="item-meta" style="margin-top: 0.25rem;">
            Confidence: \${(s.confidenceScore * 100).toFixed(0)}% · \${formatTime(s.extractedAt)}
          </div>
        </div>
      \`).join('');
    }

    function updateAuditLog(events) {
      auditCount.textContent = events.length;
      const container = document.getElementById('audit-log');
      if (events.length === 0) {
        container.innerHTML = '<div class="empty-state">No audit events</div>';
        return;
      }
      container.innerHTML = events.map(e => \`
        <div class="list-item">
          <div class="item-header">
            <span class="item-title">\${e.eventType}</span>
            <span class="badge \${getSeverityBadge(e.severity)}">\${e.severity}</span>
          </div>
          <div class="item-meta">
            \${e.actorType}: \${e.actorId}
          </div>
          <div class="item-meta" style="margin-top: 0.25rem;">
            \${formatTime(e.occurredAt)}
            \${e.runId ? '· Run: ' + e.runId.slice(0, 12) : ''}
          </div>
        </div>
      \`).join('');
    }

    function updateUI(state) {
      lastUpdated.textContent = 'Updated: ' + formatTime(state.lastUpdated);
      updateActiveRuns(state.activeRuns);
      updateWorkflows(state.recentWorkflows);
      updateAgentStats(state.agentStats);
      updateSkills(state.learnedSkills);
      updateAuditLog(state.recentAuditEvents);
    }

    function connect() {
      const evtSource = new EventSource('/events');

      evtSource.addEventListener('connected', (e) => {
        statusDot.classList.remove('disconnected');
        statusText.textContent = 'Connected';
        const data = JSON.parse(e.data);
        updateUI(data.state);
      });

      evtSource.addEventListener('update', (e) => {
        const state = JSON.parse(e.data);
        updateUI(state);
      });

      evtSource.onerror = () => {
        statusDot.classList.add('disconnected');
        statusText.textContent = 'Disconnected';
        evtSource.close();
        setTimeout(connect, 3000);
      };
    }

    connect();
  </script>
</body>
</html>`;

    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(html);
  }
}

// Standalone server entry point
async function main() {
  // Load dependencies using require for CommonJS compatibility
  const { parse } = require("yaml");
  const { FileSystemSkillRegistry } = require("../skills");
  const { RedisAuditLogger } = require("../audit-logger");
  const { RedisMessageBus } = require("../message-bus");

  // Get environment variables
  const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
  const port = parseInt(process.env.DASHBOARD_PORT ?? "3000", 10);
  const keyPrefix = process.env.REDIS_KEY_PREFIX ?? "tenclaw";

  // Initialize Redis client for dependencies
  const redis = new Redis(redisUrl);

  // Initialize dependencies
  const skillRegistry = new FileSystemSkillRegistry({
    rootDirectory: "./skills",
    parseYaml: parse,
    cacheTtlMs: 5000,
  });

  const auditLogger = new RedisAuditLogger({
    client: redis,
    keyPrefix,
    maxStreamLength: 100_000,
  });

  const messageBus = new RedisMessageBus({
    client: redis,
    keyPrefix,
    maxStreamLength: 10_000,
  });

  // Create and start dashboard server
  const server = new DashboardServer({
    port,
    redisUrl,
    pollIntervalMs: 3000,
    keyPrefix,
    auditLogger,
    messageBus,
    skillRegistry,
  });
  process.on("SIGINT", async () => {
    console.log("\n[Dashboard] Shutting down...");
    await server.stop();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    await server.stop();
    process.exit(0);
  });

  await server.start();
}

// Run if executed directly
if (require.main === module) {
  main().catch((err) => {
    console.error("[Dashboard] Failed to start:", err);
    process.exit(1);
  });
}

export default DashboardServer;
