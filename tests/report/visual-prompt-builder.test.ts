import { describe, expect, it } from "vitest";
import { buildVisualPrompt } from "../../src/report/visual-prompt-builder.ts";
import type { VisualDiffPage, VisualDiffSummary } from "../../src/types/schema.ts";
import { makeRun } from "../helpers/make-run.ts";

function makeVisualPage(over: Partial<VisualDiffPage> = {}): VisualDiffPage {
  return {
    pageKey: "/::mobile",
    pagePath: "/",
    pageLabel: "Home · mobile",
    viewport: "mobile",
    prodUrl: "https://prod/",
    candUrl: "https://cand/",
    prodScreenshotPath: "/tmp/run/screenshots/home-prod.png",
    candScreenshotPath: "/tmp/run/screenshots/home-cand.png",
    heatmapPath: "/tmp/run/screenshots/diff-home.png",
    pctDiff: 0.04,
    verdict: "diffs",
    prodSections: ["Hero", "Footer"],
    candSections: ["Footer"],
    sectionsOnlyInProd: ["Hero"],
    sectionsOnlyInCand: [],
    differences: [
      { type: "missing-component", region: "hero", severity: "critical", description: "hero missing" },
    ],
    llmCalled: true,
    ...over,
  };
}

function makeVisualDiff(over: Partial<VisualDiffSummary> = {}): VisualDiffSummary {
  return {
    pagesChecked: 1,
    pagesWithDiffs: 1,
    pagesPassed: 0,
    pagesFailed: 0,
    llmCallsUsed: 1,
    results: [makeVisualPage()],
    ...over,
  };
}

describe("buildVisualPrompt", () => {
  it("emits a fallback header when visualDiff is missing", () => {
    const md = buildVisualPrompt(makeRun(), "/tmp/run");
    expect(md).toMatch(/Visual Diff Report/);
    expect(md).toMatch(/Nenhuma comparação visual rodou/);
  });

  it("includes prod/cand URLs and run id", () => {
    const md = buildVisualPrompt(
      makeRun({ id: "run-xyz", visualDiff: makeVisualDiff() }),
      "/tmp/run",
    );
    expect(md).toContain("run-xyz");
    expect(md).toContain("https://prod.example.com");
    expect(md).toContain("https://cand.example.com");
  });

  it("renders sections-only-in-prod as priority context", () => {
    const md = buildVisualPrompt(makeRun({ visualDiff: makeVisualDiff() }), "/tmp/run");
    expect(md).toContain("Hero");
    expect(md).toMatch(/AUSENTES em cand/);
  });

  it("includes relative screenshot paths", () => {
    const md = buildVisualPrompt(makeRun({ visualDiff: makeVisualDiff() }), "/tmp/run");
    expect(md).toContain("screenshots/home-prod.png");
    expect(md).toContain("screenshots/home-cand.png");
    expect(md).toContain("screenshots/diff-home.png");
  });

  it("emits 'all passed' message when no page has diffs", () => {
    const md = buildVisualPrompt(
      makeRun({
        visualDiff: makeVisualDiff({
          results: [
            makeVisualPage({ verdict: "pass", differences: [], sectionsOnlyInProd: [] }),
          ],
          pagesWithDiffs: 0,
          pagesPassed: 1,
        }),
      }),
      "/tmp/run",
    );
    expect(md).toMatch(/Todas as páginas comparadas passaram/);
  });

  it("filters out pages below minSeverity", () => {
    const md = buildVisualPrompt(
      makeRun({
        visualDiff: makeVisualDiff({
          results: [
            makeVisualPage({
              pageKey: "/low::mobile",
              pageLabel: "Low · mobile",
              differences: [
                { type: "cosmetic", region: "footer", severity: "low", description: "tiny" },
              ],
              sectionsOnlyInProd: [],
            }),
            makeVisualPage({
              pageKey: "/crit::mobile",
              pageLabel: "Crit · mobile",
              differences: [
                { type: "missing-component", region: "hero", severity: "critical", description: "huge" },
              ],
              sectionsOnlyInProd: [],
            }),
          ],
        }),
      }),
      "/tmp/run",
      { minSeverity: "high" },
    );
    expect(md).toContain("Crit · mobile");
    expect(md).not.toContain("Low · mobile");
  });

  it("sorts pages: most severe first", () => {
    const md = buildVisualPrompt(
      makeRun({
        visualDiff: makeVisualDiff({
          results: [
            makeVisualPage({
              pageKey: "/medium::mobile",
              pageLabel: "MED-PAGE",
              differences: [
                { type: "text-changed", region: "main", severity: "medium", description: "x" },
              ],
              sectionsOnlyInProd: [],
            }),
            makeVisualPage({
              pageKey: "/critical::mobile",
              pageLabel: "CRIT-PAGE",
              differences: [
                { type: "missing-component", region: "hero", severity: "critical", description: "x" },
              ],
              sectionsOnlyInProd: [],
            }),
          ],
        }),
      }),
      "/tmp/run",
    );
    const idxCrit = md.indexOf("CRIT-PAGE");
    const idxMed = md.indexOf("MED-PAGE");
    expect(idxCrit).toBeGreaterThan(-1);
    expect(idxCrit).toBeLessThan(idxMed);
  });

  it("includes Fresh→TanStack instruction block at the end", () => {
    const md = buildVisualPrompt(makeRun({ visualDiff: makeVisualDiff() }), "/tmp/run");
    expect(md).toMatch(/registerSections/);
    expect(md).toMatch(/só sugira mudanças em cand/i);
  });
});
