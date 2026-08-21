import { describe, expect, it } from "vitest";
import { lighthouseOpportunities } from "../../src/checks/lighthouse-opportunities.ts";
import type { LhOpportunity } from "../../src/types/schema.ts";
import { makeContext } from "../helpers/make-context.ts";
import { makePageCapture } from "../helpers/make-page-capture.ts";

function opp(over: Partial<LhOpportunity>): LhOpportunity {
  return { id: "x", title: "X", savingsMs: 0, savingsBytes: 0, score: null, ...over };
}

function ctx(candOpps?: LhOpportunity[], prodOpps?: LhOpportunity[]) {
  return makeContext({
    prodPages: [
      makePageCapture({
        url: "https://prod.example/",
        side: "prod",
        ...(prodOpps ? { lhOpportunities: prodOpps } : {}),
      }),
    ],
    candPages: [
      makePageCapture({
        url: "https://cand.example/",
        side: "cand",
        ...(candOpps ? { lhOpportunities: candOpps } : {}),
      }),
    ],
  });
}

describe("lighthouseOpportunities", () => {
  it("skips when Lighthouse never ran — an empty result must not look like a clean one", () => {
    const r = lighthouseOpportunities(ctx());
    expect(r.status).toBe("skipped");
    expect(r.issues).toEqual([]);
    expect(r.summary).toContain("Sem dados de Lighthouse");
  });

  it("passes when Lighthouse ran and found nothing above the threshold", () => {
    const r = lighthouseOpportunities(ctx([opp({ id: "font-display", savingsMs: 40 })]));
    expect(r.status).toBe("pass");
    expect(r.issues).toEqual([]);
  });

  it("reports an issue per opportunity, severity from the savings", () => {
    const r = lighthouseOpportunities(
      ctx(
        [
          opp({ id: "render-blocking-resources", title: "Render blocking", savingsMs: 690 }),
          opp({ id: "unused-css-rules", title: "Unused CSS", savingsMs: 250 }),
        ],
        [
          opp({ id: "render-blocking-resources", title: "Render blocking", savingsMs: 650 }),
          opp({ id: "unused-css-rules", title: "Unused CSS", savingsMs: 240 }),
        ],
      ),
    );

    expect(r.status).toBe("fail");
    expect(r.issues.map((i) => [i.id, i.severity])).toEqual([
      ["lh:render-blocking-resources", "high"],
      ["lh:unused-css-rules", "medium"],
    ]);
    expect(r.issues[0]?.category).toBe("performance");
  });

  it("escalates a medium to high when the migration introduced it", () => {
    const r = lighthouseOpportunities(ctx([opp({ id: "unused-css-rules", savingsMs: 250 })]));
    expect(r.issues[0]?.severity).toBe("high");
    expect(r.issues[0]?.summary).toContain("regressão");
    expect(r.issues[0]?.details).toContain("prod: audit não acionada");
  });

  it("does not call a shared cost a regression", () => {
    const r = lighthouseOpportunities(
      ctx([opp({ id: "server-response-time", savingsMs: 600 })], [
        opp({ id: "server-response-time", savingsMs: 590 }),
      ]),
    );
    expect(r.issues[0]?.summary).not.toContain("regressão");
    expect(r.issues[0]?.details).toContain("prod: 590ms na mesma audit");
  });

  it("says how many it dropped below the threshold instead of hiding them", () => {
    const r = lighthouseOpportunities(
      ctx([
        opp({ id: "a", savingsMs: 900 }),
        opp({ id: "b", savingsMs: 30 }),
        opp({ id: "c", savingsMs: 10 }),
      ]),
    );
    expect(r.issues).toHaveLength(1);
    expect(r.summary).toContain("2 abaixo do limite");
    expect(r.data).toMatchObject({ total: 3, reported: 1, belowThreshold: 2 });
  });

  it("formats savings over a second in seconds, and includes bytes when present", () => {
    const r = lighthouseOpportunities(
      ctx([opp({ id: "unused-javascript", savingsMs: 3200, savingsBytes: 3151 * 1024 })]),
    );
    expect(r.issues[0]?.summary).toContain("3.2s");
    expect(r.issues[0]?.details).toContain("3151 KB");
  });
});
