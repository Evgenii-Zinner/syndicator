import { PLATFORMS } from '../config/platforms';
import type { Bindings, PlatformResult, SyndicatePayload } from '../types';
import { getErrorMessage } from '../utils/format';
import { planSocialThread } from '../utils/thread';

interface ThreadsProfileResponse {
  readonly id?: string | number;
  readonly username?: string;
}

interface ThreadsContainerResponse {
  readonly id?: string;
}

interface ThreadsPublishResponse {
  readonly id?: string | number;
}

/**
 * Resolves the authenticated user ID from the Meta Graph API `/me` endpoint if not explicitly provided in environment bindings.
 */
async function resolveThreadsUserId(token: string): Promise<string> {
  const res = await fetch(
    `https://graph.threads.net/v1.0/me?fields=id,username&access_token=${encodeURIComponent(token)}`
  );

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Threads /me resolution failed (${res.status}): ${errorText}`);
  }

  const data = (await res.json()) as ThreadsProfileResponse;
  if (!data?.id) {
    throw new Error('Threads /me returned no user ID in response.');
  }

  return String(data.id);
}

/**
 * Syndicates an article to Meta Threads using the official Graph API (`graph.threads.net`).
 *
 * Characteristics:
 * - Employs the algorithmic link-in-reply strategy (`PLATFORMS.threads`):
 *   Post 1 contains the hook/excerpt to protect organic discovery in recommendation algorithms.
 *   Post 2 contains the destination link chained via `reply_to_id`.
 * - Multi-step publishing process required by Meta:
 *   1. `POST /{user_id}/threads` to create a TEXT container.
 *   2. `POST /{user_id}/threads_publish` to publish the created container.
 *
 * @param data - The syndication payload containing canonical URL, short URL, title, and excerpt.
 * @param env - Cloudflare Worker environment bindings including `THREADS_ACCESS_TOKEN` and optional `THREADS_USER_ID`.
 * @returns PlatformResult indicating posted, skipped, or failed.
 */
export async function syndicateToThreads(
  data: SyndicatePayload,
  env: Bindings
): Promise<PlatformResult> {
  const token = env.THREADS_ACCESS_TOKEN;

  if (!token) {
    return {
      status: 'skipped',
      reason: 'Threads access token not configured (THREADS_ACCESS_TOKEN).',
    };
  }

  let userId = env.THREADS_USER_ID;
  if (!userId) {
    try {
      userId = await resolveThreadsUserId(token);
    } catch (err: unknown) {
      return {
        status: 'failed',
        error: getErrorMessage(err),
      };
    }
  }

  // 1. Plan thread using Threads 500-char algorithmic reply strategy
  const targetLink = data.shortUrl || data.canonicalUrl;
  const content = (data.excerpt?.trim() || data.title).trim();
  const threadPlan = planSocialThread({
    text: content,
    shortUrl: targetLink,
    platform: PLATFORMS.threads,
  });

  let rootThreadId: string | undefined;
  let previousPostId: string | undefined;

  for (let i = 0; i < threadPlan.posts.length; i++) {
    const postText = threadPlan.posts[i] ?? '';

    // Step 1: Create media container
    const containerParams: Record<string, string> = {
      media_type: 'TEXT',
      text: postText,
      access_token: token,
      ...(previousPostId ? { reply_to_id: previousPostId } : {}),
    };

    const containerForm = new URLSearchParams(containerParams);
    const containerRes = await fetch(
      `https://graph.threads.net/v1.0/${encodeURIComponent(userId)}/threads`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: containerForm,
      }
    );

    if (!containerRes.ok) {
      const errorText = await containerRes.text();
      return {
        status: 'failed',
        error: `Threads container creation failed (${containerRes.status}): ${errorText}`,
      };
    }

    const containerData = (await containerRes.json()) as ThreadsContainerResponse;
    const containerId = containerData?.id;

    if (!containerId) {
      return {
        status: 'failed',
        error: 'Threads container creation returned no container ID.',
      };
    }

    // Step 2: Publish container
    const pubForm = new URLSearchParams({
      creation_id: containerId,
      access_token: token,
    });

    const pubRes = await fetch(
      `https://graph.threads.net/v1.0/${encodeURIComponent(userId)}/threads_publish`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: pubForm,
      }
    );

    if (!pubRes.ok) {
      const errorText = await pubRes.text();
      return {
        status: 'failed',
        error: `Threads publish failed (${pubRes.status}): ${errorText}`,
      };
    }

    const pubData = (await pubRes.json()) as ThreadsPublishResponse;
    const publishedId = pubData?.id ? String(pubData.id) : '';

    if (!publishedId) {
      return {
        status: 'failed',
        error: 'Threads publish returned no post ID.',
      };
    }

    if (i === 0) {
      rootThreadId = publishedId;
    }
    previousPostId = publishedId;
  }

  if (!rootThreadId) {
    return {
      status: 'failed',
      error: 'No posts created for Threads syndication.',
    };
  }

  return {
    status: 'posted',
    remoteId: rootThreadId,
    url: `https://www.threads.net/t/${rootThreadId}`,
  };
}
