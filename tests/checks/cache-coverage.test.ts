import { describe, expect, it } from "vitest";
import { cacheCoverage } from "../../src/checks/cache-coverage.ts";
import { makeContext } from "../helpers/make-context.ts";
import { makePageCapture } from "../helpers/make-page-capture.ts";
import type { NetworkEntry } from "../../src/types/schema.ts";

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

describe("cacheCoverage", () => {
  it("returns skipped when cand has no network data", () => {
    const r = cacheCoverage(makeContext({ candPages: [] }));
    expect(r.status).toBe("skipped");
    expect(r.issues).toEqual([]);
  });

  it("passes when cand has nothing to cache (no opportunities)", () => {
    const r = cacheCoverage(
      makeContext({
        candPages: [
          makePageCapture({
            url: "https://x.com/",
            side: "cand",
            network: [net({ url: "https://x.com/api/cart", resourceType: "fetch" })],
          }),
        ],
      }),
    );
    expect(r.status).toBe("pass");
  });

  it("flags hashed assets that MISS as opportunities (medium)", () => {
    const r = cacheCoverage(
      makeContext({
        candPages: [
          makePageCapture({
            url: "https://x.com/",
            side: "cand",
            network: [
              net({ url: "https://x.com/app.deadbeef.js", bytes: 50_000 }),
            ],
          }),
        ],
      }),
    );
    expect(r.status).toBe("warn");
    expect(r.issues.find((i) => i.id === "cache:opportunities-summary")).toBeDefined();
  });

  it("escalates to high when ≥10 opportunities OR >1MB total", () => {
    const network: NetworkEntry[] = Array.from({ length: 15 }, (_, i) =>
      net({ url: `https://x.com/app.deadbeef${i}.js`, bytes: 10_000 }),
    );
    const r = cacheCoverage(
      makeContext({
        candPages: [makePageCapture({ url: "https://x.com/", side: "cand", network })],
      }),
    );
    expect(r.status).toBe("fail");
    const summaryIssue = r.issues.find((i) => i.id === "cache:opportunities-summary");
    expect(summaryIssue?.severity).toBe("high");
  });

  it("flags hit-rate regression when cand is >15pp below prod", () => {
    const r = cacheCoverage(
      makeContext({
        prodPages: [
          makePageCapture({
            url: "https://x.com/",
            side: "prod",
            network: [
              net({ fromCache: true }),
              net({ fromCache: true }),
              net({ fromCache: true }),
              net({ fromCache: true }),
            ],
          }),
        ],
        candPages: [
          makePageCapture({
            url: "https://x.com/",
            side: "cand",
            network: [
              net({ fromCache: false }),
              net({ fromCache: false }),
              net({ fromCache: false }),
              net({ fromCache: false }),
            ],
          }),
        ],
      }),
    );
    expect(r.issues.find((i) => i.id === "cache:hit-rate-regression")).toBeDefined();
  });

  it("caps per-opportunity issues to top 5 biggest", () => {
    const network: NetworkEntry[] = Array.from({ length: 20 }, (_, i) =>
      net({ url: `https://x.com/app${i}.deadbeef.js`, bytes: 10_000 + i }),
    );
    const r = cacheCoverage(
      makeContext({
        candPages: [makePageCapture({ url: "https://x.com/", side: "cand", network })],
      }),
    );
    const perOpp = r.issues.filter((i) => i.id.startsWith("cache:miss:"));
    expect(perOpp.length).toBe(5);
  });

  it("exposes structured data for dashboard tile (hitRate, opportunityCount, etc.)", () => {
    const r = cacheCoverage(
      makeContext({
        candPages: [
          makePageCapture({
            url: "https://x.com/",
            side: "cand",
            network: [net({ fromCache: true }), net({ url: "https://x.com/app.deadbeef.js" })],
          }),
        ],
      }),
    );
    expect(r.data?.hitRate).toBeDefined();
    expect(r.data?.opportunityCount).toBeDefined();
    expect(typeof r.data?.totalRequests).toBe("number");
  });
});
