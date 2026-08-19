/**
 * Shared Web Vitals primitives.
 *
 * Single source of truth for:
 *   - The set of metric names we track (`VitalMetric`)
 *   - Human-readable labels for those metrics (`VITAL_LABELS`)
 *   - The formatter used in both reports (`formatVital`)
 *
 * Threshold semantics live elsewhere because they differ by use case:
 *
 *   - `src/audit/thresholds.ts`  — absolute Core Web Vitals cutoffs (single-site)
 *   - `src/diff/vitals.ts`        — prod×cand ratios (comparison)
 *
 * Both files import `VitalMetric` from here so adding/removing a metric
 * only requires one edit in one place.
 */

export type VitalMetric = "lcp" | "fcp" | "cls" | "inp" | "ttfb";

export const VITAL_LABELS: Record<VitalMetric, string> = {
  lcp: "LCP",
  fcp: "FCP",
  cls: "CLS",
  inp: "INP",
  ttfb: "TTFB",
};

/**
 * Render a vital value in the user-facing format. CLS is unitless and
 * shown with 3 decimal places; all timing metrics are rounded ms.
 */
export function formatVital(metric: VitalMetric, value: number): string {
  if (metric === "cls") return value.toFixed(3);
  return `${Math.round(value)}ms`;
}
