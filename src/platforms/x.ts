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
 * RFC 3986 percent-encoding for OAuth 1.0a signatures.
 */
function percentEncode(str: string): string {
  return encodeURIComponent(str).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

/**
 * Builds an RFC 5849 OAuth 1.0a Authorization header with HMAC-SHA1 signature.
 * Note: In OAuth 1.0a, JSON request bodies are not included in the signature base string (RFC 5849 §3.4.1.3).
 */
async function buildOAuth1Header(params: {
  method: string;
  url: string;
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessSecret: string;
}): Promise<string> {
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: params.apiKey,
    oauth_nonce: crypto.randomUUID().replace(/-/g, ''),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: params.accessToken,
    oauth_version: '1.0',
  };

  const sortedKeys = Object.keys(oauthParams).sort();
  const paramString = sortedKeys
    .map((k) => `${percentEncode(k)}=${percentEncode(oauthParams[k] ?? '')}`)
    .join('&');

  const baseString = [
    params.method.toUpperCase(),
    percentEncode(params.url),
    percentEncode(paramString),
  ].join('&');

  const signingKey = `${percentEncode(params.apiSecret)}&${percentEncode(params.accessSecret)}`;

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(signingKey),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign']
  );

  const sigBuffer = await crypto.subtle.sign(
    'HMAC',
    cryptoKey,
    new TextEncoder().encode(baseString)
  );
  const signature = btoa(String.fromCharCode(...new Uint8Array(sigBuffer)));

  oauthParams.oauth_signature = signature;

  return `OAuth ${Object.keys(oauthParams)
    .sort()
    .map((k) => `${percentEncode(k)}="${percentEncode(oauthParams[k] ?? '')}"`)
    .join(', ')}`;
}

/**
 * Syndicates an article to X (formerly Twitter) using the Twitter API v2 (`POST /2/tweets`).
 *
 * Authentication:
 * - Supports OAuth 1.0a (User Context) via `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, and `X_ACCESS_SECRET`.
 *   Tokens never expire in OAuth 1.0a.
 * - Supports OAuth 2.0 Bearer token fallback via `X_ACCESS_TOKEN`.
 *
 * Characteristics:
 * - Employs the algorithmic link-in-reply strategy (`PLATFORMS.x`):
 *   Post 1 contains the clean hook/excerpt to maximize organic algorithmic reach.
 *   Post 2 contains the destination link chained via `reply: { in_reply_to_tweet_id }`.
 * - Validates against 280 weighted characters.
 *
 * @param data - The syndication payload containing canonical URL, short URL, title, and excerpt.
 * @param env - Cloudflare Worker environment bindings.
 * @returns PlatformResult indicating posted, skipped, or failed.
 */
export async function syndicateToX(data: SyndicatePayload, env: Bindings): Promise<PlatformResult> {
  const isOAuth1 = Boolean(
    env.X_API_KEY && env.X_API_SECRET && env.X_ACCESS_TOKEN && env.X_ACCESS_SECRET
  );
  const isOAuth2 = Boolean(env.X_ACCESS_TOKEN && !isOAuth1);

  if (!isOAuth1 && !isOAuth2) {
    return {
      status: 'skipped',
      reason:
        'X credentials not configured (requires X_API_KEY + X_API_SECRET + X_ACCESS_TOKEN + X_ACCESS_SECRET or X_ACCESS_TOKEN).',
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
    const tweetUrl = 'https://api.twitter.com/2/tweets';

    const payload: Record<string, unknown> = {
      text: postText,
      ...(previousTweetId ? { reply: { in_reply_to_tweet_id: previousTweetId } } : {}),
    };

    const authHeader = isOAuth1
      ? await buildOAuth1Header({
          method: 'POST',
          url: tweetUrl,
          apiKey: env.X_API_KEY as string,
          apiSecret: env.X_API_SECRET as string,
          accessToken: env.X_ACCESS_TOKEN as string,
          accessSecret: env.X_ACCESS_SECRET as string,
        })
      : `Bearer ${env.X_ACCESS_TOKEN}`;

    const res = await fetch(tweetUrl, {
      method: 'POST',
      headers: {
        Authorization: authHeader,
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
