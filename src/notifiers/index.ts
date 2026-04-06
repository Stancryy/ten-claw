// File: src/notifiers/index.ts
/**
 * Notification adapters for external delivery channels.
 */

import type {
  Notifier,
  NotificationChannel,
  NotificationRequest,
  SecretProvider,
  TenantScope,
} from "../types";

/** Shared HTTP client contract for notification adapters. */
export interface HttpClient {
  postJson<TResponse>(url: string, body: unknown, headers?: Record<string, string>): Promise<TResponse>;
}

/** Dependency-injected destination resolver for environment-backed channels. */
export interface DestinationResolver {
  resolve(scope: TenantScope, destinationRef: string): Promise<string>;
}

/** Configuration for the Telegram notifier. */
export interface TelegramNotifierConfig {
  botTokenSecretKey: string;
  apiBaseUrl?: string;
  defaultParseMode?: "Markdown" | "MarkdownV2" | "HTML";
  disableWebPagePreview?: boolean;
}

/** Configuration for a Discord webhook notifier. */
export interface DiscordNotifierConfig {
  webhookUrlSecretKey: string;
  username?: string;
}

/** Configuration for a WhatsApp Cloud API notifier. */
export interface WhatsAppNotifierConfig {
  accessTokenSecretKey: string;
  phoneNumberIdSecretKey: string;
  apiBaseUrl?: string;
}

/** Telegram Bot API success envelope. */
export interface TelegramApiResponse {
  ok: boolean;
  description?: string;
  result?: unknown;
}

/** Discord webhook success envelope. */
export interface DiscordWebhookResponse {
  id?: string;
  type?: number;
}

/** WhatsApp Cloud API success envelope. */
export interface WhatsAppApiResponse {
  messaging_product?: string;
  messages?: Array<{
    id?: string;
  }>;
}

