import { describe, expect, it } from "vitest";
import { median } from "../../src/engine/benchmark.ts";
import { deltaTone, pctChange, speedup } from "../../src/report/benchmark-html.ts";

// The benchmark's number-crunching is what the client-facing headline rests on
// ("X× mais rápido", the per-step deltas and their good/bad colour). If any of
// this drifts the report lies, so it gets a runnable check.

describe("median", () => {
  it("returns 0 for empty / all-non-finite", () => {
    expect(median([])).toBe(0);
    expect(median([Number.NaN, Number.POSITIVE_INFINITY])).toBe(0);
  });
  it("picks the middle of an odd-length set (unsorted input)", () => {
    expect(median([300, 100, 200])).toBe(200);
  });
  it("averages the two middles of an even-length set", () => {
    expect(median([100, 200, 300, 400])).toBe(250);
  });
  it("ignores non-finite samples", () => {
    expect(median([100, Number.NaN, 300])).toBe(200);
  });
});

describe("speedup", () => {
  it("is prod/cand", () => {
    expect(speedup(3000, 1000)).toBe(3);
  });
  it("is 0 when cand time is unknown (avoids divide-by-zero)", () => {
    expect(speedup(3000, 0)).toBe(0);
  });
});

describe("pctChange", () => {
  it("is negative when cand is faster", () => {
    expect(pctChange(1000, 600)).toBe("-40%");
  });
  it("is positive (with sign) when cand is slower", () => {
    expect(pctChange(1000, 1500)).toBe("+50%");
  });
  it("is a dash when a side is missing", () => {
    expect(pctChange(0, 500)).toBe("—");
  });
  it("keeps a decimal below 1% so a green cell never reads -0%", () => {
    expect(pctChange(1000, 997)).toBe("-0.3%");
    expect(pctChange(1000, 1003)).toBe("+0.3%");
  });
});

describe("deltaTone", () => {
  const GREEN = "#8caa25";
  const RED = "#d43d3d";
  it("greens a meaningfully faster candidate", () => {
    expect(deltaTone(1000, 500)).toBe(GREEN);
  });
  it("reds a meaningfully slower candidate", () => {
    expect(deltaTone(1000, 1200)).toBe(RED);
  });
  it("greens a win however small — a win is never yellow", () => {
    expect(deltaTone(1000, 999)).toBe(GREEN);
    expect(deltaTone(1000, 980)).toBe(GREEN);
  });
  it("yellows a small loss, reds a meaningful one", () => {
    expect(deltaTone(1000, 1020)).not.toBe(GREEN);
    expect(deltaTone(1000, 1020)).not.toBe(RED);
  });
  it("stays neutral for a roughly-even result", () => {
    expect(deltaTone(1000, 1000)).not.toBe(GREEN);
    expect(deltaTone(1000, 1000)).not.toBe(RED);
  });
});
