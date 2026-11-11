import { PLATFORMS } from '../config/platforms';
import type { Bindings, PlatformResult, SyndicatePayload } from '../types';
import { planSocialThread } from '../utils/thread';

interface XTweetResponse {
  readonly data?: {
    readonly id: string;
    readonly text: string;
  };
  readonly errors?: readonly {
    readonly message: string;
    readonly code?: number;
  }[];
}

/**
 * Syndicates an article to X (formerly Twitter) using the Twitter API v2 (`POST /2/tweets`).
 *
 * Characteristics:
 * - Employs the algorithmic link-in-reply strategy (`PLATFORMS.x`):
 *   Post 1 contains the clean hook/excerpt to maximize organic algorithmic reach.
 *   Post 2 contains the destination link chained via `reply: { in_reply_to_tweet_id }`.
 * - Validates against 280 weighted characters.
 *
 * @param data - The syndication payload containing canonical URL, short URL, title, and excerpt.
 * @param env - Cloudflare Worker environment bindings including `X_ACCESS_TOKEN`.
 * @returns PlatformResult indicating posted, skipped, or failed.
 */
export async function syndicateToX(data: SyndicatePayload, env: Bindings): Promise<PlatformResult> {
  const accessToken = env.X_ACCESS_TOKEN;

  if (!accessToken) {
    return {
      status: 'skipped',
      reason: 'X access token not configured (X_ACCESS_TOKEN).',
    };
  }

  // 1. Plan thread using X 280-char algorithmic reply strategy
  const targetLink = data.shortUrl || data.canonicalUrl;
  const content = (data.excerpt?.trim() || data.title).trim();
  const threadPlan = planSocialThread({
    text: content,
    shortUrl: targetLink,
    platform: PLATFORMS.x,
  });

  let rootTweetId: string | undefined;
  let previousTweetId: string | undefined;

  for (let i = 0; i < threadPlan.posts.length; i++) {
    const postText = threadPlan.posts[i] ?? '';

    const payload: Record<string, unknown> = {
      text: postText,
      ...(previousTweetId ? { reply: { in_reply_to_tweet_id: previousTweetId } } : {}),
    };

    const res = await fetch('https://api.twitter.com/2/tweets', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errorText = await res.text();
      return {
        status: 'failed',
        error: `X API error (${res.status}): ${errorText}`,
      };
    }

    const result = (await res.json()) as XTweetResponse;
    const tweetId = result?.data?.id;

    if (!tweetId) {
      return {
        status: 'failed',
        error: 'X API did not return tweet ID in response.',
      };
    }

    if (i === 0) {
      rootTweetId = tweetId;
    }
    previousTweetId = tweetId;
  }

  if (!rootTweetId) {
    return {
      status: 'failed',
      error: 'No tweets created for X syndication.',
    };
  }

  return {
    status: 'posted',
    remoteId: rootTweetId,
    url: `https://x.com/i/status/${rootTweetId}`,
  };
}
