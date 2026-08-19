/**
 * Pure href-overlap math shared by the PLP pagination check's fetch-based
 * fallback (`plp-pagination.ts`) and the interactive Playwright-driven
 * pagination step (`engine/flows/simple.ts`). Both need the same "how much
 * did this set of product links change" measurement — extracted here so a
 * future tweak to the overlap formula can't drift between the two call
 * sites the way duplicated math tends to (see M1's HTML-compaction work
 * for the same class of drift in a different check).
 */

/**
 * Fraction of `b` that also appears in `a`, normalized by the larger of the
 * two set sizes. 0 when either input is empty. 1.0 means "identical sets".
 */
export function hrefOverlap(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const sa = new Set(a);
  let common = 0;
  for (const x of b) if (sa.has(x)) common++;
  return common / Math.max(a.length, b.length);
}

/**
 * Normalize a product href for set-membership comparison: strip query
 * string and trailing slash so `skuId=` params or trailing-slash variance
 * don't make the same product count as "different".
 */
export function normalizeHref(href: string): string {
  const withoutQuery = href.split("?")[0] ?? href;
  return withoutQuery.replace(/\/$/, "");
}

/**
 * Does `after` carry a "page" signal that `before` didn't — either the
 * `?page=` query param changed or the path itself changed (path-based
 * pagination, e.g. `/pagina/2`). Equal URLs always return false.
 */
export function urlGainedPageIndicator(before: string, after: string): boolean {
  if (before === after) return false;
  try {
    const ub = new URL(before);
    const ua = new URL(after);
    if (ub.searchParams.get("page") !== ua.searchParams.get("page")) return true;
    if (ub.pathname !== ua.pathname) return true;
    return false;
  } catch {
    return before !== after;
  }
}
