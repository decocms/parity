/**
 * Pure helpers for the `hover-preload-budget` flow step (folded into
 * `flowPlp`) and the `serverfn-hover-flood` check (issue #54, 3/D —
 * TanStack's `preload="intent"` firing a `_serverFn` request per hovered
 * `<Link>`, flooding the worker on a PLP with several product cards).
 *
 * Kept separate from the Playwright-driven hover simulation so the
 * regex-matching and budget-threshold logic is unit-testable without a
 * browser.
 */

/** TanStack Start's real server-fn request convention, used when `ParityRc.serverFnPattern` is unset. */
export const DEFAULT_SERVERFN_PATTERN = "_serverFn";

/** Default budget (max concurrent server-fn requests tolerated from a hover burst) when `ParityRc.serverFnFloodBudget` is unset. */
export const DEFAULT_SERVERFN_FLOOD_BUDGET = 10;

/**
 * Count how many of `urls` match the given server-fn pattern (string form,
 * compiled case-insensitively). Falls back to 0 matches (not a throw) when
 * the configured pattern is an invalid regex — a bad `ParityRc` value
 * should never crash the check, just make it a no-op.
 */
export function countServerFnRequests(urls: string[], patternSource: string): number {
  let re: RegExp;
  try {
    re = new RegExp(patternSource, "i");
  } catch {
    return 0;
  }
  return urls.filter((u) => re.test(u)).length;
}

export interface HoverFloodBudgetResult {
  exceeded: boolean;
  count: number;
  budget: number;
}

/** Pure pass/fail: did the observed server-fn request count exceed the configured budget? */
export function evaluateHoverFloodBudget(count: number, budget: number): HoverFloodBudgetResult {
  return { exceeded: count > budget, count, budget };
}
