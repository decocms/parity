import { describe, expect, it } from "vitest";
import { imageLoadingHealth } from "../../src/checks/image-health.ts";
import { makeContext } from "../helpers/make-context.ts";
import { makePageCapture } from "../helpers/make-page-capture.ts";
import type { NetworkEntry } from "../../src/types/schema.ts";

function netImg(over: Partial<NetworkEntry> = {}): NetworkEntry {
  return {
    url: "https://x.com/a.jpg",
    method: "GET",
    status: 200,
    resourceType: "image",
    fromCache: false,
    bytes: 1000,
    durationMs: 50,
    cacheControl: null,
    serverTiming: null,
    decoSection: null,
    ...over,
  };
}

const html = (imgs: string) => `<html><body>${imgs}</body></html>`;

describe("imageLoadingHealth", () => {
  it("passes when both sides have healthy images", () => {
    const h = html(`<img src="a.jpg" alt="a" srcset="a.jpg 1x, a2.jpg 2x"/>`);
    const r = imageLoadingHealth(
      makeContext({
        prodPages: [makePageCapture({ url: "https://x.com/", side: "prod", html: h, network: [netImg()] })],
        candPages: [makePageCapture({ url: "https://x.com/", side: "cand", html: h, network: [netImg()] })],
      }),
    );
    expect(r.status).toBe("pass");
  });

  it("flags failed image requests in cand", () => {
    const r = imageLoadingHealth(
      makeContext({
        prodPages: [makePageCapture({ url: "https://x.com/", side: "prod" })],
        candPages: [
          makePageCapture({
            url: "https://x.com/",
            side: "cand",
            network: [
              netImg({ status: 404 }),
              netImg({ status: 500 }),
              netImg({ status: 0 }),
            ],
          }),
        ],
      }),
    );
    const failed = r.issues.find((i) => i.id.includes("images:failed"));
    expect(failed?.summary).toMatch(/3 imagem/);
  });

  it("flags loss of alt text when cand has > +1 imgs without alt", () => {
    const prodHtml = html(`<img src="a.jpg" alt="a"/><img src="b.jpg" alt="b"/>`);
    const candHtml = html(`<img src="a.jpg"/><img src="b.jpg"/><img src="c.jpg"/>`);
    const r = imageLoadingHealth(
      makeContext({
        prodPages: [makePageCapture({ url: "https://x.com/", side: "prod", html: prodHtml })],
        candPages: [makePageCapture({ url: "https://x.com/", side: "cand", html: candHtml })],
      }),
    );
    expect(r.issues.find((i) => i.id.includes("images:alt"))).toBeDefined();
  });

  it("flags loss of srcset > 2 between sides", () => {
    const withSrcset = (n: number) =>
      Array.from({ length: n })
        .map((_, i) => `<img src="${i}.jpg" srcset="${i}.jpg 1x, ${i}2.jpg 2x"/>`)
        .join("");
    const r = imageLoadingHealth(
      makeContext({
        prodPages: [makePageCapture({ url: "https://x.com/", side: "prod", html: html(withSrcset(5)) })],
        candPages: [makePageCapture({ url: "https://x.com/", side: "cand", html: html(withSrcset(1)) })],
      }),
    );
    expect(r.issues.find((i) => i.id.includes("images:srcset"))).toBeDefined();
  });

  it("only counts image-resourceType failures (ignores xhr/script 404s)", () => {
    const r = imageLoadingHealth(
      makeContext({
        prodPages: [makePageCapture({ url: "https://x.com/", side: "prod" })],
        candPages: [
          makePageCapture({
            url: "https://x.com/",
            side: "cand",
            network: [{ ...netImg({ status: 404 }), resourceType: "script" }],
          }),
        ],
      }),
    );
    expect(r.issues.find((i) => i.id.includes("images:failed"))).toBeUndefined();
  });
});
