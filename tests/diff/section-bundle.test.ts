import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type BundleInputs,
  assembleSectionDiffBundle,
  buildStyleDeltas,
} from "../../src/diff/section-bundle.ts";
import type { ComputedStylesResult } from "../../src/engine/computed-styles.ts";
import { SECTION_STYLE_KEYS } from "../../src/engine/computed-styles.ts";

function makeStyles(over: Partial<Record<string, string>> = {}): ComputedStylesResult {
  const styles: Record<string, string> = {};
  for (const k of SECTION_STYLE_KEYS) styles[k] = "0px";
  Object.assign(styles, over);
  return {
    found: true,
    styles,
    rect: { x: 0, y: 0, width: 100, height: 50 },
    hiddenByPlaywright: false,
  };
}

function makeInputs(over: Partial<BundleInputs> = {}): BundleInputs {
  const dir = mkdtempSync(join(tmpdir(), "parity-bundle-test-"));
  return {
    selector: "header",
    pageKey: "/::mobile",
    viewport: "mobile",
    prodUrl: "https://prod.example.com/",
    candUrl: "https://cand.example.com/",
    outDir: dir,
    filePrefix: "test-section",
    ...over,
  };
}

describe("buildStyleDeltas", () => {
  it("vazio quando computedStyles ausente", () => {
    expect(buildStyleDeltas(makeInputs())).toEqual([]);
  });

  it("vazio quando todos os styles batem", () => {
    const inputs = makeInputs({
      computedStyles: { prod: makeStyles(), cand: makeStyles() },
    });
    expect(buildStyleDeltas(inputs)).toEqual([]);
  });

  it("retorna apenas propriedades divergentes", () => {
    const inputs = makeInputs({
      computedStyles: {
        prod: makeStyles({ color: "rgb(51,51,51)" }),
        cand: makeStyles({ color: "rgb(255,0,0)" }),
      },
    });
    const deltas = buildStyleDeltas(inputs);
    expect(deltas).toHaveLength(1);
    expect(deltas[0]?.property).toBe("color");
    expect(deltas[0]?.prod).toBe("rgb(51,51,51)");
    expect(deltas[0]?.cand).toBe("rgb(255,0,0)");
  });

  it("linka cssSources quando providos", () => {
    const inputs = makeInputs({
      computedStyles: {
        prod: makeStyles({ color: "red" }),
        cand: makeStyles({ color: "blue" }),
      },
      cssSources: {
        prod: new Map([
          [
            "color",
            {
              source: "styles.css",
              selector: ".btn",
              value: "red",
              important: false,
              inheritedFromDistance: 0,
            },
          ],
        ]),
        cand: new Map([
          [
            "color",
            {
              source: "tailwind.css",
              selector: ".text-blue-500",
              value: "blue",
              important: false,
              inheritedFromDistance: 0,
            },
          ],
        ]),
      },
    });
    const deltas = buildStyleDeltas(inputs);
    expect(deltas[0]?.candSource?.source).toBe("tailwind.css");
    expect(deltas[0]?.prodSource?.selector).toBe(".btn");
  });
});

