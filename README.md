# Syndicator

A lightweight, open-source Cloudflare Worker that polls an RSS feed on a schedule (`0 */4 * * *`), deduplicates posts using **Cloudflare KV**, generates ultra-short 3-character links (`s.yourdomain.com/:code`), and cross-posts new articles to **Bluesky**, **Mastodon**, **X (Twitter)**, **Meta Threads**, and **Nostr** with intelligent word-boundary thread splitting.

## Key Features

1. **Built-in 3-Character Base62 URL Shortener**:
   - Automatically generates a clean, deterministic 3-character Base62 code (`[0-9a-zA-Z]`, 238,328 combinations) for each syndicated article when `SHORT_DOMAIN` is configured.
   - Example: `https://s.yourdomain.com/a9X` -> 301 Permanent Redirect to `https://yourdomain.com/articles/.../`.
   - Edge-cached with `Cache-Control: public, max-age=86400` for instant redirection.
   - If `SHORT_DOMAIN` is omitted, the worker simply syndicates the direct canonical article URL.

2. **Smart Word-Boundary Thread Splitting & Link Strategies**:
   - Text is split strictly at natural word boundaries—never truncating thoughts with raw ellipses (`…`).
   - Centralized platform configurations (`src/config/platforms.ts`) enforce platform-specific rules:
     - **Bluesky** (300 graphemes, non-algorithmic): inlines link directly into the root post.
     - **Mastodon** (500 characters, non-algorithmic): inlines link in post, chains multi-part threads via `in_reply_to_id`, and includes `Idempotency-Key` headers to prevent duplicate posts on retries.
     - **X & Threads** (algorithmic feeds): planned for hook in Post 1 and link in Post 2 (first reply) to protect organic reach.
     - **Nostr** (500 graphemes, non-algorithmic): broadcasts signed NIP-01 text notes to configured relays via WebSockets.

3. **Clean Caching & Deduplication**:
   - **HTTP Conditional Requests**: Stores `rss:etag` and `rss:last_modified` in KV. Sends `If-None-Match` and `If-Modified-Since` on each cron. If the feed hasn't changed, the server returns `304 Not Modified` for an instant ~5ms exit with zero CPU and no XML parsing.
   - **High-Water Mark**: Checks the top (newest) item against `rss:latest_url` in KV. If the latest post hasn't changed, it exits immediately.
   - **First-Run Baseline**: On the very first run, simply writes `rss:latest_url` as the baseline. It checks nothing and posts nothing.
   - **Sequential Chronological Syndication**: When multiple posts appear in the 4-hour window, the worker posts them sequentially from oldest to newest.
   - **Fault-Tolerant Retries**: If any platform fails, batch halts immediately to preserve order, `rss:latest_url` advances only to the last successful post, and already-posted platforms are recorded in KV so retries never duplicate posts.

---

## Configuration

> [!NOTE]
> For step-by-step instructions on obtaining API keys, app passwords, and required scopes for all platforms (Bluesky, Mastodon, X, Threads, Nostr), see the [**Platform Credentials & Setup Guide**](PLATFORMS.md).

All configuration is supplied via **Environment Variables** and **Secrets** (set in Cloudflare Dashboard under **Settings → Variables and Secrets**, or via Wrangler CLI).

### 1. Public Variables

| Variable                | Description                                                          | Example                              |
| :---------------------- | :------------------------------------------------------------------- | :----------------------------------- |
| `RSS_FEED_URL`          | **(Required)** Public URL of the RSS feed                            | `https://yourdomain.com/rss.xml`     |
| `BLUESKY_IDENTIFIER`    | Your Bluesky handle or DID                                           | `yourhandle.bsky.social`             |
| `BLUESKY_SERVICE`       | AT Protocol PDS host (defaults to `https://bsky.social`)             | `https://bsky.social`                |
| `MASTODON_INSTANCE_URL` | Mastodon instance host (defaults to `https://mastodon.social`)       | `https://mastodon.social`            |
| `SHORT_DOMAIN`          | _(Optional)_ Domain for built-in shortener (e.g. `s.yourdomain.com`) | `s.yourdomain.com`                   |
| `THREADS_USER_ID`       | _(Optional)_ Threads User ID (auto-resolved via `/me` if omitted)    | `123456789`                          |
| `NOSTR_RELAYS`          | _(Optional)_ Comma-separated relay URLs                              | `wss://relay.damus.io,wss://nos.lol` |

