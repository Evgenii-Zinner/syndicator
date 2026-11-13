import { nip19 } from 'nostr-tools';
import { type EventTemplate, finalizeEvent } from 'nostr-tools/pure';
import { PLATFORMS } from '../config/platforms';
import type { Bindings, PlatformResult, SyndicatePayload } from '../types';
import { planSocialThread } from '../utils/thread';

/**
 * Default public Nostr relays used when NOSTR_RELAYS is not explicitly configured.
 */
export const DEFAULT_NOSTR_RELAYS: readonly string[] = [
  'wss://relay.nostr.com',
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://nostr.bitcoiner.social',
  'wss://nostr.mom',
  'wss://relay.snort.social',
  'wss://offchain.pub',
];

/**
 * Parses a private key string (either 64-character hex or bech32 `nsec1...`) into a 32-byte Uint8Array.
 *
 * @param keyInput - Hex or bech32 encoded private key.
 * @returns 32-byte secret key Uint8Array.
 */
export function parseNostrPrivateKey(keyInput: string): Uint8Array {
  const trimmed = keyInput.trim();

  if (trimmed.startsWith('nsec1')) {
    const decoded = nip19.decode(trimmed);
    if (decoded.type === 'nsec') {
      return decoded.data;
    }
    throw new Error(`Invalid nsec key: expected type 'nsec', got '${decoded.type}'.`);
  }

  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    const match = trimmed.match(/.{1,2}/g);
    if (match) {
      return new Uint8Array(match.map((byte) => Number.parseInt(byte, 16)));
    }
  }

  throw new Error(
    'Invalid Nostr private key. Must be a 64-character hex string or bech32 nsec1... key.'
  );
}

/**
 * Resolves configured relay URLs from bindings or falls back to standard public relays.
 */
export function resolveNostrRelays(env: Bindings): readonly string[] {
  if (env.NOSTR_RELAYS?.trim()) {
    return env.NOSTR_RELAYS.split(',')
      .map((r) => r.trim())
      .filter(Boolean)
      .map((r) => (r.startsWith('ws://') || r.startsWith('wss://') ? r : `wss://${r}`));
  }
  return DEFAULT_NOSTR_RELAYS;
}

/**
 * Establishes an outbound WebSocket connection to a Nostr relay.
 * Works seamlessly across both Cloudflare Workers (`fetch(wss://...)` with `Upgrade: websocket`)
 * and standard environments (Node / Bun `WebSocket`).
 */
async function connectToRelay(relayUrl: string, timeoutMs: number): Promise<WebSocket> {
  let wsUrl = relayUrl.trim();
  if (!wsUrl.startsWith('ws://') && !wsUrl.startsWith('wss://')) {
    wsUrl = `wss://${wsUrl}`;
  }

  // 1. Cloudflare Workers outbound WebSocket upgrade via fetch
  try {
    const res = await fetch(wsUrl, {
      headers: {
        Upgrade: 'websocket',
        'User-Agent': 'Syndicator-Bot/1.0 (+https://github.com/Evgenii-Zinner/syndicator)',
      },
    });
    const ws = (res as unknown as { webSocket?: WebSocket }).webSocket;
    if (ws) {
      (ws as unknown as { accept: () => void }).accept();
      return ws;
    }
  } catch {
    // If running in local tests or standard runtime, proceed to standard constructor
  }

  // 2. Standard WebSocket constructor
  if (typeof WebSocket !== 'undefined') {
    const ws = new WebSocket(wsUrl);
    if (ws.readyState === 1 /* OPEN */) {
      return ws;
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`WebSocket connection timeout to ${relayUrl}`)),
        timeoutMs
      );
      ws.addEventListener(
        'open',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true }
      );
      ws.addEventListener(
        'error',
        () => {
          clearTimeout(timer);
          reject(new Error(`WebSocket connection error to ${relayUrl}`));
        },
        { once: true }
      );
    });
    return ws;
  }

  throw new Error(`WebSocket client is not supported in this runtime for ${relayUrl}`);
}

interface RelayPublishResult {
  readonly relay: string;
  readonly success: boolean;
  readonly message?: string;
}

/**
 * Broadcasts a signed Nostr event to a single relay and awaits the NIP-01 `["OK", id, ...]` acknowledgement.
 */
