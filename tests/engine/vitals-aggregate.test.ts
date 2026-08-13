import { describe, expect, it } from "vitest";
import { aggregateVitalsSamples } from "../../src/engine/collect.ts";
import type { WebVitals } from "../../src/types/schema.ts";

function vitals(over: Partial<WebVitals>): WebVitals {
  return { lcp: null, cls: null, fcp: null, ttfb: null, inp: null, ...over };
}

describe("aggregateVitalsSamples (issue #179)", () => {
  it("computes median/p75/min/max and keeps raw samples in capture order", () => {
    const samples = [1000, 1200, 900, 1100, 1300].map((lcp) => vitals({ lcp }));
    const stats = aggregateVitalsSamples(samples);
    expect(stats.lcp).not.toBeNull();
    expect(stats.lcp?.median).toBe(1100);
    expect(stats.lcp?.min).toBe(900);
    expect(stats.lcp?.max).toBe(1300);
    // p75 of [900,1000,1100,1200,1300] with linear interpolation, index 3 -> 1200
    expect(stats.lcp?.p75).toBe(1200);
    // Raw samples preserve capture order, not sorted order.
    expect(stats.lcp?.samples).toEqual([1000, 1200, 900, 1100, 1300]);
  });

  it("returns null for a metric that never resolved on any run", () => {
    const samples = [vitals({ lcp: 1000 }), vitals({ lcp: 1100 })];
    const stats = aggregateVitalsSamples(samples);
    expect(stats.inp).toBeNull();
  });

  it("drops individual null samples but still aggregates the resolved ones", () => {
    const samples = [vitals({ inp: null }), vitals({ inp: 50 }), vitals({ inp: 150 })];
    const stats = aggregateVitalsSamples(samples);
    expect(stats.inp?.samples).toEqual([50, 150]);
    expect(stats.inp?.median).toBe(100);
  });

  it("a single sample is its own median/p75/min/max", () => {
    const stats = aggregateVitalsSamples([vitals({ cls: 0.05 })]);
    expect(stats.cls).toEqual({ median: 0.05, p75: 0.05, min: 0.05, max: 0.05, samples: [0.05] });
  });
});