### 2. Secrets (set via Cloudflare Dashboard or `wrangler secret put`)

| Secret                  | Description                                                             |
| :---------------------- | :---------------------------------------------------------------------- |
| `BLUESKY_PASSWORD`      | Bluesky App Password (generate in Bluesky Settings → App Passwords)     |
| `MASTODON_ACCESS_TOKEN` | Mastodon User Access Token (from Preferences → Development → New App)   |
| `X_API_KEY`             | **(OAuth 1.0a - Recommended)** X Consumer API Key (permanent)           |
| `X_API_SECRET`          | **(OAuth 1.0a - Recommended)** X Consumer API Key Secret (permanent)    |
| `X_ACCESS_TOKEN`        | X Access Token (OAuth 1.0a permanent, or OAuth 2.0 2-hour fallback)     |
| `X_ACCESS_SECRET`       | **(OAuth 1.0a - Recommended)** X Access Token Secret (permanent)        |
| `THREADS_ACCESS_TOKEN`  | Meta Threads User Access Token (with `threads_content_publish` scope)   |
| `NOSTR_PRIVATE_KEY`     | Nostr private key (hex or `nsec1...` format)                            |
| `API_SECRET`            | _(Optional)_ Bearer token required for triggering `POST /sync` manually |

_(Any platform whose secret is omitted is simply skipped during syndication)._

---

## Endpoints

| Method | Path       | Description                                                              |
| :----- | :--------- | :----------------------------------------------------------------------- |
| `GET`  | `/`        | Health check, latest synced URL, ETag, and configuration status          |
| `GET`  | `/:code`   | 301 Permanent Redirect to canonical URL (e.g. `s.yourdomain.com/a9X`)    |
| `GET`  | `/s/:code` | Alternative 301 Permanent Redirect path                                  |
| `POST` | `/sync`    | Manually run RSS sync (send `Authorization: Bearer <API_SECRET>` if set) |
| `GET`  | `/history` | List all syndicated posts recorded in KV                                 |

---

## Deployment

### Option A: Cloudflare Dashboard (Deploy from Git)

1. Create a KV namespace:
   - Go to Cloudflare Dashboard → **Storage & Databases** → **KV** → **Create namespace** (e.g. name it `syndicator-kv`).
2. Create your Worker:
   - Go to **Workers & Pages** → **Create** → **Import from Git** → select this repository.
3. Configure KV binding:
   - Under Worker **Settings** → **Bindings** → **KV Namespace Bindings** → click **Add binding**:
     - Variable name: `KV`
     - KV namespace: select the namespace created in step 1.
4. Configure Variables & Secrets:
   - Under Worker **Settings** → **Variables and Secrets**:
     - Add your `RSS_FEED_URL` and platform variables / secrets.
5. (Optional) Custom Shortener Domain:
   - Under Worker **Settings** → **Domains & Routes** → **Add Custom Domain** (e.g. `s.yourdomain.com`).

### Option B: Deploy via Wrangler CLI

```bash
# 1. Create KV namespace
bunx wrangler kv namespace create syndicator_kv

# 2. Bind KV and set secrets
bunx wrangler secret put BLUESKY_PASSWORD
bunx wrangler secret put MASTODON_ACCESS_TOKEN
bunx wrangler secret put X_API_KEY
bunx wrangler secret put X_API_SECRET
bunx wrangler secret put X_ACCESS_TOKEN
bunx wrangler secret put X_ACCESS_SECRET
bunx wrangler secret put THREADS_ACCESS_TOKEN
bunx wrangler secret put NOSTR_PRIVATE_KEY

# 3. Deploy
bun run deploy
```

---

## Development & Testing

```bash
# Install dependencies
bun install

# Run test suite (43 unit tests across 8 suites)
bun test

# Typecheck
bun run typecheck

# Code formatting & linting with Biome
bun run check
bun run fix
```
