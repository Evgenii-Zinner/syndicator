import { describe, expect, it } from 'bun:test';
import { syndicateToMastodon } from '../src/platforms/mastodon';
import type { Bindings, SyndicatePayload } from '../src/types';

describe('Mastodon Platform Syndication', () => {
  const dummyEnv: Bindings = {
    KV: {} as KVNamespace,
    RSS_FEED_URL: 'https://example.com/rss.xml',
    BLUESKY_IDENTIFIER: 'example.com',
    MASTODON_INSTANCE_URL: 'https://mastodon.social',
    MASTODON_ACCESS_TOKEN: 'test-token-123',
  };

  const payload: SyndicatePayload = {
    canonicalUrl: 'https://example.com/articles/mastodon-guide',
    shortUrl: 'https://s.example.com/m4s',
    title: 'Mastodon Guide',
    excerpt: 'Comprehensive guide to building Mastodon federated bots.',
  };

  it('skips syndication when MASTODON_ACCESS_TOKEN is missing', async () => {
    const envWithoutToken: Bindings = {
      ...dummyEnv,
      MASTODON_ACCESS_TOKEN: undefined,
    };

    const result = await syndicateToMastodon(payload, envWithoutToken);
    expect(result.status).toBe('skipped');
    if (result.status === 'skipped') {
      expect(result.reason).toContain('not configured');
    }
  });

  it('successfully posts a single status with Idempotency-Key and Bearer auth', async () => {
    const calls: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      const headers = new Headers(init?.headers as Record<string, string>);
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      calls.push({ url, headers, body });

      return new Response(
        JSON.stringify({
          id: '109988776655',
          url: 'https://mastodon.social/@me/109988776655',
          uri: 'https://mastodon.social/users/me/statuses/109988776655',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as unknown as typeof fetch;

    try {
      const result = await syndicateToMastodon(payload, dummyEnv);

      expect(result.status).toBe('posted');
      if (result.status === 'posted') {
        expect(result.remoteId).toBe('109988776655');
        expect(result.url).toBe('https://mastodon.social/@me/109988776655');
      }

      expect(calls.length).toBe(1);
      const [firstCall] = calls;
      expect(firstCall?.url).toBe('https://mastodon.social/api/v1/statuses');
      expect(firstCall?.headers.get('Authorization')).toBe('Bearer test-token-123');
      expect(firstCall?.headers.get('Content-Type')).toBe('application/json');

      const idempotencyKey = firstCall?.headers.get('Idempotency-Key');
      expect(idempotencyKey).toBeTruthy();
      expect(idempotencyKey?.length).toBe(32);

      expect(firstCall?.body.status).toBe(
        'Comprehensive guide to building Mastodon federated bots.\n\nhttps://s.example.com/m4s'
      );
      expect(firstCall?.body.visibility).toBe('public');
      expect(firstCall?.body.in_reply_to_id).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('chains multi-post threads sequentially using in_reply_to_id', async () => {
    const longExcerpt = 'Word '.repeat(110); // ~550 characters, forces split across two posts
    const multiPayload: SyndicatePayload = {
      canonicalUrl: 'https://example.com/articles/long-story',
      shortUrl: 'https://s.example.com/xyz',
      title: 'Long Story',
      excerpt: longExcerpt,
    };

    const calls: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
    let postIdCounter = 100;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      const headers = new Headers(init?.headers as Record<string, string>);
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      calls.push({ url, headers, body });

      postIdCounter++;
      return new Response(
        JSON.stringify({
          id: String(postIdCounter),
          url: `https://mastodon.social/@me/${postIdCounter}`,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as unknown as typeof fetch;

    try {
      const result = await syndicateToMastodon(multiPayload, dummyEnv);

      expect(result.status).toBe('posted');
      expect(calls.length).toBe(2);

      // Post 1: Root status, no in_reply_to_id
      expect(calls[0]?.body.in_reply_to_id).toBeUndefined();
      expect(calls[0]?.headers.get('Idempotency-Key')).toBeTruthy();

      // Post 2: Reply chained to post 1 id ('101')
      expect(calls[1]?.body.in_reply_to_id).toBe('101');
      expect(calls[1]?.headers.get('Idempotency-Key')).toBeTruthy();
      // Ensure idempotency keys are unique per post segment
      expect(calls[0]?.headers.get('Idempotency-Key')).not.toBe(
        calls[1]?.headers.get('Idempotency-Key')
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('returns status failed on API error', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (): Promise<Response> => {
      return new Response('Rate limited', { status: 429 });
    }) as unknown as typeof fetch;

    try {
      const result = await syndicateToMastodon(payload, dummyEnv);
      expect(result.status).toBe('failed');
      if (result.status === 'failed') {
        expect(result.error).toContain('429');
        expect(result.error).toContain('Rate limited');
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
