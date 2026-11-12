import { describe, expect, it } from 'bun:test';
import { formatTelegramMessage, syndicateToTelegram } from '../src/platforms/telegram';
import type { Bindings, SyndicatePayload } from '../src/types';

describe('Telegram Platform Syndication', () => {
  const dummyEnv: Bindings = {
    KV: {} as KVNamespace,
    RSS_FEED_URL: 'https://example.com/rss.xml',
    BLUESKY_IDENTIFIER: 'example.com',
    TELEGRAM_BOT_TOKEN: '123456789:ABCdefGHIjklMNOpqrSTUvwxYZ',
    TELEGRAM_CHAT_ID: '@devlog',
  };

  const payload: SyndicatePayload = {
    canonicalUrl: 'https://example.com/articles/telegram-syndication',
    shortUrl: 'https://s.example.com/tg1',
    title: 'Telegram Bot Syndication & Channels',
    excerpt: 'Detailed overview of broadcasting updates with HTML formatting <script> & alerts.',
  };

  it('properly formats message with HTML tags and escapes raw entities', () => {
    const formatted = formatTelegramMessage(
      'Title <with> & "special" chars',
      'Excerpt with <tags> & symbols',
      'https://s.example.com/test'
    );

    expect(formatted).toContain('<b>Title &lt;with&gt; &amp; "special" chars</b>');
    expect(formatted).toContain('Excerpt with &lt;tags&gt; &amp; symbols');
    expect(formatted).toContain(
      '<a href="https://s.example.com/test">https://s.example.com/test</a>'
    );
  });

  it('skips syndication when TELEGRAM_BOT_TOKEN is missing', async () => {
    const envWithoutToken: Bindings = {
      ...dummyEnv,
      TELEGRAM_BOT_TOKEN: undefined,
    };

    const result = await syndicateToTelegram(payload, envWithoutToken);
    expect(result.status).toBe('skipped');
    if (result.status === 'skipped') {
      expect(result.reason).toContain('not configured');
    }
  });

  it('skips syndication when TELEGRAM_CHAT_ID is missing', async () => {
    const envWithoutChat: Bindings = {
      ...dummyEnv,
      TELEGRAM_CHAT_ID: undefined,
    };

    const result = await syndicateToTelegram(payload, envWithoutChat);
    expect(result.status).toBe('skipped');
  });

  it('successfully publishes message to channel and constructs public channel URL', async () => {
    const calls: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      const headers = new Headers(init?.headers as Record<string, string>);
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      calls.push({ url, headers, body });

      return new Response(
        JSON.stringify({
          ok: true,
          result: {
            message_id: 42,
            chat: {
              id: -100123456789,
              title: 'Devlog',
              username: 'devlog',
              type: 'channel',
            },
            date: 1700000000,
            text: body.text,
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as unknown as typeof fetch;

    try {
      const result = await syndicateToTelegram(payload, dummyEnv);
      expect(result.status).toBe('posted');
      if (result.status === 'posted') {
        expect(result.remoteId).toBe('42');
        expect(result.url).toBe('https://t.me/devlog/42');
      }

      expect(calls.length).toBe(1);
      const call = calls[0];
      expect(call?.url).toContain('/bot123456789:ABCdefGHIjklMNOpqrSTUvwxYZ/sendMessage');
      expect(call?.body.chat_id).toBe('@devlog');
      expect(call?.body.parse_mode).toBe('HTML');
      expect(call?.body.text).toContain('<b>Telegram Bot Syndication &amp; Channels</b>');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('returns status failed on API error response', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (): Promise<Response> => {
      return new Response(
        JSON.stringify({
          ok: false,
          error_code: 400,
          description: 'Bad Request: chat not found',
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }) as unknown as typeof fetch;

    try {
      const result = await syndicateToTelegram(payload, dummyEnv);
      expect(result.status).toBe('failed');
      if (result.status === 'failed') {
        expect(result.error).toContain('400');
        expect(result.error).toContain('chat not found');
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
