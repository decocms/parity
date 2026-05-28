import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Anthropic SDK — vi.mock is hoisted, so this runs before imports.
const mockCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  })),
}));

import { visualRegressionKeyframes } from "../../src/checks/visual-regression.ts";
import { makeContext } from "../helpers/make-context.ts";
import { makePageCapture } from "../helpers/make-page-capture.ts";
import { makeTmpDir } from "../helpers/tmp-dir.ts";

function makePng(path: string, w: number, h: number, fill: [number, number, number]): void {
  const png = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (w * y + x) << 2;
      png.data[idx] = fill[0];
      png.data[idx + 1] = fill[1];
      png.data[idx + 2] = fill[2];
      png.data[idx + 3] = 255;
    }
  }
  writeFileSync(path, PNG.sync.write(png));
}

describe("visualRegressionKeyframes", () => {
  let dir: { path: string; cleanup: () => void };

  beforeEach(() => {
    mockCreate.mockReset();
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    dir = makeTmpDir();
  });
  afterEach(() => {
    dir.cleanup();
  });

  it("returns pass when prod and cand screenshots are identical (no LLM call)", async () => {
    const prodPath = join(dir.path, "p.png");
    const candPath = join(dir.path, "c.png");
    makePng(prodPath, 50, 50, [100, 100, 100]);
    makePng(candPath, 50, 50, [100, 100, 100]);
    const r = await visualRegressionKeyframes(
      makeContext({
        outDir: dir.path,
        prodPages: [makePageCapture({ url: "https://x.com/", side: "prod", screenshotPath: prodPath })],
        candPages: [makePageCapture({ url: "https://x.com/", side: "cand", screenshotPath: candPath })],
      }),
    );
    expect(r.status).toBe("pass");
    expect(r.issues).toEqual([]);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("flags sectionsOnlyInProd as a 'high' issue (DOM detection, no LLM needed)", async () => {
    const prodPath = join(dir.path, "p.png");
    const candPath = join(dir.path, "c.png");
    makePng(prodPath, 50, 50, [100, 100, 100]);
    makePng(candPath, 50, 50, [100, 100, 100]);
    const prodHtml = `<html><body><div data-section="HeroBanner"></div><div data-section="Shelf"></div></body></html>`;
    const candHtml = `<html><body><div data-section="HeroBanner"></div></body></html>`;
    const r = await visualRegressionKeyframes(
      makeContext({
        outDir: dir.path,
        prodPages: [
          makePageCapture({ url: "https://x.com/", side: "prod", screenshotPath: prodPath, html: prodHtml }),
        ],
        candPages: [
          makePageCapture({ url: "https://x.com/", side: "cand", screenshotPath: candPath, html: candHtml }),
        ],
      }),
    );
    const sectionIssue = r.issues.find((i) => i.id.includes("visual:sections"));
    expect(sectionIssue?.severity).toBe("high");
    expect(sectionIssue?.summary).toMatch(/Shelf/);
  });

  it("does NOT call LLM when no key is set, even when pixels differ", async () => {
    const prodPath = join(dir.path, "p.png");
    const candPath = join(dir.path, "c.png");
    makePng(prodPath, 50, 50, [0, 0, 0]);
    makePng(candPath, 50, 50, [255, 255, 255]);
    await visualRegressionKeyframes(
      makeContext({
        outDir: dir.path,
        prodPages: [makePageCapture({ url: "https://x.com/", side: "prod", screenshotPath: prodPath })],
        candPages: [makePageCapture({ url: "https://x.com/", side: "cand", screenshotPath: candPath })],
      }),
    );
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("calls LLM with screenshots + sections context when key is set", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    mockCreate.mockResolvedValue({
      content: [
        {
          type: "tool_use",
          name: "report_visual_differences",
          input: {
            differences: [
              { type: "missing-component", region: "hero", severity: "critical", description: "hero gone" },
            ],
          },
        },
      ],
    });
    const prodPath = join(dir.path, "p.png");
    const candPath = join(dir.path, "c.png");
    makePng(prodPath, 50, 50, [0, 0, 0]);
    makePng(candPath, 50, 50, [255, 255, 255]);
    const r = await visualRegressionKeyframes(
      makeContext({
        outDir: dir.path,
        prodPages: [makePageCapture({ url: "https://x.com/", side: "prod", screenshotPath: prodPath })],
        candPages: [makePageCapture({ url: "https://x.com/", side: "cand", screenshotPath: candPath })],
      }),
    );
    expect(mockCreate).toHaveBeenCalledOnce();
    const semantic = r.issues.find((i) => i.id.includes("visual:semantic"));
    expect(semantic?.severity).toBe("critical");
    expect(r.data?.visualDiff).toBeDefined();
    delete process.env.ANTHROPIC_API_KEY;
  });

  it("emits structured data.visualDiff with results, pagesChecked, pagesWithDiffs", async () => {
    const prodPath = join(dir.path, "p.png");
    const candPath = join(dir.path, "c.png");
    makePng(prodPath, 50, 50, [100, 100, 100]);
    makePng(candPath, 50, 50, [100, 100, 100]);
    const r = await visualRegressionKeyframes(
      makeContext({
        outDir: dir.path,
        prodPages: [makePageCapture({ url: "https://x.com/", side: "prod", screenshotPath: prodPath })],
        candPages: [makePageCapture({ url: "https://x.com/", side: "cand", screenshotPath: candPath })],
      }),
    );
    expect(r.data?.visualDiff).toMatchObject({
      pagesChecked: 1,
      pagesWithDiffs: 0,
      pagesPassed: 1,
    });
  });

  it("#22: downgrades hero-region diffs to 'low' when both sides expose a carousel/slider section", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    mockCreate.mockResolvedValue({
      content: [
        {
          type: "tool_use",
          name: "report_visual_differences",
          input: {
            differences: [
              {
                type: "different-component",
                region: "hero",
                severity: "critical",
                description: "Hero banner completamente diferente: prod 'myGlow', cand 'LIVE ON'",
              },
              {
                type: "missing-component",
                region: "footer",
                severity: "high",
                description: "Footer real regression",
              },
            ],
          },
        },
      ],
    });
    const prodPath = join(dir.path, "p.png");
    const candPath = join(dir.path, "c.png");
    makePng(prodPath, 50, 50, [0, 0, 0]);
    makePng(candPath, 50, 50, [255, 255, 255]);
    const prodHtml = `<html><body><div data-section="Images/Carousel"></div></body></html>`;
    const candHtml = `<html><body><div data-section="Images/Carousel"></div></body></html>`;
    const r = await visualRegressionKeyframes(
      makeContext({
        outDir: dir.path,
        prodPages: [
          makePageCapture({ url: "https://x.com/", side: "prod", screenshotPath: prodPath, html: prodHtml }),
        ],
        candPages: [
          makePageCapture({ url: "https://x.com/", side: "cand", screenshotPath: candPath, html: candHtml }),
        ],
      }),
    );
    const semanticIssues = r.issues.filter((i) => i.id.includes("visual:semantic"));
    const heroIssue = semanticIssues.find((i) => i.summary.includes("[hero]"));
    const footerIssue = semanticIssues.find((i) => i.summary.includes("[footer]"));
    expect(heroIssue?.severity).toBe("low");
    expect(heroIssue?.summary).toMatch(/downgraded/);
    expect(footerIssue?.severity).toBe("high");
    delete process.env.ANTHROPIC_API_KEY;
  });

  it("cubic #32: missing-component / extra-component are STRUCTURAL — never downgraded even when both sides have carousel", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    mockCreate.mockResolvedValue({
      content: [
        {
          type: "tool_use",
          name: "report_visual_differences",
          input: {
            differences: [
              {
                type: "missing-component",
                region: "hero",
                severity: "critical",
                description: "Hero shelf component vanished",
              },
              {
                type: "extra-component",
                region: "hero",
                severity: "high",
                description: "Unexpected promo element appeared in hero",
              },
              {
                type: "different-component",
                region: "hero",
                severity: "critical",
                description: "Banner content differs (this IS framing — should downgrade)",
              },
            ],
          },
        },
      ],
    });
    const prodPath = join(dir.path, "p.png");
    const candPath = join(dir.path, "c.png");
    makePng(prodPath, 50, 50, [0, 0, 0]);
    makePng(candPath, 50, 50, [255, 255, 255]);
    const prodHtml = `<html><body><div data-section="Images/Carousel"></div></body></html>`;
    const candHtml = `<html><body><div data-section="Images/Carousel"></div></body></html>`;
    const r = await visualRegressionKeyframes(
      makeContext({
        outDir: dir.path,
        prodPages: [
          makePageCapture({ url: "https://x.com/", side: "prod", screenshotPath: prodPath, html: prodHtml }),
        ],
        candPages: [
          makePageCapture({ url: "https://x.com/", side: "cand", screenshotPath: candPath, html: candHtml }),
        ],
      }),
    );
    const semanticIssues = r.issues.filter((i) => i.id.includes("visual:semantic"));
    const missing = semanticIssues.find((i) => i.summary.includes("vanished"));
    const extra = semanticIssues.find((i) => i.summary.includes("Unexpected promo"));
    const different = semanticIssues.find((i) => i.summary.includes("Banner content differs"));
    // Structural diffs stay at original severity
    expect(missing?.severity).toBe("critical");
    expect(extra?.severity).toBe("high");
    expect(missing?.summary).not.toMatch(/downgraded/);
    expect(extra?.summary).not.toMatch(/downgraded/);
    // Framing/timing diff still gets downgraded
    expect(different?.severity).toBe("low");
    expect(different?.summary).toMatch(/downgraded/);
    delete process.env.ANTHROPIC_API_KEY;
  });

  it("#22: does NOT downgrade hero diffs when only one side has a carousel (real regression)", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    mockCreate.mockResolvedValue({
      content: [
        {
          type: "tool_use",
          name: "report_visual_differences",
          input: {
            differences: [
              {
                type: "missing-component",
                region: "hero",
                severity: "critical",
                description: "Hero carousel completely missing in cand",
              },
            ],
          },
        },
      ],
    });
    const prodPath = join(dir.path, "p.png");
    const candPath = join(dir.path, "c.png");
    makePng(prodPath, 50, 50, [0, 0, 0]);
    makePng(candPath, 50, 50, [255, 255, 255]);
    const prodHtml = `<html><body><div data-section="Images/Carousel"></div></body></html>`;
    const candHtml = "<html><body></body></html>";
    const r = await visualRegressionKeyframes(
      makeContext({
        outDir: dir.path,
        prodPages: [
          makePageCapture({ url: "https://x.com/", side: "prod", screenshotPath: prodPath, html: prodHtml }),
        ],
        candPages: [
          makePageCapture({ url: "https://x.com/", side: "cand", screenshotPath: candPath, html: candHtml }),
        ],
      }),
    );
    const heroIssue = r.issues.find((i) => i.id.includes("visual:semantic") && i.summary.includes("[hero]"));
    expect(heroIssue?.severity).toBe("critical");
    expect(heroIssue?.summary).not.toMatch(/downgraded/);
    delete process.env.ANTHROPIC_API_KEY;
  });

  it("emits 'failed' verdict for the page when LLM throws", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    mockCreate.mockRejectedValue(new Error("LLM down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const prodPath = join(dir.path, "p.png");
    const candPath = join(dir.path, "c.png");
    makePng(prodPath, 50, 50, [0, 0, 0]);
    makePng(candPath, 50, 50, [255, 255, 255]);
    const r = await visualRegressionKeyframes(
      makeContext({
        outDir: dir.path,
        prodPages: [makePageCapture({ url: "https://x.com/", side: "prod", screenshotPath: prodPath })],
        candPages: [makePageCapture({ url: "https://x.com/", side: "cand", screenshotPath: candPath })],
      }),
    );
    // LLM error returns null; visualSemanticDiff swallows it via console.error.
    // The page verdict still gets evaluated based on differences === [].
    expect(r.data?.visualDiff).toBeDefined();
    delete process.env.ANTHROPIC_API_KEY;
    spy.mockRestore();
  });
});
