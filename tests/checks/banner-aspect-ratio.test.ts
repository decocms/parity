import { describe, expect, it } from "vitest";
import { bannerAspectRatio } from "../../src/checks/banner-aspect-ratio.ts";
import { makeContext } from "../helpers/make-context.ts";
import { makePairedPages } from "../helpers/make-page-capture.ts";

function html(body: string): string {
  return `<html><body>${body}</body></html>`;
}

function banner(opts: { src: string; width?: number; height?: number; section?: string }) {
  const wAttr = opts.width !== undefined ? `width="${opts.width}"` : "";
  const hAttr = opts.height !== undefined ? `height="${opts.height}"` : "";
  const img = `<img src="${opts.src}" ${wAttr} ${hAttr}>`;
  return opts.section ? `<div data-section="${opts.section}">${img}</div>` : img;
}

describe("bannerAspectRatio", () => {
  it("passa quando prod e cand têm os mesmos banners e mesmos dims", () => {
    const b = banner({ src: "/hero.jpg", width: 1440, height: 600, section: "Images/Carousel" });
    const { prod, cand } = makePairedPages({ prodHtml: html(b), candHtml: html(b) });
    const r = bannerAspectRatio(
      makeContext({ prodPages: [prod], candPages: [cand], outDir: "/tmp" }),
    );
    expect(r.status).toBe("pass");
    expect(r.issues).toHaveLength(0);
  });

  it("detecta atributos width/height ausentes em cand (CLS risk)", () => {
    const prodB = banner({ src: "/hero.jpg", width: 1440, height: 600, section: "Carousel" });
    const candB = banner({ src: "/hero.jpg", section: "Carousel" });
    const { prod, cand } = makePairedPages({ prodHtml: html(prodB), candHtml: html(candB) });
    const r = bannerAspectRatio(
      makeContext({ prodPages: [prod], candPages: [cand], outDir: "/tmp" }),
    );
    const issue = r.issues.find((i) => i.id.startsWith("banner-aspect:missing-dims"));
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe("medium");
    expect(issue?.summary).toMatch(/1440×600/);
  });

  it("flag HIGH quando aspect ratio mobile/desktop trocado (wide → tall)", () => {
    // Prod: 1440x600 (wide hero, ratio 2.4)
    // Cand: 600x800 (mobile asset rendered at mobile width 600 — ratio 0.75 "tall")
    const prodB = banner({ src: "/hero.jpg", width: 1440, height: 600, section: "Carousel" });
    const candB = banner({ src: "/hero.jpg", width: 600, height: 800, section: "Carousel" });
    const { prod, cand } = makePairedPages({ prodHtml: html(prodB), candHtml: html(candB) });
    const r = bannerAspectRatio(
      makeContext({ prodPages: [prod], candPages: [cand], outDir: "/tmp" }),
    );
    const issue = r.issues.find((i) => i.id.startsWith("banner-aspect:ratio"));
    expect(issue?.severity).toBe("high");
    expect(issue?.summary).toMatch(/variante mobile\/desktop/);
  });

  it("tolera variações pequenas (<15%) no aspect ratio", () => {
    const prodB = banner({ src: "/hero.jpg", width: 1440, height: 600, section: "Carousel" });
    // 1500x600 — 4% wider, same overall shape
    const candB = banner({ src: "/hero.jpg", width: 1500, height: 600, section: "Carousel" });
    const { prod, cand } = makePairedPages({ prodHtml: html(prodB), candHtml: html(candB) });
    const r = bannerAspectRatio(
      makeContext({ prodPages: [prod], candPages: [cand], outDir: "/tmp" }),
    );
    expect(r.issues.filter((i) => i.id.startsWith("banner-aspect:ratio"))).toHaveLength(0);
  });

  it("flag MEDIUM quando ratio diverge ≥15% mas as duas formas continuam wide", () => {
    // Both wide (ratio > 1.5) but ratios differ by ~25%
    const prodB = banner({ src: "/hero.jpg", width: 1600, height: 600, section: "Carousel" }); // ~2.67
    const candB = banner({ src: "/hero.jpg", width: 1600, height: 800, section: "Carousel" }); // 2.0
    const { prod, cand } = makePairedPages({ prodHtml: html(prodB), candHtml: html(candB) });
    const r = bannerAspectRatio(
      makeContext({ prodPages: [prod], candPages: [cand], outDir: "/tmp" }),
    );
    const issue = r.issues.find((i) => i.id.startsWith("banner-aspect:ratio"));
    expect(issue?.severity).toBe("medium");
  });

  it("cubic #30: shape muda mas NÃO é wide↔tall → MEDIUM (não escala pra high)", () => {
    // wide (ratio 2.0) → near-square (ratio 1.0) é mudança de bucket mas
    // não orientation-flip. Severity HIGH é reservado pra wide↔tall apenas.
    const prodB = banner({ src: "/hero.jpg", width: 1600, height: 800, section: "Carousel" }); // 2.0 wide
    const candB = banner({ src: "/hero.jpg", width: 800, height: 800, section: "Carousel" }); // 1.0 near-square
    const { prod, cand } = makePairedPages({ prodHtml: html(prodB), candHtml: html(candB) });
    const r = bannerAspectRatio(
      makeContext({ prodPages: [prod], candPages: [cand], outDir: "/tmp" }),
    );
    const issue = r.issues.find((i) => i.id.startsWith("banner-aspect:ratio"));
    expect(issue?.severity).toBe("medium");
    expect(issue?.summary).not.toMatch(/variante mobile\/desktop/);
  });

  it("flag MEDIUM quando contagem de banners é diferente", () => {
    const prodB =
      banner({ src: "/a.jpg", width: 1440, height: 600, section: "Carousel" }) +
      banner({ src: "/b.jpg", width: 1440, height: 600, section: "Carousel" });
    const candB = banner({ src: "/a.jpg", width: 1440, height: 600, section: "Carousel" });
    const { prod, cand } = makePairedPages({ prodHtml: html(prodB), candHtml: html(candB) });
    const r = bannerAspectRatio(
      makeContext({ prodPages: [prod], candPages: [cand], outDir: "/tmp" }),
    );
    const issue = r.issues.find((i) => i.id.startsWith("banner-aspect:count"));
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe("medium");
  });

  it("ignora imagens pequenas (product thumbs, shelf cards)", () => {
    // 300x300 thumbs — well below BANNER_WIDTH_THRESHOLD (600) and no banner section
    const prodB = `<img src="/p.jpg" width="300" height="300">`;
    const candB = `<img src="/p.jpg" width="300" height="450">`; // different ratio
    const { prod, cand } = makePairedPages({ prodHtml: html(prodB), candHtml: html(candB) });
    const r = bannerAspectRatio(
      makeContext({ prodPages: [prod], candPages: [cand], outDir: "/tmp" }),
    );
    expect(r.issues).toHaveLength(0);
    expect(r.status).toBe("pass");
  });
});
