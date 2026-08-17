/**
 * In-page text fetch for `parity migrate` discovery (sitemap, PLP/PDP).
 *
 * A bare node `fetch` is 403'd by Akamai/Cloudflare bot protection on many
 * storefronts, which would silently degrade discovery to home-only. Fetching
 * THROUGH the live page (`page.evaluate(fetch)`) reuses the real browser's
 * TLS/UA/cookies and gets through — same trick `assets.ts` uses for binary
 * downloads. Node fetch is kept as a fallback for cross-origin bodies that
 * CORS blocks the in-page read of.
 */

import type { Page } from "playwright";

export async function browserFetchText(page: Page, url: string): Promise<string | null> {
  try {
    const text = await page.evaluate(async (u: string) => {
      const res = await fetch(u);
      if (!res.ok) return null;
      return res.text();
    }, url);
    if (text != null) return text;
  } catch {
    /* fall through to node fetch */
  }
  return nodeFetchText(url);
}

export async function nodeFetchText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}
