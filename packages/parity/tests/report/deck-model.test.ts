import { describe, expect, it } from "vitest";
import { buildDeckModel } from "../../src/report/deck-model.ts";
import type { Issue, Run } from "../../src/types/schema.ts";

function issue(over: Partial<Issue> = {}): Issue {
  return {
    id: "x",
    severity: "high",
    category: "visual",
    check: "c",
    summary: "algo divergiu",
    ...over,
  } as Issue;
}

function run(over: Partial<Run> = {}): Run {
  return {
    schemaVersion: "0.1",
    id: "2026-01-01T00-00-00-000Z",
    timestamp: "2026-01-01T00:00:00.000Z",
    prodUrl: "https://prod.example/",
    candUrl: "https://cand.example/",
    flows: [],
    viewports: ["mobile"],
    cep: "",
    durationMs: 1,
    verdict: {
      status: "fail",
      score: 57,
      critical: 2,
      high: 5,
      medium: 3,
      low: 1,
      checksRun: 34,
      checksPassed: 6,
      checksFailed: 9,
      checksSkipped: 13,
      pagesAnalyzed: 5,
    },
    topIssues: [],
    issues: [],
    checks: [],
    flowCaptures: [],
    ...over,
  } as unknown as Run;
}

describe("buildDeckModel (#289)", () => {
  it("carries the verdict into headline tiles, tone-coded", () => {
    const m = buildDeckModel(run());
    expect(m.headline.map((t) => t.value)).toEqual(["57/100", "2", "5", "6/34"]);
    expect(m.headline[0]?.tone).toBe("bad");
    expect(m.headline[0]?.label).toEqual({ pt: "score parity", en: "parity score" });
    expect(m.headline[1]?.label).toEqual({ pt: "critical", en: "critical" });
    expect(m.headline[3]?.sub).toEqual({ pt: "13 pulados", en: "13 skipped" });
  });

  it("says nothing about skipped checks when none were skipped", () => {
    const m = buildDeckModel(
      run({
        verdict: { ...run().verdict, checksSkipped: 0, checksFailed: 0 },
      } as Partial<Run>),
    );
    // null, not an empty string: the renderer omits the line entirely rather than drawing a blank.
    expect(m.headline[3]?.sub).toBeNull();
    expect(m.headline[3]?.tone).toBe("good");
  });

  it("prefers the run's ranked topIssues over the raw list", () => {
    const m = buildDeckModel(
      run({
        topIssues: [issue({ summary: "ranqueado" })],
        issues: [issue({ summary: "cru" }), issue({ summary: "outro cru" })],
      }),
    );
    expect(m.findings.map((f) => f.summary)).toEqual(["ranqueado"]);
  });

  it("falls back to the raw issues when nothing was ranked", () => {
    const m = buildDeckModel(run({ topIssues: [], issues: [issue({ summary: "cru" })] }));
    expect(m.findings.map((f) => f.summary)).toEqual(["cru"]);
  });

  it("sorts by severity, and puts a conclusive finding ahead of an inconclusive one", () => {
    const m = buildDeckModel(
      run({
        topIssues: [
          issue({ severity: "medium", summary: "medium" }),
          issue({ severity: "high", summary: "high inconclusivo", inconclusive: true }),
          issue({ severity: "high", summary: "high firme" }),
          issue({ severity: "critical", summary: "critical" }),
        ],
      }),
    );
    expect(m.findings.map((f) => f.summary)).toEqual([
      "critical",
      "high firme",
      "high inconclusivo",
      "medium",
    ]);
  });

  it("marks inconclusive findings so the renderer can label them instead of hiding them", () => {
    const m = buildDeckModel(run({ topIssues: [issue({ inconclusive: true })] }));
    expect(m.findings[0]?.inconclusive).toBe(true);
  });

  it("counts what the cap dropped instead of silently truncating", () => {
    const many = Array.from({ length: 20 }, (_, i) => issue({ summary: `f${i}` }));
    const m = buildDeckModel(run({ topIssues: many }));
    expect(m.findings).toHaveLength(12);
    expect(m.findingsOmitted).toBe(8);
  });

  it("reports no omissions when everything fits", () => {
    const m = buildDeckModel(run({ topIssues: [issue()] }));
    expect(m.findingsOmitted).toBe(0);
  });

  it("passes run caveats straight through", () => {
    const m = buildDeckModel(
      run({
        caveats: [
          { id: "cand-dev-server", level: "warn", summary: "dev server", detail: "não comparável" },
        ],
      }),
    );
    expect(m.caveats).toHaveLength(1);
    expect(m.caveats[0]?.id).toBe("cand-dev-server");
  });

  it("leaves visual null when the module did not run", () => {
    expect(buildDeckModel(run()).visual).toBeNull();
  });

  it("summarizes the visual module when it did run", () => {
    const m = buildDeckModel(
      run({
        visualDiff: {
          pagesChecked: 5,
          pagesPassed: 3,
          pagesWithDiffs: 2,
          pagesFailed: 0,
          parityOk: false,
          pagesFromCache: 0,
          llmCallsUsed: 5,
          results: [],
        },
      } as Partial<Run>),
    );
    expect(m.visual).toEqual({ pagesChecked: 5, pagesPassed: 3, pagesWithDiffs: 2 });
  });

  it("maps module verdicts with a tone", () => {
    const m = buildDeckModel(
      run({
        moduleVerdicts: [
          { module: "html", score: 62, status: "fail" },
          { module: "e2e", score: 100, status: "pass" },
        ],
      } as Partial<Run>),
    );
    expect(m.modules).toEqual([
      { module: "html", score: 62, status: "fail", tone: "bad" },
      { module: "e2e", score: 100, status: "pass", tone: "good" },
    ]);
  });
});
