import { describe, expect, it } from "vitest";
import {
  classifyPaginationMode,
  verifyPaginationResult,
} from "../../../src/engine/flows/simple.ts";

describe("classifyPaginationMode", () => {
  it("prefers a next-page link when present, regardless of other signals", () => {
    expect(
      classifyPaginationMode({
        hasNextLink: true,
        hasLoadMoreButton: true,
        countGrewOnScroll: true,
      }),
    ).toBe("page-link");
  });

  it("falls back to load-more when no next link but a load-more button exists", () => {
    expect(
      classifyPaginationMode({
        hasNextLink: false,
        hasLoadMoreButton: true,
        countGrewOnScroll: true,
      }),
    ).toBe("load-more");
  });

  it("falls back to infinite-scroll when only the scroll probe found more items", () => {
    expect(
      classifyPaginationMode({
        hasNextLink: false,
        hasLoadMoreButton: false,
        countGrewOnScroll: true,
      }),
    ).toBe("infinite-scroll");
  });

  it("returns none when nothing matched", () => {
    expect(
      classifyPaginationMode({
        hasNextLink: false,
        hasLoadMoreButton: false,
        countGrewOnScroll: false,
      }),
    ).toBe("none");
  });
});

describe("verifyPaginationResult", () => {
  it("page-link: passes when the URL gained a page indicator and the product set changed", () => {
    const r = verifyPaginationResult({
      mode: "page-link",
      before: ["/p/a", "/p/b"],
      after: ["/p/c", "/p/d"],
      urlBefore: "https://x.com/c",
      urlAfter: "https://x.com/c?page=2",
    });
    expect(r.ok).toBe(true);
    expect(r.overlap).toBe(0);
  });

  it("page-link: fails when the URL didn't change (?page=N silently ignored)", () => {
    const r = verifyPaginationResult({
      mode: "page-link",
      before: ["/p/a", "/p/b"],
      after: ["/p/a", "/p/b"],
      urlBefore: "https://x.com/c",
      urlAfter: "https://x.com/c",
    });
    expect(r.ok).toBe(false);
  });

  it("page-link: fails when URL changed but the product set is >=50% the same", () => {
    const r = verifyPaginationResult({
      mode: "page-link",
      before: ["/p/a", "/p/b"],
      after: ["/p/a", "/p/b"],
      urlBefore: "https://x.com/c?page=1",
      urlAfter: "https://x.com/c?page=2",
    });
    expect(r.ok).toBe(false);
  });

  it("load-more: passes when more items appeared and aren't an exact duplicate", () => {
    const r = verifyPaginationResult({
      mode: "load-more",
      before: ["/p/a", "/p/b"],
      after: ["/p/a", "/p/b", "/p/c", "/p/d"],
      urlBefore: "https://x.com/c",
      urlAfter: "https://x.com/c",
    });
    expect(r.ok).toBe(true);
  });

  it("load-more: fails when the count didn't grow", () => {
    const r = verifyPaginationResult({
      mode: "load-more",
      before: ["/p/a", "/p/b"],
      after: ["/p/a", "/p/b"],
      urlBefore: "https://x.com/c",
      urlAfter: "https://x.com/c",
    });
    expect(r.ok).toBe(false);
  });

  it("infinite-scroll: fails when the 'new' items are an exact duplicate of before", () => {
    const r = verifyPaginationResult({
      mode: "infinite-scroll",
      before: ["/p/a", "/p/b"],
      after: ["/p/a", "/p/b", "/p/a", "/p/b"],
      urlBefore: "https://x.com/c",
      urlAfter: "https://x.com/c",
    });
    // overlap is 1 (every "after" item is in "before"'s set) even though
    // length grew — that's the "loaded a duplicate page" false-pass this
    // guards against.
    expect(r.overlap).toBe(1);
    expect(r.ok).toBe(false);
  });
});