async function publishToRelay(
  relayUrl: string,
  event: Record<string, unknown>,
  eventId: string,
  timeoutMs = 7000
): Promise<RelayPublishResult> {
  let ws: WebSocket | null = null;

  return new Promise<RelayPublishResult>((resolve) => {
    let settled = false;

    const cleanup = () => {
      if (ws) {
        try {
          ws.close();
        } catch {
          // Ignore close errors
        }
      }
    };

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        cleanup();
        resolve({ relay: relayUrl, success: false, message: 'Relay timeout' });
      }
    }, timeoutMs);

    connectToRelay(relayUrl, timeoutMs)
      .then((socket) => {
        ws = socket;

        ws.addEventListener('message', (msgEvent: MessageEvent) => {
          try {
            const rawData =
              typeof msgEvent.data === 'string' ? msgEvent.data : msgEvent.data.toString();
            const parsed = JSON.parse(rawData);

            if (Array.isArray(parsed) && parsed[0] === 'OK' && parsed[1] === eventId) {
              if (!settled) {
                settled = true;
                clearTimeout(timer);
                cleanup();
                const isOk = Boolean(parsed[2]);
                const reason = typeof parsed[3] === 'string' ? parsed[3] : '';
                resolve({ relay: relayUrl, success: isOk, message: reason });
              }
            }
          } catch {
            // Ignore non-json messages
          }
        });

        ws.addEventListener('error', () => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            cleanup();
            resolve({ relay: relayUrl, success: false, message: 'Socket error' });
          }
        });

        // Send NIP-01 EVENT message
        ws.send(JSON.stringify(['EVENT', event]));
      })
      .catch((err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          cleanup();
          resolve({
            relay: relayUrl,
            success: false,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      });
  });
}

/**
 * Syndicates an article to Nostr as a NIP-01 Short Text Note (Kind 1).
 *
 * Characteristics:
 * - Employs non-algorithmic inline link strategy (`PLATFORMS.nostr`): excerpt + link directly in post.
 * - Signs event with BIP-340 Schnorr signatures over secp256k1 using `nostr-tools`.
 * - Attaches `r` (reference URL) tag pointing to canonical/short URL.
 * - Broadcasts simultaneously to configured Nostr relays via WebSocket.
 * - Confirms successful publication if at least one relay returns `["OK", id, true]`.
 *
 * @param data - The syndication payload containing canonical URL, short URL, title, and excerpt.
 * @param env - Cloudflare Worker environment bindings including `NOSTR_PRIVATE_KEY` and optional `NOSTR_RELAYS`.
 * @returns PlatformResult indicating posted, skipped, or failed.
 */
export async function syndicateToNostr(
  data: SyndicatePayload,
  env: Bindings
): Promise<PlatformResult> {
  const privateKeyRaw = env.NOSTR_PRIVATE_KEY;

  if (!privateKeyRaw) {
    return {
      status: 'skipped',
      reason: 'Nostr private key not configured (NOSTR_PRIVATE_KEY).',
    };
  }

  let secretKey: Uint8Array;
  try {
    secretKey = parseNostrPrivateKey(privateKeyRaw);
  } catch (err) {
    return {
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // 1. Plan post text using Nostr 500-char non-algorithmic inline strategy
  const targetLink = data.shortUrl || data.canonicalUrl;
  const content = (data.excerpt?.trim() || data.title).trim();
  const threadPlan = planSocialThread({
    text: content,
    shortUrl: targetLink,
    platform: PLATFORMS.nostr,
  });

  const postText = threadPlan.posts[0] ?? `${content}\n\n${targetLink}`;

  // 2. Build and sign NIP-01 Kind 1 event
  const unsignedEvent: EventTemplate = {
    kind: 1,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['r', targetLink],
      ['title', data.title],
    ],
    content: postText,
  };

  const signedEvent = finalizeEvent(unsignedEvent, secretKey);

  // 3. Broadcast to relays
  const relays = resolveNostrRelays(env);
  const eventPayload = signedEvent as unknown as Record<string, unknown>;

  const results = await Promise.all(
    relays.map((relay) => publishToRelay(relay, eventPayload, signedEvent.id))
  );

  const successfulRelays = results.filter((r) => r.success);

  if (successfulRelays.length === 0) {
    const errorSummary = results.map((r) => `${r.relay} (${r.message || 'failed'})`).join('; ');
    return {
      status: 'failed',
      error: `Failed to broadcast Nostr event to any relay: ${errorSummary}`,
    };
  }

  const noteId = nip19.noteEncode(signedEvent.id);

  return {
    status: 'posted',
    remoteId: signedEvent.id,
    url: `https://njump.me/${noteId}`,
  };
}
