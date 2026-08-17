import { describe, expect, it } from "vitest";
import { parseSample, pickSpread, sampleFromSitemap } from "../../src/commands/migrate.ts";

describe("parseSample", () => {
  it("parses a spec into per-kind counts", () => {
    expect(parseSample("plp=2,pdp=1,other=3")).toEqual({ plp: 2, pdp: 1, other: 3 });
  });
  it("falls back to a default incl. institutional (other)", () => {
    const d = parseSample(undefined);
    expect(d.other).toBeGreaterThan(0);
    expect(d.plp).toBeGreaterThan(0);
  });
  it("ignores malformed parts", () => {
    expect(parseSample("plp=x,pdp=2,=3,foo")).toEqual({ pdp: 2 } as never);
  });
});

describe("pickSpread", () => {
  it("returns all when count >= length", () => {
    expect(pickSpread([1, 2], 5)).toEqual([1, 2]);
  });
  it("spreads across the list, not just the first N", () => {
    expect(pickSpread([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 3)).toEqual([0, 3, 6]);
  });
});

describe("sampleFromSitemap", () => {
  const classified = [
    { url: "https://l.com/", kind: "home" as const },
    { url: "https://l.com/cat/a", kind: "plp" as const },
    { url: "https://l.com/cat/b", kind: "plp" as const },
    { url: "https://l.com/p1/p", kind: "pdp" as const },
    { url: "https://l.com/sobre", kind: "other" as const },
    { url: "https://l.com/contato", kind: "other" as const },
  ];

  it("samples per kind, skips home + already-resolved, incl. institutional", () => {
    const existing = [{ path: "/cat/a", url: "https://l.com/cat/a", kind: "plp" as const }];
    const out = sampleFromSitemap(classified, { plp: 2, other: 2 }, existing);
    const urls = out.map((p) => p.url);
    expect(urls).toContain("https://l.com/cat/b"); // plp (a already resolved)
    expect(urls).toContain("https://l.com/sobre"); // institutional
    expect(urls).toContain("https://l.com/contato");
    expect(urls).not.toContain("https://l.com/"); // home skipped
    expect(urls).not.toContain("https://l.com/cat/a"); // already resolved
    expect(out.every((p) => p.path.startsWith("/"))).toBe(true);
  });
});
