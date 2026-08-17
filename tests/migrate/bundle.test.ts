import { describe, expect, it } from "vitest";
import {
  compactComponentHtml,
  dedupeRepeatedChildren,
  isGlobalRole,
  planComponentDedup,
  toMigratedComponent,
} from "../../src/migrate/bundle.ts";
import type { ExtractedComponent } from "../../src/types/extract.ts";

const shelf = `<ul>${Array.from({ length: 6 }, (_, i) => `<li class="card"><span>Product ${i}</span></li>`).join("")}</ul>`;

describe("dedupeRepeatedChildren", () => {
  it("collapses identical siblings to one representative + marker", () => {
    const { html, collapsed } = dedupeRepeatedChildren(shelf);
    expect(collapsed).toBe(5);
    expect((html.match(/<li/g) ?? []).length).toBe(1);
    expect(html).toContain("×6 itens idênticos omitidos");
  });

  it("leaves distinct children alone", () => {
    const { collapsed } = dedupeRepeatedChildren("<div><a>x</a><button>y</button></div>");
    expect(collapsed).toBe(0);
  });
});

describe("compactComponentHtml", () => {
  it("strips scripts/styles, purges utility classes, collapses repeats", () => {
    const html = `<section class="w-full flex product-shelf"><style>.x{}</style><script>1</script>${shelf}</section>`;
    const out = compactComponentHtml(html);
    expect(out.html).not.toContain("<script");
    expect(out.html).not.toContain("<style");
    expect(out.html).toContain("product-shelf"); // semantic class kept
    expect(out.html).not.toContain("w-full"); // utility class purged
    expect(out.collapsed).toBe(5);
    expect(out.truncated).toBe(false);
  });

  it("neutralizes base64 data-uri images", () => {
    const out = compactComponentHtml('<img src="data:image/png;base64,AAAABBBB">');
    expect(out.html).toContain("[data-uri]");
    expect(out.html).not.toContain("base64");
  });

  it("flags truncation past the char ceiling", () => {
    const big = `<div>${"x".repeat(20)}</div>`;
    const out = compactComponentHtml(big, 10);
    expect(out.truncated).toBe(true);
    expect(out.html).toContain("TRUNCATED");
  });
});

describe("planComponentDedup", () => {
  it("keeps first of each role+signature group, counting the rest", () => {
    const plan = planComponentDedup([
      { role: "carousel", signature: "DIV|shelf|4" },
      { role: "carousel", signature: "DIV|shelf|4" },
      { role: "carousel", signature: "DIV|shelf|4" },
      { role: "header", signature: "HEADER||3" },
      { role: "carousel", signature: "DIV|hero|1" }, // different signature → own entry
    ]);
    expect(plan).toEqual([
      { index: 0, repeated: 3 },
      { index: 3, repeated: 1 },
      { index: 4, repeated: 1 },
    ]);
  });

  it("does not merge same signature under different roles", () => {
    const plan = planComponentDedup([
      { role: "banner", signature: "DIV||2" },
      { role: "hero", signature: "DIV||2" },
    ]);
    expect(plan).toHaveLength(2);
  });
});

describe("toMigratedComponent / isGlobalRole", () => {
  const base: ExtractedComponent = {
    role: "header",
    selector: "header",
    html: "<header></header>",
    computedStyles: { display: "flex", gap: "16px" },
    screenshotPath: "/x.png",
    assets: { images: [], backgroundImages: [], fonts: [] },
    links: [],
    textContent: [],
  };

  it("adds tailwind IR and preserves the raw component", () => {
    const m = toMigratedComponent(base, [], "global");
    expect(m.tailwind).toEqual(expect.arrayContaining(["flex", "gap-4"]));
    expect(m.html).toBe("<header></header>");
    expect(m.scope).toBe("global");
  });

  it("recognizes global roles", () => {
    expect(isGlobalRole("header")).toBe(true);
    expect(isGlobalRole("footer-2")).toBe(true);
    expect(isGlobalRole("minicart-drawer")).toBe(true);
    expect(isGlobalRole("shelf-related")).toBe(false);
  });
});
