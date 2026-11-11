import { beforeEach, describe, expect, it } from 'bun:test';
import { nip19 } from 'nostr-tools';
import { generateSecretKey } from 'nostr-tools/pure';
import { syncRssFeed } from '../src/sync';
import type { Bindings, KvSyndicatedItem } from '../src/types';
import { formatPostText } from '../src/utils/format';

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
}

const BASELINE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Example Tech Blog</title>
    <link>https://example.com</link>
    <item>
      <title>Article 1</title>
      <link>https://example.com/articles/article-1</link>
      <description>Excerpt for article 1.</description>
      <pubDate>Mon, 01 Jan 2026 00:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;

const UPDATED_XML_WITH_TWO_POSTS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Example Tech Blog</title>
    <link>https://example.com</link>
    <item>
      <title>Article 3</title>
      <link>https://example.com/articles/article-3</link>
      <description>Excerpt for article 3.</description>
      <pubDate>Wed, 03 Jan 2026 00:00:00 GMT</pubDate>
    </item>
    <item>
      <title>Article 2</title>
      <link>https://example.com/articles/article-2</link>
      <description>Excerpt for article 2.</description>
      <pubDate>Tue, 02 Jan 2026 00:00:00 GMT</pubDate>
    </item>
    <item>
      <title>Article 1</title>
      <link>https://example.com/articles/article-1</link>
      <description>Excerpt for article 1.</description>
      <pubDate>Mon, 01 Jan 2026 00:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;

describe('Formatting Utilities', () => {
  it('formats Bluesky text with excerpt and link only (no title)', () => {
    const text = formatPostText({
      canonicalUrl: 'https://example.com/articles/v8-isolates',
      title: 'V8 Isolates Guide',
      excerpt: 'How V8 isolates work at the OS level.',
    });

    expect(text).toBe(
      'How V8 isolates work at the OS level.\n\nhttps://example.com/articles/v8-isolates'
    );
    expect(text).not.toContain('V8 Isolates Guide');
  });

  it('uses shortUrl in post text when provided', () => {
    const text = formatPostText({
      canonicalUrl: 'https://example.com/articles/v8-isolates',
      shortUrl: 'https://s.example.com/a9X',
      title: 'V8 Isolates Guide',
      excerpt: 'How V8 isolates work at the OS level.',
    });

    expect(text).toBe('How V8 isolates work at the OS level.\n\nhttps://s.example.com/a9X');
  });

  it('falls back to title if excerpt is missing', () => {
    const text = formatPostText({
      canonicalUrl: 'https://example.com/articles/v8-isolates',
      title: 'V8 Isolates Guide',
      excerpt: '',
    });

    expect(text).toBe('V8 Isolates Guide\n\nhttps://example.com/articles/v8-isolates');
  });
});

