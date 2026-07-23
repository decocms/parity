import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { markdownExporter } from "../../../src/extract/exporters/markdown.ts";
import type { ExtractBundle } from "../../../src/types/extract.ts";

function makeBundle(): ExtractBundle {
  return {
    url: "https://example.com",
    timestamp: "2026-07-23T00:00:00.000Z",
    viewport: "mobile",
    components: [
      {
        role: "header",
        selector: "header",
        html: "<header>hi</header>",
        computedStyles: { display: "flex", color: "rgb(0, 0, 0)" },
        screenshotPath: "/out/components/header-1/screenshot.png",
        assets: { images: ["/logo.png"], backgroundImages: ["/bg.png"], fonts: ["Inter"] },
        links: [{ href: "/account", text: "Minha conta" }],
        textContent: ["Bem-vindo"],
      },
      {
        role: "footer",
        selector: "footer",
        html: "<footer>bye</footer>",
        computedStyles: null,
        screenshotPath: "/out/components/footer-2/screenshot.png",
        assets: { images: [], backgroundImages: [], fonts: [] },
        links: [],
        textContent: [],
      },
    ],
  };
}

describe("markdownExporter", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "parity-extract-md-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("escreve index.md com URL, timestamp e uma linha de tabela por componente", async () => {
    const bundle = makeBundle();
    await markdownExporter.export(bundle, dir);
    const index = readFileSync(join(dir, "index.md"), "utf8");
    expect(index).toContain("https://example.com");
    expect(index).toContain("2026-07-23T00:00:00.000Z");
    expect(index).toContain("`header`");
    expect(index).toContain("`footer`");
    expect(index).toContain("./components/header-1/README.md");
    expect(index).toContain("./components/footer-2/README.md");
  });

  it("escreve um README.md por componente na pasta <role>-<index>", async () => {
    const bundle = makeBundle();
    await markdownExporter.export(bundle, dir);
    expect(existsSync(join(dir, "components", "header-1", "README.md"))).toBe(true);
    expect(existsSync(join(dir, "components", "footer-2", "README.md"))).toBe(true);
  });

  it("inclui a tabela de design tokens quando há computedStyles", async () => {
    const bundle = makeBundle();
    await markdownExporter.export(bundle, dir);
    const readme = readFileSync(join(dir, "components", "header-1", "README.md"), "utf8");
    expect(readme).toContain("## Design tokens (computed styles)");
    expect(readme).toContain("`display`");
    expect(readme).toContain("`flex`");
  });

  it("lida com computedStyles nulo sem quebrar", async () => {
    const bundle = makeBundle();
    await markdownExporter.export(bundle, dir);
    const readme = readFileSync(join(dir, "components", "footer-2", "README.md"), "utf8");
    expect(readme).toContain("No computed styles captured");
  });

  it("inclui links e texto notável quando presentes", async () => {
    const bundle = makeBundle();
    await markdownExporter.export(bundle, dir);
    const readme = readFileSync(join(dir, "components", "header-1", "README.md"), "utf8");
    expect(readme).toContain("Minha conta");
    expect(readme).toContain("Bem-vindo");
  });
});
