import { describe, expect, it } from "vitest";
import {
  diffOpportunities,
  opportunitySeverity,
} from "../../src/diff/lighthouse.ts";
import type { LhOpportunity, PageCapture } from "../../src/types/schema.ts";

function opp(over: Partial<LhOpportunity>): LhOpportunity {
  return { id: "x", title: "X", savingsMs: 0, savingsBytes: 0, score: null, ...over };
}

function page(opps?: LhOpportunity[]): PageCapture {
  return { lhOpportunities: opps } as unknown as PageCapture;
}

describe("opportunitySeverity", () => {
  it("ranks by the time Lighthouse says the fix is worth", () => {
    expect(opportunitySeverity(690)).toBe("high");
    expect(opportunitySeverity(500)).toBe("high");
    expect(opportunitySeverity(499)).toBe("medium");
    expect(opportunitySeverity(200)).toBe("medium");
    expect(opportunitySeverity(199)).toBe("low");
    expect(opportunitySeverity(0)).toBe("low");
  });
});

describe("diffOpportunities", () => {
  it("flags an opportunity prod does not have as a regression", () => {
    const out = diffOpportunities(
      [page([opp({ id: "unused-css-rules", savingsMs: 300 })])],
      [page([opp({ id: "render-blocking-resources", savingsMs: 690 })])],
    );

    expect(out).toHaveLength(1);
    expect(out[0]?.prod).toBeNull();
    expect(out[0]?.regression).toBe(true);
    expect(out[0]?.deltaMs).toBe(690);
  });

  it("does not call a shared opportunity a regression when prod wastes the same", () => {
    const out = diffOpportunities(
      [page([opp({ id: "render-blocking-resources", savingsMs: 650 })])],
      [page([opp({ id: "render-blocking-resources", savingsMs: 690 })])],
    );

    expect(out[0]?.regression).toBe(false);
    expect(out[0]?.deltaMs).toBe(40);
    expect(out[0]?.prod?.savingsMs).toBe(650);
  });

  it("calls a shared opportunity a regression once cand is materially worse", () => {
    const out = diffOpportunities(
      [page([opp({ id: "unused-javascript", savingsMs: 100 })])],
      [page([opp({ id: "unused-javascript", savingsMs: 900 })])],
    );

    expect(out[0]?.regression).toBe(true);
    expect(out[0]?.deltaMs).toBe(800);
  });

  it("never claims a regression on a single-site run — there is nothing to compare", () => {
    const out = diffOpportunities([], [page([opp({ id: "font-display", savingsMs: 800 })])]);

    expect(out[0]?.prod).toBeNull();
    expect(out[0]?.regression).toBe(false);
  });

  it("uses the worst page per audit on each side", () => {
    const out = diffOpportunities(
      [page([opp({ id: "a", savingsMs: 100 })]), page([opp({ id: "a", savingsMs: 400 })])],
      [page([opp({ id: "a", savingsMs: 300 })]), page([opp({ id: "a", savingsMs: 900 })])],
    );

    expect(out[0]?.cand.savingsMs).toBe(900);
    expect(out[0]?.prod?.savingsMs).toBe(400);
  });

  it("returns nothing when cand captured no Lighthouse data", () => {
    expect(diffOpportunities([page([opp({ savingsMs: 500 })])], [page(undefined)])).toEqual([]);
  });
});
