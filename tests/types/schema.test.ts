import { describe, expect, it } from "vitest";
import {
  Issue,
  Run,
  SeoSummary,
  VisualDiffSummary,
} from "../../src/types/schema.ts";

describe("Issue schema", () => {
  it("accepts a minimal issue", () => {
    const i = Issue.parse({
      id: "x",
      severity: "high",
      category: "seo",
      check: "demo",
      summary: "broken",
    });
    expect(i.id).toBe("x");
    expect(i.severity).toBe("high");
  });

  it("rejects unknown severity", () => {
    expect(() =>
      Issue.parse({ id: "x", severity: "extreme", category: "seo", check: "d", summary: "s" }),
    ).toThrow();
  });

  it("accepts optional evidence list", () => {
    const i = Issue.parse({
      id: "x",
      severity: "low",
      category: "visual",
      check: "v",
      summary: "s",
      evidence: [{ kind: "screenshot", path: "/x.png" }],
    });
    expect(i.evidence?.length).toBe(1);
  });
});

describe("VisualDiffSummary schema", () => {
  it("roundtrips through JSON.stringify", () => {
    const s = VisualDiffSummary.parse({
      results: [],
      pagesChecked: 0,
      pagesWithDiffs: 0,
      pagesPassed: 0,
      pagesFailed: 0,
      llmCallsUsed: 0,
      parityOk: true,
      pagesFromCache: 0,
    });
    const json = JSON.stringify(s);
    const back = VisualDiffSummary.parse(JSON.parse(json));
    expect(back.pagesChecked).toBe(0);
    expect(back.parityOk).toBe(true);
    expect(back.pagesFromCache).toBe(0);
  });
});

describe("SeoSummary schema", () => {
  it("accepts an empty SEO summary", () => {
    const s = SeoSummary.parse({
      pages: [],
      robotsTxt: {
        prodPresent: false,
        candPresent: false,
        prodSitemaps: [],
        candSitemaps: [],
        uaDiffCount: 0,
      },
      sitemap: {
        prodPresent: false,
        candPresent: false,
        prodCount: 0,
        candCount: 0,
        countDelta: 0,
        countPct: 0,
        onlyProdSample: [],
        onlyCandSample: [],
      },
      issues: [],
      pagesWithIssues: 0,
    });
    expect(s.pages).toEqual([]);
  });

  it("roundtrips with a full page entry through JSON", () => {
    const s = SeoSummary.parse({
      pages: [
        {
          pageKey: "/::mobile",
          pageLabel: "Home · mobile",
          prodTitle: "x",
          candTitle: "y",
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
          maxSeverity: null,
          issueCount: 0,
        },
      ],
      robotsTxt: { prodPresent: true, candPresent: true, prodSitemaps: [], candSitemaps: [], uaDiffCount: 0 },
      sitemap: {
        prodPresent: true,
        candPresent: true,
        prodCount: 10,
        candCount: 10,
        countDelta: 0,
        countPct: 0,
        onlyProdSample: [],
        onlyCandSample: [],
      },
      issues: [],
      pagesWithIssues: 0,
    });
    const back = SeoSummary.parse(JSON.parse(JSON.stringify(s)));
    expect(back.pages[0]?.pageKey).toBe("/::mobile");
  });
});

describe("Run schema", () => {
  it("accepts a minimal Run with all required fields", () => {
    const r = Run.parse({
      schemaVersion: "0.1",
      id: "test",
      timestamp: "2026-01-01T00:00:00Z",
      prodUrl: "https://a",
      candUrl: "https://b",
      flows: ["homepage"],
      viewports: ["mobile"],
      cep: "01310-100",
      durationMs: 1000,
      verdict: {
        status: "pass",
        score: 100,
        critical: 0,
        high: 0,
        medium: 0,
        low: 0,
        checksRun: 0,
        checksPassed: 0,
        checksFailed: 0,
        checksSkipped: 0,
      },
      topIssues: [],
      issues: [],
      checks: [],
      flowCaptures: [],
    });
    expect(r.id).toBe("test");
    expect(r.visualDiff).toBeUndefined();
    expect(r.seo).toBeUndefined();
  });

  it("schemaVersion must be the literal '0.1'", () => {
    expect(() =>
      Run.parse({
        schemaVersion: "0.2",
        id: "x",
        timestamp: "",
        prodUrl: "",
        candUrl: "",
        flows: [],
        viewports: [],
        cep: "",
        durationMs: 0,
        verdict: { status: "pass", score: 0, critical: 0, high: 0, medium: 0, low: 0, checksRun: 0, checksPassed: 0, checksFailed: 0, checksSkipped: 0 },
        topIssues: [],
        issues: [],
        checks: [],
        flowCaptures: [],
      }),
    ).toThrow();
  });

  it("bug #29: xRobotsTag nullable+optional roundtrips through JSON", () => {
    // PageCapture in flowCaptures has xRobotsTag: string|null|undefined. JSON.stringify drops undefined,
    // and parse must accept both shapes.
    const r = Run.parse({
      schemaVersion: "0.1",
      id: "t",
      timestamp: "",
      prodUrl: "",
      candUrl: "",
      flows: [],
      viewports: [],
      cep: "",
      durationMs: 0,
      verdict: { status: "pass", score: 0, critical: 0, high: 0, medium: 0, low: 0, checksRun: 0, checksPassed: 0, checksFailed: 0, checksSkipped: 0 },
      topIssues: [],
      issues: [],
      checks: [],
      flowCaptures: [
        {
          flow: "homepage",
          side: "prod",
          viewport: "mobile",
          totalDurationMs: 0,
          pages: [
            {
              url: "/",
              finalUrl: "/",
              status: 200,
              viewport: "mobile",
              side: "prod",
              durationMs: 0,
              html: "",
              vitals: { lcp: null, cls: null, fcp: null, ttfb: null, inp: null },
              console: [],
              network: [],
              screenshotPath: "",
              // xRobotsTag intentionally omitted
            },
          ],
        },
      ],
    });
    expect(JSON.parse(JSON.stringify(r)).flowCaptures[0].pages[0].xRobotsTag).toBeUndefined();
  });
});
