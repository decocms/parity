import { describe, expect, it } from "vitest";
import { webVitalsMobile } from "../../src/checks/web-vitals.ts";
import { makeContext } from "../helpers/make-context.ts";
import { makePageCapture } from "../helpers/make-page-capture.ts";
import type { WebVitals } from "../../src/types/schema.ts";

const goodVitals: WebVitals = { lcp: 1500, fcp: 800, ttfb: 200, inp: 100, cls: 0.05 };
const badVitals: WebVitals = { lcp: 5000, fcp: 3500, ttfb: 1500, inp: 600, cls: 0.4 };

describe("webVitalsMobile", () => {
  it("passes when both sides have good vitals", () => {
    const r = webVitalsMobile(
      makeContext({
        prodPages: [makePageCapture({ url: "https://x.com/", viewport: "mobile", side: "prod", vitals: goodVitals })],
        candPages: [makePageCapture({ url: "https://x.com/", viewport: "mobile", side: "cand", vitals: goodVitals })],
      }),
    );
    expect(r.status).toBe("pass");
  });

  it("flags LCP regression in cand", () => {
    const r = webVitalsMobile(
      makeContext({
        prodPages: [
          makePageCapture({ url: "https://x.com/", viewport: "mobile", side: "prod", vitals: goodVitals }),
        ],
        candPages: [
          makePageCapture({ url: "https://x.com/", viewport: "mobile", side: "cand", vitals: badVitals }),
        ],
      }),
    );
    expect(r.status).toBe("fail");
    expect(r.issues[0]?.summary).toMatch(/LCP/);
    expect(r.issues[0]?.severity).toBe("high");
  });

  it("ignores desktop pairs (mobile only)", () => {
    const r = webVitalsMobile(
      makeContext({
        prodPages: [
          makePageCapture({ url: "https://x.com/", viewport: "desktop", side: "prod", vitals: goodVitals }),
        ],
        candPages: [
          makePageCapture({ url: "https://x.com/", viewport: "desktop", side: "cand", vitals: badVitals }),
        ],
      }),
    );
    expect(r.status).toBe("pass");
  });

  it("includes evidence screenshots for failed pages", () => {
    const r = webVitalsMobile(
      makeContext({
        prodPages: [
          makePageCapture({
            url: "https://x.com/",
            viewport: "mobile",
            side: "prod",
            vitals: goodVitals,
            screenshotPath: "/p.png",
          }),
        ],
        candPages: [
          makePageCapture({
            url: "https://x.com/",
            viewport: "mobile",
            side: "cand",
            vitals: badVitals,
            screenshotPath: "/c.png",
          }),
        ],
      }),
    );
    expect(r.issues[0]?.evidence?.map((e) => e.path)).toEqual(["/p.png", "/c.png"]);
  });

  it("returns pass with zero issues when no mobile pairs exist", () => {
    const r = webVitalsMobile(makeContext({}));
    expect(r.status).toBe("pass");
    expect(r.issues).toEqual([]);
  });
});
