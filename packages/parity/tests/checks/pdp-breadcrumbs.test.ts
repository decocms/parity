import { describe, expect, it } from "vitest";
import { pdpBreadcrumbs } from "../../src/checks/pdp-breadcrumbs.ts";
import { makeContext } from "../helpers/make-context.ts";
import { makePageCapture } from "../helpers/make-page-capture.ts";

const HTML_WITH_BREADCRUMB = `<html><body><nav aria-label="Breadcrumb"><a href="/">Home</a></nav><h1>Product</h1></body></html>`;
const HTML_NO_BREADCRUMB = "<html><body><h1>Product</h1></body></html>";

describe("pdpBreadcrumbs", () => {
  it("skipped when no PDP pages captured", () => {
    const r = pdpBreadcrumbs(makeContext());
    expect(r.status).toBe("skipped");
  });

  it("single-site: medium issue when PDP has no breadcrumb signal", () => {
    const r = pdpBreadcrumbs(
      makeContext({
        candPages: [
          makePageCapture({
            url: "https://x.com/product/p",
            html: HTML_NO_BREADCRUMB,
            side: "cand",
          }),
        ],
      }),
    );
    expect(r.status).toBe("warn");
    expect(r.issues[0]?.severity).toBe("medium");
    expect(r.issues[0]?.category).toBe("seo");
  });

  it("single-site: pass when PDP has breadcrumb markup", () => {
    const r = pdpBreadcrumbs(
      makeContext({
        candPages: [
          makePageCapture({
            url: "https://x.com/product/p",
            html: HTML_WITH_BREADCRUMB,
            side: "cand",
          }),
        ],
      }),
    );
    expect(r.status).toBe("pass");
    expect(r.issues.length).toBe(0);
  });

  it("comparative: issue when prod has breadcrumbs but cand doesn't", () => {
    const r = pdpBreadcrumbs(
      makeContext({
        prodPages: [
          makePageCapture({
            url: "https://x.com/product/p",
            html: HTML_WITH_BREADCRUMB,
            side: "prod",
            viewport: "mobile",
          }),
        ],
        candPages: [
          makePageCapture({
            url: "https://cand.com/product/p",
            html: HTML_NO_BREADCRUMB,
            side: "cand",
            viewport: "mobile",
          }),
        ],
      }),
    );
    expect(r.status).toBe("warn");
    expect(r.issues.some((i) => i.id.includes("lost"))).toBe(true);
  });

  it("comparative: pass when neither side has breadcrumbs", () => {
    const r = pdpBreadcrumbs(
      makeContext({
        prodPages: [
          makePageCapture({
            url: "https://x.com/product/p",
            html: HTML_NO_BREADCRUMB,
            side: "prod",
            viewport: "mobile",
          }),
        ],
        candPages: [
          makePageCapture({
            url: "https://cand.com/product/p",
            html: HTML_NO_BREADCRUMB,
            side: "cand",
            viewport: "mobile",
          }),
        ],
      }),
    );
    expect(r.status).toBe("pass");
    expect(r.issues.length).toBe(0);
  });

  it("ignores non-PDP pages entirely", () => {
    const r = pdpBreadcrumbs(
      makeContext({
        candPages: [
          makePageCapture({ url: "https://x.com/", html: HTML_NO_BREADCRUMB, side: "cand" }),
        ],
      }),
    );
    expect(r.status).toBe("skipped");
  });
});
