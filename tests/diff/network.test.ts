import { describe, expect, it } from "vitest";
import { diffNetwork, diffUrls, summarizeNetwork } from "../../src/diff/network.ts";
import type { NetworkEntry } from "../../src/types/schema.ts";

function entry(partial: Partial<NetworkEntry>): NetworkEntry {
  return {
    url: "https://example.com/",
    method: "GET",
    status: 200,
    resourceType: "document",
    fromCache: false,
    bytes: 1000,
    durationMs: 100,
    cacheControl: null,
    serverTiming: null,
    decoSection: null,
    ...partial,
  };
}

describe("summarizeNetwork", () => {
  it("agrupa por bucket de status", () => {
    const s = summarizeNetwork([
      entry({ status: 200 }),
      entry({ status: 404 }),
      entry({ status: 500 }),
    ]);
    expect(s.status["2xx"]).toBe(1);
    expect(s.status["4xx"]).toBe(1);
    expect(s.status["5xx"]).toBe(1);
  });

  it("calcula cache hit rate", () => {
    const s = summarizeNetwork([
      entry({ fromCache: true }),
      entry({ fromCache: true }),
      entry({ fromCache: false }),
    ]);
    expect(s.cacheHitRate).toBeCloseTo(2 / 3, 2);
  });

  it("lista deco sections", () => {
    const s = summarizeNetwork([entry({ decoSection: "hero" }), entry({ decoSection: "shelf" })]);
    expect(s.decoSectionsHit).toEqual(["hero", "shelf"]);
  });

  it("conta API calls e lazy sections", () => {
    const s = summarizeNetwork([
      entry({ url: "https://x.com/api/products" }),
      entry({ url: "https://x.com/deco/render/shelf" }),
    ]);
    expect(s.apiCalls).toBe(1);
    expect(s.lazySectionCalls).toBe(1);
  });
});

describe("diffUrls", () => {
  it("aplica ignorePatterns glob", () => {
    const prod = [
      entry({ url: "https://x.com/img.gif?t=1" }),
      entry({ url: "https://x.com/api/products" }),
    ];
    const cand = [
      entry({ url: "https://x.com/img.gif?t=99" }),
      entry({ url: "https://x.com/api/products" }),
    ];
    const d = diffUrls(prod, cand, { ignorePatterns: ["**/img.gif*"] });
    expect(d.onlyProd).toEqual([]);
    expect(d.onlyCand).toEqual([]);
  });
});

describe("diffNetwork", () => {
  it("falha quando volume diverge mais de 30%", () => {
    const prod = Array.from({ length: 10 }, () => entry({}));
    const cand = Array.from({ length: 20 }, () => entry({}));
    const d = diffNetwork(prod, cand);
    expect(d.anyFailed).toBe(true);
  });
});
