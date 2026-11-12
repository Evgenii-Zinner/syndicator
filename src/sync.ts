import { syndicateToBluesky } from './platforms/bluesky';
import { syndicateToDevto } from './platforms/devto';
import { syndicateToMastodon } from './platforms/mastodon';
import { syndicateToNostr } from './platforms/nostr';
import { syndicateToTelegram } from './platforms/telegram';
import { syndicateToThreads } from './platforms/threads';
import { syndicateToX } from './platforms/x';
import type {
  Bindings,
  KvSyndicatedItem,
  PlatformResult,
  SyncItemResult,
  SyncSummary,
} from './types';
import { getErrorMessage } from './utils/format';
import { parseRssFeed } from './utils/rss';
import { getOrCreateShortCode } from './utils/shortener';

/**
 * Executes a full RSS sync against the configured feed URL.
 * - On first run: establishes baseline by saving latest URL and exits immediately without posting.
 * - On subsequent runs: uses HTTP conditional requests (ETag) and a high-water mark to detect only new posts,
 *   assigns a 3-character Base62 short URL, and publishes them sequentially from oldest to newest to configured platforms.
 * - On failure: stops batch to preserve chronological order, advances high-water mark ONLY to the last successful post,
 *   and skips caching ETag so failed items are retried on the next run.
 */
