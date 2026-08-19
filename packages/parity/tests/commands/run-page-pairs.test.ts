import { describe, expect, it } from "vitest";
import { parsePagePair } from "../../src/commands/run.ts";
import { captureKey } from "../../src/checks/lib/pairing.ts";
import type { PageCapture } from "../../src/types/schema.ts";

/**
 * Explicit prod->cand page pairs.
 *
 * A partially-migrated storefront usually has NO path parity: the reference PDP
 * on prod is a product the candidate hasn't ported yet, so `/encimera-gc60/p`
 * has to be compared against `/ar-condicionado-12k/p`. Before pairs, every
 * check that calls `pairCaptures` keyed off the URL pathname, so those two
 * captures landed in different buckets and were reported as two orphans — no
 * comparison at all, exactly on the pages that matter most during a migration.
 */
describe("parsePagePair", () => {
  it("uses the same path for both sides when there is no arrow", () => {
    expect(parsePagePair("/checkout")).toEqual({ prod: "/checkout", cand: "/checkout" });
  });

  it("prepends the missing leading slash on both sides", () => {
    expect(parsePagePair("account")).toEqual({ prod: "/account", cand: "/account" });
    expect(parsePagePair("a->b")).toEqual({ prod: "/a", cand: "/b" });
  });

  it("splits an arrow entry into distinct prod and cand paths", () => {
    expect(parsePagePair("/encimera-gc60/p->/ar-condicionado-12k/p")).toEqual({
      prod: "/encimera-gc60/p",
      cand: "/ar-condicionado-12k/p",
    });
  });

  it("tolerates whitespace around the arrow", () => {
    expect(parsePagePair("  /a  ->  /b  ")).toEqual({ prod: "/a", cand: "/b" });
  });

  it("keeps query strings intact on each side", () => {
    expect(parsePagePair("/search?q=fogao->/s?term=fogao")).toEqual({
      prod: "/search?q=fogao",
      cand: "/s?term=fogao",
    });
  });
});

function capture(url: string, pairKey?: string): PageCapture {
  return {
    url,
    finalUrl: url,
    status: 200,
    viewport: "mobile",
    side: "prod",
    durationMs: 1,
    html: "",
    vitals: { lcp: null, cls: null, fcp: null, ttfb: null, inp: null },
    console: [],
    network: [],
    screenshotPath: "",
    pairKey,
  };
}

describe("captureKey with an explicit pairKey", () => {
  it("falls back to the URL pathname when no pairKey is set", () => {
    expect(captureKey(capture("https://prod.example.com/encimera-gc60/p"))).toBe(
      "/encimera-gc60/p::mobile",
    );
  });

  it("makes two different paths pair when both carry the same pairKey", () => {
    const prod = capture("https://prod.example.com/encimera-gc60/p", "/encimera-gc60/p");
    const cand = capture("https://cand.example.com/ar-condicionado-12k/p", "/encimera-gc60/p");
    expect(captureKey(prod)).toBe(captureKey(cand));
  });

  it("still separates captures of the same pair across viewports", () => {
    const mobile = capture("https://prod.example.com/a", "/a");
    const desktop = { ...capture("https://cand.example.com/b", "/a"), viewport: "desktop" as const };
    expect(captureKey(mobile)).not.toBe(captureKey(desktop));
  });
});
