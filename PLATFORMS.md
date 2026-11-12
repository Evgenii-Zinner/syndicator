# Platform Credentials & Setup Guide

This guide details the requirements, permissions, and step-by-step procedures for obtaining credentials to publish content across all supported and planned syndication platforms.

---

## Summary of Platform Configurations

| Platform         | Variable / Host                           | Required Secret         | Character Limit    | Link Strategy                              |
| :--------------- | :---------------------------------------- | :---------------------- | :----------------- | :----------------------------------------- |
| **Bluesky**      | `BLUESKY_IDENTIFIER`<br>`BLUESKY_SERVICE` | `BLUESKY_PASSWORD`      | 300 graphemes      | Inline in root post + link card embed      |
| **Mastodon**     | `MASTODON_INSTANCE_URL`                   | `MASTODON_ACCESS_TOKEN` | 500 characters     | Inline in root post + chained reply thread |
| **X (Twitter)**  | Default Twitter API v2                    | `X_ACCESS_TOKEN`        | 280 weighted chars | Hook in Post 1, link in first reply        |
| **Meta Threads** | Graph API `graph.threads.net`             | `THREADS_ACCESS_TOKEN`  | 500 characters     | Hook in Post 1, link in first reply        |
| **Nostr**        | Relays via WebSocket (NIP-01)             | `NOSTR_PRIVATE_KEY`     | 500 graphemes      | Inline in root post + `r` reference tag    |
| **Telegram**     | Telegram Bot API                          | `TELEGRAM_BOT_TOKEN`    | 4096 characters    | Rich HTML formatting + link preview        |
| **DEV.to**       | REST API v1 (`dev.to/api/articles`)       | `DEVTO_API_KEY`         | 100,000 characters | Full HTML content + canonical URL for SEO  |

---

## 1. Bluesky

Bluesky uses the AT Protocol (Authenticated Transfer Protocol). We authenticate directly against the Personal Data Server (PDS) using an **App Password**—never use your primary account password.

### Requirements

- A Bluesky handle (e.g., `yourdomain.com` or `yourhandle.bsky.social`).
- An App Password with standard posting capabilities.

### How to Get the App Password

