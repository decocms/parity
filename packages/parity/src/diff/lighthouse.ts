/**
 * Lighthouse opportunity comparison.
 *
 * `extractOpportunities` (engine/lighthouse.ts) already pulls the actionable audits Lighthouse
 * computes — render-blocking resources, a lazy-loaded LCP image, unused preconnects — with the
 * savings Lighthouse itself estimated. Until now those landed in `vitals.json` as data and
 * nowhere else: no issues, no severity, no score impact, nothing for `parity prompt` to hand an
 * agent. This module turns them into something comparable. Issue #264.
 */

import type { LhOpportunity, PageCapture, Severity } from "../types/schema.ts";

/** Savings thresholds (ms) for issue severity, per #264. */
const HIGH_SAVINGS_MS = 500;
const MEDIUM_SAVINGS_MS = 200;

/**
 * Severity from what Lighthouse says the fix is worth. Time saved is the only ranking a reader
 * can act on — an audit that scores badly but saves 30ms is noise.
 */
export function opportunitySeverity(savingsMs: number): Severity {
  if (savingsMs >= HIGH_SAVINGS_MS) return "high";
  if (savingsMs >= MEDIUM_SAVINGS_MS) return "medium";
  return "low";
}

/**
 * Dedupe opportunities across pages by audit id, keeping the worst (max savings) instance — the
 * same audit repeats on every page, and the worst page is the one worth fixing first. Biggest
 * wins first.
 */
export function aggregateOpportunities(pages: PageCapture[]): LhOpportunity[] {
  const byId = new Map<string, LhOpportunity>();
  for (const p of pages) {
    for (const o of p.lhOpportunities ?? []) {
      const prev = byId.get(o.id);
      if (!prev || o.savingsMs > prev.savingsMs) byId.set(o.id, o);
    }
  }
  return [...byId.values()].sort(
    (a, b) => b.savingsMs - a.savingsMs || b.savingsBytes - a.savingsBytes,
  );
}

export interface OpportunityDelta {
  cand: LhOpportunity;
  /** The same audit on the prod side, when prod also has it. */
  prod: LhOpportunity | null;
  /** cand savings minus prod savings; positive means cand is worse. */
  deltaMs: number;
  /**
   * Whether this is a regression the migration introduced, as opposed to something prod does
   * too. `true` when prod has no such opportunity, or when cand wastes materially more time on
   * it. This is the distinction that decides if an issue reads as "we broke it" or "it was
   * always like this" — reporting both the same way is how a real regression gets lost in a
   * list of pre-existing debt.
   */
  regression: boolean;
}

/** How much worse cand has to be, in ms, before a shared opportunity counts as a regression. */
const REGRESSION_DELTA_MS = 200;

/**
 * Pair cand opportunities against prod by audit id. Single-site runs (no prod pages) get
 * `prod: null` and `regression: false` — with nothing to compare against, calling something a
 * regression would be a guess.
 */
export function diffOpportunities(
  prodPages: PageCapture[],
  candPages: PageCapture[],
): OpportunityDelta[] {
  const prodById = new Map(aggregateOpportunities(prodPages).map((o) => [o.id, o]));
  const singleSite = prodPages.length === 0;

  return aggregateOpportunities(candPages).map((cand) => {
    const prod = prodById.get(cand.id) ?? null;
    const deltaMs = cand.savingsMs - (prod?.savingsMs ?? 0);
    return {
      cand,
      prod,
      deltaMs,
      regression: singleSite ? false : !prod || deltaMs >= REGRESSION_DELTA_MS,
    };
  });
}
