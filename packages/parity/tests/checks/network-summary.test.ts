import { describe, expect, it } from "vitest";
import { networkSummaryDelta } from "../../src/checks/network-summary.ts";
import type { NetworkEntry } from "../../src/types/schema.ts";
import { makeContext } from "../helpers/make-context.ts";
import { makePageCapture } from "../helpers/make-page-capture.ts";

function net(over: Partial<NetworkEntry> = {}): NetworkEntry {
  return {
    url: "https://x.com/a.js",
    method: "GET",
    status: 200,
    resourceType: "script",
    fromCache: false,
    bytes: 1000,
    durationMs: 50,
    cacheControl: null,
    serverTiming: null,
    decoSection: null,
    ...over,
  };
}

describe("networkSummaryDelta", () => {
  it("passes when prod and cand have similar request volume", () => {
    const requests = [net({ url: "https://x.com/a.js" }), net({ url: "https://x.com/b.js" })];
    const r = networkSummaryDelta(
      makeContext({
        prodPages: [makePageCapture({ url: "https://x.com/", side: "prod", network: requests })],
        candPages: [makePageCapture({ url: "https://x.com/", side: "cand", network: requests })],
      }),
    );
    expect(r.status).toBe("pass");
  });

  it("flags volume divergence beyond threshold", () => {
    const prodRequests = Array.from({ length: 100 }, (_, i) =>
      net({ url: `https://x.com/p${i}.js` }),
    );
    const candRequests: NetworkEntry[] = [net({ url: "https://x.com/c.js" })];
    const r = networkSummaryDelta(
      makeContext({
        prodPages: [
          makePageCapture({ url: "https://x.com/", side: "prod", network: prodRequests }),
        ],
        candPages: [
          makePageCapture({ url: "https://x.com/", side: "cand", network: candRequests }),
        ],
      }),
    );
    expect(r.status).toBe("warn");
    expect(r.issues.find((i) => i.id.includes("network:volume"))).toBeDefined();
  });

  it("flags decoSection present in prod but missing in cand as high", () => {
    const r = networkSummaryDelta(
      makeContext({
        prodPages: [
          makePageCapture({
            url: "https://x.com/",
            side: "prod",
            network: [net({ decoSection: "Hero" }), net({ decoSection: "Shelf" })],
          }),
        ],
        candPages: [
          makePageCapture({
            url: "https://x.com/",
            side: "cand",
            network: [net({ decoSection: "Hero" })],
          }),
        ],
      }),
    );
    const missing = r.issues.find((i) => i.id.includes("deco-section-gone"));
    expect(missing?.severity).toBe("high");
    expect(missing?.summary).toMatch(/Shelf/);
  });

  it("ignoreRequestPatterns is applied to URL diff lists, not to volume counts (known limitation)", () => {
    // BUG/QUIRK: ignorePatterns currently only filters `urls.onlyProd/onlyCand`,
    // not the request totals used for volume divergence detection.
    // See src/diff/network.ts:114 — pSum/cSum are computed from raw arrays.
    const prodRequests = [
      net({ url: "https://x.com/pixel/a.gif" }),
      net({ url: "https://x.com/pixel/b.gif" }),
      net({ url: "https://x.com/pixel/c.gif" }),
    ];
    const candRequests: NetworkEntry[] = [net({ url: "https://x.com/main.js" })];
    const r = networkSummaryDelta(
      makeContext({
        prodPages: [
          makePageCapture({ url: "https://x.com/", side: "prod", network: prodRequests }),
        ],
        candPages: [
          makePageCapture({ url: "https://x.com/", side: "cand", network: candRequests }),
        ],
        ignore: { ignoreRequestPatterns: ["**/pixel/*"] },
      }),
    );
    // Volume still flagged because pixels count toward total
    expect(r.issues.find((i) => i.id.includes("network:volume"))).toBeDefined();
    // But the URLs listed in details should NOT contain the ignored ones
    const volumeIssue = r.issues.find((i) => i.id.includes("network:volume"));
    expect(volumeIssue?.details).not.toMatch(/pixel\/a\.gif/);
  });
});
