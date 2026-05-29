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

  it("emits visualDiff.parityOk=true when every page passes", async () => {
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
    const vd = r.data?.visualDiff as { parityOk: boolean; pagesFromCache: number };
    expect(vd.parityOk).toBe(true);
    expect(vd.pagesFromCache).toBe(0);
  });

  it("emits visualDiff.parityOk=false when any page has diffs", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    mockCreate.mockResolvedValue({
      content: [
        {
          type: "tool_use",
          name: "report_visual_differences",
          input: {
            differences: [
              { type: "missing-component", region: "main", severity: "critical", description: "x" },
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
    const vd = r.data?.visualDiff as { parityOk: boolean };
    expect(vd.parityOk).toBe(false);
    delete process.env.ANTHROPIC_API_KEY;
  });

  it("falls back to 'diffs' verdict when LLM skipped + pctDiff is meaningfully high (no false OK)", async () => {
    // Simulate the budget-cap bug: high pctDiff, no LLM call, no section
    // drift. Old behavior would return verdict="pass". New behavior should
    // surface this as "diffs" since we don't have a semantic read.
    process.env.PARITY_MAX_LLM_CALLS = "0"; // force budget exhaustion
    process.env.ANTHROPIC_API_KEY = "sk-test"; // LLM available but capped
    const prodPath = join(dir.path, "p.png");
    const candPath = join(dir.path, "c.png");
    makePng(prodPath, 50, 50, [0, 0, 0]);
    makePng(candPath, 50, 50, [255, 255, 255]); // ~100% pctDiff
    const r = await visualRegressionKeyframes(
      makeContext({
        outDir: dir.path,
        prodPages: [makePageCapture({ url: "https://x.com/account", side: "prod", screenshotPath: prodPath })],
        candPages: [makePageCapture({ url: "https://x.com/account", side: "cand", screenshotPath: candPath })],
      }),
    );
    const vd = r.data?.visualDiff as {
      parityOk: boolean;
      results: Array<{ verdict: string; llmCalled: boolean; pctDiff: number }>;
    };
    expect(vd.results[0]?.llmCalled).toBe(false);
    expect(vd.results[0]?.pctDiff).toBeGreaterThan(0.5);
    expect(vd.results[0]?.verdict).toBe("diffs");
    expect(vd.parityOk).toBe(false);
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.PARITY_MAX_LLM_CALLS;
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("passes heatmap as 3rd image to the LLM when heatmap was written", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    mockCreate.mockResolvedValue({
      content: [
        {
          type: "tool_use",
          name: "report_visual_differences",
          input: { differences: [] },
        },
      ],
    });
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
    expect(mockCreate).toHaveBeenCalledOnce();
    const callArgs = mockCreate.mock.calls[0]?.[0];
    const userMessage = callArgs?.messages?.[0]?.content;
    const imageBlocks = (userMessage as Array<{ type: string }>)?.filter(
      (block) => block.type === "image",
    );
    expect(imageBlocks?.length).toBe(3); // prod + cand + heatmap
    delete process.env.ANTHROPIC_API_KEY;
  });

  it("uses cached verdict on second run with identical screenshots (no LLM call)", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    mockCreate.mockResolvedValue({
      content: [
        {
          type: "tool_use",
          name: "report_visual_differences",
          input: { differences: [] }, // first run finds no diffs, caches pass
        },
      ],
    });
    const prodPath = join(dir.path, "p.png");
    const candPath = join(dir.path, "c.png");
    makePng(prodPath, 50, 50, [0, 0, 0]);
    makePng(candPath, 50, 50, [255, 255, 255]); // forces LLM (pctDiff above trivial)
    const cacheDir = join(dir.path, "cache");

    const r1 = await visualRegressionKeyframes(
      makeContext({
        outDir: dir.path,
        cacheDir,
        prodPages: [makePageCapture({ url: "https://x.com/", side: "prod", screenshotPath: prodPath })],
        candPages: [makePageCapture({ url: "https://x.com/", side: "cand", screenshotPath: candPath })],
      }),
    );
    const vd1 = r1.data?.visualDiff as { llmCallsUsed: number; pagesFromCache: number };
    expect(vd1.llmCallsUsed).toBe(1);
    expect(vd1.pagesFromCache).toBe(0);

    // Reset the mock spy; if the cache works the 2nd run must NOT hit it.
    mockCreate.mockClear();

    const r2 = await visualRegressionKeyframes(
      makeContext({
        outDir: dir.path,
        cacheDir,
        prodPages: [makePageCapture({ url: "https://x.com/", side: "prod", screenshotPath: prodPath })],
        candPages: [makePageCapture({ url: "https://x.com/", side: "cand", screenshotPath: candPath })],
      }),
    );
    const vd2 = r2.data?.visualDiff as {
      llmCallsUsed: number;
      pagesFromCache: number;
      results: Array<{ cachedAt?: string; verdict: string }>;
    };
    expect(vd2.llmCallsUsed).toBe(0);
    expect(vd2.pagesFromCache).toBe(1);
    expect(vd2.results[0]?.cachedAt).toBeDefined();
    expect(vd2.results[0]?.verdict).toBe("pass");
    expect(mockCreate).not.toHaveBeenCalled();
    delete process.env.ANTHROPIC_API_KEY;
  });

  it("downgrades skeleton-vs-loaded diffs to 'low' when one side has many skeletons and LLM flagged them as missing/different", async () => {
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
                region: "shelf",
                severity: "critical",
                description: "Product shelf shows only gray skeleton placeholder cards in cand while prod has fully loaded products",
              },
              {
                type: "missing-component",
                region: "footer",
                severity: "high",
                description: "Footer 'About Us' navigation block is absent in cand — entire <ul> markup removed",
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
    // Imbalanced skeletons: cand has 8 skeletons, prod has none
    const prodHtml = "<html><body><div data-section='Shelf'><div class='product'>real product</div></div></body></html>";
    const candHtml = `<html><body><div data-section='Shelf'>${"<div class='skeleton'></div>".repeat(8)}</div></body></html>`;
    const r = await visualRegressionKeyframes(
      makeContext({
        outDir: dir.path,
        prodPages: [makePageCapture({ url: "https://x.com/", side: "prod", screenshotPath: prodPath, html: prodHtml })],
        candPages: [makePageCapture({ url: "https://x.com/", side: "cand", screenshotPath: candPath, html: candHtml })],
      }),
    );
    const semantic = r.issues.filter((i) => i.id.includes("visual:semantic"));
    const shelfIssue = semantic.find((i) => i.summary.includes("[shelf]"));
    const footerIssue = semantic.find((i) => i.summary.includes("[footer]"));
    // shelf diff matches skeleton wording → downgraded to low
    expect(shelfIssue?.severity).toBe("low");
    expect(shelfIssue?.summary).toMatch(/skeleton-vs-loaded/);
    // footer diff is unrelated → keeps original severity
    expect(footerIssue?.severity).toBe("high");
    expect(footerIssue?.summary).not.toMatch(/downgraded/);
    delete process.env.ANTHROPIC_API_KEY;
  });

  it("does NOT downgrade when skeleton imbalance is below threshold (1-2 baseline skeletons are noise)", async () => {
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
                region: "shelf",
                severity: "critical",
                description: "Product shelf section is showing skeleton loaders in cand",
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
    // Only 2-skeleton imbalance: under the 5 threshold, should NOT downgrade
    const prodHtml = "<html><body><div class='skeleton'></div></body></html>";
    const candHtml = "<html><body><div class='skeleton'></div><div class='skeleton'></div><div class='skeleton'></div></body></html>";
    const r = await visualRegressionKeyframes(
      makeContext({
        outDir: dir.path,
        prodPages: [makePageCapture({ url: "https://x.com/", side: "prod", screenshotPath: prodPath, html: prodHtml })],
        candPages: [makePageCapture({ url: "https://x.com/", side: "cand", screenshotPath: candPath, html: candHtml })],
      }),
    );
    const shelfIssue = r.issues.find((i) => i.id.includes("visual:semantic") && i.summary.includes("[shelf]"));
    expect(shelfIssue?.severity).toBe("critical"); // unchanged
    expect(shelfIssue?.summary).not.toMatch(/downgraded/);
    delete process.env.ANTHROPIC_API_KEY;
  });

  it("noCache=true bypasses cache and forces a fresh LLM call", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    mockCreate.mockResolvedValue({
      content: [
        { type: "tool_use", name: "report_visual_differences", input: { differences: [] } },
      ],
    });
    const prodPath = join(dir.path, "p.png");
    const candPath = join(dir.path, "c.png");
    makePng(prodPath, 50, 50, [0, 0, 0]);
    makePng(candPath, 50, 50, [255, 255, 255]);
    const cacheDir = join(dir.path, "cache");

    // Seed the cache with a first run
    await visualRegressionKeyframes(
      makeContext({
        outDir: dir.path,
        cacheDir,
        prodPages: [makePageCapture({ url: "https://x.com/", side: "prod", screenshotPath: prodPath })],
        candPages: [makePageCapture({ url: "https://x.com/", side: "cand", screenshotPath: candPath })],
      }),
    );
    mockCreate.mockClear();

    // Second run with noCache=true must ignore the seeded entry and call LLM again
    const r = await visualRegressionKeyframes(
      makeContext({
        outDir: dir.path,
        cacheDir,
        noCache: true,
        prodPages: [makePageCapture({ url: "https://x.com/", side: "prod", screenshotPath: prodPath })],
        candPages: [makePageCapture({ url: "https://x.com/", side: "cand", screenshotPath: candPath })],
      }),
    );
    const vd = r.data?.visualDiff as { llmCallsUsed: number; pagesFromCache: number };
    expect(mockCreate).toHaveBeenCalledOnce();
    expect(vd.llmCallsUsed).toBe(1);
    expect(vd.pagesFromCache).toBe(0);
    delete process.env.ANTHROPIC_API_KEY;
  });
});
