import { PLATFORMS } from '../config/platforms';
import type { Bindings, PlatformResult, SyndicatePayload } from '../types';
import { planSocialThread } from '../utils/thread';

interface MastodonStatusResponse {
  readonly id: string;
  readonly url?: string;
  readonly uri?: string;
}

/**
 * Computes a deterministic 32-character hex idempotency key using Web Crypto SHA-256.
 * Mastodon instances cache this key for 1 hour to prevent duplicate statuses if network retries occur.
 *
 * @param canonicalUrl - The canonical article URL.
 * @param segmentIndex - The 0-based index of the thread segment.
 * @returns 32-character hexadecimal digest.
 */
async function generateIdempotencyKey(canonicalUrl: string, segmentIndex: number): Promise<string> {
  const input = new TextEncoder().encode(`mastodon:${canonicalUrl}:${segmentIndex}`);
  const digestBuffer = await crypto.subtle.digest('SHA-256', input);
  const bytes = new Uint8Array(digestBuffer);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32);
}

/**
 * Syndicates an article to Mastodon via REST API v1 (`POST /api/v1/statuses`).
 *
 * Characteristics:
 * - Uses Mastodon platform config (500 characters, non-algorithmic inline link).
 * - Multi-post threads are chained sequentially with `in_reply_to_id`.
 * - Employs `Idempotency-Key` headers per segment to guard against double-posting on retries.
 *
 * @param data - The syndication payload containing canonical URL, short URL, title, and excerpt.
 * @param env - Cloudflare Worker environment bindings including `MASTODON_ACCESS_TOKEN` and optional `MASTODON_INSTANCE_URL`.
 * @returns PlatformResult indicating posted, skipped, or failed.
 */
export async function syndicateToMastodon(
  data: SyndicatePayload,
  env: Bindings
): Promise<PlatformResult> {
  const accessToken = env.MASTODON_ACCESS_TOKEN;
  const instanceUrl = (env.MASTODON_INSTANCE_URL || 'https://mastodon.social').replace(/\/+$/, '');

  if (!accessToken) {
    return {
      status: 'skipped',
      reason: 'Mastodon access token not configured (MASTODON_ACCESS_TOKEN).',
    };
  }

  // 1. Plan thread using Mastodon 500-char non-algorithmic inline strategy
  const targetLink = data.shortUrl || data.canonicalUrl;
  const content = (data.excerpt?.trim() || data.title).trim();
  const threadPlan = planSocialThread({
    text: content,
    shortUrl: targetLink,
    platform: PLATFORMS.mastodon,
  });

  let rootStatus: MastodonStatusResponse | undefined;
  let previousStatusId: string | undefined;

  for (let i = 0; i < threadPlan.posts.length; i++) {
    const postText = threadPlan.posts[i] ?? '';
    const idempotencyKey = await generateIdempotencyKey(data.canonicalUrl, i);

    const payload: Record<string, unknown> = {
      status: postText,
      visibility: 'public',
      ...(previousStatusId ? { in_reply_to_id: previousStatusId } : {}),
    };

    const res = await fetch(`${instanceUrl}/api/v1/statuses`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errorText = await res.text();
      return {
        status: 'failed',
        error: `Mastodon API error (${res.status}): ${errorText}`,
      };
    }

    const status = (await res.json()) as MastodonStatusResponse;

    if (i === 0) {
      rootStatus = status;
    }
    previousStatusId = status.id;
  }

  if (!rootStatus) {
    return {
      status: 'failed',
      error: 'No statuses created for Mastodon syndication.',
    };
  }

  return {
    status: 'posted',
    remoteId: rootStatus.id,
    url: rootStatus.url || rootStatus.uri || `${instanceUrl}/@me/${rootStatus.id}`,
  };
}
