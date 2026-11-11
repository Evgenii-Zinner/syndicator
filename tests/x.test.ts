import { describe, expect, it } from 'bun:test';
import { syndicateToX } from '../src/platforms/x';
import type { Bindings, SyndicatePayload } from '../src/types';

describe('X (Twitter) Platform Syndication', () => {
  const dummyEnv: Bindings = {
    KV: {} as KVNamespace,
    RSS_FEED_URL: 'https://example.com/rss.xml',
    BLUESKY_IDENTIFIER: 'example.com',
    X_ACCESS_TOKEN: 'mock-x-access-token',
  };

  const payload: SyndicatePayload = {
    canonicalUrl: 'https://example.com/articles/v8-engine-internals',
    shortUrl: 'https://s.example.com/v8x',
    title: 'V8 Engine Internals',
    excerpt: 'Deep dive into V8 engine memory management and JIT compilation.',
  };

  it('skips syndication when X_ACCESS_TOKEN is missing', async () => {
    const envWithoutToken: Bindings = {
      ...dummyEnv,
      X_ACCESS_TOKEN: undefined,
    };

    const result = await syndicateToX(payload, envWithoutToken);
    expect(result.status).toBe('skipped');
    if (result.status === 'skipped') {
      expect(result.reason).toContain('not configured');
    }
  });

  it('syndicates via algorithmic reply strategy (hook in post 1, link in reply post 2)', async () => {
    const calls: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
    let tweetCounter = 7000;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      const headers = new Headers(init?.headers as Record<string, string>);
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      calls.push({ url, headers, body });

      tweetCounter++;
      return new Response(
        JSON.stringify({
          data: {
            id: String(tweetCounter),
            text: body.text,
          },
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } }
      );
    }) as unknown as typeof fetch;

    try {
      const result = await syndicateToX(payload, dummyEnv);

      expect(result.status).toBe('posted');
      if (result.status === 'posted') {
        expect(result.remoteId).toBe('7001');
        expect(result.url).toBe('https://x.com/i/status/7001');
      }

      // X requires 2 posts: root post with hook, second post with link to avoid algorithmic penalty
      expect(calls.length).toBe(2);

      // Post 1: Root hook, no reply field
      const [post1, post2] = calls;
      expect(post1?.url).toBe('https://api.twitter.com/2/tweets');
      expect(post1?.headers.get('Authorization')).toBe('Bearer mock-x-access-token');
      expect(post1?.headers.get('Content-Type')).toBe('application/json');
      expect(post1?.body.text).toBe(
        'Deep dive into V8 engine memory management and JIT compilation.'
      );
      expect(post1?.body.reply).toBeUndefined();

      // Post 2: Reply chained to post 1 (id: '7001'), contains link
      expect(post2?.url).toBe('https://api.twitter.com/2/tweets');
      expect(post2?.body.text).toBe('Read the full article:\n\nhttps://s.example.com/v8x');
      expect(post2?.body.reply).toEqual({ in_reply_to_tweet_id: '7001' });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('returns status failed on API error', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (): Promise<Response> => {
      return new Response(
        JSON.stringify({
          title: 'Unauthorized',
          detail: 'Your access token is invalid or expired.',
        }),
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      );
    }) as unknown as typeof fetch;

    try {
      const result = await syndicateToX(payload, dummyEnv);
      expect(result.status).toBe('failed');
      if (result.status === 'failed') {
        expect(result.error).toContain('401');
        expect(result.error).toContain('Unauthorized');
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
