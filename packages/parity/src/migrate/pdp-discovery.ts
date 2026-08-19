/**
 * Platform-aware first-product-href detection for `parity migrate`'s
 * `pdp-auto` discovery.
 *
 * The shared `firstProductHrefFromPlpHtml` only knows VTEX (`/p`) and Shopify
 * (`/products/`) URL shapes, so on other platforms (e.g. Salesforce Commerce
 * Cloud, whose product URLs end in `-<pid>.html` or carry `?pid=`) `pdp-auto`
 * finds nothing. This adds platform-specific patterns and falls back to the
 * shared heuristic. Pure + unit-tested; the shared function is untouched so
 * run/journey discovery keeps its exact behavior.
 */

import { firstProductHrefFromPlpHtml } from "../engine/selector-discovery-pass.ts";
import type { Platform } from "../learned/platform.ts";

/** Extra product-href patterns keyed by platform (tried before the shared heuristic). */
// Patterns use `[^"]*` (not `+`) before the key path so root-relative hrefs
// (`/products/x`, `/slug-P123.html`) match — migrate reads rendered relative
// links, not just absolute ones.
const PLATFORM_PATTERNS: Partial<Record<Platform, RegExp[]>> = {
  "salesforce-commerce": [
    // `…-<PID with 3+ digits>.html` (canonical Demandware product page) — first.
    /href="([^"]*-[A-Za-z]?\d{3,}\.html)"/gi,
    // Product-Show / Product-Detail controller with a pid (not Wishlist/Cart).
    /href="([^"]*Product-(?:Show|Detail)[^"]*[?&]pid=[^"&]+[^"]*)"/gi,
  ],
  shopify: [/href="([^"]*\/products\/[^"]+)"/gi],
  vtex: [/href="([^"]*\/p(?:\?[^"]*|\/[^"]+|))"/gi],
  "vtex-fs": [/href="([^"]*\/p(?:\?[^"]*|\/[^"]+|))"/gi],
};

/** Reject action/endpoint URLs that carry a pid but aren't a product page. */
const ACTION_URL = /(Wishlist|Cart|MiniCart|Login|Account|Address|Order|Compare)-|add-?to-?/i;

/** A candidate is a plausible PDP if it parses and isn't a known action endpoint. */
function acceptProductUrl(href: string, baseUrl: string): string | null {
  if (ACTION_URL.test(href)) return null;
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return null;
  }
}

export function firstProductHref(
  html: string,
  baseUrl: string,
  platform?: Platform,
): string | null {
  const patterns = platform ? (PLATFORM_PATTERNS[platform] ?? []) : [];
  for (const re of patterns) {
    re.lastIndex = 0;
    for (let m = re.exec(html); m; m = re.exec(html)) {
      const url = m[1] ? acceptProductUrl(m[1], baseUrl) : null;
      if (url) return url;
    }
  }
  // Fall back to the shared VTEX/Shopify heuristic (covers unknown platforms).
  return firstProductHrefFromPlpHtml(html, baseUrl);
}
