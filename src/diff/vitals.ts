import type { WebVitals } from "../types/schema.ts";

export interface VitalsThresholds {
  /** Multiplicative tolerance over prod value, e.g. 1.20 = cand may be 20% worse */
  lcp: number;
  fcp: number;
  ttfb: number;
  inp: number;
  /** Absolute tolerance for CLS */
  clsAbsolute: number;
}

export const DEFAULT_THRESHOLDS: VitalsThresholds = {
  lcp: 1.2,
  fcp: 1.2,
  ttfb: 1.1,
  inp: 1.2,
  clsAbsolute: 0.05,
};

export interface VitalDelta {
  prod: number | null;
  cand: number | null;
  delta: number | null;
  deltaPct: number | null;
  passed: boolean;
  reason?: string;
}

export interface VitalsDiff {
  lcp: VitalDelta;
  cls: VitalDelta;
  fcp: VitalDelta;
  ttfb: VitalDelta;
  inp: VitalDelta;
  anyFailed: boolean;
}

export function diffVitals(
  prod: WebVitals,
  cand: WebVitals,
  thresholds: VitalsThresholds = DEFAULT_THRESHOLDS,
): VitalsDiff {
  const lcp = compareRatio(prod.lcp, cand.lcp, thresholds.lcp, "lcp");
  const fcp = compareRatio(prod.fcp, cand.fcp, thresholds.fcp, "fcp");
  const ttfb = compareRatio(prod.ttfb, cand.ttfb, thresholds.ttfb, "ttfb");
  const inp = compareRatio(prod.inp, cand.inp, thresholds.inp, "inp");
  const cls = compareAbsolute(prod.cls, cand.cls, thresholds.clsAbsolute, "cls");
  const anyFailed = [lcp, fcp, ttfb, inp, cls].some((d) => !d.passed);
  return { lcp, fcp, ttfb, inp, cls, anyFailed };
}

function compareRatio(
  prod: number | null,
  cand: number | null,
  maxRatio: number,
  name: string,
): VitalDelta {
  if (prod == null || cand == null) {
    return {
      prod,
      cand,
      delta: null,
      deltaPct: null,
      passed: true,
      reason: `${name}: missing measurement`,
    };
  }
  const delta = cand - prod;
  const ratio = prod > 0 ? cand / prod : 1;
  const deltaPct = prod > 0 ? (delta / prod) * 100 : 0;
  const passed = ratio <= maxRatio;
  return {
    prod,
    cand,
    delta,
    deltaPct,
    passed,
    reason: passed ? undefined : `${name} ratio ${ratio.toFixed(2)} > ${maxRatio}`,
  };
}

function compareAbsolute(
  prod: number | null,
  cand: number | null,
  maxAbsoluteIncrease: number,
  name: string,
): VitalDelta {
  if (prod == null || cand == null) {
    return {
      prod,
      cand,
      delta: null,
      deltaPct: null,
      passed: true,
      reason: `${name}: missing measurement`,
    };
  }
  const delta = cand - prod;
  const passed = delta <= maxAbsoluteIncrease;
  return {
    prod,
    cand,
    delta,
    deltaPct: prod > 0 ? (delta / prod) * 100 : null,
    passed,
    reason: passed ? undefined : `${name} delta ${delta.toFixed(3)} > ${maxAbsoluteIncrease}`,
  };
}
