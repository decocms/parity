import { describe, expect, it } from "vitest";
import { aggregateOpportunities } from "../../src/commands/vitals.ts";
import type { LhOpportunity, PageCapture } from "../../src/types/schema.ts";

function opp(over: Partial<LhOpportunity>): LhOpportunity {
  return { id: "x", title: "X", savingsMs: 0, savingsBytes: 0, score: null, ...over };
}

function page(opps?: LhOpportunity[]): PageCapture {
  return { lhOpportunities: opps } as unknown as PageCapture;
}

describe("aggregateOpportunities (#264)", () => {
  it("dedupes by id keeping the worst (max savings) instance, biggest first", () => {
    const out = aggregateOpportunities([
      page([opp({ id: "unused-js", savingsMs: 200 }), opp({ id: "render-block", savingsMs: 500 })]),
      page([opp({ id: "unused-js", savingsMs: 800 })]), // worse instance wins
    ]);
    expect(out.map((o) => [o.id, o.savingsMs])).toEqual([
      ["unused-js", 800],
      ["render-block", 500],
    ]);
  });

  it("returns empty when no page ran Lighthouse", () => {
    expect(aggregateOpportunities([page(), page(undefined)])).toEqual([]);
  });

  it("breaks ms ties by bytes", () => {
    const out = aggregateOpportunities([
      page([
        opp({ id: "a", savingsMs: 100, savingsBytes: 10 }),
        opp({ id: "b", savingsMs: 100, savingsBytes: 99 }),
      ]),
    ]);
    expect(out.map((o) => o.id)).toEqual(["b", "a"]);
  });
});
