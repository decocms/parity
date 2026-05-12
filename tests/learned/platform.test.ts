import { describe, expect, it } from "vitest";
import { detectPlatform } from "../../src/learned/platform.ts";

describe("detectPlatform — URL heuristics", () => {
  it("detects VTEX from .myvtex.com", () => {
    expect(detectPlatform({ url: "https://store.myvtex.com" })).toBe("vtex");
  });

  it("detects VTEX from .vtex.app", () => {
    expect(detectPlatform({ url: "https://store.vtex.app" })).toBe("vtex");
  });

  it("detects Shopify from .myshopify.com", () => {
    expect(detectPlatform({ url: "https://store.myshopify.com" })).toBe("shopify");
  });

  it("detects Nuvemshop from .lojavirtualnuvem.com.br", () => {
    expect(detectPlatform({ url: "https://store.lojavirtualnuvem.com.br" })).toBe("nuvemshop");
  });

  it("detects Wake from .fbits.store and .wake.tech", () => {
    expect(detectPlatform({ url: "https://store.fbits.store" })).toBe("wake");
    expect(detectPlatform({ url: "https://store.wake.tech" })).toBe("wake");
  });

  it("detects Deco from .deco.site and .deco-cx.workers.dev", () => {
    expect(detectPlatform({ url: "https://store.deco.site" })).toBe("deco");
    expect(detectPlatform({ url: "https://store.deco-cx.workers.dev" })).toBe("deco");
  });

  it("falls back to custom for unknown URLs", () => {
    expect(detectPlatform({ url: "https://www.example.com" })).toBe("custom");
  });

  it("returns custom for malformed URLs (no crash)", () => {
    expect(detectPlatform({ url: "not a url" })).toBe("custom");
  });
});

describe("detectPlatform — header heuristics", () => {
  it("detects VTEX from x-vtex-account header", () => {
    expect(
      detectPlatform({ url: "https://www.x.com", headers: { "x-vtex-account": "store" } }),
    ).toBe("vtex");
  });

  it("detects Shopify from x-powered-by", () => {
    expect(
      detectPlatform({ url: "https://www.x.com", headers: { "x-powered-by": "Shopify" } }),
    ).toBe("shopify");
  });

  it("detects from server header (case-insensitive)", () => {
    expect(detectPlatform({ url: "https://www.x.com", headers: { Server: "VTEX" } })).toBe("vtex");
  });
});

describe("detectPlatform — HTML heuristics", () => {
  it("detects VTEX legacy from vtex-* class density", () => {
    const html = `<html><body>${'<div class="vtex-foo"></div>'.repeat(6)}</body></html>`;
    expect(detectPlatform({ url: "https://www.x.com", html })).toBe("vtex");
  });

  it("detects VTEX FastStore from fs-* class density", () => {
    const html = `<html><body>${'<div class="fs-foo"></div>'.repeat(6)}</body></html>`;
    expect(detectPlatform({ url: "https://www.x.com", html })).toBe("vtex-fs");
  });

  it("detects Shopify from shopify-checkout meta", () => {
    const html = `<html><head><meta name="shopify-checkout-api-token" content="x"/></head></html>`;
    expect(detectPlatform({ url: "https://www.x.com", html })).toBe("shopify");
  });

  it("detects Deco from data-section/data-deco markers", () => {
    const html = `<html><body>${'<div data-section="x"></div>'.repeat(4)}</body></html>`;
    expect(detectPlatform({ url: "https://www.x.com", html })).toBe("deco");
  });

  it("detects Nuvemshop from script src", () => {
    const html = `<html><head><script src="https://cdn.nuvemshop.com.br/x.js"></script></head></html>`;
    expect(detectPlatform({ url: "https://www.x.com", html })).toBe("nuvemshop");
  });

  it("detects from generator meta tag", () => {
    const html = `<html><head><meta name="generator" content="Shopify 5.0"/></head></html>`;
    expect(detectPlatform({ url: "https://www.x.com", html })).toBe("shopify");
  });
});
