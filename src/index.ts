import { type Context, Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { syncRssFeed } from './sync';
import type { Bindings, KvSyndicatedItem } from './types';
import { getErrorMessage } from './utils/format';

const app = new Hono<{ Bindings: Bindings }>();

app.use('*', logger());
app.use('*', cors());

app.onError((err, c) => {
  console.error('Worker error:', err);
  return c.json(
    {
      status: 'error',
      message: err.message || 'Internal Server Error',
      name: err.name,
    },
    500
  );
});

/**
 * Health check & instance state endpoint.
 */
app.get('/', async (c) => {
  if (!c.env?.KV) {
    return c.json(
      {
        service: 'syndicator',
        status: 'misconfigured',
        error:
          'KV binding "KV" is missing. Please add a KV namespace binding named "KV" in Cloudflare Dashboard (Worker Settings -> Bindings -> KV).',
      },
      500
    );
  }

  const [latestUrl, lastSyncedAt, etag] = await Promise.all([
    c.env.KV.get('rss:latest_url'),
    c.env.KV.get('rss:last_synced_at'),
    c.env.KV.get('rss:etag'),
  ]);

  const blueskyConfigured = Boolean(c.env.BLUESKY_IDENTIFIER && c.env.BLUESKY_PASSWORD);
  const mastodonConfigured = Boolean(c.env.MASTODON_ACCESS_TOKEN);
  const xConfigured = Boolean(
    (c.env.X_API_KEY && c.env.X_API_SECRET && c.env.X_ACCESS_TOKEN && c.env.X_ACCESS_SECRET) ||
      c.env.X_ACCESS_TOKEN
  );
  const threadsConfigured = Boolean(c.env.THREADS_ACCESS_TOKEN);
  const nostrConfigured = Boolean(c.env.NOSTR_PRIVATE_KEY);

  return c.json({
    service: 'syndicator',
    storage: 'cloudflare-kv',
    status: 'healthy',
    timestamp: new Date().toISOString(),
    config: {
      feedUrl: c.env.RSS_FEED_URL ?? 'not_set',
      shortDomain: c.env.SHORT_DOMAIN || 'not configured',
      cronSchedule: '0 */4 * * * (every 4 hours)',
      platforms: {
        bluesky: {
          configured: blueskyConfigured,
          identifier: c.env.BLUESKY_IDENTIFIER ?? null,
        },
        mastodon: {
          configured: mastodonConfigured,
          instance: c.env.MASTODON_INSTANCE_URL || 'https://mastodon.social',
        },
        x: {
          configured: xConfigured,
          auth: c.env.X_API_KEY ? 'oauth1' : c.env.X_ACCESS_TOKEN ? 'oauth2' : 'none',
        },
        threads: {
          configured: threadsConfigured,
        },
        nostr: {
          configured: nostrConfigured,
        },
      },
    },
    state: {
      lastSyncedAt,
      latestUrl,
      etag,
    },
  });
});

/**
 * Manually trigger RSS synchronization immediately.
 */
app.post('/sync', async (c) => {
  // If API_SECRET is configured, require Bearer token
  if (c.env.API_SECRET) {
    const authHeader = c.req.header('Authorization');
    if (authHeader !== `Bearer ${c.env.API_SECRET}`) {
      return c.json({ error: 'Unauthorized: Invalid API secret.' }, 401);
    }
  }

  let force = false;
  try {
    const body = await c.req.json<{ force?: boolean }>();
    force = Boolean(body?.force);
  } catch {
    // Empty body is acceptable
  }

  try {
    const summary = await syncRssFeed(c.env, { force });
    return c.json(summary);
  } catch (err: unknown) {
    return c.json(
      {
        success: false,
        error: getErrorMessage(err),
      },
      500
    );
  }
});

/**
 * Query syndicated history from Cloudflare KV.
 * Key format: `post:<canonical_url>`
 */
app.get('/history', async (c) => {
  const list = await c.env.KV.list({ prefix: 'post:' });
  const items: KvSyndicatedItem[] = [];

  for (const key of list.keys) {
    const raw = await c.env.KV.get(key.name);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as KvSyndicatedItem;
        items.push(parsed);
      } catch {
        // Ignore unparseable entries
      }
    }
  }

  return c.json({
    count: items.length,
    items,
  });
});

/**
 * Reusable handler for 301 short URL redirection.
 */
async function handleShortRedirect(c: Context<{ Bindings: Bindings }>) {
  const code = c.req.param('code');
  const targetUrl = await c.env.KV.get(`short:${code}`);

  if (!targetUrl) {
    return c.text('Not found', 404);
  }

  c.header('Cache-Control', 'public, max-age=86400');
  return c.redirect(targetUrl, 301);
}

/**
 * Short URL 301 redirection routes (supports both /:code and /s/:code).
 * Regex constraint ensures it only matches 3-8 char alphanumeric short codes.
 */
app.get('/:code{[0-9a-zA-Z]{3,8}}', handleShortRedirect);
app.get('/s/:code{[0-9a-zA-Z]{3,8}}', handleShortRedirect);

export { app };

export default {
  fetch: app.fetch,
  /**
   * Cloudflare Cron Trigger handler running every 4 hours (0 *\/4 * * *).
   */
  async scheduled(_event: ScheduledEvent, env: Bindings, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      syncRssFeed(env).catch((err: unknown) => {
        console.error('[Syndicator Cron] Scheduled RSS sync failed:', err);
      })
    );
  },
};
