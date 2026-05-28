/**
 * Absolute thresholds for `parity audit` — applied to ONE site with no
 * comparison baseline. Each metric has a "needs improvement" cutoff and a
 * "poor" cutoff aligned with Google's official Core Web Vitals guidance
 * (https://web.dev/articles/vitals). The parity comparison checks in
 * `src/checks/web-vitals.ts` use prod×cand ratios; here we apply the raw
 * numbers Google publishes.
 *
 *   metric   | good (≤) | needs improvement | poor (>)
 *   ---------|----------|-------------------|---------
 *   LCP (ms) | 2500     | 2500-4000         | 4000
 *   FCP (ms) | 1800     | 1800-3000         | 3000
 *   CLS      | 0.10     | 0.10-0.25         | 0.25
 *   INP (ms) | 200      | 200-500           | 500
 *   TTFB (ms)| 800      | 800-1800          | 1800
 *
 * Severity mapping for audit issues:
 *   good             → no issue
 *   needs improvement → severity "medium"
 *   poor              → severity "high"  (LCP/CLS/INP also escalate to "critical" when 2× the poor cutoff)
 */

import type { Severity } from "../types/schema.ts";
import type { VitalMetric } from "../types/vitals.ts";

// Re-export shared primitives so existing imports of these names from
// `src/audit/thresholds.ts` keep working (no breaking change for the
// audit/* modules and tests). The single source lives in
// `src/types/vitals.ts` now.
export { VITAL_LABELS, formatVital } from "../types/vitals.ts";

export interface VitalThreshold {
  /** Upper bound for "good". At or below this is no issue. */
  goodMax: number;
  /** Upper bound for "needs improvement". Above goodMax up to this → medium. */
  niMax: number;
  /** Above this is "poor". → high. 2× this → critical. */
  poorCriticalMultiplier?: number;
}

export const VITAL_THRESHOLDS: Record<VitalMetric, VitalThreshold> = {
  lcp: { goodMax: 2500, niMax: 4000, poorCriticalMultiplier: 2 },
  fcp: { goodMax: 1800, niMax: 3000 },
  cls: { goodMax: 0.10, niMax: 0.25, poorCriticalMultiplier: 2 },
  inp: { goodMax: 200, niMax: 500, poorCriticalMultiplier: 2 },
  ttfb: { goodMax: 800, niMax: 1800 },
};

export function classifyVital(
  metric: VitalMetric,
  value: number,
): { severity: Severity | "ok"; label: "good" | "needs-improvement" | "poor" | "critical" } {
  const t = VITAL_THRESHOLDS[metric];
  if (value <= t.goodMax) return { severity: "ok", label: "good" };
  if (value <= t.niMax) return { severity: "medium", label: "needs-improvement" };
  if (t.poorCriticalMultiplier && value > t.niMax * t.poorCriticalMultiplier) {
    return { severity: "critical", label: "critical" };
  }
  return { severity: "high", label: "poor" };
}