1. Log in to [bsky.app](https://bsky.app).
2. Go to **Settings** → **Privacy and Security** → **App Passwords**.
3. Click **Add App Password**.
4. Name the password (e.g. `syndicator-worker`).
5. Copy the generated 19-character password (formatted as `xxxx-xxxx-xxxx-xxxx`).

### Worker Configuration

```bash
# Set your handle and PDS service URL in Cloudflare Variables (or wrangler.jsonc vars)
# BLUESKY_IDENTIFIER="yourhandle.bsky.social"
# BLUESKY_SERVICE="https://bsky.social"

# Store the App Password securely in Cloudflare
bunx wrangler secret put BLUESKY_PASSWORD
```

---

## 2. Mastodon

Mastodon uses standard OAuth Bearer tokens to communicate with the REST API v1 (`POST /api/v1/statuses`). Any ActivityPub Mastodon instance is supported.

### Requirements

- An account on any Mastodon instance (e.g., `mastodon.social`).
- A personal access token with the `write:statuses` scope.

### How to Get the Access Token

1. Log in to your Mastodon instance (e.g. `https://mastodon.social`).
2. Go to **Preferences** (gear icon) → **Development** → **New Application**.
3. Fill in:
   - **Application name:** `Syndicator`
   - **Application website:** Your website URL (e.g. `https://example.com` or `https://s.example.com`)
   - **Redirect URI:** Leave default (`urn:ietf:wg:oauth:2.0:oob`)
   - **Scopes:** Check `write:statuses` only. (Uncheck `read`, `write`, and `follow` to maintain least-privilege security).
4. Click **Submit**.
5. Click on the newly created application name.
6. Copy the **Your access token** string.

### Worker Configuration

```bash
# In Cloudflare Variables (or wrangler.jsonc vars):
# MASTODON_INSTANCE_URL="https://mastodon.social"

# Store the token securely in Cloudflare
bunx wrangler secret put MASTODON_ACCESS_TOKEN
```

---

## 3. X (Twitter)

X uses Twitter API v2 (`POST https://api.twitter.com/2/tweets`). Because outbound URLs in root tweets are algorithmically downranked on X, Syndicator formats the excerpt as Post 1 and posts the link in a self-reply.

### Requirements

- An approved developer account on the [X Developer Portal](https://developer.x.com).
- A Project and App with **Read and Write** permissions.
- **OAuth 1.0a (Recommended):** Generates permanent tokens that never expire. Requires:
  - Consumer API Key & Secret
  - User Access Token & Secret
- Alternatively, OAuth 2.0 User Access Token (`X_ACCESS_TOKEN`).

### How to Get OAuth 1.0a Keys (Permanent, Never Expire)

1. Navigate to the [X Developer Portal Dashboard](https://developer.x.com/en/portal/dashboard).
2. Go to your App settings → **User authentication settings** → click **Edit** (or Set up):
   - **App permissions:** Select **Read and write**.
   - **Type of App:** Select **Web App, Automated App or Bot**.
   - **OAuth 1.0a:** Turn the toggle **ON**.
   - **App info:** Fill in Callback URI (`https://example.com`) and Website URL (`https://example.com`).
3. Save settings.
4. Navigate to the **Keys and Tokens** tab:
   - Under **Consumer Keys**, click **Generate** (or Regenerate) to get your **API Key** and **API Key Secret**.
   - Under **Authentication Tokens** → **Access Token and Secret**, click **Generate** to get your **Access Token** and **Access Token Secret** (ensure it says "Created with Read and Write permissions").
5. Save all 4 values.

### Worker Configuration

```bash
# OAuth 1.0a (Recommended - never expires):
bunx wrangler secret put X_API_KEY
bunx wrangler secret put X_API_SECRET
bunx wrangler secret put X_ACCESS_TOKEN
bunx wrangler secret put X_ACCESS_SECRET
```

---

## 4. Meta Threads

Threads uses the Meta Threads API (`graph.threads.net`). Like X, Threads penalizes outbound links in root posts; Syndicator places the link in the first reply.

### Requirements

- A Meta Developer Account on [Meta for Developers](https://developers.facebook.com/).
- A Threads App with the **Threads API** product added.
- An active Instagram/Threads account linked as a Tester or Admin.
- Access token carrying permissions:
  - `threads_basic`
  - `threads_content_publish`
  - `threads_manage_replies` (required for threading replies)

### How to Get the Access Token

1. Go to [developers.facebook.com](https://developers.facebook.com) and click **My Apps** → **Create App**.
2. Select **Other** as the use case, then choose **Business** or **None**.
3. Under App Dashboard, locate **Threads API** and click **Set Up**.
4. In **Roles** → **Test Users** (or App Roles), add your Threads account as a Tester, and accept the tester invite inside the Instagram/Threads app settings (**Settings** → **Website permissions** → **Invites**).
5. Generate a Short-Lived User Access Token via the **Graph API Explorer** or Authorization URL with scopes `threads_basic,threads_content_publish,threads_manage_replies`.
6. Exchange the short-lived token for a **Long-Lived Access Token** (valid for 60 days, refreshable) by calling:

   ```http
   GET https://graph.threads.net/access_token
     ?grant_type=th_exchange_token
     &client_secret=<APP_SECRET>
     &access_token=<SHORT_LIVED_TOKEN>
   ```

### Worker Configuration

```bash
# Store the Long-Lived Token securely in Cloudflare
bunx wrangler secret put THREADS_ACCESS_TOKEN
```

---

## 5. Nostr

Nostr is a decentralized protocol based on cryptographic keypairs (secp256k1) and WebSocket relays. Syndicator creates signed **NIP-01 Kind 1** Short Text Notes with an `r` (reference URL) tag and broadcasts them to configured relays.

### Requirements

- A Nostr identity (secp256k1 private key in `nsec1...` bech32 format or 64-character hex).
- One or more public/private relays (e.g. `wss://relay.damus.io`, `wss://nos.lol`, `wss://relay.nostr.band`).

### How to Get Your Private Key

1. If you already use a Nostr client (like [Primal](https://primal.net), [Damus](https://damus.io), or [Coracle](https://coracle.social)):
   - Open your profile settings → **Account & Keys** → **Export Secret Key**.
   - Copy your `nsec1...` key (or hex format).
2. Or generate a dedicated bot keypair via `nostr-tools`:

   ```bash
   bun -e "import { generateSecretKey } from 'nostr-tools/pure'; import { nip19 } from 'nostr-tools'; const sk = generateSecretKey(); console.log('nsec:', nip19.nsecEncode(sk)); console.log('npub:', nip19.npubEncode(nip19.decode(nip19.nsecEncode(sk)).data));"
   ```

### Worker Configuration

```bash
# Optional in wrangler.jsonc vars:
# NOSTR_RELAYS="wss://relay.damus.io,wss://nos.lol,wss://relay.nostr.band"

# Store the Private Key securely in Cloudflare
bunx wrangler secret put NOSTR_PRIVATE_KEY
```

---

## 6. Telegram Channel / Group

Telegram uses the official Telegram Bot API (`POST https://api.telegram.org/bot<TOKEN>/sendMessage`). Messages support full HTML formatting with bold titles, full excerpts, and rich link previews.

### Requirements

- A Telegram Bot created via [@BotFather](https://t.me/BotFather).
- A Telegram Channel or Group where your bot has **Administrator** privileges with permission to **Post Messages**.

### How to Set Up

1. Open Telegram and start a chat with [@BotFather](https://t.me/BotFather).
2. Send `/newbot` and follow prompts to choose a name and username (e.g. `my_blog_syndicator_bot`).
3. Copy the **HTTP API Token** (e.g. `123456789:ABCdefGHIjklMNOpqrSTUvwxYZ`).
4. In your Telegram Channel:
   - Go to **Channel Info** → **Administrators** → **Add Admin**.
   - Search for your newly created bot username and add it with permission to **Post Messages**.
5. Determine your `TELEGRAM_CHAT_ID`:
   - For public channels: `@your_channel_username` (e.g. `@devlog`).
   - For private channels: forward a message from your channel to [@userinfobot](https://t.me/userinfobot) or [@JsonDumpBot](https://t.me/JsonDumpBot) to find the numeric ID (e.g. `-1001234567890`).

### Worker Configuration

```bash
# In Cloudflare Variables:
# TELEGRAM_CHAT_ID="@devlog"

# Store the Bot Token securely in Cloudflare:
bunx wrangler secret put TELEGRAM_BOT_TOKEN
```

---

## 7. DEV.to (Forem)

DEV.to uses the official DEV REST API v1 (`POST https://dev.to/api/articles`). Syndicator extracts the full HTML content from `<content:encoded>` in your RSS feed and publishes it with your article's `canonical_url`—ensuring 100% of the SEO credit stays with your original domain.

### Requirements

- A [DEV.to](https://dev.to) account.
- A DEV.to Personal API Key.

### How to Get the API Key

1. Log in to [dev.to](https://dev.to).
2. Go to **Settings** → **Extensions** (or navigate directly to `https://dev.to/settings/extensions`).
3. Scroll down to the **DEV Community API Keys** section.
4. Enter a description for your key (e.g. `Syndicator Bot`) and click **Generate API Key**.
5. Copy the generated key.

### Publishing as Draft vs Published

- By default, `DEVTO_PUBLISHED` is `true` (articles go live immediately).
- Set `DEVTO_PUBLISHED="false"` in Cloudflare Variables if you prefer posts to be imported as unpublished drafts for manual review.

### Worker Configuration

```bash
# Optional in Cloudflare Variables:
# DEVTO_PUBLISHED="true" (or "false" to import as drafts)

# Store the API key securely in Cloudflare:
bunx wrangler secret put DEVTO_API_KEY
```

---

## Testing & Verifying Secrets Locally

When developing locally, store your secrets in `.dev.vars` (which is git-ignored):

```ini
BLUESKY_PASSWORD=xxxx-xxxx-xxxx-xxxx
MASTODON_ACCESS_TOKEN=your_token_here
X_ACCESS_TOKEN=your_token_here
THREADS_ACCESS_TOKEN=your_token_here
NOSTR_PRIVATE_KEY=nsec1..._or_64_char_hex
```

To verify the connection without waiting for the 4-hour cron trigger:

```bash
# Run local dev server
bun run dev

# In another terminal, trigger a manual sync
curl -X POST http://localhost:8787/sync
```
