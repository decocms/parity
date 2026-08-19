import { describe, expect, it } from "vitest";
import {
  hrefOverlap,
  normalizeHref,
  urlGainedPageIndicator,
} from "../../../src/checks/lib/pagination-overlap.ts";

describe("hrefOverlap", () => {
  it("returns 0 when either input is empty", () => {
    expect(hrefOverlap([], ["/p/a"])).toBe(0);
    expect(hrefOverlap(["/p/a"], [])).toBe(0);
  });

  it("returns 1 for identical sets", () => {
    expect(hrefOverlap(["/p/a", "/p/b"], ["/p/a", "/p/b"])).toBe(1);
  });

  it("returns 0 for fully disjoint sets", () => {
    expect(hrefOverlap(["/p/a", "/p/b"], ["/p/c", "/p/d"])).toBe(0);
  });

  it("returns a fraction for partial overlap, normalized by the larger set", () => {
    // 1 common item out of max(2,3) = 0.333
    expect(hrefOverlap(["/p/a", "/p/b"], ["/p/a", "/p/c", "/p/d"])).toBeCloseTo(1 / 3);
  });
});

describe("normalizeHref", () => {
  it("strips query string", () => {
    expect(normalizeHref("/p/a?skuId=123")).toBe("/p/a");
  });

  it("strips trailing slash", () => {
    expect(normalizeHref("/p/a/")).toBe("/p/a");
  });

  it("leaves a clean path untouched", () => {
    expect(normalizeHref("/p/a")).toBe("/p/a");
  });
});

describe("urlGainedPageIndicator", () => {
  it("returns false for identical URLs", () => {
    expect(urlGainedPageIndicator("https://x.com/c?page=1", "https://x.com/c?page=1")).toBe(false);
  });

  it("returns true when the page query param changes", () => {
    expect(urlGainedPageIndicator("https://x.com/c?page=1", "https://x.com/c?page=2")).toBe(true);
  });

  it("returns true when the pathname changes (path-based pagination)", () => {
    expect(urlGainedPageIndicator("https://x.com/c", "https://x.com/c/pagina/2")).toBe(true);
  });

  it("returns false when neither page param nor pathname changed", () => {
    expect(urlGainedPageIndicator("https://x.com/c?sort=price", "https://x.com/c?sort=name")).toBe(
      false,
    );
  });

  it("falls back to strict inequality for unparsable URLs", () => {
    expect(urlGainedPageIndicator("not-a-url", "not-a-url")).toBe(false);
    expect(urlGainedPageIndicator("not-a-url", "still-not-a-url")).toBe(true);
  });
});
