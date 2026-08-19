import type { Page } from "playwright";
import type { DiscoveredSelectors } from "../llm/discover-selectors.ts";

/**
 * Live-validation results for a batch of `page.locator(sel).count()` probes
 * against ONE already-loaded page. The caller decides which keys are
 * relevant for which page (home/PLP/PDP) — this module is deliberately
 * dumb/generic: give it a page + a selector map, get back a pass/fail map.
 */
export interface ValidationResult {
  /** `true` when `count() > 0`, `false` when it matched nothing or timed out. */
  validated: Partial<Record<keyof DiscoveredSelectors, boolean>>;
  failed: (keyof DiscoveredSelectors)[];
}

/** Per-selector budget — a live DOM probe should never hang a discovery run. */
const PROBE_TIMEOUT_MS = 2_000;

/**
 * Small local timeout helper (deliberately not importing `withCap` from
 * `engine/flows/shared.ts` — that module pulls in flow-only helpers and
 * Playwright device presets that have nothing to do with this generic
 * validation pass; a 6-line local helper is cheaper than the cross-module
 * coupling).
 */
function withTimeout<T>(p: Promise<T>, capMs: number, fallback: T): Promise<T> {
  return Promise.race([
    p.catch(() => fallback),
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), capMs)),
  ]);
}

/**
 * Only the fields that hold an actual CSS/Playwright selector string are
 * probed. `lowConfidenceKeys` is metadata (string[]), not a selector.
 */
function selectorKeysOf(selectors: DiscoveredSelectors): (keyof DiscoveredSelectors)[] {
  return (Object.keys(selectors) as (keyof DiscoveredSelectors)[]).filter(
    (k) => k !== "lowConfidenceKeys",
  );
}

/**
 * Run a `page.locator(sel).count() > 0` probe for every non-empty selector
 * in `selectors`, capped at ~2s each so a pathological selector (or a hung
 * page) can't stall discovery. A selector "validates" when it matches at
 * least one element on the CURRENT page — callers are responsible for
 * loading the right page (home/PLP/PDP) before calling this for the keys
 * that belong to it.
 */
export async function validateSelectors(
  page: Page,
  selectors: DiscoveredSelectors,
): Promise<ValidationResult> {
  const validated: Partial<Record<keyof DiscoveredSelectors, boolean>> = {};
  const failed: (keyof DiscoveredSelectors)[] = [];

  for (const key of selectorKeysOf(selectors)) {
    const sel = selectors[key] as string | undefined;
    if (!sel) continue; // empty/absent selector — nothing to validate
    const count = await withTimeout(
      page
        .locator(sel)
        .count()
        .catch(() => -1),
      PROBE_TIMEOUT_MS,
      -1,
    );
    const ok = count > 0;
    validated[key] = ok;
    if (!ok) failed.push(key);
  }

  return { validated, failed };
}
