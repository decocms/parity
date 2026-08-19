import { afterEach, describe, expect, it } from "vitest";
import { plpSorting } from "../../src/checks/plp-sorting.ts";
import type { FlowCapture } from "../../src/types/schema.ts";
import { makeContext } from "../helpers/make-context.ts";
import { mockFetch } from "../helpers/mock-fetch.ts";

function htmlWithProducts(order: string[]): string {
  return `<html><body>${order.map((p) => `<a href="${p}">x</a>`).join("")}</body></html>`;
}

function plpFlow(side: "prod" | "cand", url: string): FlowCapture {
  return {
    flow: "purchase-journey",
    side,
    viewport: "mobile",
    pages: [],
    totalDurationMs: 100,
    steps: [
      {
        step: 2,
        name: "navigate-plp",
        side,
        viewport: "mobile",
        status: "ok",
        durationMs: 100,
        screenshotPath: "",
        url,
      },
    ],
  };
}

describe("plpSorting", () => {
  let restore: () => void = () => undefined;
  afterEach(() => restore());

  it("skipped when no PLP is resolvable", async () => {
    const r = await plpSorting(makeContext());
    expect(r.status).toBe("skipped");
  });

  it("pass when neither side's PLP is fetchable (untestable, not a failure)", async () => {
    ({ restore } = mockFetch(() => ({ status: 500, body: "" })));
    const r = await plpSorting(
      makeContext({
        prodFlows: [plpFlow("prod", "https://prod.com/categoria")],
        candFlows: [plpFlow("cand", "https://cand.com/categoria")],
      }),
    );
    expect(r.status).toBe("pass");
    expect(r.issues.length).toBe(0);
  });

  it("flags divergence when prod's sort changes order but cand's doesn't", async () => {
    ({ restore } = mockFetch((url) => {
      const u = new URL(url);
      const isSorted = u.searchParams.has("sort") || u.searchParams.has("orderBy");
      if (u.hostname === "prod.com") {
        return {
          status: 200,
          body: isSorted
            ? htmlWithProducts(["/c/p", "/b/p", "/a/p"])
            : htmlWithProducts(["/a/p", "/b/p", "/c/p"]),
        };
      }
      // cand: sorting is a no-op — same order regardless of query params.
      return { status: 200, body: htmlWithProducts(["/a/p", "/b/p", "/c/p"]) };
    }));
    const r = await plpSorting(
      makeContext({
        prodFlows: [plpFlow("prod", "https://prod.com/categoria")],
        candFlows: [plpFlow("cand", "https://cand.com/categoria")],
      }),
    );
    expect(r.status).toBe("warn");
    expect(r.issues.some((i) => i.id === "plp-sorting:divergence")).toBe(true);
    expect(r.issues[0]?.severity).toBe("medium");
  });

  it("pass when both sides apply sort consistently", async () => {
    ({ restore } = mockFetch((url) => {
      const u = new URL(url);
      const isSorted = u.searchParams.has("sort") || u.searchParams.has("orderBy");
      return {
        status: 200,
        body: isSorted
          ? htmlWithProducts(["/c/p", "/b/p", "/a/p"])
          : htmlWithProducts(["/a/p", "/b/p", "/c/p"]),
      };
    }));
    const r = await plpSorting(
      makeContext({
        prodFlows: [plpFlow("prod", "https://prod.com/categoria")],
        candFlows: [plpFlow("cand", "https://cand.com/categoria")],
      }),
    );
    expect(r.status).toBe("pass");
    expect(r.issues.length).toBe(0);
  });
});
