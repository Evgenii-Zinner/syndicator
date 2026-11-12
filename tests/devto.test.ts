import { describe, expect, it } from 'bun:test';
import { syndicateToDevto } from '../src/platforms/devto';
import type { Bindings, SyndicatePayload } from '../src/types';

interface DevtoRequestBody {
  article: {
    title: string;
    published: boolean;
    body_markdown: string;
    canonical_url: string;
    description?: string;
  };
}

describe('DEV.to Platform Syndication', () => {
  const dummyEnv: Bindings = {
    KV: {} as KVNamespace,
    RSS_FEED_URL: 'https://example.com/rss.xml',
    BLUESKY_IDENTIFIER: 'example.com',
  };

  const dummyPayload: SyndicatePayload = {
    canonicalUrl: 'https://example.com/blog/building-syndicator',
    shortUrl: 'https://s.example.com/xyz',
    title: 'Building Syndicator with Cloudflare Workers',
    excerpt: 'How to build an automated syndication pipeline using Cloudflare KV.',
    contentHtml: '<h1>Building Syndicator</h1><p>Full article text content goes here.</p>',
  };

  it('skips syndication when DEVTO_API_KEY is missing', async () => {
    const result = await syndicateToDevto(dummyPayload, dummyEnv);
    expect(result.status).toBe('skipped');
    if (result.status === 'skipped') {
      expect(result.reason).toContain('DEVTO_API_KEY');
    }
  });

  it('successfully publishes an article with HTML body and canonical URL', async () => {
    const calls: { url: string; headers: Headers; body: DevtoRequestBody }[] = [];
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      const headers = new Headers(init?.headers as Record<string, string>);
      const body = JSON.parse(init?.body as string) as DevtoRequestBody;
      calls.push({ url, headers, body });

      if (url === 'https://dev.to/api/articles') {
        return new Response(
          JSON.stringify({
            id: 1234567,
            title: dummyPayload.title,
            url: 'https://dev.to/exampleuser/building-syndicator-cloudflare-workers-abc',
            canonical_url: dummyPayload.canonicalUrl,
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response('Not Found', { status: 404 });
    }) as unknown as typeof fetch;

    try {
      const env: Bindings = {
        ...dummyEnv,
        DEVTO_API_KEY: 'test-devto-key-xyz',
      };

      const result = await syndicateToDevto(dummyPayload, env);

      expect(result.status).toBe('posted');
      if (result.status === 'posted') {
        expect(result.remoteId).toBe('1234567');
        expect(result.url).toBe(
          'https://dev.to/exampleuser/building-syndicator-cloudflare-workers-abc'
        );
      }

      expect(calls.length).toBe(1);
      const call = calls[0];
      expect(call?.headers.get('api-key')).toBe('test-devto-key-xyz');
      expect(call?.headers.get('content-type')).toBe('application/json');
      expect(call?.body.article.title).toBe(dummyPayload.title);
      expect(call?.body.article.body_markdown).toBe(dummyPayload.contentHtml ?? '');
      expect(call?.body.article.canonical_url).toBe(dummyPayload.canonicalUrl);
      expect(call?.body.article.description).toBe(dummyPayload.excerpt);
      expect(call?.body.article.published).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('supports DEVTO_PUBLISHED="false" to create a draft', async () => {
    const calls: { body: DevtoRequestBody }[] = [];
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async (
      _input: RequestInfo | URL,
      init?: RequestInit
    ): Promise<Response> => {
      const body = JSON.parse(init?.body as string) as DevtoRequestBody;
      calls.push({ body });

      return new Response(
        JSON.stringify({
          id: 999999,
          title: dummyPayload.title,
          url: 'https://dev.to/exampleuser/draft-preview',
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } }
      );
    }) as unknown as typeof fetch;

    try {
      const env: Bindings = {
        ...dummyEnv,
        DEVTO_API_KEY: 'test-devto-key-xyz',
        DEVTO_PUBLISHED: 'false',
      };

      const result = await syndicateToDevto(dummyPayload, env);
      expect(result.status).toBe('posted');
      expect(calls[0]?.body.article.published).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('falls back to excerpt or title if contentHtml is not present', async () => {
    const calls: { body: DevtoRequestBody }[] = [];
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async (
      _input: RequestInfo | URL,
      init?: RequestInit
    ): Promise<Response> => {
      const body = JSON.parse(init?.body as string) as DevtoRequestBody;
      calls.push({ body });

      return new Response(
        JSON.stringify({
          id: 111,
          title: 'No Content',
          url: 'https://dev.to/example/no-content',
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } }
      );
    }) as unknown as typeof fetch;

    try {
      const payloadWithoutHtml: SyndicatePayload = {
        canonicalUrl: 'https://example.com/post',
        shortUrl: 'https://s.example.com/abc',
        title: 'Short Article Title',
        excerpt: 'Just an excerpt.',
      };

      const result = await syndicateToDevto(payloadWithoutHtml, {
        ...dummyEnv,
        DEVTO_API_KEY: 'test-key',
      });
      expect(result.status).toBe('posted');
      expect(calls[0]?.body.article.body_markdown).toBe('Just an excerpt.');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('returns status failed when DEV.to returns an error', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (): Promise<Response> => {
      return new Response(JSON.stringify({ error: 'unauthorized', status: 401 }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    try {
      const result = await syndicateToDevto(dummyPayload, {
        ...dummyEnv,
        DEVTO_API_KEY: 'invalid-key',
      });

      expect(result.status).toBe('failed');
      if (result.status === 'failed') {
        expect(result.error).toContain('DEV.to API error (401)');
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
