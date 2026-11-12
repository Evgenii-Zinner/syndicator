import type { Bindings, PlatformResult, SyndicatePayload } from '../types';

interface TelegramApiResponse {
  readonly ok: boolean;
  readonly error_code?: number;
  readonly description?: string;
  readonly result?: {
    readonly message_id: number;
    readonly chat?: {
      readonly id: number | string;
      readonly title?: string;
      readonly username?: string;
      readonly type?: string;
    };
  };
}

/**
 * Escapes reserved HTML entities for Telegram HTML parse_mode.
 */
function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Formats a Telegram channel message using HTML formatting.
 * Includes bold title, full excerpt, and link with web page preview enabled.
 */
export function formatTelegramMessage(title: string, excerpt?: string, link?: string): string {
  const cleanTitle = escapeHtml(title.trim());
  const cleanExcerpt = excerpt?.trim() ? escapeHtml(excerpt.trim()) : '';
  const cleanLink = link?.trim() || '';

  const parts: string[] = [`<b>${cleanTitle}</b>`];
  if (cleanExcerpt) {
    parts.push(cleanExcerpt);
  }
  if (cleanLink) {
    parts.push(`<a href="${cleanLink}">${cleanLink}</a>`);
  }

  let text = parts.join('\n\n');
  if (text.length > 4096) {
    text = `${text.slice(0, 4090)}...`;
  }
  return text;
}

/**
 * Syndicates an article to a Telegram Channel or Group via the Telegram Bot API (`sendMessage`).
 *
 * @param data - The syndication payload containing canonical URL, short URL, title, and excerpt.
 * @param env - Cloudflare Worker environment bindings including `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`.
 * @returns PlatformResult indicating posted, skipped, or failed.
 */
export async function syndicateToTelegram(
  data: SyndicatePayload,
  env: Bindings
): Promise<PlatformResult> {
  const botToken = env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = env.TELEGRAM_CHAT_ID?.trim();

  if (!botToken || !chatId) {
    return {
      status: 'skipped',
      reason:
        'Telegram credentials not configured (requires TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID).',
    };
  }

  const targetLink = data.shortUrl || data.canonicalUrl;
  const messageText = formatTelegramMessage(data.title, data.excerpt, targetLink);

  const payload = {
    chat_id: chatId,
    text: messageText,
    parse_mode: 'HTML',
    disable_web_page_preview: false,
  };

  const apiUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;

  const res = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errorText = await res.text();
    return {
      status: 'failed',
      error: `Telegram API error (${res.status}): ${errorText}`,
    };
  }

  const result = (await res.json()) as TelegramApiResponse;

  if (!result.ok || !result.result?.message_id) {
    return {
      status: 'failed',
      error: `Telegram error (${result.error_code ?? 'unknown'}): ${
        result.description ?? 'Failed to send message'
      }`,
    };
  }

  const messageId = result.result.message_id;
  const channelUsername =
    result.result.chat?.username || (chatId.startsWith('@') ? chatId.slice(1) : undefined);

  let messageUrl: string;
  if (channelUsername) {
    messageUrl = `https://t.me/${channelUsername}/${messageId}`;
  } else if (chatId.startsWith('-100')) {
    messageUrl = `https://t.me/c/${chatId.slice(4)}/${messageId}`;
  } else {
    messageUrl = `https://t.me/${chatId}/${messageId}`;
  }

  return {
    status: 'posted',
    remoteId: String(messageId),
    url: messageUrl,
  };
}
