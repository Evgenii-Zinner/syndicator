import type { PlatformConfig } from '../config/platforms';

/**
 * Counts unicode grapheme clusters using Intl.Segmenter.
 */
export function getGraphemeCount(text: string): number {
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    const segmenter = new Intl.Segmenter();
    return Array.from(segmenter.segment(text)).length;
  }
  return text.length;
}

/**
 * Hard slices a long string by grapheme clusters (used only when an unbroken token exceeds the limit).
 */
function sliceGraphemes(
  text: string,
  maxGraphemes: number
): { readonly head: string; readonly tail: string } {
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    const segmenter = new Intl.Segmenter();
    const graphemes = Array.from(segmenter.segment(text)).map((s) => s.segment);
    return {
      head: graphemes.slice(0, maxGraphemes).join(''),
      tail: graphemes.slice(maxGraphemes).join(''),
    };
  }
  return {
    head: text.slice(0, maxGraphemes),
    tail: text.slice(maxGraphemes),
  };
}

/**
 * Splits text into multiple messages at word boundaries without cutting words in half.
 */
export function splitTextIntoThread(text: string, maxGraphemes: number): string[] {
  const clean = text.trim();
  if (!clean) {
    return [];
  }

  if (getGraphemeCount(clean) <= maxGraphemes) {
    return [clean];
  }

  const words = clean.split(/\s+/);
  const chunks: string[] = [];
  let currentChunk = '';

  for (const word of words) {
    const candidate = currentChunk ? `${currentChunk} ${word}` : word;

    if (getGraphemeCount(candidate) <= maxGraphemes) {
      currentChunk = candidate;
    } else {
      if (currentChunk) {
        chunks.push(currentChunk);
        currentChunk = '';
      }

      // If a single word exceeds the entire post limit, force-split it
      let remainder = word;
      while (getGraphemeCount(remainder) > maxGraphemes) {
        const { head, tail } = sliceGraphemes(remainder, maxGraphemes);
        chunks.push(head);
        remainder = tail;
      }
      currentChunk = remainder;
    }
  }

  if (currentChunk) {
    chunks.push(currentChunk);
  }

  return chunks;
}

export interface ThreadPlan {
  readonly posts: readonly string[];
  readonly linkPostIndex: number;
}

/**
 * Plans the complete social thread based on platform character limits and algorithmic link strategies:
 * - Non-algorithmic (Bluesky, Mastodon): Link is inlined in the post without algorithmic penalty.
 * - Algorithmic (X, Threads): Links in the main post are downranked, so the link is placed in the final reply post.
 */
export function planSocialThread(params: {
  readonly text: string;
  readonly shortUrl: string;
  readonly platform: PlatformConfig;
}): ThreadPlan {
  const { text, shortUrl, platform } = params;
  const content = text.trim();

  // 1. Algorithmic Strategy (X, Threads): Clean hook in main post, link in final reply post
  if (platform.linkStrategy === 'reply') {
    const textChunks = splitTextIntoThread(content, platform.maxGraphemes);
    const replyPost = `${platform.replyPrefix}${shortUrl}`;
    const posts = [...(textChunks.length > 0 ? textChunks : [shortUrl]), replyPost];

    return {
      posts,
      linkPostIndex: posts.length - 1,
    };
  }

  // 2. Non-Algorithmic Strategy (Bluesky, Mastodon): Link placed in main post or attached to the last thread post
  const linkSuffix = `\n\n${shortUrl}`;
  const suffixLength = getGraphemeCount(linkSuffix);
  const singlePostBudget = platform.maxGraphemes - suffixLength;

  // Fits in a single post
  if (getGraphemeCount(content) <= singlePostBudget) {
    return {
      posts: [`${content}${linkSuffix}`],
      linkPostIndex: 0,
    };
  }

  // Multi-post thread: split text by word boundaries
  const textChunks = splitTextIntoThread(content, platform.maxGraphemes);

  if (textChunks.length === 0) {
    return {
      posts: [shortUrl],
      linkPostIndex: 0,
    };
  }

  const lastChunkIndex = textChunks.length - 1;
  const lastChunk = textChunks[lastChunkIndex] ?? '';

  // Can the link append to the final chunk without overflowing?
  if (getGraphemeCount(lastChunk) + suffixLength <= platform.maxGraphemes) {
    const updatedChunks = [...textChunks];
    updatedChunks[lastChunkIndex] = `${lastChunk}${linkSuffix}`;
    return {
      posts: updatedChunks,
      linkPostIndex: lastChunkIndex,
    };
  }

  // Otherwise, the link becomes its own final reply post
  return {
    posts: [...textChunks, shortUrl],
    linkPostIndex: textChunks.length,
  };
}