export async function syncRssFeed(
  env: Bindings,
  options?: { readonly force?: boolean }
): Promise<SyncSummary> {
  const feedUrl = env.RSS_FEED_URL?.trim();
  if (!feedUrl) {
    throw new Error("Missing required 'RSS_FEED_URL' environment variable.");
  }

  const shortDomain = env.SHORT_DOMAIN?.trim()
    ? env.SHORT_DOMAIN.trim().replace(/\/+$/, '')
    : undefined;

  // 1. Retrieve transport cache and latest seen URL from KV
  const [savedEtag, savedLastModified, savedLatestUrl] = await Promise.all([
    env.KV.get('rss:etag'),
    env.KV.get('rss:last_modified'),
    env.KV.get('rss:latest_url'),
  ]);

  // 2. Build HTTP request headers with conditional validation
  const headers: Record<string, string> = {
    'User-Agent': 'Syndicator-Bot/1.0 (+https://github.com/Evgenii-Zinner/syndicator)',
  };

  if (!options?.force) {
    if (savedEtag) {
      headers['If-None-Match'] = savedEtag;
    }
    if (savedLastModified) {
      headers['If-Modified-Since'] = savedLastModified;
    }
  }

  const res = await fetch(feedUrl, { headers });

  // 3. Fast Exit: HTTP 304 Not Modified
  if (res.status === 304) {
    await env.KV.put('rss:last_synced_at', new Date().toISOString());
    return {
      success: true,
      feedUrl,
      httpStatus: 304,
      feedChanged: false,
      itemsProcessed: 0,
      postedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      items: [],
    };
  }

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Failed to fetch RSS feed (${res.status}): ${errorText}`);
  }

  const rawXml = await res.text();
  const feedItems = parseRssFeed(rawXml);

  if (feedItems.length === 0) {
    return {
      success: true,
      feedUrl,
      httpStatus: res.status,
      feedChanged: false,
      itemsProcessed: 0,
      postedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      items: [],
    };
  }

  const topItem = feedItems[0];
  const isFirstRun = savedLatestUrl === null;

  // 4. First Run Baseline: save latest URL, check nothing, post nothing
  if (isFirstRun && !options?.force) {
    if (topItem) {
      await env.KV.put('rss:latest_url', topItem.link);
    }

    const responseEtag = res.headers.get('etag');
    if (responseEtag) {
      await env.KV.put('rss:etag', responseEtag);
    }
    const responseLastModified = res.headers.get('last-modified');
    if (responseLastModified) {
      await env.KV.put('rss:last_modified', responseLastModified);
    }
    await env.KV.put('rss:last_synced_at', new Date().toISOString());

    return {
      success: true,
      feedUrl,
      httpStatus: res.status,
      feedChanged: true,
      itemsProcessed: 0,
      postedCount: 0,
      skippedCount: feedItems.length,
      failedCount: 0,
      items: [],
    };
  }

  // 5. Subsequent Runs: Fast exit if top item is unchanged
  if (!options?.force && topItem && topItem.link === savedLatestUrl) {
    await env.KV.put('rss:last_synced_at', new Date().toISOString());
    return {
      success: true,
      feedUrl,
      httpStatus: res.status,
      feedChanged: false,
      itemsProcessed: 0,
      postedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      items: [],
    };
  }

  // 6. Slice only new posts appearing above the saved latest URL (or include latest item if force is enabled)
  const latestIndex = savedLatestUrl
    ? feedItems.findIndex((item) => item.link === savedLatestUrl)
    : -1;
  const newItems =
    options?.force && latestIndex !== -1
      ? feedItems.slice(0, Math.max(1, latestIndex))
      : latestIndex === -1
        ? feedItems
        : feedItems.slice(0, latestIndex);

  // Process sequentially from oldest to newest to preserve publication order
  const itemsToPost = [...newItems].reverse();
  const itemResults: SyncItemResult[] = [];

  let postedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;
  let lastSuccessfulUrl: string | undefined;

  for (const item of itemsToPost) {
    const kvKey = `post:${item.link}`;
    const existingRaw = await env.KV.get(kvKey);
    let existingRecord: KvSyndicatedItem | null = null;
    if (existingRaw) {
      try {
        existingRecord = JSON.parse(existingRaw) as KvSyndicatedItem;
      } catch {
        // Ignore JSON parse errors for backward compatibility
      }
    }

    // Check if already fully syndicated across all enabled platforms
    const bskyDone = Boolean(existingRecord?.bluesky || !env.BLUESKY_PASSWORD);
    const mastodonDone = Boolean(existingRecord?.mastodon || !env.MASTODON_ACCESS_TOKEN);
    const xDone = Boolean(existingRecord?.x || (!env.X_ACCESS_TOKEN && !env.X_API_KEY));
    const threadsDone = Boolean(existingRecord?.threads || !env.THREADS_ACCESS_TOKEN);
    const nostrDone = Boolean(existingRecord?.nostr || !env.NOSTR_PRIVATE_KEY);
    const telegramDone = Boolean(existingRecord?.telegram || !env.TELEGRAM_BOT_TOKEN);
    const devtoDone = Boolean(existingRecord?.devto || !env.DEVTO_API_KEY);

    if (
      existingRecord &&
      bskyDone &&
      mastodonDone &&
      xDone &&
      threadsDone &&
      nostrDone &&
      telegramDone &&
      devtoDone &&
      !options?.force
    ) {
      skippedCount++;
      lastSuccessfulUrl = item.link;
      itemResults.push({
        link: item.link,
        title: item.title,
        status: 'skipped',
        reason: 'Already syndicated',
      });
      continue;
    }

    // Generate or retrieve 3-character Base62 short URL (when SHORT_DOMAIN is configured)
    let shortUrl: string | undefined;
    let shortCode: string | undefined;
    if (shortDomain) {
      try {
        shortCode = await getOrCreateShortCode(env.KV, item.link);
        shortUrl = `https://${shortDomain}/${shortCode}`;
      } catch {
        // Non-fatal if shortener fails; falls back to canonical URL
      }
    }

    const payload = {
      canonicalUrl: item.link,
      shortUrl,
      title: item.title,
      excerpt: item.description,
      contentHtml: item.contentEncoded,
    };

    try {
      // Syndicate to Bluesky (if not already posted)
      const bskyResult: PlatformResult = existingRecord?.bluesky
        ? {
            status: 'posted',
            remoteId: existingRecord.bluesky.uri,
            url: existingRecord.bluesky.url,
          }
        : await syndicateToBluesky(payload, env);

      // Syndicate to Mastodon (if not already posted)
      const mastodonResult: PlatformResult = existingRecord?.mastodon
        ? {
            status: 'posted',
            remoteId: existingRecord.mastodon.id,
            url: existingRecord.mastodon.url,
          }
        : await syndicateToMastodon(payload, env);

      // Syndicate to X (if not already posted)
      const xResult: PlatformResult = existingRecord?.x
        ? {
            status: 'posted',
            remoteId: existingRecord.x.id,
            url: existingRecord.x.url,
          }
        : await syndicateToX(payload, env);

      // Syndicate to Threads (if not already posted)
      const threadsResult: PlatformResult = existingRecord?.threads
        ? {
            status: 'posted',
            remoteId: existingRecord.threads.id,
            url: existingRecord.threads.url,
          }
        : await syndicateToThreads(payload, env);

      // Syndicate to Nostr (if not already posted)
      const nostrResult: PlatformResult = existingRecord?.nostr
        ? {
            status: 'posted',
            remoteId: existingRecord.nostr.id,
            url: existingRecord.nostr.url ?? `https://njump.me/${existingRecord.nostr.id}`,
          }
        : await syndicateToNostr(payload, env);

      // Syndicate to Telegram (if not already posted)
      const telegramResult: PlatformResult = existingRecord?.telegram
        ? {
            status: 'posted',
            remoteId: String(existingRecord.telegram.messageId),
            url: existingRecord.telegram.url ?? '',
          }
        : await syndicateToTelegram(payload, env);

      // Syndicate to DEV.to (if not already posted)
      const devtoResult: PlatformResult = existingRecord?.devto
        ? {
            status: 'posted',
            remoteId: String(existingRecord.devto.id),
            url: existingRecord.devto.url,
          }
        : await syndicateToDevto(payload, env);

      const hasFailures =
        bskyResult.status === 'failed' ||
        mastodonResult.status === 'failed' ||
        xResult.status === 'failed' ||
        threadsResult.status === 'failed' ||
        nostrResult.status === 'failed' ||
        telegramResult.status === 'failed' ||
        devtoResult.status === 'failed';
      const hasPosts =
        bskyResult.status === 'posted' ||
        mastodonResult.status === 'posted' ||
        xResult.status === 'posted' ||
        threadsResult.status === 'posted' ||
        nostrResult.status === 'posted' ||
        telegramResult.status === 'posted' ||
        devtoResult.status === 'posted';

      // Record any successful platforms in KV so retries do not duplicate them
      if (hasPosts) {
        const kvRecord: KvSyndicatedItem = {
          link: item.link,
          shortCode,
          shortUrl,
          title: item.title,
          pubDate: item.pubDate,
          syndicatedAt: new Date().toISOString(),
          ...(bskyResult.status === 'posted'
            ? { bluesky: { uri: bskyResult.remoteId, url: bskyResult.url } }
            : existingRecord?.bluesky
              ? { bluesky: existingRecord.bluesky }
              : {}),
          ...(mastodonResult.status === 'posted'
            ? { mastodon: { id: mastodonResult.remoteId, url: mastodonResult.url } }
            : existingRecord?.mastodon
              ? { mastodon: existingRecord.mastodon }
              : {}),
          ...(xResult.status === 'posted'
            ? { x: { id: xResult.remoteId, url: xResult.url } }
            : existingRecord?.x
              ? { x: existingRecord.x }
              : {}),
          ...(threadsResult.status === 'posted'
            ? { threads: { id: threadsResult.remoteId, url: threadsResult.url } }
            : existingRecord?.threads
              ? { threads: existingRecord.threads }
              : {}),
          ...(nostrResult.status === 'posted'
            ? { nostr: { id: nostrResult.remoteId, url: nostrResult.url } }
            : existingRecord?.nostr
              ? { nostr: existingRecord.nostr }
              : {}),
          ...(telegramResult.status === 'posted'
            ? {
                telegram: {
                  messageId: Number.parseInt(telegramResult.remoteId, 10),
                  url: telegramResult.url,
                },
              }
            : existingRecord?.telegram
              ? { telegram: existingRecord.telegram }
              : {}),
          ...(devtoResult.status === 'posted'
            ? {
                devto: {
                  id: Number.parseInt(devtoResult.remoteId, 10),
                  url: devtoResult.url,
                },
              }
            : existingRecord?.devto
              ? { devto: existingRecord.devto }
              : {}),
        };

        await env.KV.put(kvKey, JSON.stringify(kvRecord));
      }

      if (hasFailures) {
        failedCount++;
        const errorMsg = [
          bskyResult.status === 'failed' ? `Bluesky: ${bskyResult.error}` : null,
          mastodonResult.status === 'failed' ? `Mastodon: ${mastodonResult.error}` : null,
          xResult.status === 'failed' ? `X: ${xResult.error}` : null,
          threadsResult.status === 'failed' ? `Threads: ${threadsResult.error}` : null,
          nostrResult.status === 'failed' ? `Nostr: ${nostrResult.error}` : null,
          telegramResult.status === 'failed' ? `Telegram: ${telegramResult.error}` : null,
          devtoResult.status === 'failed' ? `DEV.to: ${devtoResult.error}` : null,
        ]
          .filter(Boolean)
          .join('; ');

        itemResults.push({
          link: item.link,
          shortUrl,
          title: item.title,
          status: 'failed',
          error: errorMsg,
          blueskyUrl: bskyResult.status === 'posted' ? bskyResult.url : undefined,
          mastodonUrl: mastodonResult.status === 'posted' ? mastodonResult.url : undefined,
          xUrl: xResult.status === 'posted' ? xResult.url : undefined,
          threadsUrl: threadsResult.status === 'posted' ? threadsResult.url : undefined,
          nostrUrl: nostrResult.status === 'posted' ? nostrResult.url : undefined,
          telegramUrl: telegramResult.status === 'posted' ? telegramResult.url : undefined,
          devtoUrl: devtoResult.status === 'posted' ? devtoResult.url : undefined,
        });
        // Stop batch on failure to prevent publishing subsequent posts out of chronological order
        break;
      }

      if (hasPosts) {
        postedCount++;
        lastSuccessfulUrl = item.link;
        itemResults.push({
          link: item.link,
          shortUrl,
          title: item.title,
          status: 'posted',
          blueskyUrl: bskyResult.status === 'posted' ? bskyResult.url : undefined,
          mastodonUrl: mastodonResult.status === 'posted' ? mastodonResult.url : undefined,
          xUrl: xResult.status === 'posted' ? xResult.url : undefined,
          threadsUrl: threadsResult.status === 'posted' ? threadsResult.url : undefined,
          nostrUrl: nostrResult.status === 'posted' ? nostrResult.url : undefined,
          telegramUrl: telegramResult.status === 'posted' ? telegramResult.url : undefined,
          devtoUrl: devtoResult.status === 'posted' ? devtoResult.url : undefined,
        });
      } else {
        skippedCount++;
        lastSuccessfulUrl = item.link;
        itemResults.push({
          link: item.link,
          shortUrl,
          title: item.title,
          status: 'skipped',
          reason: [
            bskyResult.status === 'skipped' ? `Bluesky: ${bskyResult.reason}` : null,
            mastodonResult.status === 'skipped' ? `Mastodon: ${mastodonResult.reason}` : null,
            xResult.status === 'skipped' ? `X: ${xResult.reason}` : null,
            threadsResult.status === 'skipped' ? `Threads: ${threadsResult.reason}` : null,
            nostrResult.status === 'skipped' ? `Nostr: ${nostrResult.reason}` : null,
            telegramResult.status === 'skipped' ? `Telegram: ${telegramResult.reason}` : null,
            devtoResult.status === 'skipped' ? `DEV.to: ${devtoResult.reason}` : null,
          ]
            .filter(Boolean)
            .join('; '),
        });
      }
    } catch (err: unknown) {
      failedCount++;
      itemResults.push({
        link: item.link,
        shortUrl,
        title: item.title,
        status: 'failed',
        error: getErrorMessage(err),
      });
      // Stop batch on failure to prevent publishing subsequent posts out of chronological order
      break;
    }
  }

  // 7. Advance high-water mark ONLY to the latest successfully syndicated item
  if (lastSuccessfulUrl) {
    await env.KV.put('rss:latest_url', lastSuccessfulUrl);
  }

  // Only cache transport headers if all items succeeded without failures
  // If an item failed, clear cache so the next run is guaranteed to re-fetch and retry
  if (failedCount === 0) {
    const responseEtag = res.headers.get('etag');
    if (responseEtag) {
      await env.KV.put('rss:etag', responseEtag);
    }
    const responseLastModified = res.headers.get('last-modified');
    if (responseLastModified) {
      await env.KV.put('rss:last_modified', responseLastModified);
    }
  } else {
    await env.KV.delete('rss:etag');
    await env.KV.delete('rss:last_modified');
  }

  await env.KV.put('rss:last_synced_at', new Date().toISOString());

  return {
    success: failedCount === 0 || postedCount > 0,
    feedUrl,
    httpStatus: res.status,
    feedChanged: true,
    itemsProcessed: itemsToPost.length,
    postedCount,
    skippedCount,
    failedCount,
    items: itemResults,
  };
}