/** Simple fetch-based HTTP client for notifier adapters. */
export class FetchHttpClient implements HttpClient {
  /** Sends a JSON POST request and parses the JSON response. */
  async postJson<TResponse>(
    url: string,
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<TResponse> {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} while sending notification to ${url}.`);
    }

    return (await response.json()) as TResponse;
  }
}

/** Resolver that treats the provided destination reference as the final destination. */
export class PassthroughDestinationResolver implements DestinationResolver {
  /** Returns the destination reference unchanged. */
  async resolve(_: TenantScope, destinationRef: string): Promise<string> {
    return destinationRef;
  }
}

/** Telegram notifier implementation backed by the Telegram Bot API. */
export class TelegramNotifier implements Notifier {
  /** Fixed channel identifier for this notifier implementation. */
  readonly channel: NotificationChannel = "telegram";

  /** Creates a notifier with injected secret access and HTTP transport. */
  constructor(
    private readonly secrets: SecretProvider,
    private readonly httpClient: HttpClient = new FetchHttpClient(),
    private readonly destinationResolver: DestinationResolver = new PassthroughDestinationResolver(),
    private readonly config: TelegramNotifierConfig,
  ) {}

  /** Sends a formatted workflow notification to Telegram. */
  async send(request: NotificationRequest): Promise<void> {
    const botToken = await this.secrets.getSecret(request.scope, this.config.botTokenSecretKey);
    const chatId = await this.destinationResolver.resolve(request.scope, request.destination);
    const endpoint = `${this.config.apiBaseUrl ?? "https://api.telegram.org"}/bot${botToken}/sendMessage`;
    const response = await this.httpClient.postJson<TelegramApiResponse>(endpoint, {
      chat_id: chatId,
      text: formatTelegramMessage(request),
      parse_mode: this.resolveParseMode(request),
      disable_web_page_preview: this.config.disableWebPagePreview ?? true,
    });

    // REQUIRES: valid Telegram bot credentials and a reachable Telegram Bot API endpoint.
    if (!response.ok) {
      throw new Error(response.description ?? "Telegram notification delivery failed.");
    }
  }

  private resolveParseMode(
    request: NotificationRequest,
  ): TelegramNotifierConfig["defaultParseMode"] | undefined {
    const parseMode = request.metadata?.parseMode;
    if (parseMode === "Markdown" || parseMode === "MarkdownV2" || parseMode === "HTML") {
      return parseMode;
    }
    return this.config.defaultParseMode;
  }
}

/** Discord notifier implementation backed by incoming webhooks. */
export class DiscordNotifier implements Notifier {
  /** Fixed channel identifier for this notifier implementation. */
  readonly channel: NotificationChannel = "discord";

  /** Creates a notifier with injected secret access and HTTP transport. */
  constructor(
    private readonly secrets: SecretProvider,
    private readonly httpClient: HttpClient = new FetchHttpClient(),
    private readonly config: DiscordNotifierConfig,
  ) {}

  /** Sends a formatted workflow notification to Discord via webhook. */
  async send(request: NotificationRequest): Promise<void> {
    const webhookUrl = await this.secrets.getSecret(request.scope, this.config.webhookUrlSecretKey);
    await this.httpClient.postJson<DiscordWebhookResponse>(webhookUrl, {
      content: formatDiscordMessage(request),
      username: this.config.username,
    });

    // REQUIRES: a valid Discord webhook URL in the configured secret backend.
  }
}

/** WhatsApp notifier implementation backed by Meta's Cloud API. */
export class WhatsAppNotifier implements Notifier {
  /** Fixed channel identifier for this notifier implementation. */
  readonly channel: NotificationChannel = "whatsapp";

  /** Creates a notifier with injected secret access, destination resolution, and HTTP transport. */
  constructor(
    private readonly secrets: SecretProvider,
    private readonly httpClient: HttpClient = new FetchHttpClient(),
    private readonly destinationResolver: DestinationResolver = new PassthroughDestinationResolver(),
    private readonly config: WhatsAppNotifierConfig,
  ) {}

  /** Sends a formatted workflow notification to WhatsApp via the Cloud API. */
  async send(request: NotificationRequest): Promise<void> {
    const accessToken = await this.secrets.getSecret(request.scope, this.config.accessTokenSecretKey);
    const phoneNumberId = await this.secrets.getSecret(
      request.scope,
      this.config.phoneNumberIdSecretKey,
    );
    const recipient = await this.destinationResolver.resolve(request.scope, request.destination);
    const endpoint =
      `${this.config.apiBaseUrl ?? "https://graph.facebook.com/v22.0"}/${phoneNumberId}/messages`;
    await this.httpClient.postJson<WhatsAppApiResponse>(
      endpoint,
      {
        messaging_product: "whatsapp",
        to: recipient,
        type: "text",
        text: {
          preview_url: false,
          body: formatWhatsAppMessage(request),
        },
      },
      {
        Authorization: `Bearer ${accessToken}`,
      },
    );

    // REQUIRES: a WhatsApp Cloud API access token, phone number id, and approved recipient routing.
  }
}

/** Registry for channel-keyed notifier lookup. */
export class NotifierRegistry {
  private readonly registry = new Map<NotificationChannel, Notifier>();

  /** Registers a notifier by its declared channel. */
  register(notifier: Notifier): void {
    this.registry.set(notifier.channel, notifier);
  }

  /** Resolves a notifier for the requested channel. */
  get(channel: NotificationChannel): Notifier | undefined {
    return this.registry.get(channel);
  }

  /** Exposes the registry contents as the orchestrator dependency shape. */
  toRecord(): Partial<Record<NotificationChannel, Notifier>> {
    return Object.fromEntries(this.registry.entries()) as Partial<
      Record<NotificationChannel, Notifier>
    >;
  }
}

/** Formats a notification into a Telegram-friendly text payload. */
export function formatTelegramMessage(request: NotificationRequest): string {
  const lines = [
    request.title,
    "",
    request.body,
  ];

  if (request.runId) {
    lines.push("", `Run ID: ${request.runId}`);
  }

  return lines.join("\n");
}

/** Formats a notification into a Discord-friendly webhook message. */
export function formatDiscordMessage(request: NotificationRequest): string {
  const lines = [
    `**${escapeDiscordMarkdown(request.title)}**`,
    request.body,
  ];

  if (request.runId) {
    lines.push(`Run ID: \`${request.runId}\``);
  }

  return lines.join("\n\n");
}

/** Formats a notification into a WhatsApp-friendly text payload. */
export function formatWhatsAppMessage(request: NotificationRequest): string {
  const lines = [
    request.title,
    "",
    request.body,
  ];

  if (request.runId) {
    lines.push("", `Run ID: ${request.runId}`);
  }

  return lines.join("\n");
}

function escapeDiscordMarkdown(text: string): string {
  return text.replace(/[*_`~|]/g, "\\$&");
}

// TODO:
// - Add retry and backoff hooks for transient network delivery failures.
// - Add structured templating for channel-specific message formatting.
// - REQUIRES: concrete secret provisioning for Telegram, Discord, and WhatsApp channel credentials in your deployment environment.
