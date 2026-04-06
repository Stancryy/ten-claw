// File: src/message-bus.ts
/**
 * Redis-backed MessageBus implementation using Redis Streams for durable
 * message transport with consumer group support.
 */

/** Redis client type (ioredis) */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RedisClient = any;
import type { AgentMessage, MessageBus, TenantScope } from "./types";

/** Configuration for RedisMessageBus */
export interface RedisMessageBusConfig {
  /** Redis client instance */
  client: RedisClient;
  /** Key prefix for all streams (default: "tenclaw") */
  keyPrefix?: string;
  /** Maximum length of each stream (approximate, for trimming) */
  maxStreamLength?: number;
}

/** Consumer group configuration for reading messages */
export interface ConsumerGroupConfig {
  /** Consumer group name */
  groupName: string;
  /** Consumer name (unique within group) */
  consumerName: string;
  /** Stream key to read from */
  streamKey: string;
  /** Whether to create the group if it doesn't exist */
  createGroupIfNotExists?: boolean;
  /** Read position: "$" for new messages only, "0" for all */
  startId?: string;
}

/** Redis Streams message entry returned from XREADGROUP */
export interface StreamMessage {
  id: string;
  fields: Record<string, string>;
}

/** Redis-backed message bus using Redis Streams */
export class RedisMessageBus implements MessageBus {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly client: any;
  private readonly keyPrefix: string;
  private readonly maxStreamLength: number;

  constructor(config: RedisMessageBusConfig) {
    this.client = config.client;
    this.keyPrefix = config.keyPrefix ?? "tenclaw";
    this.maxStreamLength = config.maxStreamLength ?? 10_000;
  }

  /**
   * Builds the Redis Stream key for a tenant scope.
   * Format: {prefix}:{tenantId}:{workspaceId}:agent-messages
   */
  private buildStreamKey(scope: TenantScope): string {
    return `${this.keyPrefix}:${scope.tenantId}:${scope.workspaceId}:agent-messages`;
  }

  /**
   * Serializes an AgentMessage to a flat object for Redis Streams.
   * Redis Streams only support string key-value pairs.
   */
  private serializeMessage(message: AgentMessage): Record<string, string> {
    return {
      id: message.id,
      kind: message.kind,
      runId: message.runId,
      sessionId: message.sessionId,
      senderAgentId: message.senderAgentId ?? "",
      recipientAgentId: message.recipientAgentId ?? "",
      correlationId: message.correlationId ?? "",
      createdAt: message.createdAt,
      payload: JSON.stringify(message.payload),
    };
  }

