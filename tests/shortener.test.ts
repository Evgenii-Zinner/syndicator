import { beforeEach, describe, expect, it } from 'bun:test';
import { app } from '../src/index';
import type { Bindings } from '../src/types';
import { generateShortCode, getOrCreateShortCode } from '../src/utils/shortener';

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

describe('3-Character Base62 Shortener', () => {
  let mockKv: MockKVNamespace;
  let mockEnv: Bindings;

  beforeEach(() => {
    mockKv = new MockKVNamespace();
    mockEnv = {
      KV: mockKv as unknown as KVNamespace,
      RSS_FEED_URL: 'https://example.com/rss.xml',
      BLUESKY_IDENTIFIER: 'example.com',
      SHORT_DOMAIN: 's.example.com',
    };
  });

  it('generates a 3-character Base62 code deterministically', async () => {
    const url = 'https://example.com/articles/v8-isolates';
    const code1 = await generateShortCode(url);
    const code2 = await generateShortCode(url);

    expect(code1.length).toBe(3);
    expect(code1).toBe(code2);
    expect(/^[0-9a-zA-Z]{3}$/.test(code1)).toBe(true);
  });

  it('assigns and persists short code in KV via getOrCreateShortCode', async () => {
    const url = 'https://example.com/articles/v8-isolates';
    const code = await getOrCreateShortCode(mockKv as unknown as KVNamespace, url);

    expect(code.length).toBe(3);
    const stored = await mockKv.get(`short:${code}`);
    expect(stored).toBe(url);

    // Calling it again returns the same code
    const secondCall = await getOrCreateShortCode(mockKv as unknown as KVNamespace, url);
    expect(secondCall).toBe(code);
  });

  it('redirects GET /:code with HTTP 301 and Cache-Control header', async () => {
    const longUrl = 'https://example.com/articles/v8-isolates';
    await mockKv.put('short:a9X', longUrl);

    const res = await app.request('/a9X', {}, mockEnv);
    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe(longUrl);
    expect(res.headers.get('Cache-Control')).toContain('public');
  });

  it('redirects GET /s/:code with HTTP 301', async () => {
    const longUrl = 'https://example.com/articles/shiki-csp';
    await mockKv.put('short:b7Y', longUrl);

    const res = await app.request('/s/b7Y', {}, mockEnv);
    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe(longUrl);
  });

  it('returns 404 for nonexistent short code', async () => {
    const res = await app.request('/zzz', {}, mockEnv);
    expect(res.status).toBe(404);
  });
});
