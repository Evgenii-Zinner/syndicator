import { describe, expect, it } from 'bun:test';
import { PLATFORMS } from '../src/config/platforms';
import { getGraphemeCount, planSocialThread, splitTextIntoThread } from '../src/utils/thread';

describe('Thread Splitting & Planning', () => {
  it('measures graphemes accurately including compound emojis', () => {
    expect(getGraphemeCount('hello')).toBe(5);
    expect(getGraphemeCount('🚀')).toBe(1);
    expect(getGraphemeCount('hello 🚀')).toBe(7);
  });

  it('does not split text if it fits within the limit', () => {
    const text = 'Short post text.';
    const result = splitTextIntoThread(text, 100);
    expect(result).toEqual(['Short post text.']);
  });

  it('splits long text strictly at word boundaries without cutting words in half', () => {
    const text = 'The quick brown fox jumps over the lazy dog repeatedly and smoothly';
    // Limit of 25 characters: "The quick brown fox jumps" is exactly 25 characters
    const chunks = splitTextIntoThread(text, 25);

    for (const chunk of chunks) {
      expect(getGraphemeCount(chunk)).toBeLessThanOrEqual(25);
    }

    // Verify words are preserved and joined correctly
    expect(chunks.join(' ')).toBe(text);
    expect(chunks.length).toBe(3);
    expect(chunks[0]).toBe('The quick brown fox jumps');
    expect(chunks[1]).toBe('over the lazy dog');
    expect(chunks[2]).toBe('repeatedly and smoothly');
  });

  describe('Non-algorithmic platforms (Bluesky - inline link)', () => {
    it('inlines link in a single post when text + link fits in 300 graphemes', () => {
      const text = 'Quick summary of our new architecture.';
      const shortUrl = 'https://s.example.com/a9X';

      const plan = planSocialThread({
        text,
        shortUrl,
        platform: PLATFORMS.bluesky,
      });

      expect(plan.posts.length).toBe(1);
      const firstPost = plan.posts[0] ?? '';
      expect(firstPost).toBe('Quick summary of our new architecture.\n\nhttps://s.example.com/a9X');
      expect(plan.linkPostIndex).toBe(0);
      expect(getGraphemeCount(firstPost)).toBeLessThanOrEqual(300);
    });

    it('splits into a multi-post thread when text is long, flowing link to the end', () => {
      const sentence =
        'Cloudflare workers provide ultra-low latency compute at the edge with zero idle cost. ';
      const text = sentence.repeat(5).trim(); // ~430 characters
      const shortUrl = 'https://s.example.com/a9X';

      const plan = planSocialThread({
        text,
        shortUrl,
        platform: PLATFORMS.bluesky,
      });

      expect(plan.posts.length).toBeGreaterThan(1);
      for (const post of plan.posts) {
        expect(getGraphemeCount(post)).toBeLessThanOrEqual(300);
      }

      // Link is attached to the final post
      const lastPost = plan.posts[plan.posts.length - 1] ?? '';
      expect(lastPost).toContain(shortUrl);
      expect(plan.linkPostIndex).toBe(plan.posts.length - 1);
    });
  });

  describe('Algorithmic platforms (X & Threads - link in reply)', () => {
    it('X (Twitter - 280 limit): puts clean text in post 1 and link in reply post', () => {
      const text = 'Why building on V8 isolates beats 20 Docker containers on a bare VPS.';
      const shortUrl = 'https://s.example.com/a9X';

      const plan = planSocialThread({
        text,
        shortUrl,
        platform: PLATFORMS.x,
      });

      expect(plan.posts.length).toBe(2);
      expect(plan.posts[0]).toBe(text);
      expect(plan.posts[0]).not.toContain('http');
      expect(plan.posts[1]).toBe('Read the full article:\n\nhttps://s.example.com/a9X');
      expect(plan.linkPostIndex).toBe(1);
    });

    it('Threads (500 limit): preserves full hook in post 1 and link in reply post', () => {
      const text = 'Here is how memory management works inside Cloudflare Workers.'.repeat(3);
      const shortUrl = 'https://s.example.com/a9X';

      const plan = planSocialThread({
        text,
        shortUrl,
        platform: PLATFORMS.threads,
      });

      expect(plan.posts.length).toBe(2);
      expect(plan.posts[0]).toBe(text);
      expect(plan.posts[0]).not.toContain('http');
      expect(plan.posts[1]).toBe('Read the full article:\n\nhttps://s.example.com/a9X');
      expect(plan.linkPostIndex).toBe(1);
    });
  });
});
