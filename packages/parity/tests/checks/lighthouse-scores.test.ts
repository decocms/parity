import { describe, expect, it } from "vitest";
import { lighthouseScores } from "../../src/checks/lighthouse-scores.ts";
import type { LhScores } from "../../src/types/schema.ts";
import { makeContext } from "../helpers/make-context.ts";
import { makePageCapture } from "../helpers/make-page-capture.ts";

const scores = (o: Partial<LhScores>): LhScores => ({
  performance: 90,
  accessibility: 90,
  bestPractices: 90,
  seo: 90,
  ...o,
});

function ctx(prod: LhScores, cand: LhScores) {
  return makeContext({
    prodPages: [makePageCapture({ url: "https://x.com/", side: "prod", lhScores: prod })],
    candPages: [makePageCapture({ url: "https://x.com/", side: "cand", lhScores: cand })],
  });
}

describe("lighthouseScores", () => {
  it("flags a category that regressed below prod", () => {
    const r = lighthouseScores(ctx(scores({ accessibility: 90 }), scores({ accessibility: 76 })));
    expect(r.status).toBe("fail");
    const iss = r.issues.find((i) => i.id.startsWith("lh-score:accessibility:"));
    expect(iss?.severity).toBe("high"); // 14-point drop
    expect(iss?.category).toBe("a11y");
  });

  it("passes when cand is equal or better everywhere", () => {
    const r = lighthouseScores(ctx(scores({ performance: 60 }), scores({ performance: 93 })));
    expect(r.status).toBe("pass");
    expect(r.issues).toEqual([]);
  });

  it("tolerates small jitter (<=3 points)", () => {
    const r = lighthouseScores(ctx(scores({ seo: 92 }), scores({ seo: 90 })));
    expect(r.issues).toEqual([]);
  });

  it("skips when no Lighthouse scores were captured", () => {
    const r = lighthouseScores(
      makeContext({
        prodPages: [makePageCapture({ url: "https://x.com/", side: "prod" })],
        candPages: [makePageCapture({ url: "https://x.com/", side: "cand" })],
      }),
    );
    expect(r.status).toBe("skipped");
  });
});
