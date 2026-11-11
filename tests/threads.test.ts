import { describe, expect, it } from 'bun:test';
import { syndicateToThreads } from '../src/platforms/threads';
import type { Bindings, SyndicatePayload } from '../src/types';

describe('Meta Threads Platform Syndication', () => {
  const dummyEnv: Bindings = {
    KV: {} as KVNamespace,
    RSS_FEED_URL: 'https://example.com/rss.xml',
    BLUESKY_IDENTIFIER: 'example.com',
    THREADS_ACCESS_TOKEN: 'mock-threads-token',
    THREADS_USER_ID: '123456789',
  };

  const payload: SyndicatePayload = {
    canonicalUrl: 'https://example.com/articles/v8-engine-internals',
    shortUrl: 'https://s.example.com/v8x',
    title: 'V8 Engine Internals',
    excerpt: 'Deep dive into V8 engine memory management and JIT compilation.',
  };

  it('skips syndication when THREADS_ACCESS_TOKEN is missing', async () => {
    const envWithoutToken: Bindings = {
      ...dummyEnv,
      THREADS_ACCESS_TOKEN: undefined,
    };

    const result = await syndicateToThreads(payload, envWithoutToken);
    expect(result.status).toBe('skipped');
    if (result.status === 'skipped') {
      expect(result.reason).toContain('not configured');
    }
  });

  it('resolves user ID via /me when THREADS_USER_ID is not provided', async () => {
    const envWithoutUserId: Bindings = {
      ...dummyEnv,
      THREADS_USER_ID: undefined,
    };

    const calls: { url: string; body: string }[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      const body = (init?.body as string) ?? '';
      calls.push({ url, body });

      if (url.includes('/me')) {
        return new Response(JSON.stringify({ id: '987654321', username: 'exampleuser' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url.includes('/threads_publish')) {
        return new Response(JSON.stringify({ id: 'pub-999' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url.includes('/threads')) {
        return new Response(JSON.stringify({ id: 'container-999' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return originalFetch(input, init);
    }) as unknown as typeof fetch;

    try {
      const result = await syndicateToThreads(payload, envWithoutUserId);
      expect(result.status).toBe('posted');

      // First call should resolve /me
      expect(calls[0]?.url).toContain('graph.threads.net/v1.0/me');
      // Subsequent calls should use resolved user ID '987654321'
      expect(calls[1]?.url).toContain('987654321/threads');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('syndicates via algorithmic reply strategy (hook in post 1, link in reply post 2)', async () => {
    const calls: { url: string; body: string }[] = [];
    let counter = 100;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      const body = (init?.body as string) ?? '';
      calls.push({ url, body });

      counter++;
      if (url.includes('/threads_publish')) {
        return new Response(JSON.stringify({ id: `pub-${counter}` }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url.includes('/threads')) {
        return new Response(JSON.stringify({ id: `container-${counter}` }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return originalFetch(input, init);
    }) as unknown as typeof fetch;

    try {
      const result = await syndicateToThreads(payload, dummyEnv);

      expect(result.status).toBe('posted');
      if (result.status === 'posted') {
        expect(result.remoteId).toBe('pub-102');
        expect(result.url).toBe('https://www.threads.net/t/pub-102');
      }

      // 4 API calls total:
      // 1. Container for Post 1 (hook)
      // 2. Publish Post 1
      // 3. Container for Post 2 (link in reply to Post 1)
      // 4. Publish Post 2
      expect(calls.length).toBe(4);

      // Post 1 container: contains hook text, no reply_to_id
      const post1Params = new URLSearchParams(calls[0]?.body);
      expect(post1Params.get('media_type')).toBe('TEXT');
      expect(post1Params.get('text')).toBe(
        'Deep dive into V8 engine memory management and JIT compilation.'
      );
      expect(post1Params.get('reply_to_id')).toBeNull();

      // Post 1 publish: creation_id matches post 1 container ('container-101')
      const post1Pub = new URLSearchParams(calls[1]?.body);
      expect(post1Pub.get('creation_id')).toBe('container-101');

      // Post 2 container: chained to published post 1 ('pub-102'), contains link
      const post2Params = new URLSearchParams(calls[2]?.body);
      expect(post2Params.get('media_type')).toBe('TEXT');
      expect(post2Params.get('text')).toBe('Read the full article:\n\nhttps://s.example.com/v8x');
      expect(post2Params.get('reply_to_id')).toBe('pub-102');

      // Post 2 publish: creation_id matches post 2 container ('container-103')
      const post2Pub = new URLSearchParams(calls[3]?.body);
      expect(post2Pub.get('creation_id')).toBe('container-103');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('returns status failed on container creation error', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (): Promise<Response> => {
      return new Response(
        JSON.stringify({
          error: {
            message: 'Invalid OAuth access token.',
            type: 'OAuthException',
            code: 190,
          },
        }),
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      );
    }) as unknown as typeof fetch;

    try {
      const result = await syndicateToThreads(payload, dummyEnv);
      expect(result.status).toBe('failed');
      if (result.status === 'failed') {
        expect(result.error).toContain('401');
        expect(result.error).toContain('OAuthException');
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
