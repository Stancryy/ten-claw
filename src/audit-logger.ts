// File: src/audit-logger.ts
/**
 * Redis-backed AuditLogger implementation using Redis Streams for durable,
 * immutable audit event storage with querying capabilities.
 */

import type { AuditEvent, AuditLogger, TenantScope } from "./types";

/** Redis client type (ioredis) */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RedisClient = any;

/** Configuration for RedisAuditLogger */
export interface RedisAuditLoggerConfig {
  /** Redis client instance */
  client: RedisClient;
  /** Key prefix for all streams (default: "tenclaw") */
  keyPrefix?: string;
  /** Maximum length of each stream (approximate, for trimming) */
  maxStreamLength?: number;
}

/** Query filter for audit events */
export interface AuditQueryFilter {
  /** Filter by actor/agent ID */
  actorId?: string;
  /** Filter by event type */
  eventType?: string;
  /** Filter by severity level */
  severity?: "info" | "warn" | "error" | "critical";
  /** Start time (ISO 8601) - defaults to beginning of stream */
  startTime?: string;
  /** End time (ISO 8601) - defaults to end of stream */
  endTime?: string;
  /** Maximum number of events to return */
  count?: number;
}

/** Audit event returned from query */
export interface QueriedAuditEvent {
  id: string;
  streamId: string;
  occurredAt: string;
  actorType: "user" | "agent" | "system";
  actorId: string;
  eventType: string;
  severity: "info" | "warn" | "error" | "critical";
  runId?: string | undefined;
  sessionId?: string | undefined;
  payload: Record<string, unknown>;
}

/** Redis-backed audit logger using Redis Streams */
export class RedisAuditLogger implements AuditLogger {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly client: any;
  private readonly keyPrefix: string;
  private readonly maxStreamLength: number;

  constructor(config: RedisAuditLoggerConfig) {
    this.client = config.client;
    this.keyPrefix = config.keyPrefix ?? "tenclaw";
    this.maxStreamLength = config.maxStreamLength ?? 100_000;
  }

  /**
   * Builds the Redis Stream key for a tenant's audit log.
   * Format: {prefix}:{tenantId}:{workspaceId}:audit-log
   */
  private buildStreamKey(scope: TenantScope): string {
    return `${this.keyPrefix}:${scope.tenantId}:${scope.workspaceId}:audit-log`;
  }

  /**
   * Serializes an AuditEvent to a flat object for Redis Streams.
   */
  private serializeEvent(event: AuditEvent): Record<string, string> {
    return {
      id: event.id,
      occurredAt: event.occurredAt,
      actorType: event.actorType,
      actorId: event.actorId,
      eventType: event.eventType,
      severity: event.severity,
      runId: event.runId ?? "",
      sessionId: event.sessionId ?? "",
      payload: JSON.stringify(event.payload),
    };
  }

  /**
   * Records an audit event to the Redis Stream.
   * On failure: logs to stderr and rethrows.
   */
  async record(event: AuditEvent): Promise<void> {
    const streamKey = this.buildStreamKey(event.scope);
    const fields = this.serializeEvent(event);

    try {
      // Build XADD command: XADD key MAXLEN ~ count * field value...
      const args: string[] = [
        streamKey,
        "MAXLEN",
        "~",
        String(this.maxStreamLength),
        "*",
      ];
      for (const [key, value] of Object.entries(fields)) {
        args.push(key, value);
      }

      await this.client.call("XADD", ...args);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(
        `[RedisAuditLogger] FAILED to record audit event to ${streamKey}: ${errorMsg}`
      );
      throw new Error(`RedisAuditLogger.record failed: ${errorMsg}`);
    }
  }

  /**
   * Queries audit events from the Redis Stream.
   * Supports filtering by actorId, eventType, severity, and time range.
   */
  async query(
    scope: TenantScope,
    filter: AuditQueryFilter = {}
  ): Promise<QueriedAuditEvent[]> {
    const streamKey = this.buildStreamKey(scope);

    try {
      // Determine range boundaries
      const startId = filter.startTime
        ? this.timestampToStreamId(filter.startTime)
        : "-";
      const endId = filter.endTime
        ? this.timestampToStreamId(filter.endTime)
        : "+";

      // Execute XRANGE
      const result = await this.client.xrange(
        streamKey,
        startId,
        endId,
        "COUNT",
        filter.count ?? 100
      );

      if (!Array.isArray(result) || result.length === 0) {
        return [];
      }

      // Parse and filter results
      const events: QueriedAuditEvent[] = result.map(
        ([streamId, fields]: [string, string[]]) => {
          const parsed = this.parseFields(fields);
          return {
            id: parsed.id ?? streamId,
            streamId,
            occurredAt: parsed.occurredAt ?? "",
            actorType: (parsed.actorType as "user" | "agent" | "system") ??
              "system",
            actorId: parsed.actorId ?? "",
            eventType: parsed.eventType ?? "",
            severity:
              (parsed.severity as "info" | "warn" | "error" | "critical") ??
              "info",
            runId: parsed.runId || undefined,
            sessionId: parsed.sessionId || undefined,
            payload: parsed.payload ? JSON.parse(parsed.payload) : {},
          };
        }
      );

      // Apply in-memory filtering for fields not in stream ID
      return events.filter((event) => {
        if (filter.actorId && event.actorId !== filter.actorId) {
          return false;
        }
        if (filter.eventType && event.eventType !== filter.eventType) {
          return false;
        }
        if (filter.severity && event.severity !== filter.severity) {
          return false;
        }
        return true;
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(
        `[RedisAuditLogger] FAILED to query audit events from ${streamKey}: ${errorMsg}`
      );
      throw new Error(`RedisAuditLogger.query failed: ${errorMsg}`);
    }
  }

  /**
   * Gets the count of audit events in the stream.
   */
  async count(scope: TenantScope): Promise<number> {
    const streamKey = this.buildStreamKey(scope);

    try {
      const result = await this.client.xlen(streamKey);
      return typeof result === "number" ? result : 0;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(
        `[RedisAuditLogger] FAILED to get event count from ${streamKey}: ${errorMsg}`
      );
      throw new Error(`RedisAuditLogger.count failed: ${errorMsg}`);
    }
  }

  /**
   * Trims the audit stream to a maximum length.
   * Useful for compliance retention policies.
   */
  async trim(scope: TenantScope, maxLength: number): Promise<number> {
    const streamKey = this.buildStreamKey(scope);

    try {
      // XTRIM key MAXLEN ~ count
      const result = await this.client.call(
        "XTRIM",
        streamKey,
        "MAXLEN",
        "~",
        String(maxLength)
      );
      return typeof result === "number" ? result : 0;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(
        `[RedisAuditLogger] FAILED to trim stream ${streamKey}: ${errorMsg}`
      );
      throw new Error(`RedisAuditLogger.trim failed: ${errorMsg}`);
    }
  }

  /**
   * Converts an ISO 8601 timestamp to a Redis Stream ID (milliseconds-0).
   */
  private timestampToStreamId(timestamp: string): string {
    const ms = new Date(timestamp).getTime();
    if (isNaN(ms)) {
      return "-";
    }
    return `${ms}-0`;
  }

  /**
   * Parses Redis stream fields (alternating key-value array) into an object.
   */
  private parseFields(fields: string[]): Record<string, string> {
    const result: Record<string, string> = {};

    for (let i = 0; i < fields.length; i += 2) {
      const key = fields[i];
      const value = fields[i + 1];
      if (key !== undefined) {
        result[key] = value ?? "";
      }
    }

    return result;
  }
}
