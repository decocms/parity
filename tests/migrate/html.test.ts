import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { htmlExporter } from "../../src/migrate/exporters/html.ts";
import type { MigrationBundle } from "../../src/types/migrate.ts";

function bundle(): MigrationBundle {
  return {
    url: "https://loja.com",
    timestamp: "2026-08-17T00:00:00.000Z",
    viewport: "mobile",
    viewports: ["mobile", "desktop"],
    screenshots: [{ viewport: "mobile", path: "screenshots/mobile.png" }],
    platform: "vtex",
    target: "faststore",
    theme: {
      colors: { primary: "rgb(4, 30, 80)", secondary: null, background: "rgb(255,255,255)", text: "rgb(0,0,0)", palette: [] },
      typography: { fontFamilies: ["Inter"], sizeScale: ["16px"] },
      spacingScale: ["8px"],
      radii: ["4px"],
      shadows: [],
      breakpoints: ["768px"],
      motion: { durations: [], easings: [] },
      tokens: { primary: "rgb(4, 30, 80)" },
    },
    assets: { logo: "assets/logo.svg", logoSource: null, favicon: "assets/favicon.png", faviconSource: null, appleTouchIcon: null, ogImage: null, manifest: null, fonts: [], icons: [{ kind: "svg-use", id: "cart", count: 3 }] },
    vtex: {
      blocks: [{ treePath: "store.home/shelf#a", blockName: "shelf", component: null, parent: "store.home" }],
      map: [{ vtex: "shelf", faststore: "ProductShelf", confidence: 0.9, strategy: "mapped", count: 1 }],
    },
    pages: [{ url: "https://loja.com/", path: "/", kind: "home", components: [] }],
    components: [
      { role: "header", selector: "header", html: "<header></header>", computedStyles: {}, screenshotPath: "", assets: { images: [], backgroundImages: [], fonts: [] }, links: [], textContent: [], tailwind: ["flex"], interactions: [{ selector: "a", kind: "link", label: "buy", e2eKey: "buyButton", animation: null, hasHoverRule: false, hasFocusRule: false }], scope: "global" },
    ],
  };
}

describe("htmlExporter", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pm-html-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes a self-contained index.html with the key sections", async () => {
    await htmlExporter.export(bundle(), dir);
    const html = readFileSync(join(dir, "index.html"), "utf8");
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("https://loja.com");
    expect(html).toContain("background:rgb(4, 30, 80)"); // primary swatch
    expect(html).toContain("screenshots/mobile.png"); // screenshot ref (relative)
    expect(html).toContain("VTEX IO → FastStore blocks");
    expect(html).toContain("ProductShelf");
    expect(html).toContain("buyButton"); // e2e key in component table
    expect(html).toContain("custom-theme.scss"); // faststore link
  });

  it("escapes HTML in values", async () => {
    const b = bundle();
    b.url = 'https://x.com/"><script>alert(1)</script>';
    await htmlExporter.export(b, dir);
    const html = readFileSync(join(dir, "index.html"), "utf8");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
