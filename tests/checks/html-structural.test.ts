import { describe, expect, it } from "vitest";
import { htmlStructuralDiff } from "../../src/checks/html-structural.ts";
import { makeContext } from "../helpers/make-context.ts";
import { makePageCapture } from "../helpers/make-page-capture.ts";

const baseHtml = (extra = "") =>
  `<!doctype html><html><head><title>X</title></head><body>${extra}</body></html>`;

describe("htmlStructuralDiff", () => {
  it("passes when DOM counts match within tolerance", () => {
    const html = baseHtml("<h1>x</h1><a href='/a'>a</a><a href='/b'>b</a>");
    const r = htmlStructuralDiff(
      makeContext({
        prodPages: [makePageCapture({ url: "https://x.com/", side: "prod", html })],
        candPages: [makePageCapture({ url: "https://x.com/", side: "cand", html })],
      }),
    );
    expect(r.status).toBe("pass");
  });

  it("flags count divergence beyond tolerance (default 2)", () => {
    const prodHtml = baseHtml(`<h1>x</h1>${"<a href='/a'>a</a>".repeat(15)}`);
    const candHtml = baseHtml("<h1>x</h1>");
    const r = htmlStructuralDiff(
      makeContext({
        prodPages: [makePageCapture({ url: "https://x.com/", side: "prod", html: prodHtml })],
        candPages: [makePageCapture({ url: "https://x.com/", side: "cand", html: candHtml })],
      }),
    );
    expect(r.status).toBe("fail");
    expect(r.issues[0]?.summary).toMatch(/links/);
  });

  it("flags deco sections present in prod but missing in cand", () => {
    const prodHtml = baseHtml(`<div data-section="Hero"></div><div data-section="Footer"></div>`);
    const candHtml = baseHtml(`<div data-section="Footer"></div>`);
    const r = htmlStructuralDiff(
      makeContext({
        prodPages: [makePageCapture({ url: "https://x.com/", side: "prod", html: prodHtml })],
        candPages: [makePageCapture({ url: "https://x.com/", side: "cand", html: candHtml })],
      }),
    );
    expect(r.status).toBe("fail");
    const sectionIssue = r.issues.find((i) => i.id.includes("deco-missing"));
    expect(sectionIssue?.summary).toMatch(/Hero/);
  });

  it("does NOT flag sections that exist only in cand", () => {
    const prodHtml = baseHtml(`<div data-section="Hero"></div>`);
    const candHtml = baseHtml(`<div data-section="Hero"></div><div data-section="Extra"></div>`);
    const r = htmlStructuralDiff(
      makeContext({
        prodPages: [makePageCapture({ url: "https://x.com/", side: "prod", html: prodHtml })],
        candPages: [makePageCapture({ url: "https://x.com/", side: "cand", html: candHtml })],
      }),
    );
    // Extras in cand are not regressions
    const sectionIssue = r.issues.find((i) => i.id.includes("deco-missing"));
    expect(sectionIssue).toBeUndefined();
  });

  it("emits both count and deco issues when both fail", () => {
    const prodHtml = baseHtml(
      `<div data-section="Hero"></div>${"<a href='/a'>a</a>".repeat(20)}`,
    );
    const candHtml = baseHtml(``);
    const r = htmlStructuralDiff(
      makeContext({
        prodPages: [makePageCapture({ url: "https://x.com/", side: "prod", html: prodHtml })],
        candPages: [makePageCapture({ url: "https://x.com/", side: "cand", html: candHtml })],
      }),
    );
    expect(r.issues.length).toBeGreaterThanOrEqual(2);
  });
});
