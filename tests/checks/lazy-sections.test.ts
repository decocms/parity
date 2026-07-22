import { describe, expect, it } from "vitest";
import { lazySectionPresence, normalizeSectionId } from "../../src/checks/lazy-sections.ts";
import type { NetworkEntry } from "../../src/types/schema.ts";
import { makeContext } from "../helpers/make-context.ts";
import { makePageCapture } from "../helpers/make-page-capture.ts";

function net(over: Partial<NetworkEntry> = {}): NetworkEntry {
  return {
    url: "https://x.com/deco/render?s=hero",
    method: "GET",
    status: 200,
    resourceType: "fetch",
    fromCache: false,
    bytes: 100,
    durationMs: 20,
    cacheControl: null,
    serverTiming: null,
    decoSection: null,
    ...over,
  };
}

describe("lazySectionPresence", () => {
  it("passes when both sides render the same lazy sections", () => {
    const requests: NetworkEntry[] = [
      net({ url: "https://x.com/deco/render?s=hero", decoSection: "Hero" }),
      net({ url: "https://x.com/deco/render?s=shelf", decoSection: "Shelf" }),
      net({ url: "https://x.com/_loader/footer", decoSection: "Footer" }),
    ];
    const r = lazySectionPresence(
      makeContext({
        prodPages: [makePageCapture({ url: "https://x.com/", side: "prod", network: requests })],
        candPages: [makePageCapture({ url: "https://x.com/", side: "cand", network: requests })],
      }),
    );
    expect(r.status).toBe("pass");
  });

  it("flags as high severity when prod has sections missing in cand", () => {
    const r = lazySectionPresence(
      makeContext({
        prodPages: [
          makePageCapture({
            url: "https://x.com/",
            side: "prod",
            network: [
              net({ decoSection: "Hero" }),
              net({ decoSection: "Shelf" }),
              net({ decoSection: "Newsletter" }),
            ],
          }),
        ],
        candPages: [
          makePageCapture({
            url: "https://x.com/",
            side: "cand",
            network: [net({ decoSection: "Hero" })],
          }),
        ],
      }),
    );
    expect(r.status).toBe("fail");
    const missing = r.issues.find((i) => i.id.includes("lazy:missing"));
    expect(missing?.severity).toBe("high");
    expect(missing?.summary).toMatch(/2 lazy section/);
  });

  it("extracts section id from URL when decoSection header is absent", () => {
    const r = lazySectionPresence(
      makeContext({
        prodPages: [
          makePageCapture({
            url: "https://x.com/",
            side: "prod",
            network: [net({ url: "https://x.com/_loader/Hero" })],
          }),
        ],
        candPages: [makePageCapture({ url: "https://x.com/", side: "cand", network: [] })],
      }),
    );
    expect(r.issues.find((i) => i.id.includes("lazy:missing"))).toBeDefined();
  });

  it("ignores requests outside the lazy URL pattern", () => {
    const r = lazySectionPresence(
      makeContext({
        prodPages: [
          makePageCapture({
            url: "https://x.com/",
            side: "prod",
            network: [{ ...net({ url: "https://x.com/api/products" }), decoSection: null }],
          }),
        ],
        candPages: [makePageCapture({ url: "https://x.com/", side: "cand", network: [] })],
      }),
    );
    expect(r.status).toBe("pass");
  });

  describe("issue #118: bundler extension drift (render vs render.ts)", () => {
    it("normalizeSectionId strips bundler extensions and lowercases", () => {
      expect(normalizeSectionId("render")).toBe("render");
      expect(normalizeSectionId("render.ts")).toBe("render");
      expect(normalizeSectionId("render.tsx")).toBe("render");
      expect(normalizeSectionId("Render.JS")).toBe("render");
      expect(normalizeSectionId("hero.mjs")).toBe("hero");
      // non-bundler suffixes are preserved
      expect(normalizeSectionId("hero.v2")).toBe("hero.v2");
    });

    it("passes when prod chunk is `render` (Fresh) and cand is `render.ts` (Vite)", () => {
      const r = lazySectionPresence(
        makeContext({
          prodPages: [
            makePageCapture({
              url: "https://x.com/",
              side: "prod",
              network: [net({ url: "https://x.com/deco/render", decoSection: null })],
            }),
          ],
          candPages: [
            makePageCapture({
              url: "https://x.com/",
              side: "cand",
              network: [net({ url: "https://x.com/deco/render.ts", decoSection: null })],
            }),
          ],
        }),
      );
      expect(r.status).toBe("pass");
      expect(r.issues).toHaveLength(0);
    });
  });

  describe("issue #46: intentional eager rendering (respectCmsLazy:false)", () => {
    const prodLazy = [
      net({ decoSection: "Hero" }),
      net({ decoSection: "Shelf" }),
      net({ decoSection: "Newsletter" }),
    ];
    // Cand renders deco sections inline via data-manifest-key (the canonical
    // deco SSR marker). Review feedback on PR #63 — raw `<section>` count
    // was too weak; counting deco-marked nodes prevents the false-negative
    // path where a fallback layout's footer/sidebar would pass.
    const eagerCandHtml = `<html><body>
      <div data-manifest-key="site/sections/Hero.tsx">Hero</div>
      <div data-manifest-key="site/sections/Banner.tsx">Banner</div>
      <div data-manifest-key="site/sections/Shelf.tsx">Shelf</div>
      <div data-manifest-key="site/sections/NewArrivals.tsx">NewArrivals</div>
      <div data-manifest-key="site/sections/Newsletter.tsx">Newsletter</div>
      <div data-manifest-key="site/sections/Footer.tsx">Footer</div>
    </body></html>`;
    const prodHtmlWithSections = `<html><body>
      <div data-manifest-key="site/sections/Hero.tsx">Hero</div>
      <div data-manifest-key="site/sections/Shelf.tsx">Shelf</div>
      <div data-manifest-key="site/sections/Footer.tsx">Footer</div>
    </body></html>`;

    it("downgrade pra low + intentional-eager-rendering quando cand renderiza tudo inline", () => {
      const r = lazySectionPresence(
        makeContext({
          prodPages: [
            makePageCapture({
              url: "https://x.com/",
              side: "prod",
              network: prodLazy,
              html: prodHtmlWithSections,
            }),
          ],
          candPages: [
            makePageCapture({
              url: "https://x.com/",
              side: "cand",
              network: [], // zero lazy requests
              html: eagerCandHtml,
            }),
          ],
        }),
      );
      expect(r.status).toBe("warn"); // não fail
      const eagerIssue = r.issues.find((i) => i.id.includes("intentional-eager"));
      expect(eagerIssue).toBeDefined();
      expect(eagerIssue?.severity).toBe("low");
      expect(eagerIssue?.summary).toMatch(/intentional-eager-rendering/);
      // o "lazy:missing" tradicional NÃO deve aparecer junto
      expect(r.issues.find((i) => i.id.includes("lazy:missing"))).toBeUndefined();
    });

    it("respeita marker explícito data-deco-async-rendering=eager mesmo com poucas sections", () => {
      const r = lazySectionPresence(
        makeContext({
          prodPages: [
            makePageCapture({
              url: "https://x.com/",
              side: "prod",
              network: prodLazy,
              html: prodHtmlWithSections,
            }),
          ],
          candPages: [
            makePageCapture({
              url: "https://x.com/",
              side: "cand",
              network: [],
              html: `<html data-deco-async-rendering="eager"><body><section>Only</section></body></html>`,
            }),
          ],
        }),
      );
      const eagerIssue = r.issues.find((i) => i.id.includes("intentional-eager"));
      expect(eagerIssue?.severity).toBe("low");
    });

    it("NÃO downgrade quando cand inlina <section> genéricos sem markers deco (false-negative guard)", () => {
      // Cand has 5 generic <section> tags but ZERO data-manifest-key — this
      // is the regression case the original heuristic missed (PR #63 review).
      const r = lazySectionPresence(
        makeContext({
          prodPages: [
            makePageCapture({
              url: "https://x.com/",
              side: "prod",
              network: prodLazy,
              html: prodHtmlWithSections,
            }),
          ],
          candPages: [
            makePageCapture({
              url: "https://x.com/",
              side: "cand",
              network: [],
              html: `<html><body>
                <section>fallback header</section>
                <section>nav</section>
                <section>error message</section>
                <section>sidebar</section>
                <section>fallback footer</section>
              </body></html>`,
            }),
          ],
        }),
      );
      expect(r.status).toBe("fail");
      expect(r.issues.find((i) => i.id.includes("lazy:missing"))?.severity).toBe("high");
      expect(r.issues.find((i) => i.id.includes("intentional-eager"))).toBeUndefined();
    });

    it("ainda HIGH quando cand não tem sections inline (regressão genuína)", () => {
      const r = lazySectionPresence(
        makeContext({
          prodPages: [
            makePageCapture({
              url: "https://x.com/",
              side: "prod",
              network: prodLazy,
              html: prodHtmlWithSections,
            }),
          ],
          candPages: [
            makePageCapture({
              url: "https://x.com/",
              side: "cand",
              network: [],
              html: "<html><body><p>nothing here</p></body></html>",
            }),
          ],
        }),
      );
      expect(r.status).toBe("fail");
      expect(r.issues.find((i) => i.id.includes("lazy:missing"))?.severity).toBe("high");
    });

    it("NÃO downgrade quando cand TAMBÉM fez lazy requests (não é eager-by-design)", () => {
      const r = lazySectionPresence(
        makeContext({
          prodPages: [
            makePageCapture({
              url: "https://x.com/",
              side: "prod",
              network: prodLazy,
              html: prodHtmlWithSections,
            }),
          ],
          candPages: [
            makePageCapture({
              url: "https://x.com/",
              side: "cand",
              network: [net({ decoSection: "Hero" })], // pelo menos 1 lazy
              html: eagerCandHtml,
            }),
          ],
        }),
      );
      expect(r.status).toBe("fail");
      const missing = r.issues.find((i) => i.id.includes("lazy:missing"));
      expect(missing?.severity).toBe("high");
    });
  });
});
