import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seoDeepAudit } from "../../src/checks/seo-deep-audit.ts";
import { makeContext } from "../helpers/make-context.ts";
import { makePageCapture } from "../helpers/make-page-capture.ts";
import { mockFetch } from "../helpers/mock-fetch.ts";

const ROBOTS_OK = "User-agent: *\nDisallow: /admin\n";
const ROBOTS_NOINDEX = "User-agent: *\nDisallow: /\n";
const SITEMAP_OK = `<?xml version="1.0"?><urlset><url><loc>https://x.com/a</loc></url><url><loc>https://x.com/b</loc></url></urlset>`;

const HTML_OK = `<!doctype html><html><head>
  <title>X</title>
  <meta name="description" content="d"/>
  <link rel="canonical" href="https://x.com/"/>
  <meta name="robots" content="index,follow"/>
  <script type="application/ld+json">{"@type":"Product","name":"P","sku":"1","offers":{"price":100,"priceCurrency":"BRL","availability":"InStock"},"image":"i","brand":"b","description":"d"}</script>
</head><body></body></html>`;

const HTML_NOINDEX = HTML_OK.replace('content="index,follow"', 'content="noindex,nofollow"');

describe("seoDeepAudit", () => {
  let restore: () => void = () => undefined;
  afterEach(() => restore());

  it("returns skipped when no pairs exist", async () => {
    const r = await seoDeepAudit(makeContext({}));
    expect(r.status).toBe("skipped");
  });

  it("emits zero per-page issues when both sides have identical SEO signals", async () => {
    ({ restore } = mockFetch({
      "/robots.txt": { status: 200, body: ROBOTS_OK },
      "/sitemap.xml": { status: 200, body: SITEMAP_OK },
    }));
    const r = await seoDeepAudit(
      makeContext({
        prodPages: [makePageCapture({ url: "https://x.com/", side: "prod", html: HTML_OK })],
        candPages: [makePageCapture({ url: "https://x.com/", side: "cand", html: HTML_OK })],
      }),
    );
    // Per-page checks (meta robots, canonical, hreflang, jsonld) should all be clean.
    const perPageIssues = r.issues.filter(
      (i) => i.page && !i.id.startsWith("seo:sitemap-") && !i.id.startsWith("seo:robots-txt"),
    );
    expect(perPageIssues).toEqual([]);
    expect(r.data?.seo).toBeDefined();
  });

  it("flags noindex regression in cand as CRITICAL", async () => {
    ({ restore } = mockFetch({
      "/robots.txt": { status: 200, body: ROBOTS_OK },
      "/sitemap.xml": { status: 200, body: SITEMAP_OK },
    }));
    const r = await seoDeepAudit(
      makeContext({
        prodPages: [makePageCapture({ url: "https://x.com/", side: "prod", html: HTML_OK })],
        candPages: [makePageCapture({ url: "https://x.com/", side: "cand", html: HTML_NOINDEX })],
      }),
    );
    expect(r.status).toBe("fail");
    const noindex = r.issues.find((i) => i.id.includes("noindex-introduced"));
    expect(noindex?.severity).toBe("critical");
  });

  it("flags canonical missing in cand as HIGH", async () => {
    ({ restore } = mockFetch({
      "/robots.txt": { status: 404, body: "" },
      "/sitemap.xml": { status: 404, body: "" },
    }));
    const prodHtml = HTML_OK;
    const candHtml = HTML_OK.replace('<link rel="canonical" href="https://x.com/"/>', "");
    const r = await seoDeepAudit(
      makeContext({
        prodPages: [makePageCapture({ url: "https://x.com/", side: "prod", html: prodHtml })],
        candPages: [makePageCapture({ url: "https://x.com/", side: "cand", html: candHtml })],
      }),
    );
    expect(r.issues.find((i) => i.id.includes("canonical-missing"))?.severity).toBe("high");
  });

  it("flags relative canonical in cand", async () => {
    ({ restore } = mockFetch({
      "/robots.txt": { status: 404, body: "" },
      "/sitemap.xml": { status: 404, body: "" },
    }));
    const candHtml = HTML_OK.replace('href="https://x.com/"', 'href="/relative-path"');
    const r = await seoDeepAudit(
      makeContext({
        prodPages: [makePageCapture({ url: "https://x.com/", side: "prod", html: HTML_OK })],
        candPages: [makePageCapture({ url: "https://x.com/", side: "cand", html: candHtml })],
      }),
    );
    expect(r.issues.find((i) => i.id.includes("canonical-relative"))).toBeDefined();
  });

  it("flags robots.txt present in prod but missing in cand", async () => {
    ({ restore } = mockFetch((url) => {
      if (url.includes("https://x.com/robots.txt")) return { status: 200, body: ROBOTS_OK };
      if (url.includes("https://other.example/robots.txt")) return { status: 404, body: "" };
      if (url.includes("sitemap")) return { status: 404, body: "" };
      return undefined;
    }));
    const r = await seoDeepAudit(
      makeContext({
        prodPages: [makePageCapture({ url: "https://x.com/", side: "prod", html: HTML_OK })],
        candPages: [
          makePageCapture({ url: "https://other.example/", side: "cand", html: HTML_OK }),
        ],
      }),
    );
    expect(r.issues.find((i) => i.id === "seo:robots-txt-missing")).toBeDefined();
  });

  it("flags sitemap URL count regression (>5% drop)", async () => {
    ({ restore } = mockFetch((url) => {
      if (url.includes("https://x.com/robots.txt")) return { status: 200, body: ROBOTS_OK };
      if (url.includes("https://other.example/robots.txt")) return { status: 200, body: ROBOTS_OK };
      if (url.includes("https://x.com/sitemap.xml")) {
        const urls = Array.from(
          { length: 100 },
          (_, i) => `<url><loc>https://x.com/${i}</loc></url>`,
        ).join("");
        return { status: 200, body: `<?xml version="1.0"?><urlset>${urls}</urlset>` };
      }
      if (url.includes("https://other.example/sitemap.xml")) {
        const urls = Array.from(
          { length: 10 },
          (_, i) => `<url><loc>https://other.example/${i}</loc></url>`,
        ).join("");
        return { status: 200, body: `<?xml version="1.0"?><urlset>${urls}</urlset>` };
      }
      return { status: 404, body: "" };
    }));
    const r = await seoDeepAudit(
      makeContext({
        prodPages: [makePageCapture({ url: "https://x.com/", side: "prod", html: HTML_OK })],
        candPages: [
          makePageCapture({ url: "https://other.example/", side: "cand", html: HTML_OK }),
        ],
      }),
    );
    expect(r.issues.find((i) => i.id === "seo:sitemap-url-count")).toBeDefined();
  });

  it("flags Product JSON-LD missing in cand as HIGH", async () => {
    ({ restore } = mockFetch({
      "/robots.txt": { status: 404, body: "" },
      "/sitemap.xml": { status: 404, body: "" },
    }));
    const candHtml = HTML_OK.replace(/<script type="application\/ld\+json">[^<]+<\/script>/, "");
    const r = await seoDeepAudit(
      makeContext({
        prodPages: [makePageCapture({ url: "https://x.com/", side: "prod", html: HTML_OK })],
        candPages: [makePageCapture({ url: "https://x.com/", side: "cand", html: candHtml })],
      }),
    );
    expect(r.issues.find((i) => i.id.includes("jsonld-product-missing"))?.severity).toBe("high");
  });

  it("data.seo carries SeoSummary structure (pages, robotsTxt, sitemap)", async () => {
    ({ restore } = mockFetch({
      "/robots.txt": { status: 200, body: ROBOTS_OK },
      "/sitemap.xml": { status: 200, body: SITEMAP_OK },
    }));
    const r = await seoDeepAudit(
      makeContext({
        prodPages: [makePageCapture({ url: "https://x.com/", side: "prod", html: HTML_OK })],
        candPages: [makePageCapture({ url: "https://x.com/", side: "cand", html: HTML_OK })],
      }),
    );
    const seo = r.data?.seo as {
      pages: unknown[];
      robotsTxt: { prodPresent: boolean; candPresent: boolean };
      sitemap: { prodCount: number; candCount: number };
    };
    expect(seo.pages).toHaveLength(1);
    expect(seo.robotsTxt.prodPresent).toBe(true);
    expect(seo.robotsTxt.candPresent).toBe(true);
    expect(seo.sitemap.prodCount).toBe(2);
    expect(seo.sitemap.candCount).toBe(2);
  });

  it("flags noindex via X-Robots-Tag header even when meta says index", async () => {
    ({ restore } = mockFetch({
      "/robots.txt": { status: 404, body: "" },
      "/sitemap.xml": { status: 404, body: "" },
    }));
    const r = await seoDeepAudit(
      makeContext({
        prodPages: [
          makePageCapture({
            url: "https://x.com/",
            side: "prod",
            html: HTML_OK,
            xRobotsTag: "all",
          }),
        ],
        candPages: [
          makePageCapture({
            url: "https://x.com/",
            side: "cand",
            html: HTML_OK,
            xRobotsTag: "noindex",
          }),
        ],
      }),
    );
    expect(r.issues.find((i) => i.id.includes("x-robots-noindex"))?.severity).toBe("critical");
  });
});
