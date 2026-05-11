import { describe, expect, it } from "vitest";
import { DEFAULT_THRESHOLDS, diffVitals } from "../../src/diff/vitals.ts";

describe("diffVitals", () => {
  it("passa quando cand está dentro do threshold", () => {
    const d = diffVitals(
      { lcp: 2000, cls: 0.05, fcp: 1000, ttfb: 200, inp: 100 },
      { lcp: 2200, cls: 0.05, fcp: 1100, ttfb: 210, inp: 110 },
    );
    expect(d.anyFailed).toBe(false);
  });

  it("falha quando LCP cresce mais que 20%", () => {
    const d = diffVitals(
      { lcp: 1000, cls: 0, fcp: 500, ttfb: 100, inp: 50 },
      { lcp: 1400, cls: 0, fcp: 500, ttfb: 100, inp: 50 },
    );
    expect(d.lcp.passed).toBe(false);
    expect(d.anyFailed).toBe(true);
  });

  it("falha quando CLS cresce mais que 0.05 absoluto", () => {
    const d = diffVitals(
      { lcp: 1000, cls: 0.01, fcp: 500, ttfb: 100, inp: 50 },
      { lcp: 1000, cls: 0.08, fcp: 500, ttfb: 100, inp: 50 },
    );
    expect(d.cls.passed).toBe(false);
  });

  it("tolera quando uma das medidas é null (não bloqueia)", () => {
    const d = diffVitals(
      { lcp: null, cls: null, fcp: null, ttfb: null, inp: null },
      { lcp: 10_000, cls: 1, fcp: 5000, ttfb: 1000, inp: 1000 },
    );
    expect(d.anyFailed).toBe(false);
  });

  it("aceita thresholds customizados", () => {
    const d = diffVitals(
      { lcp: 1000, cls: 0, fcp: 500, ttfb: 100, inp: 50 },
      { lcp: 1500, cls: 0, fcp: 500, ttfb: 100, inp: 50 },
      { ...DEFAULT_THRESHOLDS, lcp: 1.6 },
    );
    expect(d.lcp.passed).toBe(true);
  });
});
