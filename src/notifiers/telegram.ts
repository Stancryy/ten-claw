// File: src/notifiers/telegram.ts
/**
 * Telegram Bot API notifier implementation.
 *
 * Sends formatted workflow notifications to Telegram chats using the Bot API.
 */

import https from "https";
import type { Notifier, NotificationRequest } from "../types";

/** Configuration for TelegramNotifier */
export interface TelegramNotifierConfig {
  /** Telegram bot token (from BotFather) */
  botToken: string;
  /** Default chat ID to send messages to */
  defaultChatId: string;
  /** Parse mode for message formatting (default: MarkdownV2) */
  parseMode?: "Markdown" | "MarkdownV2" | "HTML";
  /** Disable link previews for messages (default: true) */
  disableWebPagePreview?: boolean;
}

/** Telegram Bot API success envelope */
export interface TelegramApiResponse {
  ok: boolean;
  description?: string;
  result?: unknown;
}

/** Telegram notifier implementation backed by the Telegram Bot API. */
export class TelegramNotifier implements Notifier {
  readonly channel: "telegram" = "telegram";

  private readonly botToken: string;
  private readonly defaultChatId: string;
  private readonly parseMode: "Markdown" | "MarkdownV2" | "HTML";
  private readonly disableWebPagePreview: boolean;

  constructor(config: TelegramNotifierConfig) {
    this.botToken = config.botToken;
    this.defaultChatId = config.defaultChatId;
    this.parseMode = config.parseMode ?? "MarkdownV2";
    this.disableWebPagePreview = config.disableWebPagePreview ?? true;
  }

  /**
   * Sends a formatted workflow notification to Telegram.
   *
   * Uses MarkdownV2 formatting:
   * - Bold title with *text*
   * - Body text
   * - Optional runId footer
   *
   * On HTTP error (non-2xx): logs status + response body, then throws
   * On network failure: rethrows with context (url, chatId)
   */
  async send(request: NotificationRequest): Promise<void> {
    const chatId = request.destination ?? this.defaultChatId;
    const message = this.formatMessage(request);

    const payload = JSON.stringify({
      chat_id: chatId,
      text: message,
      parse_mode: this.parseMode,
      disable_web_page_preview: this.disableWebPagePreview,
    });

    const options: https.RequestOptions = {
      hostname: "api.telegram.org",
      port: 443,
      path: `/bot${this.botToken}/sendMessage`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
    };

    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        let data = "";

        res.on("data", (chunk) => {
          data += chunk;
        });

        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const result = JSON.parse(data) as TelegramApiResponse;
              if (!result.ok) {
                console.error(
                  `[TelegramNotifier] Telegram API error: ${result.description || "Unknown error"}`
                );
                reject(
                  new Error(
                    `Telegram notification failed: ${result.description || "Unknown error"}`
                  )
                );
              } else {
                resolve();
              }
            } catch (parseError) {
              console.error(`[TelegramNotifier] Failed to parse response: ${data}`);
              reject(new Error(`Failed to parse Telegram API response: ${data}`));
            }
          } else {
            console.error(
              `[TelegramNotifier] HTTP ${res.statusCode} error: ${data}`
            );
            reject(
              new Error(
                `Telegram notification failed: HTTP ${res.statusCode} - ${data || "No response body"}`
              )
            );
          }
        });
      });

      req.on("error", (error) => {
        console.error(
          `[TelegramNotifier] Network error sending to Telegram (chatId: ${chatId}): ${error.message}`
        );
        reject(
          new Error(
            `Network error sending to Telegram (chatId: ${chatId}): ${error.message}`
          )
        );
      });

      req.write(payload);
      req.end();
    });
  }

  /**
   * Escapes special characters for Telegram MarkdownV2 parse mode.
   * Characters that must be escaped: . - ( ) ! # + = | { } [ ] ~
   */
  private escapeMarkdownV2(text: string): string {
    if (this.parseMode !== "MarkdownV2") {
      return text;
    }
    // Escape each special character individually
    // Order matters - escape backslash first, then others
    const escaped = text
      .replace(/\\/g, "\\\\")  // Escape backslashes first
      .replace(/_/g, "\\_")
      .replace(/\*/g, "\\*")
      .replace(/\[/g, "\\[")
      .replace(/\]/g, "\\]")
      .replace(/\(/g, "\\(")
      .replace(/\)/g, "\\)")
      .replace(/~/g, "\\~")
      .replace(/`/g, "\\`")
      .replace(/>/g, "\\>")
      .replace(/#/g, "\\#")
      .replace(/\+/g, "\\+")
      .replace(/-/g, "\\-")   // Hyphen
      .replace(/=/g, "\\=")
      .replace(/\|/g, "\\|")
      .replace(/\{/g, "\\{")
      .replace(/\}/g, "\\}")
      .replace(/\./g, "\\.")
      .replace(/!/g, "\\!");
    return escaped;
  }

  /**
   * Formats a notification into a Telegram-friendly HTML text payload.
   */
  private formatMessage(request: NotificationRequest): string {
    const lines: string[] = [];

    // Bold title using HTML
    lines.push(`<b>${this.escapeHtml(request.title)}</b>`);
    lines.push("");

    // Body text
    lines.push(this.escapeHtml(request.body));

    // Optional runId footer
    if (request.runId) {
      lines.push("");
      lines.push(`Run ID: ${this.escapeHtml(request.runId)}`);
    }

    return lines.join("\n");
  }

  /**
   * Escapes HTML special characters.
   */
  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
}
