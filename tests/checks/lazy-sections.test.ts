import { describe, expect, it } from "vitest";
import { lazySectionPresence } from "../../src/checks/lazy-sections.ts";
import { makeContext } from "../helpers/make-context.ts";
import { makePageCapture } from "../helpers/make-page-capture.ts";
import type { NetworkEntry } from "../../src/types/schema.ts";

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

  describe("issue #46: intentional eager rendering (respectCmsLazy:false)", () => {
    const prodLazy = [
      net({ decoSection: "Hero" }),
      net({ decoSection: "Shelf" }),
      net({ decoSection: "Newsletter" }),
    ];
    const eagerCandHtml = `<html><body>
      <section>Hero</section>
      <section>Banner</section>
      <section>Shelf</section>
      <section>NewArrivals</section>
      <section>Newsletter</section>
      <section>Footer</section>
    </body></html>`;
    const prodHtmlWithSections = `<html><body>
      <section>Hero</section>
      <section>Shelf</section>
      <section>Footer</section>
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
