import { describe, expect, it } from "vitest";
import { metaSeoParity } from "../../src/checks/meta-seo.ts";
import { makeContext } from "../helpers/make-context.ts";
import { makePageCapture } from "../helpers/make-page-capture.ts";

const buildHtml = (title: string, desc: string, canonical: string, og: Record<string, string> = {}) => `
<!doctype html>
<html><head>
  <title>${title}</title>
  <meta name="description" content="${desc}"/>
  <link rel="canonical" href="${canonical}"/>
  ${Object.entries(og)
    .map(([k, v]) => `<meta property="${k}" content="${v}"/>`)
    .join("\n")}
</head><body></body></html>`;

describe("metaSeoParity", () => {
  it("passes when title/description/canonical match", () => {
    const html = buildHtml("Loja X", "best store", "https://x.com/");
    const r = metaSeoParity(
      makeContext({
        prodPages: [makePageCapture({ url: "https://x.com/", side: "prod", html })],
        candPages: [makePageCapture({ url: "https://x.com/", side: "cand", html })],
      }),
    );
    expect(r.status).toBe("pass");
  });

  it("flags title divergence as high severity", () => {
    const r = metaSeoParity(
      makeContext({
        prodPages: [
          makePageCapture({ url: "https://x.com/", side: "prod", html: buildHtml("Loja X", "d", "https://x.com/") }),
        ],
        candPages: [
          makePageCapture({ url: "https://x.com/", side: "cand", html: buildHtml("WRONG", "d", "https://x.com/") }),
        ],
      }),
    );
    expect(r.status).toBe("fail");
    expect(r.issues[0]?.severity).toBe("high");
    expect(r.issues[0]?.summary).toMatch(/title/);
  });

  it("flags canonical divergence as high severity", () => {
    const r = metaSeoParity(
      makeContext({
        prodPages: [
          makePageCapture({ url: "https://x.com/", side: "prod", html: buildHtml("X", "d", "https://x.com/") }),
        ],
        candPages: [
          makePageCapture({ url: "https://x.com/", side: "cand", html: buildHtml("X", "d", "https://other.com/") }),
        ],
      }),
    );
    expect(r.issues[0]?.severity).toBe("high");
  });

  it("flags description divergence as medium severity", () => {
    const r = metaSeoParity(
      makeContext({
        prodPages: [
          makePageCapture({ url: "https://x.com/", side: "prod", html: buildHtml("X", "DESC PROD", "https://x.com/") }),
        ],
        candPages: [
          makePageCapture({ url: "https://x.com/", side: "cand", html: buildHtml("X", "DESC CAND", "https://x.com/") }),
        ],
      }),
    );
    expect(r.issues[0]?.severity).toBe("medium");
  });

  it("flags og:image divergence", () => {
    const r = metaSeoParity(
      makeContext({
        prodPages: [
          makePageCapture({
            url: "https://x.com/",
            side: "prod",
            html: buildHtml("X", "d", "https://x.com/", { "og:image": "https://x.com/p.png" }),
          }),
        ],
        candPages: [
          makePageCapture({
            url: "https://x.com/",
            side: "cand",
            html: buildHtml("X", "d", "https://x.com/", { "og:image": "https://x.com/c.png" }),
          }),
        ],
      }),
    );
    expect(r.status).toBe("fail");
  });

  it("respects ignoreMetaKeys", () => {
    const r = metaSeoParity(
      makeContext({
        prodPages: [
          makePageCapture({ url: "https://x.com/", side: "prod", html: buildHtml("OLD", "d", "https://x.com/") }),
        ],
        candPages: [
          makePageCapture({ url: "https://x.com/", side: "cand", html: buildHtml("NEW", "d", "https://x.com/") }),
        ],
        ignore: { ignoreMetaKeys: ["title"] },
      }),
    );
    expect(r.status).toBe("pass");
  });
});
