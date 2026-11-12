import type { Bindings, PlatformResult, SyndicatePayload } from '../types';

interface DevtoArticleResponse {
  readonly id: number;
  readonly title: string;
  readonly url: string;
  readonly canonical_url?: string;
  readonly error?: string;
}

/**
 * Syndicates an article to DEV.to using the official REST API v1 (`POST https://dev.to/api/articles`).
 *
 * Characteristics:
 * - Uses the full HTML content from `<content:encoded>` inside `body_markdown` (CommonMark/HTML passthrough).
 * - Enforces `canonical_url` pointing to the original article URL to preserve 100% SEO authority.
 * - Supports `DEVTO_PUBLISHED="false"` to import as a draft if desired (defaults to `true`).
 *
 * @param data - The syndication payload containing canonical URL, title, excerpt, and contentHtml.
 * @param env - Cloudflare Worker environment bindings including `DEVTO_API_KEY`.
 * @returns PlatformResult indicating posted, skipped, or failed.
 */
export async function syndicateToDevto(
  data: SyndicatePayload,
  env: Bindings
): Promise<PlatformResult> {
  const apiKey = env.DEVTO_API_KEY?.trim();

  if (!apiKey) {
    return {
      status: 'skipped',
      reason: 'DEV.to API key not configured (DEVTO_API_KEY).',
    };
  }

  const isPublished = env.DEVTO_PUBLISHED?.trim() !== 'false';
  const bodyContent = data.contentHtml?.trim() || data.excerpt?.trim() || data.title.trim();

  const payload = {
    article: {
      title: data.title.trim(),
      published: isPublished,
      body_markdown: bodyContent,
      canonical_url: data.canonicalUrl,
      description: data.excerpt?.trim(),
    },
  };

  const res = await fetch('https://dev.to/api/articles', {
    method: 'POST',
    headers: {
      'api-key': apiKey,
      'Content-Type': 'application/json',
      'User-Agent': 'Syndicator-Bot/1.0 (+https://github.com/Evgenii-Zinner/syndicator)',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errorText = await res.text();
    return {
      status: 'failed',
      error: `DEV.to API error (${res.status}): ${errorText}`,
    };
  }

  const result = (await res.json()) as DevtoArticleResponse;

  if (!result?.id || !result?.url) {
    return {
      status: 'failed',
      error: `DEV.to API did not return article ID or URL: ${result.error ?? 'Unknown error'}`,
    };
  }

  return {
    status: 'posted',
    remoteId: String(result.id),
    url: result.url,
  };
}
