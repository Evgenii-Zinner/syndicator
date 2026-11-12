export type { LinkStrategy, PlatformConfig, PlatformId } from './config/platforms';

declare global {
  interface KVNamespace {
    get(key: string, options?: { type?: 'text' }): Promise<string | null>;
    get(key: string, options: { type: 'json' }): Promise<unknown | null>;
    put(
      key: string,
      value: string | ArrayBuffer | ReadableStream,
      options?: { expirationTtl?: number }
    ): Promise<void>;
    delete(key: string): Promise<void>;
    list(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<{
      keys: { name: string; expiration?: number; metadata?: unknown }[];
      list_complete: boolean;
      cursor?: string;
    }>;
  }

  interface ExecutionContext {
    waitUntil(promise: Promise<unknown>): void;
    passThroughOnException(): void;
  }

  interface ScheduledEvent {
    readonly cron: string;
    readonly scheduledTime: number;
    readonly type: string;
    noRetry(): void;
  }
}

/**
 * Supported syndication target platforms.
 */
export type Platform = 'bluesky' | 'x' | 'threads' | 'mastodon' | 'nostr' | 'telegram' | 'devto';

/**
 * Cloudflare Worker environment bindings, variables, and secrets.
 */
export interface Bindings {
  // Storage (Cloudflare KV only)
  readonly KV: KVNamespace;

  // Environment Variables (Configured in wrangler.jsonc vars or dashboard)
  readonly ENVIRONMENT?: string;
  readonly RSS_FEED_URL: string;
  readonly BLUESKY_IDENTIFIER: string;
  readonly BLUESKY_SERVICE?: string;
  readonly SHORT_DOMAIN?: string;
  readonly MASTODON_INSTANCE_URL?: string;
  readonly THREADS_USER_ID?: string;
  readonly NOSTR_RELAYS?: string;
  readonly TELEGRAM_CHAT_ID?: string;
  readonly DEVTO_PUBLISHED?: string;

  // Secrets (Configured via `wrangler secret put` or Cloudflare Dashboard)
  readonly BLUESKY_PASSWORD?: string;
  readonly MASTODON_ACCESS_TOKEN?: string;
  // X (Twitter) - OAuth 1.0a (recommended, permanent):
  readonly X_API_KEY?: string;
  readonly X_API_SECRET?: string;
  readonly X_ACCESS_TOKEN?: string;
  readonly X_ACCESS_SECRET?: string;
  readonly THREADS_ACCESS_TOKEN?: string;
  readonly NOSTR_PRIVATE_KEY?: string;
  readonly TELEGRAM_BOT_TOKEN?: string;
  readonly DEVTO_API_KEY?: string;
  readonly API_SECRET?: string;
}

/**
 * Content payload to syndicate to social platforms.
 */
export interface SyndicatePayload {
  readonly canonicalUrl: string;
  readonly shortUrl?: string;
  readonly title: string;
  readonly excerpt?: string;
  readonly thumbnailUrl?: string;
  readonly contentHtml?: string;
}

/**
 * Result of publishing to a social platform.
 */
export type PlatformResult =
  | { readonly status: 'posted'; readonly remoteId: string; readonly url: string }
  | {
      readonly status: 'skipped';
      readonly reason: string;
      readonly remoteId?: string;
      readonly url?: string;
    }
  | { readonly status: 'failed'; readonly error: string };

/**
 * Record stored in Cloudflare KV for each syndicated post.
 * Key format: `post:<canonical_url>`
 */
export interface KvSyndicatedItem {
  readonly link: string;
  readonly shortCode?: string;
  readonly shortUrl?: string;
  readonly title: string;
  readonly pubDate?: string;
  readonly syndicatedAt: string;
  readonly bluesky?: {
    readonly uri: string;
    readonly url: string;
  };
  readonly mastodon?: {
    readonly id: string;
    readonly url: string;
  };
  readonly x?: {
    readonly id: string;
    readonly url: string;
  };
  readonly threads?: {
    readonly id: string;
    readonly url: string;
  };
  readonly nostr?: {
    readonly id: string;
    readonly url?: string;
  };
  readonly telegram?: {
    readonly messageId: number;
    readonly url?: string;
  };
  readonly devto?: {
    readonly id: number;
    readonly url: string;
  };
  readonly status?: string;
}

/**
 * Per-item result of an RSS sync operation.
 */
export interface SyncItemResult {
  readonly link: string;
  readonly shortUrl?: string;
  readonly title: string;
  readonly status: 'posted' | 'skipped' | 'failed';
  readonly reason?: string;
  readonly error?: string;
  readonly blueskyUrl?: string;
  readonly mastodonUrl?: string;
  readonly xUrl?: string;
  readonly threadsUrl?: string;
  readonly nostrUrl?: string;
  readonly telegramUrl?: string;
  readonly devtoUrl?: string;
}

/**
 * Comprehensive summary of an RSS sync execution.
 */
export interface SyncSummary {
  readonly success: boolean;
  readonly feedUrl: string;
  readonly httpStatus: number;
  readonly feedChanged: boolean;
  readonly itemsProcessed: number;
  readonly postedCount: number;
  readonly skippedCount: number;
  readonly failedCount: number;
  readonly items: readonly SyncItemResult[];
}
