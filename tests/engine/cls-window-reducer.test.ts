import { describe, expect, it } from "vitest";
import { clsWindowReducer } from "../../src/engine/collect.ts";

/**
 * Regression test for issue #182: CLS was a lifetime cumulative sum of
 * every layout-shift entry, inflating scores 5-8x on content-heavy pages
 * (carousels, lazy-loaded shelves). The fix takes the max 5s session
 * window (<=1s gaps between shifts) per the CLS spec, mirroring
 * https://github.com/GoogleChrome/web-vitals/blob/main/src/onCLS.ts.
 */

const initial = { sessionValue: 0, sessionStart: 0, sessionLast: 0, clsValue: 0 };

function runSession(
  entries: Array<{ startTime: number; value: number; hadRecentInput?: boolean }>,
): number {
  let state = initial;
  for (const e of entries) {
    state = clsWindowReducer(state, { hadRecentInput: false, ...e });
  }
  return state.clsValue;
}

describe("clsWindowReducer", () => {
  it("sums shifts within the same 5s/1s-gap session", () => {
    const cls = runSession([
      { startTime: 0, value: 0.1 },
      { startTime: 500, value: 0.1 },
      { startTime: 1000, value: 0.1 },
    ]);
    expect(cls).toBeCloseTo(0.3);
  });

  it("starts a new session once the gap between shifts exceeds 1s", () => {
    const cls = runSession([
      { startTime: 0, value: 0.5 },
      { startTime: 1500, value: 0.5 }, // gap > 1s -> new session
    ]);
    // each session maxes at 0.5, not summed to 1.0
    expect(cls).toBeCloseTo(0.5);
  });

  it("starts a new session once the window exceeds 5s even with small gaps", () => {
    const entries = [];
    for (let t = 0; t <= 6000; t += 900) {
      entries.push({ startTime: t, value: 0.1 });
    }
    const cls = runSession(entries);
    // no single 5s window contains more than 6 shifts of 0.1 -> < lifetime sum
    expect(cls).toBeLessThan(entries.length * 0.1);
  });

  it("ignores shifts that follow recent user input", () => {
    const cls = runSession([
      { startTime: 0, value: 0.5 },
      { startTime: 100, value: 5, hadRecentInput: true },
    ]);
    expect(cls).toBeCloseTo(0.5);
  });

  it("does not inflate CLS on a long-running page with sparse continuous shifts", () => {
    // regression case from the issue: shifts spread across a long capture
    // window (carousel/lazy-load) should NOT sum to a lifetime total.
    const entries = [];
    for (let t = 0; t < 30_000; t += 3000) {
      entries.push({ startTime: t, value: 0.15 });
    }
    const cls = runSession(entries);
    const lifetimeSum = entries.length * 0.15;
    expect(cls).toBeLessThan(lifetimeSum);
    // each shift is its own session (3s gap < 1s? no, 3s > 1s), so max session
    // is a single shift's value
    expect(cls).toBeCloseTo(0.15);
  });
});
