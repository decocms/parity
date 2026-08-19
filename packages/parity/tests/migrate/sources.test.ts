import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decoFresh } from "../../src/migrate/sources/deco-fresh.ts";
import { detectSource, getSource, SOURCE_KINDS } from "../../src/migrate/sources/index.ts";
import { liveOnly } from "../../src/migrate/sources/live-only.ts";
import { vtexIo } from "../../src/migrate/sources/vtex-io.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "parity-src-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(rel: string, content: string): void {
  const abs = join(dir, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

describe("decoFresh.detect", () => {
  it("matches a Fresh repo with deno.json importing @deco/deco + fresh.gen.ts", () => {
    write("deno.json", JSON.stringify({ imports: { "@deco/deco": "jsr:@deco/deco" } }));
    write("fresh.gen.ts", "// manifest");
    expect(decoFresh.detect(dir)).toBe(true);
  });

  it("rejects a repo without fresh.gen.ts", () => {
    write("deno.json", JSON.stringify({ imports: { "@deco/deco": "jsr:@deco/deco" } }));
    expect(decoFresh.detect(dir)).toBe(false);
  });

  it("rejects a non-deco Fresh app (deno.json without @deco/deco)", () => {
    write("deno.json", JSON.stringify({ imports: { "$fresh/": "https://deno.land/x/fresh/" } }));
    write("fresh.gen.ts", "// manifest");
    expect(decoFresh.detect(dir)).toBe(false);
  });
});

describe("decoFresh.inventory", () => {
  it("finds every .tsx under sections/ (and nothing outside it), tagging globals", () => {
    write("sections/Hero.tsx", "export default function Hero() {}");
    write("sections/Header/Menu.tsx", "export default function Menu() {}");
    write("islands/Counter.tsx", "// not a section");
    write("loaders/products.ts", "// not a section");

    const inv = decoFresh.inventory(dir);
    const names = inv.components.map((c) => c.name).sort();
    expect(names).toEqual(["Header/Menu", "Hero"]);
    // Header/Menu matches the global hint; Hero is page-scoped.
    expect(inv.components.find((c) => c.name === "Header/Menu")?.scope).toBe("global");
    expect(inv.components.find((c) => c.name === "Hero")?.scope).toBe("page");
    expect(inv.components.find((c) => c.name === "Hero")?.file).toBe("sections/Hero.tsx");
    // islands/ + loaders/ presence surfaces as notes, not components.
    expect(inv.notes.some((n) => n.includes("islands/"))).toBe(true);
    expect(inv.notes.some((n) => n.includes("loaders/"))).toBe(true);
  });
});

describe("vtexIo.detect", () => {
  it("matches via the store builder", () => {
    write("manifest.json", JSON.stringify({ vendor: "acme", builders: { store: "0.x" } }));
    expect(vtexIo.detect(dir)).toBe(true);
  });

  it("matches via a vtex.store* dependency", () => {
    write(
      "manifest.json",
      JSON.stringify({ vendor: "acme", dependencies: { "vtex.store-components": "3.x" } }),
    );
    expect(vtexIo.detect(dir)).toBe(true);
  });

  it("rejects a manifest without a vendor", () => {
    write("manifest.json", JSON.stringify({ builders: { store: "0.x" } }));
    expect(vtexIo.detect(dir)).toBe(false);
  });
});

describe("vtexIo.inventory", () => {
  it("parses .jsonc block files (strips comments) and dedupes by block name", () => {
    write(
      "store/blocks/home.jsonc",
      `{
        // the home template
        "store.home": { "blocks": ["flex-layout.row#deals"] },
        "flex-layout.row#deals": { "children": [] }
      }`,
    );
    // Same block name (#other instance) in a second file — must dedupe.
    write("store/blocks/deals.json", JSON.stringify({ "flex-layout.row#other": {} }));
    write("store/blocks/header.json", JSON.stringify({ "header.full": {} }));

    const inv = vtexIo.inventory(dir);
    const names = inv.components.map((c) => c.name).sort();
    expect(names).toEqual(["flex-layout.row", "header.full", "store.home"]);
    expect(inv.components.find((c) => c.name === "header.full")?.scope).toBe("global");
    expect(inv.components.find((c) => c.name === "store.home")?.scope).toBe("page");
  });
});

describe("detectSource registry", () => {
  it("returns decoFresh for a deco Fresh repo", () => {
    write("deno.json", JSON.stringify({ imports: { "@deco/deco": "jsr:@deco/deco" } }));
    write("fresh.gen.ts", "");
    expect(detectSource(dir).kind).toBe("deco-fresh");
  });

  it("returns vtexIo for a VTEX IO repo", () => {
    write("manifest.json", JSON.stringify({ vendor: "acme", builders: { store: "0.x" } }));
    expect(detectSource(dir).kind).toBe("vtex-io");
  });

  it("falls back to liveOnly when nothing matches", () => {
    write("package.json", JSON.stringify({ name: "plain-node-app" }));
    expect(detectSource(dir)).toBe(liveOnly);
  });

  it("exposes explicit kinds via getSource, including the non-auto-detected live-only", () => {
    expect(getSource("vtex-io")?.kind).toBe("vtex-io");
    expect(getSource("live-only")).toBe(liveOnly);
    expect(getSource("nope")).toBeUndefined();
    expect(SOURCE_KINDS).toContain("live-only");
  });
});
