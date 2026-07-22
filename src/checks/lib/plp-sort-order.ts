/**
 * Pure helpers for `plp-sorting.ts` — extracted so the order-comparison
 * logic (the part that actually decides "did sorting do anything?") can
 * be unit tested without spinning up a fetch mock for every case.
 */

/**
 * Extract product hrefs from PLP HTML IN DOM ORDER (dedup'd, first
 * occurrence wins). Mirrors the same generic Deco/VTEX/Shopify href
 * conventions `plp-pagination.ts` uses (`/p`, `/p/...`, `/products/...`)
 * but preserves order — `plp-pagination.ts`'s version returns a Set,
 * which is enough for overlap counting but useless for "did the order
 * change" comparisons.
 */
export function extractOrderedProductHrefs(html: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string): void => {
    const normalized = raw.split("?")[0]!.replace(/\/$/, "");
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    out.push(normalized);
  };

  const rePOrCatchAll = /href="([^"]*\/p(?:\?[^"]*|\/[^"]+|))"/gi;
  for (;;) {
    const m = rePOrCatchAll.exec(html);
    if (!m) break;
    if (m[1]) push(m[1]);
  }
  const reProducts = /href="([^"]*\/products\/[^"]+)"/gi;
  for (;;) {
    const m = reProducts.exec(html);
    if (!m) break;
    if (m[1]) push(m[1]);
  }
  return out;
}

/**
 * Did applying a sort query param actually change the product order?
 * Compares the first N (capped, since some PLPs render 50+ cards) items
 * position-by-position. Returns false when either list is empty (nothing
 * to compare — the caller should treat that as "untestable", not
 * "unchanged").
 */
export function sortOrderChanged(defaultOrder: string[], sortedOrder: string[]): boolean {
  if (defaultOrder.length === 0 || sortedOrder.length === 0) return false;
  const len = Math.min(defaultOrder.length, sortedOrder.length, 20);
  for (let i = 0; i < len; i++) {
    if (defaultOrder[i] !== sortedOrder[i]) return true;
  }
  return false;
}
