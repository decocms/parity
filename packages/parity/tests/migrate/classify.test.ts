import { describe, expect, it } from "vitest";
import { classifyLiveStack, describeStack } from "../../src/migrate/sources/classify.ts";

// Markers below are the ones actually observed on each store (curl probe,
// 2026-08) — this suite is the calibration guard.

describe("classifyLiveStack", () => {
  it("miess → deco-fresh, no htmx (deco.cx + fresh + /live/invoke)", () => {
    const html = `<html><head><meta name="generator" content="deco.cx"></head>
      <body><script id="__FRSH_STATE"></script>
      <form action="/live/invoke/deco/actions/x.ts"></form></body></html>`;
    const s = classifyLiveStack(html);
    expect(s.frontend).toBe("deco-fresh");
    expect(s.htmx).toBe(false);
    expect(s.evidence).toContain("deco.cx");
  });

  it("farmrio → deco-fresh + htmx (deco + hx-* + htmx.org), commerce vtex", () => {
    const html = `<html><head><meta name="generator" content="deco.cx">
      <script src="https://cdn/htmx.org@1.9"></script></head>
      <body><script>window.__FRSH_STATE={}</script>
      <button hx-get="/live/invoke/x" hx-target="#c" hx-swap="outerHTML">go</button>
      <img src="https://farmrio.vtexassets.com/x.jpg"></body></html>`;
    const s = classifyLiveStack(html);
    expect(s.frontend).toBe("deco-fresh");
    expect(s.htmx).toBe(true);
    expect(s.commerce).toBe("vtex");
    expect(describeStack(s)).toContain("deco-fresh + htmx");
  });

  it("electrolux → vtex-io (__RUNTIME__ + render-runtime)", () => {
    const html = `<html><body><div class="render-runtime"></div>
      <script>window.__RUNTIME__={account:"electrolux"}</script>
      <div class="vtex-store-components-3-x-container"></div></body></html>`;
    const s = classifyLiveStack(html);
    expect(s.frontend).toBe("vtex-io");
    expect(s.commerce).toBe("vtex");
    expect(s.htmx).toBe(false);
  });

  it("osklen → deco-fresh, no htmx, commerce vtex (deco on custom domain)", () => {
    const html = `<html><head><meta name="generator" content="Deco.cx"></head>
      <body><script id="__FRSH_STATE"></script>
      <img src="https://osklen.vtexassets.com/x.png"></body></html>`;
    const s = classifyLiveStack(html);
    expect(s.frontend).toBe("deco-fresh");
    expect(s.htmx).toBe(false);
    expect(s.commerce).toBe("vtex");
  });

  it("newbalance → salesforce-commerce (demandware/cquotient cookies)", () => {
    const html = `<html><body><script src="https://cdn.cquotient.com/x.js"></script></body></html>`;
    const cookies = "dwac_0ed=abc; cqcid=xyz; dwanonymous_74=q";
    const s = classifyLiveStack(html, cookies);
    expect(s.frontend).toBe("salesforce-commerce");
    expect(s.commerce).toBe("salesforce-commerce");
  });

  it("faststore → data-fs-* markers", () => {
    const html = `<div data-fs-container><a data-fs-link><span data-fs-badge>x</span>
      <p data-fs-price></p></div>`;
    const s = classifyLiveStack(html);
    expect(s.frontend).toBe("faststore");
  });

  it("unknown when no marker matches", () => {
    const s = classifyLiveStack("<html><body><h1>plain</h1></body></html>");
    expect(s.frontend).toBe("unknown");
    expect(s.htmx).toBe(false);
  });

  it("does not mistake a deco frontend (vtex commerce) for vtex-io", () => {
    // vtexassets present but NO render-runtime → frontend stays deco-fresh.
    const html = `<meta name="generator" content="deco.cx">
      <img src="https://x.vtexassets.com/a.png">`;
    expect(classifyLiveStack(html).frontend).toBe("deco-fresh");
  });
});
