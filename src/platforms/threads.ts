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

export interface ThreadsSyndicateOptions {
  readonly replyDelayMs?: number;
  readonly retryDelayMs?: number;
  readonly maxRetries?: number;
  readonly existingRootId?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postThreadsFormWithRetry(params: {
  readonly url: string;
  readonly body: URLSearchParams;
  readonly actionLabel: string;
  readonly maxRetries: number;
  readonly retryDelayMs: number;
}): Promise<
  { readonly ok: true; readonly data: unknown } | { readonly ok: false; readonly error: string }
> {
  const { url, body, actionLabel, maxRetries, retryDelayMs } = params;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    if (res.ok) {
      return { ok: true, data: await res.json() };
    }

    const errorText = await res.text();
    const errorMessage = `${actionLabel} (${res.status}): ${errorText}`;

    // Never retry authentication or permission errors
    if (res.status === 401 || res.status === 403 || attempt >= maxRetries) {
      return { ok: false, error: errorMessage };
    }

    if (retryDelayMs > 0) {
      await sleep(retryDelayMs * attempt);
    }
  }

  return { ok: false, error: `${actionLabel}: Exhausted retries.` };
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
 *   2. Wait briefly and `POST /{user_id}/threads_publish` (with retry backoff) to publish the container.
 * - Preserves `partialRemoteId` if a reply fails after the root post succeeded, allowing future
 *   retries via `existingRootId` to append only the missing reply without duplicating Post 1.
 *
 * @param data - The syndication payload containing canonical URL, short URL, title, and excerpt.
 * @param env - Cloudflare Worker environment bindings including `THREADS_ACCESS_TOKEN` and optional `THREADS_USER_ID`.
 * @param options - Optional timing, retry, and partial-thread resume configuration.
 * @returns PlatformResult indicating posted, skipped, or failed.
 */
export async function syndicateToThreads(
  data: SyndicatePayload,
  env: Bindings,
  options?: ThreadsSyndicateOptions
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

  const isTestEnv = typeof process !== 'undefined' && process.env.NODE_ENV === 'test';
  const replyDelayMs = options?.replyDelayMs ?? (isTestEnv ? 0 : 2000);
  const retryDelayMs = options?.retryDelayMs ?? (isTestEnv ? 0 : 2500);
  const maxRetries = options?.maxRetries ?? 3;

  // 1. Plan thread using Threads 500-char algorithmic reply strategy
  const targetLink = data.shortUrl || data.canonicalUrl;
  const content = (data.excerpt?.trim() || data.title).trim();
  const threadPlan = planSocialThread({
    text: content,
    shortUrl: targetLink,
    platform: PLATFORMS.threads,
  });

  const existingRootId = options?.existingRootId;
  let rootThreadId: string | undefined = existingRootId;
  let previousPostId: string | undefined = existingRootId;
  const startIndex = existingRootId ? 1 : 0;

  const failWithOptionalPartial = (error: string): PlatformResult =>
    rootThreadId
      ? {
          status: 'failed',
          error,
          partialRemoteId: rootThreadId,
          partialUrl: `https://www.threads.net/t/${rootThreadId}`,
        }
      : {
          status: 'failed',
          error,
        };

  for (let i = startIndex; i < threadPlan.posts.length; i++) {
    const postText = threadPlan.posts[i] ?? '';

    // Allow Meta's backend to index the newly published parent post before chaining reply_to_id
    if (i > 0 && !(existingRootId && i === 1) && replyDelayMs > 0) {
      await sleep(replyDelayMs);
    }

    // Step 1: Create media container
    const containerParams: Record<string, string> = {
      media_type: 'TEXT',
      text: postText,
      access_token: token,
      ...(previousPostId ? { reply_to_id: previousPostId } : {}),
    };

    const containerAttempt = await postThreadsFormWithRetry({
      url: `https://graph.threads.net/v1.0/${encodeURIComponent(userId)}/threads`,
      body: new URLSearchParams(containerParams),
      actionLabel: 'Threads container creation failed',
      maxRetries,
      retryDelayMs,
    });

    if (!containerAttempt.ok) {
      return failWithOptionalPartial(containerAttempt.error);
    }

    const containerData = containerAttempt.data as ThreadsContainerResponse;
    const containerId = containerData?.id;

    if (!containerId) {
      return failWithOptionalPartial('Threads container creation returned no container ID.');
    }

    // Give Meta time to finish processing container & URL preview before publishing
    if (replyDelayMs > 0) {
      await sleep(replyDelayMs);
    }

    // Step 2: Publish container
    const pubAttempt = await postThreadsFormWithRetry({
      url: `https://graph.threads.net/v1.0/${encodeURIComponent(userId)}/threads_publish`,
      body: new URLSearchParams({
        creation_id: containerId,
        access_token: token,
      }),
      actionLabel: 'Threads publish failed',
      maxRetries,
      retryDelayMs,
    });

    if (!pubAttempt.ok) {
      return failWithOptionalPartial(pubAttempt.error);
    }

    const pubData = pubAttempt.data as ThreadsPublishResponse;
    const publishedId = pubData?.id ? String(pubData.id) : '';

    if (!publishedId) {
      return failWithOptionalPartial('Threads publish returned no post ID.');
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
