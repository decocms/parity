import { describe, expect, it } from "vitest";
import { renderHtmlReport } from "../../src/report/render.ts";
import type { CheckResult, Issue, Run, SeoSummary, VisualDiffSummary } from "../../src/types/schema.ts";
import { makeIssue, makeRun } from "../helpers/make-run.ts";

function makeCheck(over: Partial<CheckResult> = {}): CheckResult {
  return {
    name: "demo",
    status: "pass",
    severity: "high",
    durationMs: 100,
    summary: "ok",
    issues: [],
    ...over,
  };
}

describe("renderHtmlReport — structure", () => {
  it("returns a full HTML document with sidebar nav and panels", () => {
    const html = renderHtmlReport(makeRun(), "/tmp/run");
    expect(html).toMatch(/^<!DOCTYPE html>/);
    expect(html).toMatch(/<html lang="en"/);
    expect(html).toMatch(/<aside class="app-sidebar"/);
    expect(html).toMatch(/<main class="app-main"/);
    expect(html).toMatch(/<\/html>$/);
  });

  it("includes the always-visible navigation tabs", () => {
    const html = renderHtmlReport(makeRun(), "/tmp/run");
    // Default makeRun() has no LLM output and no baseline, so:
    //   - "diff" is conditional on baseline (Issue #68) → absent
    //   - "visualdiff" / "prompt" are LLM-only (Issue #75) → absent
    const tabs = ["summary", "seo", "sidebyside", "issues", "vitals", "cache", "checks", "pages", "console", "network"];
    for (const tab of tabs) {
      expect(html).toContain(`data-tab="${tab}"`);
      expect(html).toContain(`data-panel="${tab}"`);
    }
    expect(html).not.toContain('data-tab="diff"');
    expect(html).not.toContain('data-panel="diff"');
    expect(html).not.toContain('data-tab="visualdiff"');
    expect(html).not.toContain('data-tab="prompt"');
    expect(html).toContain("LLM disabled");
  });

  it("renders the health score from verdict", () => {
    const html = renderHtmlReport(
      makeRun({
        verdict: {
          status: "fail",
          score: 42,
          critical: 3,
          high: 1,
          medium: 0,
          low: 0,
          checksRun: 5,
          checksPassed: 1,
          checksFailed: 3,
          checksSkipped: 1,
        },
      }),
      "/tmp/run",
    );
    expect(html).toContain("42");
    expect(html).toMatch(/Critical/);
  });

  it("renders top issues with severity classes", () => {
    const issue: Issue = makeIssue({
      id: "x",
      severity: "critical",
      summary: "VERY-BAD-THING",
      details: "what happened",
    });
    const html = renderHtmlReport(makeRun({ topIssues: [issue], issues: [issue] }), "/tmp/run");
    expect(html).toContain("VERY-BAD-THING");
    expect(html).toContain("sev-critical");
  });

  it("renders Visual Diff tab content when run.visualDiff is present", () => {
    const visualDiff: VisualDiffSummary = {
      pagesChecked: 1,
      pagesWithDiffs: 1,
      pagesPassed: 0,
      pagesFailed: 0,
      llmCallsUsed: 1,
      parityOk: false,
      pagesFromCache: 0,
      results: [
        {
          pageKey: "/::mobile",
          pagePath: "/",
          pageLabel: "Home · mobile",
          viewport: "mobile",
          prodUrl: "https://prod/",
          candUrl: "https://cand/",
          prodScreenshotPath: "/tmp/run/screenshots/prod.png",
          candScreenshotPath: "/tmp/run/screenshots/cand.png",
          heatmapPath: "/tmp/run/screenshots/heat.png",
          pctDiff: 0.1,
          verdict: "diffs",
          prodSections: ["Hero"],
          candSections: [],
          sectionsOnlyInProd: ["Hero"],
          sectionsOnlyInCand: [],
          differences: [
            { type: "missing-component", region: "hero", severity: "critical", description: "missing" },
          ],
          llmCalled: true,
        },
      ],
    };
    const html = renderHtmlReport(makeRun({ visualDiff }), "/tmp/run");
    expect(html).toContain("Home · mobile");
    expect(html).toMatch(/missing/);
    expect(html).toContain("vd-gallery");
    // sections-only-in-prod block
    expect(html).toMatch(/MISSING in cand/);
  });

  it("renders SEO tab with cards when run.seo is present", () => {
    const seo: SeoSummary = {
      pages: [
        {
          pageKey: "/::mobile",
          pageLabel: "Home · mobile",
          prodTitle: "PT",
          candTitle: "CT",
          prodDescription: null,
          candDescription: null,
          prodCanonical: null,
          candCanonical: null,
          prodRobots: null,
          candRobots: null,
          prodXRobotsTag: null,
          candXRobotsTag: null,
          prodJsonLdTypes: [],
          candJsonLdTypes: [],
          maxSeverity: "high",
          issueCount: 1,
        },
      ],
      robotsTxt: {
        prodPresent: true,
        candPresent: false,
        prodSitemaps: ["https://x/s.xml"],
        candSitemaps: [],
        uaDiffCount: 0,
      },
      sitemap: {
        prodPresent: true,
        candPresent: false,
        prodCount: 100,
        candCount: 0,
        countDelta: -100,
        countPct: -1,
        onlyProdSample: ["https://x/a"],
        onlyCandSample: [],
      },
      issues: [
        makeIssue({ id: "seo:1", category: "seo", severity: "high", summary: "title diverges" }),
      ],
      pagesWithIssues: 1,
    };
    const html = renderHtmlReport(makeRun({ seo }), "/tmp/run");
    expect(html).toContain("robots.txt");
    expect(html).toContain("sitemap.xml");
    expect(html).toContain("title diverges");
  });

  it("renders the LLM prompt panel with copy button when LLM ran", () => {
    // The Prompt tab is now LLM-only (Issue #75) — it shows only when at
    // least one visualDiff result was produced by an actual LLM call.
    const html = renderHtmlReport(
      makeRun({
        visualDiff: {
          pagesChecked: 1,
          pagesWithDiffs: 0,
          pagesPassed: 1,
          pagesFailed: 0,
          llmCallsUsed: 1,
          parityOk: true,
          pagesFromCache: 0,
          results: [
            {
              pageKey: "/::mobile",
              pagePath: "/",
              pageLabel: "Home · mobile",
              viewport: "mobile",
              prodUrl: "https://prod/",
              candUrl: "https://cand/",
              prodScreenshotPath: "/tmp/run/p.png",
              candScreenshotPath: "/tmp/run/c.png",
              heatmapPath: undefined,
              pctDiff: 0,
              verdict: "pass",
              prodSections: [],
              candSections: [],
              sectionsOnlyInProd: [],
              sectionsOnlyInCand: [],
              differences: [],
              llmCalled: true,
            },
          ],
        },
      }),
      "/tmp/run",
    );
    expect(html).toContain("LLM prompt");
    expect(html).toMatch(/prompt-copy/);
    expect(html).toMatch(/prompt-download/);
    expect(html).toContain('data-tab="prompt"');
  });

  it("renders checks table from run.checks", () => {
    const html = renderHtmlReport(
      makeRun({
        checks: [
          makeCheck({ name: "x-check", status: "pass", summary: "all good" }),
          makeCheck({ name: "y-check", status: "fail", summary: "broken" }),
        ],
      }),
      "/tmp/run",
    );
    expect(html).toContain("x-check");
    expect(html).toContain("y-check");
    expect(html).toContain("all good");
    expect(html).toContain("broken");
  });

  it("hides the visual-diff tab entirely when no LLM ran (Issue #75)", () => {
    const html = renderHtmlReport(makeRun(), "/tmp/run");
    // No LLM output → tab + panel both omitted, banner explains why
    expect(html).not.toContain('data-tab="visualdiff"');
    expect(html).not.toContain('data-panel="visualdiff"');
    expect(html).toContain("LLM disabled");
    expect(html).toContain("tabs hidden");
  });

  it("escapes HTML in user-supplied strings to prevent injection", () => {
    const html = renderHtmlReport(
      makeRun({
        issues: [
          makeIssue({
            id: "xss",
            summary: "<script>alert(1)</script>",
            details: "<img src=x onerror=alert(1)>",
          }),
        ],
        topIssues: [
          makeIssue({
            id: "xss",
            summary: "<script>alert(1)</script>",
            details: "<img src=x onerror=alert(1)>",
          }),
        ],
      }),
      "/tmp/run",
    );
    // Critical: the literal <script> tag should be escaped, not present as a real tag
    expect(html).not.toMatch(/<script>alert\(1\)<\/script>/);
    expect(html).toContain("&lt;script&gt;");
  });

  it("includes baseline delta panel when run.baseline is present", () => {
    const html = renderHtmlReport(
      makeRun({
        baseline: {
          name: "stable",
          delta: {
            resolved: [makeIssue({ id: "r1", summary: "resolved-issue" })],
            new: [makeIssue({ id: "n1", summary: "new-issue" })],
            regressions: [makeIssue({ id: "g1", summary: "regression-issue" })],
          },
        },
      }),
      "/tmp/run",
    );
    expect(html).toContain("stable");
    expect(html).toContain("new-issue");
    expect(html).toContain("regression-issue");
  });

  // Regression guard for Issue #67. If a future change adds Portuguese copy
  // to render.ts, the diacritic scan catches it; the deny-list catches
  // PT-BR strings that happen to have no accents. Keep both — diacritics
  // alone wouldn't have caught "Prompt para LLM" / "Copiar markdown".
  it("has no Portuguese-only diacritics in the rendered HTML", () => {
    const html = renderHtmlReport(makeRun(), "/tmp/run");
    const hits = html.match(/[áéíóúâêîôûãõçÁÉÍÓÚÂÊÎÔÛÃÕÇ]/g);
    expect(hits, `unexpected diacritics in report HTML: ${hits?.slice(0, 5).join(" ")}`).toBeNull();
  });

  it("has no untranslated PT-BR substrings in the rendered HTML", () => {
    const html = renderHtmlReport(makeRun(), "/tmp/run");
    const banned = [
      "Páginas",
      "Atalhos",
      "Copiar",
      "Fechar",
      "Coleta",
      "carregando",
      "Prompt para LLM",
      "Pronto pra",
    ];
    for (const word of banned) {
      expect(html, `unexpected PT-BR token "${word}" in report HTML`).not.toContain(word);
    }
  });
});
