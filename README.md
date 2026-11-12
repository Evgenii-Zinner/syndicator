# Syndicator

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com)
[![Bun](https://img.shields.io/badge/Bun-1.3+-black?logo=bun&logoColor=white)](https://bun.sh)
[![Biome](https://img.shields.io/badge/Biome-Linter%20%26%20Formatter-60a5fa?logo=biome&logoColor=white)](https://biomejs.dev)
[![Tests](https://img.shields.io/badge/Tests-53%20Passing-brightgreen.svg)](tests/)

A lightweight, free, and open-source autonomous distribution engine that polls your RSS feed on a 4-hour schedule (`0 */4 * * *`) and cross-posts new articles across **Bluesky**, **Mastodon**, **Meta Threads**, **Telegram**, **Nostr**, **DEV.to**, and **X (Twitter)** with intelligent thread planning, algorithmic link routing, and a built-in 3-character URL shortener.

Runs entirely within the **Cloudflare Workers Free Tier** ($0/month). No monthly SaaS fees, no servers, and zero relational databases.

---

## ⚡ 1-Click Deploy

Deploy directly to your own Cloudflare account with a single click:

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Evgenii-Zinner/syndicator)

_(The KV namespace will be auto-provisioned automatically by Cloudflare during deployment)._

---

## Why Syndicator?

| Feature                 | Typical SaaS (Buffer, Hootsuite, Zapier) | Syndicator                                                                    |
| :---------------------- | :--------------------------------------- | :---------------------------------------------------------------------------- |
| **Cost**                | $15–$50 / month                          | **$0 / month** (Cloudflare Free Tier)                                         |
| **Data Privacy**        | Credentials stored on 3rd-party servers  | **100% self-hosted** in your own Cloudflare account                           |
| **Algorithmic Routing** | Blasts links in root posts (kills reach) | **Places links in replies on X & Threads**, inline on chronological platforms |
| **Shortener**           | External bit.ly / paid shortener         | **Built-in 3-char Base62 shortener** (`s.yourdomain.com/:code`)               |
| **Storage**             | Heavy SQL database                       | **Cloudflare KV only** (zero DBs)                                             |
| **Nostr Support**       | Non-existent                             | **BIP-340 Schnorr signatures & multi-relay WebSockets**                       |
| **Telegram Support**    | Limited / webhook required               | **Native HTML formatting with rich link previews**                            |
| **DEV.to Syndication**  | Third-party Zapier / paid RSS import     | **Full HTML article publishing with canonical URL SEO preservation**          |

---

## Key Features

1. **Smart Word-Boundary Thread Splitting & Link Strategies**:
   - Uses `Intl.Segmenter` for accurate Unicode grapheme counting (prevents multi-byte emojis from overflowing character limits).
   - Never chops words or inserts raw ellipses (`…`).
   - **Chronological Feeds (Bluesky, Mastodon, Nostr, Telegram):** Inlines link directly into the post with rich cards or HTML previews.
   - **Algorithmic Feeds (X, Meta Threads):** Places the clean hook/excerpt in Post 1, and chains the link into Post 2 (the first self-reply) to protect organic reach in recommendation feeds.

2. **Built-in 3-Character Base62 URL Shortener**:
   - Generates deterministic 3-character Base62 codes (`[0-9a-zA-Z]`, 238,328 combinations) when `SHORT_DOMAIN` is configured.
   - Example: `https://s.yourdomain.com/waC` -> `301 Moved Permanently` to `https://yourdomain.com/articles/.../`.
   - Edge-cached with `Cache-Control: public, max-age=86400` for near-instant redirection.

3. **Clean Caching & Deduplication**:
   - **HTTP Conditional Requests:** Sends `If-None-Match` (ETag) and `If-Modified-Since` on every cron. If the feed hasn't changed, the server returns `304 Not Modified` -> exits in **~5ms** with zero CPU or XML parsing.
   - **High-Water Mark (`rss:latest_url`):** Tracks the latest seen article.
   - **First-Run Baseline Seeding:** On fresh deployment, records the top post as baseline and posts **0 items**. You will never spam your accounts with years of archives.
   - **Sequential Chronological Syndication:** When multiple posts appear in the 4-hour window, posts are syndicated oldest-to-newest.
   - **Partial State & Fault Tolerance:** If one platform fails, successful platforms are recorded in KV (`post:<url>`). On retries, already-posted platforms are skipped.

---

## Configuration

> [!TIP]
> Setting up with an AI assistant? Refer to [**AGENTS.md**](AGENTS.md) for step-by-step instructions.
> For manual credential acquisition guides, see [**PLATFORMS.md**](PLATFORMS.md).

All settings are configured via **Environment Variables** and **Secrets** in the Cloudflare Dashboard (**Worker Settings → Variables and Secrets**):

### 1. Variables (Plaintext)

| Variable                | Description                                                         | Example                              |
| :---------------------- | :------------------------------------------------------------------ | :----------------------------------- |
| `RSS_FEED_URL`          | **(Required)** Public URL of your RSS or Atom feed                  | `https://example.com/rss.xml`        |
| `SHORT_DOMAIN`          | _(Optional)_ Domain for built-in shortener                          | `s.example.com`                      |
| `BLUESKY_IDENTIFIER`    | _(Optional)_ Your Bluesky handle or DID                             | `yourname.bsky.social`               |
| `BLUESKY_SERVICE`       | _(Optional)_ AT Protocol PDS host (default: `https://bsky.social`)  | `https://bsky.social`                |
| `MASTODON_INSTANCE_URL` | _(Optional)_ Mastodon instance (default: `https://mastodon.social`) | `https://mastodon.social`            |
| `TELEGRAM_CHAT_ID`      | _(Optional)_ Telegram Channel/Group username or numeric ID          | `@devlog`                            |
| `DEVTO_PUBLISHED`       | _(Optional)_ Publish directly (`true`) or import as draft (`false`) | `true`                               |
| `NOSTR_RELAYS`          | _(Optional)_ Comma-separated WebSocket relay URLs                   | `wss://relay.damus.io,wss://nos.lol` |

### 2. Secrets (Encrypted)

Add via Cloudflare Dashboard or `bunx wrangler secret put <NAME>`:

| Secret                  | Platform     | Description                                                                                  |
| :---------------------- | :----------- | :------------------------------------------------------------------------------------------- |
| `BLUESKY_PASSWORD`      | Bluesky      | App Password from [bsky.app/settings/app-passwords](https://bsky.app/settings/app-passwords) |
| `MASTODON_ACCESS_TOKEN` | Mastodon     | User Access Token with `write:statuses` scope                                                |
| `TELEGRAM_BOT_TOKEN`    | Telegram     | Bot API Token generated via [@BotFather](https://t.me/BotFather)                             |
| `DEVTO_API_KEY`         | DEV.to       | Personal API Key from [dev.to/settings/extensions](https://dev.to/settings/extensions)       |
| `THREADS_ACCESS_TOKEN`  | Meta Threads | 60-day Long-Lived Token from Meta Developer Portal                                           |
| `NOSTR_PRIVATE_KEY`     | Nostr        | Private key in `nsec1...` or 64-character hex format                                         |
| `X_API_KEY`             | X (Twitter)  | Consumer API Key (OAuth 1.0a permanent)                                                      |
| `X_API_SECRET`          | X (Twitter)  | Consumer API Key Secret (OAuth 1.0a permanent)                                               |
| `X_ACCESS_TOKEN`        | X (Twitter)  | User Access Token (OAuth 1.0a permanent)                                                     |
| `X_ACCESS_SECRET`       | X (Twitter)  | User Access Token Secret (OAuth 1.0a permanent)                                              |
| `API_SECRET`            | Worker       | _(Optional)_ Bearer token required for manual `POST /sync`                                   |

_(Any platform whose secret is omitted is simply skipped during syndication)._

---

## Endpoints

| Method | Path       | Description                                                               |
| :----- | :--------- | :------------------------------------------------------------------------ |
| `GET`  | `/`        | Health check, latest synced URL, ETag, and live platform status           |
| `GET`  | `/:code`   | 301 Permanent Redirect to canonical URL (e.g. `s.yourdomain.com/waC`)     |
| `GET`  | `/s/:code` | Alternative 301 Permanent Redirect path                                   |
| `POST` | `/sync`    | Manually trigger sync (pass `{"force": true}` to re-evaluate latest post) |
| `GET`  | `/history` | List all syndicated posts and their remote platform URLs stored in KV     |

---

## Local Development & Testing

```bash
# Install dependencies
bun install

# Run test suite (48 passing unit tests across 9 files)
bun test

# Type check
bun run typecheck

# Code formatting & linting with Biome
bun run check
bun run fix
```

---

## License

[MIT](LICENSE) © 2026 Evgenii Zinner
