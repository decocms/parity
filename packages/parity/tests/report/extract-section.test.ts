import { describe, expect, it } from "vitest";
import { extractReportSection } from "../../src/report/extract-section.ts";
import { makeIssue, makeRun } from "../helpers/make-run.ts";

describe("extractReportSection — HTML mode", () => {
  it("returns the inner HTML of the requested data-panel block", () => {
    const html = `<html><body><section class="panel" data-panel="seo"><h2>SEO</h2><p>robots.txt</p></section><section class="panel" data-panel="checks"><h2>Checks</h2></section></body></html>`;
    const out = extractReportSection({ kind: "html", section: "seo", html });
    expect(out).toBe("<h2>SEO</h2><p>robots.txt</p>");
  });

  it("returns null when the requested section is absent", () => {
    const html = `<html><body><section class="panel" data-panel="seo">x</section></body></html>`;
    const out = extractReportSection({ kind: "html", section: "diff", html });
    expect(out).toBeNull();
  });

  it("matches single-quoted data-panel attributes too", () => {
    const html = `<section class='panel' data-panel='vitals'>v</section>`;
    const out = extractReportSection({ kind: "html", section: "vitals", html });
    expect(out).toBe("v");
  });
});

describe("extractReportSection — JSON mode", () => {
  it("returns a summary slice containing verdict and topIssues", () => {
    const issue = makeIssue({ id: "i1", summary: "the issue" });
    const run = makeRun({ topIssues: [issue], issues: [issue] });
    const out = extractReportSection({ kind: "json", section: "summary", run }) as Record<
      string,
      unknown
    >;
    expect(out.runId).toBe(run.id);
    expect(out.verdict).toEqual(run.verdict);
    expect((out.topIssues as unknown[]).length).toBe(1);
  });

  it("returns the issues list with count for the issues section", () => {
    const issues = [makeIssue({ id: "i1" }), makeIssue({ id: "i2" })];
    const run = makeRun({ issues });
    const out = extractReportSection({ kind: "json", section: "issues", run }) as {
      count: number;
      issues: unknown[];
    };
    expect(out.count).toBe(2);
    expect(out.issues.length).toBe(2);
  });

  it("returns null for diff when no baseline is loaded", () => {
    const run = makeRun();
    const out = extractReportSection({ kind: "json", section: "diff", run });
    expect(out).toBeNull();
  });

  it("returns the checks array projected to a compact shape", () => {
    const run = makeRun({
      checks: [
        {
          name: "demo",
          status: "pass",
          severity: "low",
          durationMs: 100,
          summary: "ok",
          issues: [],
        },
      ],
    });
    const out = extractReportSection({ kind: "json", section: "checks", run }) as Array<
      Record<string, unknown>
    >;
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      name: "demo",
      status: "pass",
      severity: "low",
      durationMs: 100,
      summary: "ok",
      issueCount: 0,
    });
  });
});
