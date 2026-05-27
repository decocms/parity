import type { FlowCapture } from "../types/schema.ts";
import type { Platform } from "./platform.ts";
import {
  type LearnedSelectors,
  promoteFromLlm,
  recordFailure,
  recordSuccess,
  SelectorKey,
} from "./repo.ts";

export interface PromoteResult {
  promoted: number;
  deprecated: number;
  recorded: number;
}

/**
 * Walk the steps captured by a flow and update the learned-selectors library:
 *   - LLM-recovered selectors are PROMOTED with successRate 0.5
 *   - "ok" steps bump the existing selector's successRate
 *   - "failed" steps decrement; if successRate < 0.3 after ≥3 attempts the
 *     entry is deprecated and removed from rotation
 *
 * Selectors that aren't a single re-usable CSS/Playwright string (e.g. a
 * composite like "input[...] → +" that describes a multi-element walk) are
 * skipped — promoting them would corrupt the cascade since `page.locator()`
 * can't parse them.
 */
export function promoteStepsFromFlow(
  learned: LearnedSelectors,
  platform: Platform,
  host: string,
  flow: FlowCapture,
): PromoteResult {
  let promoted = 0;
  let deprecated = 0;
  let recorded = 0;
  for (const step of flow.steps ?? []) {
    if (!step.selectorKey || !step.usedSelector) continue;
    if (!isReusableSelector(step.usedSelector)) continue;
    const parsed = SelectorKey.safeParse(step.selectorKey);
    if (!parsed.success) continue;
    const key = parsed.data;
    if (step.recoveredByLlm) {
      promoteFromLlm(learned, platform, key, step.usedSelector, host);
      promoted++;
    } else if (step.status === "ok") {
      recordSuccess(learned, platform, key, step.usedSelector, host);
      recorded++;
    } else if (step.status === "failed") {
      const before = recordFailure(learned, platform, key, step.usedSelector, host);
      if (before?.deprecated) deprecated++;
    }
  }
  return { promoted, deprecated, recorded };
}

/**
 * A selector is "reusable" when it can be passed verbatim to `page.locator()`
 * in a future run. Composite descriptors (e.g. "<sel> → +") used to record
 * which multi-step walk a heuristic took are useful for human debug but not
 * for the cascade — exclude them.
 */
function isReusableSelector(s: string): boolean {
  if (s.includes("→")) return false;
  if (s.includes(" ~ ")) return false;
  return s.trim().length > 0;
}