describe("assembleSectionDiffBundle", () => {
  it("escreve json + markdown nos paths esperados", () => {
    const inputs = makeInputs();
    const out = assembleSectionDiffBundle(inputs);
    expect(out.jsonPath).toMatch(/test-section-bundle\.json$/);
    expect(out.markdownPath).toMatch(/test-section-prompt\.md$/);
    const json = JSON.parse(readFileSync(out.jsonPath, "utf8"));
    expect(json.selector).toBe("header");
    expect(json.viewport).toBe("mobile");
  });

  it("não inclui HTML completo no JSON (só diff + bytes count)", () => {
    const inputs = makeInputs({
      html: { prod: "x".repeat(100_000), cand: "y".repeat(100_000), diffPatch: "...diff..." },
    });
    const out = assembleSectionDiffBundle(inputs);
    const json = JSON.parse(readFileSync(out.jsonPath, "utf8"));
    expect(json.html.diffPatch).toBe("...diff...");
    expect(json.html.prodHtmlBytes).toBe(100_000);
    expect(json.html.candHtmlBytes).toBe(100_000);
    expect(json.html.prod).toBeUndefined();
    expect(json.html.cand).toBeUndefined();
  });

  it("markdown contém instrução opinionated de 'understand first, no code'", () => {
    const inputs = makeInputs();
    const out = assembleSectionDiffBundle(inputs);
    const md = readFileSync(out.markdownPath, "utf8");
    expect(md).toMatch(/Step 1: confirm understanding/);
    expect(md).toMatch(/Do \*\*NOT\*\* write code yet/);
    expect(md).toMatch(/Step 2.*next turn/);
  });

  it("markdown referencia screenshots via path relativo quando no mesmo dir", () => {
    const inputs = makeInputs();
    const inputsWithSs: BundleInputs = {
      ...inputs,
      screenshots: {
        prodPath: join(inputs.outDir, "shot-prod.png"),
        candPath: join(inputs.outDir, "shot-cand.png"),
        heatmapPath: join(inputs.outDir, "heatmap.png"),
      },
    };
    const out = assembleSectionDiffBundle(inputsWithSs);
    const md = readFileSync(out.markdownPath, "utf8");
    expect(md).toContain("![prod](shot-prod.png)");
    expect(md).toContain("![cand](shot-cand.png)");
    expect(md).toContain("![heatmap](heatmap.png)");
  });

  it("markdown table de deltas inclui source quando csSources presentes", () => {
    const inputs = makeInputs({
      computedStyles: {
        prod: makeStyles({ color: "rgb(51,51,51)" }),
        cand: makeStyles({ color: "rgb(255,0,0)" }),
      },
      cssSources: {
        prod: new Map(),
        cand: new Map([
          [
            "color",
            {
              source: "tailwind.css",
              selector: ".text-red-500",
              value: "rgb(255,0,0)",
              important: false,
              inheritedFromDistance: 0,
            },
          ],
        ]),
      },
    });
    const out = assembleSectionDiffBundle(inputs);
    const md = readFileSync(out.markdownPath, "utf8");
    expect(md).toContain("| `color` |");
    expect(md).toContain("rgb(51,51,51)");
    expect(md).toContain("rgb(255,0,0)");
    expect(md).toContain(".text-red-500");
    expect(md).toContain("tailwind.css");
  });

  it("summary one-liner reflete o que foi capturado", () => {
    const inputs = makeInputs({
      heatmap: {
        imageWidth: 100,
        imageHeight: 100,
        diffPixels: 1250,
        pctDiff: 0.125,
        boundingBox: { x: 0, y: 0, width: 100, height: 100, pixelCount: 1250 },
        hotspots: [],
      },
      computedStyles: {
        prod: makeStyles({ color: "red" }),
        cand: makeStyles({ color: "blue" }),
      },
      html: { prod: "x", cand: "y", diffPatch: "-line\n+line" },
    });
    const out = assembleSectionDiffBundle(inputs);
    expect(out.summary).toMatch(/12\.5% pixels differ/);
    expect(out.summary).toMatch(/1 style delta/);
  });

  it("summary quando não há diff algum", () => {
    const inputs = makeInputs();
    const out = assembleSectionDiffBundle(inputs);
    expect(out.summary).toMatch(/no diffs detected/);
  });

  it("trunca HTML diff quando muito longo (cap de 200 linhas no markdown)", () => {
    const longDiff = Array.from({ length: 500 }, (_, i) => `-line${i}`).join("\n");
    const inputs = makeInputs({
      html: { prod: "", cand: "", diffPatch: longDiff },
    });
    const out = assembleSectionDiffBundle(inputs);
    const md = readFileSync(out.markdownPath, "utf8");
    expect(md).toContain("[300 more lines truncated]");
  });
});
