import { beforeEach, describe, expect, it } from 'bun:test';
import { app } from '../src/index';
import type { Bindings, SyncSummary } from '../src/types';

class MockKVNamespace {
  private readonly store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async list(options?: { prefix?: string }): Promise<{ keys: Array<{ name: string }> }> {
    const prefix = options?.prefix ?? '';
    const matchingKeys: Array<{ name: string }> = [];

    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        matchingKeys.push({ name: key });
      }
    }

    return { keys: matchingKeys };
  }
}

const SAMPLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Test Blog</title>
    <link>https://example.com</link>
    <item>
      <title>Hello World</title>
      <link>https://example.com/hello</link>
      <description>First post</description>
      <pubDate>${new Date().toUTCString()}</pubDate>
    </item>
  </channel>
</rss>`;

describe('Syndicator KV Worker', () => {
  let mockKv: MockKVNamespace;
  let mockEnv: Bindings;

  beforeEach(() => {
    mockKv = new MockKVNamespace();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url === 'https://example.com/rss.xml') {
        return new Response(SAMPLE_XML, {
          status: 200,
          headers: {
            'Content-Type': 'application/xml',
            etag: '"test-etag-1"',
          },
        });
      }

      if (url.includes('/xrpc/com.atproto.server.createSession')) {
        return new Response(
          JSON.stringify({
            did: 'did:plc:test123',
            accessJwt: 'jwt-123',
            refreshJwt: 'ref-123',
            handle: 'test.com',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (url.includes('/xrpc/com.atproto.repo.createRecord')) {
        return new Response(
          JSON.stringify({
            uri: 'at://did:plc:test123/app.bsky.feed.post/3lb123',
            cid: 'bafy123',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      return originalFetch(input, init);
    }) as unknown as typeof fetch;

    mockEnv = {
      KV: mockKv as unknown as KVNamespace,
      RSS_FEED_URL: 'https://example.com/rss.xml',
      BLUESKY_IDENTIFIER: 'test.com',
      BLUESKY_PASSWORD: 'app-password-123',
      API_SECRET: 'test-secret',
    };
  });

  it('serves root health check and KV status on GET /', async () => {
    await mockKv.put('rss:latest_url', 'https://example.com/hello');
    await mockKv.put('rss:etag', '"test-etag-1"');
    await mockKv.put('rss:last_synced_at', '2026-11-11T12:00:00Z');

    const res = await app.request('/', {}, mockEnv);
    expect(res.status).toBe(200);

    const data = (await res.json()) as {
      service: string;
      storage: string;
      state: { lastSyncedAt: string; latestUrl: string; etag: string };
      config: { feedUrl: string };
    };

    expect(data.service).toBe('syndicator');
    expect(data.storage).toBe('cloudflare-kv');
    expect(data.state.latestUrl).toBe('https://example.com/hello');
    expect(data.state.etag).toBe('"test-etag-1"');
    expect(data.config.feedUrl).toBe('https://example.com/rss.xml');
  });

  it('rejects POST /sync with invalid API_SECRET when secret is set', async () => {
    const res = await app.request(
      '/sync',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer wrong-secret' },
      },
      mockEnv
    );
    expect(res.status).toBe(401);
  });

  it('executes sync on authorized POST /sync', async () => {
    // Seed an earlier baseline post in KV
    await mockKv.put('rss:latest_url', 'https://example.com/previous-post');

    const res = await app.request(
      '/sync',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer test-secret' },
      },
      mockEnv
    );
    expect(res.status).toBe(200);

    const summary = (await res.json()) as SyncSummary;
    expect(summary.success).toBe(true);
    expect(summary.postedCount).toBe(1);

    // Verify history endpoint returns the item from KV with post: prefix
    const historyRes = await app.request('/history', {}, mockEnv);
    const historyData = (await historyRes.json()) as {
      count: number;
      items: Array<{ title: string; link: string }>;
    };
    expect(historyData.count).toBe(1);
    expect(historyData.items[0]?.title).toBe('Hello World');

    const storedItem = await mockKv.get('post:https://example.com/hello');
    expect(storedItem).not.toBeNull();
  });
});
