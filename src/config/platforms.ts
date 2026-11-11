/**
 * Supported platform identifiers.
 */
export type PlatformId = 'bluesky' | 'x' | 'threads' | 'mastodon' | 'nostr';

/**
 * Strategy for placing the link in social posts.
 * - 'inline': Non-algorithmic platforms (Bluesky, Mastodon) where links in the main post are not penalized.
 * - 'reply': Algorithmic platforms (X, Threads) where links in the main post are downranked by recommendation algorithms.
 */
export type LinkStrategy = 'inline' | 'reply';

/**
 * Centralized platform configuration: character limits, algorithmic policies, and link strategies.
 * Modifying limits here updates all formatting, splitting, and posting logic automatically.
 */
export interface PlatformConfig {
  readonly id: PlatformId;
  readonly name: string;
  readonly maxGraphemes: number;
  readonly isAlgorithmic: boolean;
  readonly linkStrategy: LinkStrategy;
  readonly replyPrefix: string;
}

export const PLATFORMS: Record<PlatformId, PlatformConfig> = {
  bluesky: {
    id: 'bluesky',
    name: 'Bluesky',
    maxGraphemes: 300,
    isAlgorithmic: false,
    linkStrategy: 'inline',
    replyPrefix: 'Read the full article:\n\n',
  },
  mastodon: {
    id: 'mastodon',
    name: 'Mastodon',
    maxGraphemes: 500,
    isAlgorithmic: false,
    linkStrategy: 'inline',
    replyPrefix: 'Read the full article:\n\n',
  },
  x: {
    id: 'x',
    name: 'X (Twitter)',
    maxGraphemes: 280,
    isAlgorithmic: true,
    linkStrategy: 'reply',
    replyPrefix: 'Read the full article:\n\n',
  },
  threads: {
    id: 'threads',
    name: 'Threads',
    maxGraphemes: 500,
    isAlgorithmic: true,
    linkStrategy: 'reply',
    replyPrefix: 'Read the full article:\n\n',
  },
  nostr: {
    id: 'nostr',
    name: 'Nostr',
    maxGraphemes: 500,
    isAlgorithmic: false,
    linkStrategy: 'inline',
    replyPrefix: 'Read the full article:\n\n',
  },
};
