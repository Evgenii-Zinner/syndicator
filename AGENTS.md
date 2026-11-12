# AGENTS.md — Agent & Assistant Setup Guide

This document provides instructions for AI coding agents (such as Antigravity, Cursor, Claude Code, GitHub Copilot) assisting developers in configuring, deploying, and maintaining **Syndicator**.

---

## 1. Project Invariants & Guardrails

When working on or configuring this repository, agents MUST respect the following rules:

1. **100% Generic & Open Source:**
   - Never commit or hardcode personal domains, email addresses, usernames, or account IDs in repository code, configuration (`wrangler.jsonc`), or test fixtures.
   - All fixtures and tests MUST strictly use RFC 2606 reserved domains (`example.com`, `s.example.com`).
2. **Cloudflare KV Only:**
   - Never introduce relational databases (e.g. D1, PostgreSQL) or external storage services. KV is the sole state store.
3. **No Credential Exposure:**
   - Secrets (`*_TOKEN`, `*_PASSWORD`, `*_PRIVATE_KEY`, `*_SECRET`) must only ever be configured via `wrangler secret put <NAME>` or the Cloudflare Dashboard **Variables and Secrets** UI.
4. **Preserve Dashboard Variables (`keep_vars`):**
   - [`wrangler.jsonc`](wrangler.jsonc) MUST keep `"keep_vars": true` so that Cloudflare's Git deployment pipeline does not wipe variables defined in the dashboard.

---

## 2. Interactive User Setup Walkthrough

When a user asks you to help them configure Syndicator, walk them through the following steps sequentially.

### Step 1: Cloudflare Worker Deployment

Guide the user to deploy the repository to Cloudflare Workers:

- **One-Click Deploy:** Click the **Deploy to Cloudflare Workers** button in the [README.md](README.md).
- **Manual Git Import:**
  1. Open [Cloudflare Dashboard → Workers & Pages](https://dash.cloudflare.com/?to=/:account/workers-and-pages).
  2. Click **Create Application** → **Pages / Workers** → **Import from Git**.
  3. Select their fork/clone of `syndicator`.
  4. Leave build settings default. The `KV` namespace will be auto-provisioned via `wrangler.jsonc`.

---

### Step 2: Public Variables Configuration

Direct the user to open their Worker in the Cloudflare Dashboard:
**Worker Settings → Variables and Secrets → Variables → Add**

Provide them this exact table:

| Variable Name           | Required? | Recommended Value / Format              | Description                                     |
| :---------------------- | :-------- | :-------------------------------------- | :---------------------------------------------- |
| `RSS_FEED_URL`          | **Yes**   | `https://yourdomain.com/rss.xml`        | Full URL to the RSS or Atom feed.               |
| `SHORT_DOMAIN`          | Optional  | `s.yourdomain.com`                      | Custom domain for 3-character Base62 redirects. |
| `BLUESKY_IDENTIFIER`    | Optional  | `yourname.bsky.social` or custom domain | Bluesky handle or DID.                          |
| `BLUESKY_SERVICE`       | Optional  | `https://bsky.social`                   | AT Protocol PDS (defaults to bsky.social).      |
| `MASTODON_INSTANCE_URL` | Optional  | `https://mastodon.social`               | Base URL of your Mastodon instance.             |
| `TELEGRAM_CHAT_ID`      | Optional  | `@your_channel` or `-100123456789`      | Public `@channel` username or private chat ID.  |
| `NOSTR_RELAYS`          | Optional  | `wss://relay.damus.io,wss://nos.lol`    | Comma-separated WebSocket relay URLs.           |

---

### Step 3: Platform Secrets Configuration

Walk the user through obtaining credentials for each platform they want to enable. _(Any platform without configured secrets is automatically skipped)_.

#### 1. Bluesky

- **URL to open:** [https://bsky.app/settings/app-passwords](https://bsky.app/settings/app-passwords)
- **Action:** Click **Add App Password**, name it `syndicator`, copy the `xxxx-xxxx-xxxx-xxxx` string.
- **Secret to set:** `BLUESKY_PASSWORD`

#### 2. Mastodon

- **URL to open:** `{your_instance_url}/settings/applications/new` (e.g. [https://mastodon.social/settings/applications/new](https://mastodon.social/settings/applications/new))
- **Action:**
  - Application name: `Syndicator`
  - Redirect URI: leave default (`urn:ietf:wg:oauth:2.0:oob`)
  - Scopes: Check **`write:statuses`** only (uncheck `read` and `follow` for least privilege).
  - Submit, click into `Syndicator`, and copy **Your access token**.
- **Secret to set:** `MASTODON_ACCESS_TOKEN`

#### 3. Telegram

- **URL to open:** [https://t.me/BotFather](https://t.me/BotFather)
- **Action:**
  - Send `/newbot`, choose display name and username.
  - Copy HTTP API token.
  - In Telegram channel, go to **Channel Info → Administrators → Add Admin**, select your bot, and allow **Post Messages**.
- **Secret to set:** `TELEGRAM_BOT_TOKEN`
- **Variable to set:** `TELEGRAM_CHAT_ID` (e.g. `@yourchannel`)

#### 4. Meta Threads

- **URL to open:** [https://developers.facebook.com](https://developers.facebook.com)
- **Action:**
  - Create App → Use case **Other** → Add **Threads API**.
  - Add your Threads account as a **Threads Tester** under **App Roles**.
  - On your phone/web Instagram, accept the tester invite (**Settings → Website Permissions → Apps and Websites → Tester Invites**).
  - In Meta Developer Portal → **Threads → User Token Generator**, click **Generate Token** next to your account and copy the token.
- **Secret to set:** `THREADS_ACCESS_TOKEN`

#### 5. Nostr

- **Action:**
  - Export the secret key (`nsec1...` or 64-character hex) from your Nostr client (Primal, Damus, Amethyst, Coracle).
  - Or generate a dedicated bot keypair via Bun/Node:

    ```bash
    bun -e "import { generateSecretKey } from 'nostr-tools/pure'; import { nip19 } from 'nostr-tools'; const sk = generateSecretKey(); console.log('nsec:', nip19.nsecEncode(sk));"
    ```

- **Secret to set:** `NOSTR_PRIVATE_KEY`

#### 6. X (Twitter) — Optional

- **URL to open:** [https://developer.x.com](https://developer.x.com)
- **Action:**
  - App Settings → **User authentication settings** → Turn **OAuth 1.0a ON** with **Read and write** permissions.
  - Under **Keys and Tokens**, generate **API Key & Secret** (Consumer) and **Access Token & Secret** (User Context).
  - Note: Requires an active X developer credit balance or Free tier project.
- **Secrets to set:** `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_SECRET`

---

### Step 4: Verification & Live Health Check

1. Tell the user to visit their worker's URL:

   ```text
   GET https://<worker-subdomain>.workers.dev/
   ```
2. Verify the JSON response:
   - `"status": "healthy"`
   - Each platform shows `"configured": true`
   - `"state": { "latestUrl": null }` confirms first-run readiness.
3. Trigger the initial baseline seeding:

   ```bash
   curl -X POST https://<worker-url>/sync
   ```

   Confirm that `itemsProcessed: 0, skippedCount: N` appears and `latestUrl` updates to the newest article in the feed.

---

## 3. Local Development & Verification Commands

When modifying the codebase, run these commands before finalizing:

```bash
# Run full unit test suite (48 tests across 9 files)
bun test

# Run Biome linter and formatter check
bun run check

# Apply automatic formatting fixes
bun run fix

# TypeScript compiler verification
bun run typecheck
```
