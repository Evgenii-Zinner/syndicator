import { describe, expect, it } from 'bun:test';
import { nip19 } from 'nostr-tools';
import { generateSecretKey } from 'nostr-tools/pure';
import { parseNostrPrivateKey, resolveNostrRelays, syndicateToNostr } from '../src/platforms/nostr';
import type { Bindings, SyndicatePayload } from '../src/types';

describe('Nostr Platform Syndication', () => {
  const sampleSecretKey = generateSecretKey();
  const sampleNsec = nip19.nsecEncode(sampleSecretKey);
  const sampleHex = Array.from(sampleSecretKey)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  const dummyEnv: Bindings = {
    KV: {} as KVNamespace,
    RSS_FEED_URL: 'https://example.com/rss.xml',
    BLUESKY_IDENTIFIER: 'example.com',
    NOSTR_PRIVATE_KEY: sampleNsec,
    NOSTR_RELAYS: 'wss://mock.relay.one,wss://mock.relay.two',
  };

  const payload: SyndicatePayload = {
    canonicalUrl: 'https://example.com/articles/nostr-protocol',
    shortUrl: 'https://s.example.com/n0s',
    title: 'Nostr Protocol Guide',
    excerpt: 'Comprehensive deep dive into the Nostr decentralized protocol.',
  };

  it('parses both nsec and 64-char hex private keys accurately', () => {
    const fromNsec = parseNostrPrivateKey(sampleNsec);
    expect(fromNsec).toEqual(sampleSecretKey);

    const fromHex = parseNostrPrivateKey(sampleHex);
    expect(fromHex).toEqual(sampleSecretKey);

    expect(() => parseNostrPrivateKey('invalid-key')).toThrow();
  });

  it('resolves configured relays or falls back to defaults', () => {
    const configured = resolveNostrRelays(dummyEnv);
    expect(configured).toEqual(['wss://mock.relay.one', 'wss://mock.relay.two']);

    const defaults = resolveNostrRelays({ ...dummyEnv, NOSTR_RELAYS: undefined });
    expect(defaults.length).toBeGreaterThanOrEqual(2);
    expect(defaults[0]).toContain('wss://');
  });

  it('skips syndication when NOSTR_PRIVATE_KEY is missing', async () => {
    const envWithoutKey: Bindings = {
      ...dummyEnv,
      NOSTR_PRIVATE_KEY: undefined,
    };

    const result = await syndicateToNostr(payload, envWithoutKey);
    expect(result.status).toBe('skipped');
    if (result.status === 'skipped') {
      expect(result.reason).toContain('not configured');
    }
  });

  it('signs a NIP-01 Kind 1 event and broadcasts to relays with OK acknowledgment', async () => {
    // Mock WebSocket for relay testing
    class MockRelayWebSocket {
      readyState = 1; // WebSocket.OPEN
      private listeners = new Map<string, ((event: unknown) => void)[]>();

      addEventListener(type: string, listener: (event: unknown) => void) {
        const arr = this.listeners.get(type) ?? [];
        arr.push(listener);
        this.listeners.set(type, arr);
      }

      send(data: string) {
        const parsed = JSON.parse(data);
        if (Array.isArray(parsed) && parsed[0] === 'EVENT') {
          const event = parsed[1] as { id: string; content: string; kind: number };
          // Simulate relay responding with NIP-01 OK confirmation
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
      const result = await syndicateToNostr(payload, dummyEnv);

      expect(result.status).toBe('posted');
      if (result.status === 'posted') {
        expect(result.remoteId.length).toBe(64); // 32-byte hex hash
        expect(result.url).toContain('https://njump.me/note1');
      }
    } finally {
      globalThis.WebSocket = originalWebSocket;
    }
  });

  it('returns status failed when all relays reject or fail', async () => {
    class FailingRelayWebSocket {
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
              h({ data: JSON.stringify(['OK', event.id, false, 'blocked: spam protection']) });
            }
          }, 10);
        }
      }

      close() {
        this.readyState = 3;
      }
    }

    const originalWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = FailingRelayWebSocket as unknown as typeof WebSocket;

    try {
      const result = await syndicateToNostr(payload, dummyEnv);
      expect(result.status).toBe('failed');
      if (result.status === 'failed') {
        expect(result.error).toContain('Failed to broadcast');
        expect(result.error).toContain('spam protection');
      }
    } finally {
      globalThis.WebSocket = originalWebSocket;
    }
  });
});
