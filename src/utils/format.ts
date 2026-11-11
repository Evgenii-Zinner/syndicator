import { PLATFORMS } from '../config/platforms';
import type { SyndicatePayload } from '../types';
import { planSocialThread } from './thread';

/**
 * Composes Bluesky post text using the centralized thread planner.
 * Uses excerpt (fallback to title) and short link (fallback to canonical URL).
 */
export function formatPostText(data: SyndicatePayload): string {
  const content = (data.excerpt?.trim() || data.title).trim();
  const link = data.shortUrl || data.canonicalUrl;
  const plan = planSocialThread({
    text: content,
    shortUrl: link,
    platform: PLATFORMS.bluesky,
  });

  return plan.posts[0] ?? link;
}

/**
 * Safely extracts a readable error message from an unknown thrown value.
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return JSON.stringify(error);
}
