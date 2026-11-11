import { PLATFORMS } from '../config/platforms';
import type { Bindings, PlatformResult, SyndicatePayload } from '../types';
import { planSocialThread } from '../utils/thread';

interface BskySession {
  readonly accessJwt: string;
  readonly refreshJwt: string;
  readonly did: string;
  readonly handle: string;
}

interface BskyRecordResponse {
  readonly uri: string;
  readonly cid: string;
}

function buildLinkFacets(text: string, link: string) {
  const facets: Array<{
    index: { byteStart: number; byteEnd: number };
    features: Array<{ $type: string; uri: string }>;
  }> = [];

  const encoder = new TextEncoder();
  const urlIndex = text.indexOf(link);
  if (urlIndex !== -1) {
    const byteStart = encoder.encode(text.slice(0, urlIndex)).length;
    const byteEnd = byteStart + encoder.encode(link).length;

    facets.push({
      index: { byteStart, byteEnd },
      features: [
        {
          $type: 'app.bsky.richtext.facet#link',
          uri: link,
        },
      ],
    });
  }

  return facets;
}

/**
 * Syndicates an article to Bluesky via direct AT Protocol XRPC calls.
 * Splits by words into a thread if content exceeds 300 graphemes,
 * and attaches UTF-8 byte facets and external link cards.
 */
export async function syndicateToBluesky(
  data: SyndicatePayload,
  env: Bindings
): Promise<PlatformResult> {
  const identifier = env.BLUESKY_IDENTIFIER;
  const password = env.BLUESKY_PASSWORD;
  const pds = (env.BLUESKY_SERVICE || 'https://bsky.social').replace(/\/+$/, '');

  if (!identifier || !password) {
    throw new Error('Bluesky credentials not configured (BLUESKY_IDENTIFIER / BLUESKY_PASSWORD).');
  }

  // 1. Create Session
  const sessionRes = await fetch(`${pds}/xrpc/com.atproto.server.createSession`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier, password }),
  });

  if (!sessionRes.ok) {
    const errorText = await sessionRes.text();
    throw new Error(`Bluesky createSession failed (${sessionRes.status}): ${errorText}`);
  }

  const session = (await sessionRes.json()) as BskySession;

  // 2. Plan Thread Chunks
  const targetLink = data.shortUrl || data.canonicalUrl;
  const content = (data.excerpt?.trim() || data.title).trim();
  const threadPlan = planSocialThread({
    text: content,
    shortUrl: targetLink,
    platform: PLATFORMS.bluesky,
  });

  const embedCard = {
    $type: 'app.bsky.embed.external',
    external: {
      uri: data.canonicalUrl,
      title: data.title,
      description: data.excerpt || '',
    },
  };

  let rootRef: { uri: string; cid: string } | undefined;
  let parentRef: { uri: string; cid: string } | undefined;
  let rootPostResult: BskyRecordResponse | undefined;

  for (let i = 0; i < threadPlan.posts.length; i++) {
    const postText = threadPlan.posts[i] ?? '';
    const isLinkPost = i === threadPlan.linkPostIndex;
    const facets = isLinkPost ? buildLinkFacets(postText, targetLink) : [];

    const recordBody: Record<string, unknown> = {
      $type: 'app.bsky.feed.post',
      text: postText,
      createdAt: new Date().toISOString(),
      ...(facets.length > 0 ? { facets } : {}),
      ...(isLinkPost ? { embed: embedCard } : {}),
      ...(rootRef && parentRef ? { reply: { root: rootRef, parent: parentRef } } : {}),
    };

    const postRes = await fetch(`${pds}/xrpc/com.atproto.repo.createRecord`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.accessJwt}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        repo: session.did,
        collection: 'app.bsky.feed.post',
        record: recordBody,
      }),
    });

    if (!postRes.ok) {
      const errorText = await postRes.text();
      throw new Error(`Bluesky createRecord failed (${postRes.status}): ${errorText}`);
    }

    const result = (await postRes.json()) as BskyRecordResponse;

    if (i === 0) {
      rootPostResult = result;
      rootRef = { uri: result.uri, cid: result.cid };
      parentRef = { uri: result.uri, cid: result.cid };
    } else {
      parentRef = { uri: result.uri, cid: result.cid };
    }
  }

  if (!rootPostResult) {
    throw new Error('No posts created for Bluesky syndication.');
  }

  const rkey = rootPostResult.uri.split('/').pop();
  const remoteUrl = `https://bsky.app/profile/${session.handle}/post/${rkey}`;

  return {
    status: 'posted',
    remoteId: rootPostResult.uri,
    url: remoteUrl,
  };
}