describe('RSS Sync Engine', () => {
  let mockKv: MockKVNamespace;
  let mockEnv: Bindings;
  let currentXml: string;
  let postedOrder: string[];

  beforeEach(() => {
    mockKv = new MockKVNamespace();
    currentXml = BASELINE_XML;
    postedOrder = [];

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url === 'https://example.com/rss.xml') {
        return new Response(currentXml, {
          status: 200,
          headers: { 'Content-Type': 'application/xml', etag: '"v1"' },
        });
      }

      if (url.includes('/xrpc/com.atproto.server.createSession')) {
        return new Response(
          JSON.stringify({
            did: 'did:plc:mock123',
            accessJwt: 'jwt-123',
            refreshJwt: 'ref-123',
            handle: 'example.com',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (url.includes('/xrpc/com.atproto.repo.createRecord')) {
        const body = JSON.parse(init?.body as string) as {
          record: { text: string; embed?: { external?: { uri: string } } };
        };
        const uri = body.record.embed?.external?.uri ?? '';
        postedOrder.push(uri);

        return new Response(
          JSON.stringify({
            uri: `at://did:plc:mock123/app.bsky.feed.post/${postedOrder.length}`,
            cid: 'bafytestcid',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (url.includes('/api/v1/statuses')) {
        return new Response(
          JSON.stringify({
            id: 'mastodon-post-1',
            url: 'https://mastodon.social/@me/1',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (url.includes('/2/tweets')) {
        return new Response(
          JSON.stringify({
            data: {
              id: 'x-tweet-1',
              text: 'test',
            },
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (url.includes('/threads_publish')) {
        return new Response(JSON.stringify({ id: 'threads-post-1' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url.includes('/threads')) {
        return new Response(JSON.stringify({ id: 'threads-container-1' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return originalFetch(input, init);
    }) as unknown as typeof fetch;

    mockEnv = {
      KV: mockKv as unknown as KVNamespace,
      RSS_FEED_URL: 'https://example.com/rss.xml',
      BLUESKY_IDENTIFIER: 'example.com',
      BLUESKY_PASSWORD: 'mock-app-password',
      BLUESKY_SERVICE: 'https://bsky.social',
    };
  });

  it('first run: establishes baseline by writing latest URL and posting nothing', async () => {
    const summary = await syncRssFeed(mockEnv);

    expect(summary.success).toBe(true);
    expect(summary.postedCount).toBe(0);
    expect(summary.itemsProcessed).toBe(0);
    expect(postedOrder.length).toBe(0);

    const storedLatestUrl = await mockKv.get('rss:latest_url');
    expect(storedLatestUrl).toBe('https://example.com/articles/article-1');
  });

  it('subsequent run without new posts: exits immediately', async () => {
    // Run 1 sets baseline
    await syncRssFeed(mockEnv);

    // Run 2 with same XML
    const secondSummary = await syncRssFeed(mockEnv);
    expect(secondSummary.feedChanged).toBe(false);
    expect(secondSummary.postedCount).toBe(0);
    expect(postedOrder.length).toBe(0);
  });

  it('subsequent run with 2 new posts: syndicates chronologically (oldest to newest)', async () => {
    // 1. Establish baseline at Article 1
    await syncRssFeed(mockEnv);

    // 2. Publish Article 2 and Article 3
    currentXml = UPDATED_XML_WITH_TWO_POSTS;

    const summary = await syncRssFeed(mockEnv);
    expect(summary.postedCount).toBe(2);

    // Verify sequential chronological order: Article 2 posted first, then Article 3
    expect(postedOrder).toEqual([
      'https://example.com/articles/article-2',
      'https://example.com/articles/article-3',
    ]);

    // Latest URL updated to newest (Article 3)
    const latestUrl = await mockKv.get('rss:latest_url');
    expect(latestUrl).toBe('https://example.com/articles/article-3');
  });

  it('halts batch on failure and retries failed post on next run', async () => {
    // 1. Establish baseline at Article 1
    await syncRssFeed(mockEnv);

    // 2. Publish Article 2 and Article 3
    currentXml = UPDATED_XML_WITH_TWO_POSTS;

    // Simulate failure on Article 3
    let failArticle3 = true;
    const prevFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/xrpc/com.atproto.repo.createRecord') && failArticle3) {
        const body = JSON.parse(init?.body as string) as {
          record: { embed?: { external?: { uri: string } } };
        };
        if (body.record.embed?.external?.uri?.includes('article-3')) {
          return new Response('Rate limited', { status: 429 });
        }
      }
      return prevFetch(input, init);
    }) as unknown as typeof fetch;

    const run1 = await syncRssFeed(mockEnv);
    expect(run1.postedCount).toBe(1);
    expect(run1.failedCount).toBe(1);

    // Article 2 posted, but latest_url stays Article 2 (does not skip Article 3!)
    expect(await mockKv.get('rss:latest_url')).toBe('https://example.com/articles/article-2');
    expect(await mockKv.get('rss:etag')).toBeNull(); // ETag not saved on failure

    // 3. Next run (e.g. 4 hours later, rate limit cleared)
    failArticle3 = false;
    const run2 = await syncRssFeed(mockEnv);
    expect(run2.postedCount).toBe(1);
    expect(run2.failedCount).toBe(0);

    // Now latest_url advances to Article 3 and ETag is saved
    expect(await mockKv.get('rss:latest_url')).toBe('https://example.com/articles/article-3');
    expect(await mockKv.get('rss:etag')).toBe('"v1"');
  });

  it('syndicates to both Bluesky and Mastodon when both are configured', async () => {
    const multiEnv: Bindings = {
      ...mockEnv,
      MASTODON_INSTANCE_URL: 'https://mastodon.social',
      MASTODON_ACCESS_TOKEN: 'mock-masto-token',
    };

    // Baseline run
    await syncRssFeed(multiEnv);

    // 1 new post
    currentXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Evgenii Zinner</title>
    <link>https://example.com</link>
    <item>
      <title>Article 2</title>
      <link>https://example.com/articles/article-2</link>
      <description>Excerpt for article 2.</description>
      <pubDate>Tue, 02 Jan 2026 00:00:00 GMT</pubDate>
    </item>
    <item>
      <title>Article 1</title>
      <link>https://example.com/articles/article-1</link>
      <description>Excerpt for article 1.</description>
      <pubDate>Mon, 01 Jan 2026 00:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;

    const summary = await syncRssFeed(multiEnv);
    expect(summary.postedCount).toBe(1);

    const kvItemRaw = await mockKv.get('post:https://example.com/articles/article-2');
    expect(kvItemRaw).toBeTruthy();
    const kvItem = JSON.parse(kvItemRaw ?? '{}') as KvSyndicatedItem;

    expect(kvItem.bluesky?.url).toBe('https://bsky.app/profile/example.com/post/1');
    expect(kvItem.mastodon?.url).toBe('https://mastodon.social/@me/1');
  });

  it('syndicates to Bluesky, Mastodon, and X concurrently when all three are configured', async () => {
    const tripleEnv: Bindings = {
      ...mockEnv,
      MASTODON_INSTANCE_URL: 'https://mastodon.social',
      MASTODON_ACCESS_TOKEN: 'mock-masto-token',
      X_ACCESS_TOKEN: 'mock-x-token',
    };

    // Baseline run
    await syncRssFeed(tripleEnv);

    // 1 new post
    currentXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Evgenii Zinner</title>
    <link>https://example.com</link>
    <item>
      <title>Article 2</title>
      <link>https://example.com/articles/article-2</link>
      <description>Excerpt for article 2.</description>
      <pubDate>Tue, 02 Jan 2026 00:00:00 GMT</pubDate>
    </item>
    <item>
      <title>Article 1</title>
      <link>https://example.com/articles/article-1</link>
      <description>Excerpt for article 1.</description>
      <pubDate>Mon, 01 Jan 2026 00:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;

    const summary = await syncRssFeed(tripleEnv);
    expect(summary.postedCount).toBe(1);

    const kvItemRaw = await mockKv.get('post:https://example.com/articles/article-2');
    expect(kvItemRaw).toBeTruthy();
    const kvItem = JSON.parse(kvItemRaw ?? '{}') as KvSyndicatedItem;

    expect(kvItem.bluesky?.url).toBe('https://bsky.app/profile/example.com/post/1');
    expect(kvItem.mastodon?.url).toBe('https://mastodon.social/@me/1');
    expect(kvItem.x?.url).toBe('https://x.com/i/status/x-tweet-1');
  });

  it('syndicates to Bluesky, Mastodon, X, and Threads concurrently when all four are configured', async () => {
    const quadEnv: Bindings = {
      ...mockEnv,
      MASTODON_INSTANCE_URL: 'https://mastodon.social',
      MASTODON_ACCESS_TOKEN: 'mock-masto-token',
      X_ACCESS_TOKEN: 'mock-x-token',
      THREADS_ACCESS_TOKEN: 'mock-threads-token',
      THREADS_USER_ID: 'mock-threads-user-123',
    };

    // Baseline run
    await syncRssFeed(quadEnv);

    // 1 new post
    currentXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Evgenii Zinner</title>
    <link>https://example.com</link>
    <item>
      <title>Article 2</title>
      <link>https://example.com/articles/article-2</link>
      <description>Excerpt for article 2.</description>
      <pubDate>Tue, 02 Jan 2026 00:00:00 GMT</pubDate>
    </item>
    <item>
      <title>Article 1</title>
      <link>https://example.com/articles/article-1</link>
      <description>Excerpt for article 1.</description>
      <pubDate>Mon, 01 Jan 2026 00:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;

    const summary = await syncRssFeed(quadEnv);
    expect(summary.postedCount).toBe(1);

    const kvItemRaw = await mockKv.get('post:https://example.com/articles/article-2');
    expect(kvItemRaw).toBeTruthy();
    const kvItem = JSON.parse(kvItemRaw ?? '{}') as KvSyndicatedItem;

    expect(kvItem.bluesky?.url).toBe('https://bsky.app/profile/example.com/post/1');
    expect(kvItem.mastodon?.url).toBe('https://mastodon.social/@me/1');
    expect(kvItem.x?.url).toBe('https://x.com/i/status/x-tweet-1');
    expect(kvItem.threads?.url).toBe('https://www.threads.net/t/threads-post-1');
  });

  it('syndicates to Bluesky, Mastodon, X, Threads, and Nostr concurrently when all five are configured', async () => {
    class MockRelayWebSocket {
      readyState = 1;
      private listeners = new Map<string, ((event: unknown) => void)[]>();

      addEventListener(type: string, listener: (event: unknown) => void) {
        const arr = this.listeners.get(type) ?? [];
        arr.push(listener);
        this.listeners.set(type, arr);
      }

      send(data: string) {
        const parsed = JSON.parse(data);
        if (Array.isArray(parsed) && parsed[0] === 'EVENT') {
          const event = parsed[1] as { id: string };
          setTimeout(() => {
            const handlers = this.listeners.get('message') ?? [];
            for (const h of handlers) {
              h({ data: JSON.stringify(['OK', event.id, true, '']) });
            }
          }, 10);
        }
      }

      close() {
        this.readyState = 3;
      }
    }

    const originalWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = MockRelayWebSocket as unknown as typeof WebSocket;

    try {
      const sampleNsec = nip19.nsecEncode(generateSecretKey());
      const quintEnv: Bindings = {
        ...mockEnv,
        MASTODON_INSTANCE_URL: 'https://mastodon.social',
        MASTODON_ACCESS_TOKEN: 'mock-masto-token',
        X_ACCESS_TOKEN: 'mock-x-token',
        THREADS_ACCESS_TOKEN: 'mock-threads-token',
        THREADS_USER_ID: 'mock-threads-user-123',
        NOSTR_PRIVATE_KEY: sampleNsec,
        NOSTR_RELAYS: 'wss://mock.relay.one',
      };

      // Baseline run
      await syncRssFeed(quintEnv);

      // 1 new post
      currentXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Evgenii Zinner</title>
    <link>https://example.com</link>
    <item>
      <title>Article 2</title>
      <link>https://example.com/articles/article-2</link>
      <description>Excerpt for article 2.</description>
      <pubDate>Tue, 02 Jan 2026 00:00:00 GMT</pubDate>
    </item>
    <item>
      <title>Article 1</title>
      <link>https://example.com/articles/article-1</link>
      <description>Excerpt for article 1.</description>
      <pubDate>Mon, 01 Jan 2026 00:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;

      const summary = await syncRssFeed(quintEnv);
      expect(summary.postedCount).toBe(1);

      const kvItemRaw = await mockKv.get('post:https://example.com/articles/article-2');
      expect(kvItemRaw).toBeTruthy();
      const kvItem = JSON.parse(kvItemRaw ?? '{}') as KvSyndicatedItem;

      expect(kvItem.bluesky?.url).toBe('https://bsky.app/profile/example.com/post/1');
      expect(kvItem.mastodon?.url).toBe('https://mastodon.social/@me/1');
      expect(kvItem.x?.url).toBe('https://x.com/i/status/x-tweet-1');
      expect(kvItem.threads?.url).toBe('https://www.threads.net/t/threads-post-1');
      expect(kvItem.nostr?.url).toContain('https://njump.me/note1');
    } finally {
      globalThis.WebSocket = originalWebSocket;
    }
  });
});
