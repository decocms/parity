import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { jsonExporter } from "../../../src/extract/exporters/json.ts";
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
        html: "<header>x</header>",
        computedStyles: { display: "flex" },
        screenshotPath: "/tmp/x/screenshot.png",
        assets: { images: ["/a.png"], backgroundImages: [], fonts: ["Inter"] },
        links: [{ href: "/", text: "Home" }],
        textContent: ["hello"],
      },
    ],
  };
}

describe("jsonExporter", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "parity-extract-json-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("escreve manifest.json com o bundle completo", async () => {
    const bundle = makeBundle();
    await jsonExporter.export(bundle, dir);
    const written = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    expect(written).toEqual(bundle);
  });
});