  /**
   * Publishes a single message to the Redis Stream.
   * Uses XADD with approximate stream trimming.
   */
  async publish(message: AgentMessage): Promise<void> {
    const streamKey = this.buildStreamKey(message.scope);
    const fields = this.serializeMessage(message);

    try {
      // Build XADD command: XADD key MAXLEN ~ count * field value [field value ...]
      // Note: MAXLEN must come BEFORE the ID (*), not after fields
      const args: string[] = [streamKey, "MAXLEN", "~", String(this.maxStreamLength), "*"];
      for (const [key, value] of Object.entries(fields)) {
        args.push(key, value);
      }
      
      // Use xadd method directly with proper argument order
      await this.client.xadd(args[0], args[1], args[2], args[3], args[4], ...args.slice(5));
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[RedisMessageBus] Failed to publish message to ${streamKey}: ${errorMsg}`);
      throw new Error(`RedisMessageBus.publish failed: ${errorMsg}`);
    }
  }

  /**
   * Publishes multiple messages in a single pipeline round-trip.
   * Each message is added to its respective tenant stream.
   */
  async publishBatch(messages: AgentMessage[]): Promise<void> {
    if (messages.length === 0) {
      return;
    }

    const pipeline = this.client.pipeline();

    for (const message of messages) {
      const streamKey = this.buildStreamKey(message.scope);
      const fields = this.serializeMessage(message);

      // XADD key MAXLEN ~ count * field value...
      const args: string[] = [streamKey, "MAXLEN", "~", String(this.maxStreamLength), "*"];
      for (const [key, value] of Object.entries(fields)) {
        args.push(key, value);
      }

      pipeline.call("XADD", ...args);
    }

    try {
      await pipeline.exec();
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[RedisMessageBus] Failed to publish batch of ${messages.length} messages: ${errorMsg}`);
      throw new Error(`RedisMessageBus.publishBatch failed: ${errorMsg}`);
    }
  }

  /**
   * Creates a consumer group for a stream if it doesn't exist.
   * Consumer groups enable multiple workers to read without duplicates.
   */
  async createConsumerGroup(
    scope: TenantScope,
    groupName: string,
    startId: string = "0"
  ): Promise<void> {
    const streamKey = this.buildStreamKey(scope);

    try {
      // XGROUP CREATE with MKSTREAM to create stream if it doesn't exist
      await this.client.xgroup("CREATE", streamKey, groupName, startId, "MKSTREAM");
    } catch (error) {
      // Ignore BUSYGROUP error (group already exists)
      const errorMsg = error instanceof Error ? error.message : String(error);
      if (errorMsg.includes("BUSYGROUP")) {
        console.log(`[RedisMessageBus] Consumer group ${groupName} already exists on ${streamKey}`);
        return;
      }
      console.error(`[RedisMessageBus] Failed to create consumer group ${groupName}: ${errorMsg}`);
      throw new Error(`RedisMessageBus.createConsumerGroup failed: ${errorMsg}`);
    }
  }

  /**
   * Reads messages from a consumer group.
   * Returns messages that can be acknowledged with XACK after processing.
   */
  async readFromConsumerGroup(
    config: ConsumerGroupConfig,
    count: number = 10,
    blockMs: number = 5000
  ): Promise<StreamMessage[]> {
    const { groupName, consumerName, streamKey } = config;

    try {
      // Create group if requested and doesn't exist
      if (config.createGroupIfNotExists) {
        try {
          await this.client.xgroup("CREATE", streamKey, groupName, config.startId ?? "0", "MKSTREAM");
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          if (!errorMsg.includes("BUSYGROUP")) {
            throw error;
          }
        }
      }

      // XREADGROUP with blocking
      const result = await this.client.xreadgroup(
        "GROUP",
        groupName,
        consumerName,
        "COUNT",
        count,
        "BLOCK",
        blockMs,
        "STREAMS",
        streamKey,
        ">" // Read new messages not yet delivered to this consumer
      );

      if (!result || result.length === 0) {
        return [];
      }

      // Parse result: [[streamKey, [[id, fields], [id, fields], ...]]]
      const [, messages] = result[0] as [string, Array<[string, string[]] | [string, [string, string][]]>];

      return messages.map(([id, fields]) => {
        // Handle both array formats from ioredis
        if (Array.isArray(fields)) {
          return { id, fields: this.parseFields(fields) };
        }
        return { id, fields: {} };
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[RedisMessageBus] Failed to read from consumer group ${groupName}: ${errorMsg}`);
      throw new Error(`RedisMessageBus.readFromConsumerGroup failed: ${errorMsg}`);
    }
  }

  /**
   * Acknowledges a message as processed, removing it from the consumer group's pending list.
   */
  async acknowledge(
    scope: TenantScope,
    groupName: string,
    messageId: string
  ): Promise<void> {
    const streamKey = this.buildStreamKey(scope);

    try {
      await this.client.xack(streamKey, groupName, messageId);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[RedisMessageBus] Failed to acknowledge message ${messageId}: ${errorMsg}`);
      throw new Error(`RedisMessageBus.acknowledge failed: ${errorMsg}`);
    }
  }

  /**
   * Gets the pending messages (unacknowledged) for a consumer group.
   * Useful for monitoring and dead-letter queue handling.
   */
  async getPendingMessages(
    scope: TenantScope,
    groupName: string,
    count: number = 10
  ): Promise<Array<{ id: string; consumer: string; elapsedMs: number; deliveredCount: number }>> {
    const streamKey = this.buildStreamKey(scope);

    try {
      const result = await this.client.xpending(streamKey, groupName, "-", "+", count);

      if (!Array.isArray(result)) {
        return [];
      }

      return result.map((item) => {
        const [id, consumer, elapsedMs, deliveredCount] = item as [string, string, number, number];
        return { id, consumer, elapsedMs, deliveredCount };
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[RedisMessageBus] Failed to get pending messages: ${errorMsg}`);
      throw new Error(`RedisMessageBus.getPendingMessages failed: ${errorMsg}`);
    }
  }

  /**
   * Claims ownership of a pending message from another consumer.
   * Useful for handling stalled messages.
   */
  async claimMessage(
    scope: TenantScope,
    groupName: string,
    consumerName: string,
    minIdleTimeMs: number,
    messageIds: string[]
  ): Promise<StreamMessage[]> {
    const streamKey = this.buildStreamKey(scope);

    try {
      const result = await this.client.xclaim(
        streamKey,
        groupName,
        consumerName,
        minIdleTimeMs,
        ...messageIds
      );

      if (!Array.isArray(result)) {
        return [];
      }

      return result.map(([id, fields]) => {
        if (Array.isArray(fields)) {
          return { id, fields: this.parseFields(fields) };
        }
        return { id, fields: {} };
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[RedisMessageBus] Failed to claim messages: ${errorMsg}`);
      throw new Error(`RedisMessageBus.claimMessage failed: ${errorMsg}`);
    }
  }

  /**
   * Converts a flat object to an array of [key, value, key, value...] for Redis commands.
   */
  private flattenFields(fields: Record<string, string>): string[] {
    const result: string[] = [];
    for (const [key, value] of Object.entries(fields)) {
      result.push(key, value);
    }
    return result;
  }

  /**
   * Parses Redis stream fields (alternating key-value array) into an object.
   */
  private parseFields(fields: string[] | [string, string][]): Record<string, string> {
    const result: Record<string, string> = {};

    if (fields.length === 0) {
      return result;
    }

    // Handle array of tuples format [[k,v], [k,v]]
    if (Array.isArray(fields[0])) {
      for (const [key, value] of fields as [string, string][]) {
        result[key] = value;
      }
      return result;
    }

    // Handle flat array format [k, v, k, v]
    for (let i = 0; i < fields.length; i += 2) {
      const key = fields[i] as string;
      const value = fields[i + 1] as string | undefined;
      if (key !== undefined) {
        result[key] = value ?? "";
      }
    }

    return result;
  }
}
