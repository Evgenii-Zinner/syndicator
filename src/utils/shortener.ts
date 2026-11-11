const BASE62_CHARS = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * Generates a deterministic, URL-safe 3-character Base62 short code from a URL
 * using Web Crypto SHA-256.
 *
 * 3 Base62 characters provide 62^3 = 238,328 clean alphanumeric combinations.
 */
export async function generateShortCode(url: string, attempt = 0): Promise<string> {
  const encoder = new TextEncoder();
  const seed = attempt === 0 ? url : `${url}:${attempt}`;
  const buffer = await crypto.subtle.digest('SHA-256', encoder.encode(seed));
  const view = new DataView(buffer);

  // Read 4 bytes as 32-bit unsigned int (up to 4.29 billion)
  let num = view.getUint32(0);
  let code = '';
  const base = BASE62_CHARS.length;

  for (let i = 0; i < 3; i++) {
    code += BASE62_CHARS[num % base];
    num = Math.floor(num / base);
  }

  return code;
}

/**
 * Resolves or creates a collision-resistant 3-character short code in Cloudflare KV.
 */
export async function getOrCreateShortCode(kv: KVNamespace, canonicalUrl: string): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = await generateShortCode(canonicalUrl, attempt);
    const existing = await kv.get(`short:${code}`);

    // If unassigned, or already points to this canonical URL, use it
    if (!existing || existing === canonicalUrl) {
      await kv.put(`short:${code}`, canonicalUrl);
      return code;
    }
  }

  throw new Error(`Failed to assign unique 3-char short code for: ${canonicalUrl}`);
}
