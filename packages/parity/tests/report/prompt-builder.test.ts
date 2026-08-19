import { describe, expect, it } from "vitest";
import { buildLlmPrompt } from "../../src/report/prompt-builder.ts";
import { makeIssue, makeRun } from "../helpers/make-run.ts";

describe("buildLlmPrompt", () => {
  it("includes the run id and both URLs in the header", () => {
    const md = buildLlmPrompt(makeRun({ id: "abc-123" }));
    expect(md).toContain("abc-123");
    expect(md).toContain("https://prod.example.com");
    expect(md).toContain("https://cand.example.com");
  });

  it("renders verdict summary line", () => {
    const md = buildLlmPrompt(
      makeRun({
        verdict: {
          status: "fail",
          score: 42,
          critical: 2,
          high: 1,
          medium: 0,
          low: 0,
          checksRun: 5,
          checksPassed: 1,
          checksFailed: 3,
          checksSkipped: 1,
        },
      }),
    );
    expect(md).toContain("42/100");
    expect(md).toContain("FAIL");
    expect(md).toMatch(/2 critical/i);
  });

  it("uses topIssues when populated; falls back to issues otherwise", () => {
    const fromTop = buildLlmPrompt(
      makeRun({
        topIssues: [makeIssue({ id: "top-1", summary: "top issue" })],
        issues: [makeIssue({ id: "all-1", summary: "all issue" })],
      }),
    );
    expect(fromTop).toContain("top issue");
    expect(fromTop).not.toContain("all issue");

    const fromAll = buildLlmPrompt(
      makeRun({
        topIssues: [],
        issues: [makeIssue({ id: "all-1", summary: "fallback issue" })],
      }),
    );
    expect(fromAll).toContain("fallback issue");
  });

  it("sorts issues by severity (critical first)", () => {
    const md = buildLlmPrompt(
      makeRun({
        topIssues: [
          makeIssue({ id: "a", severity: "low", summary: "LOW-ISSUE" }),
          makeIssue({ id: "b", severity: "critical", summary: "CRIT-ISSUE" }),
          makeIssue({ id: "c", severity: "high", summary: "HIGH-ISSUE" }),
        ],
      }),
    );
    const idxCrit = md.indexOf("CRIT-ISSUE");
    const idxHigh = md.indexOf("HIGH-ISSUE");
    const idxLow = md.indexOf("LOW-ISSUE");
    expect(idxCrit).toBeGreaterThan(-1);
    expect(idxCrit).toBeLessThan(idxHigh);
    expect(idxHigh).toBeLessThan(idxLow);
  });

  it("respects minSeverity filter", () => {
    const md = buildLlmPrompt(
      makeRun({
        topIssues: [
          makeIssue({ id: "a", severity: "low", summary: "LOW-ITEM" }),
          makeIssue({ id: "b", severity: "high", summary: "HIGH-ITEM" }),
        ],
      }),
      { minSeverity: "high" },
    );
    expect(md).toContain("HIGH-ITEM");
    expect(md).not.toContain("LOW-ITEM");
  });

  it("respects limit cap", () => {
    const issues = Array.from({ length: 30 }, (_, i) =>
      makeIssue({ id: `i-${i}`, severity: "medium", summary: `SUMMARY-${i}` }),
    );
    const md = buildLlmPrompt(makeRun({ topIssues: issues }), { limit: 5 });
    expect(md).toContain("SUMMARY-0");
    expect(md).toContain("SUMMARY-4");
    expect(md).not.toContain("SUMMARY-5");
    expect(md).not.toContain("SUMMARY-29");
  });

  it("renders the empty-state line when no issues match filter", () => {
    const md = buildLlmPrompt(makeRun({ topIssues: [], issues: [] }));
    expect(md).toMatch(/no issues/i);
  });

  it("includes severity emoji per issue", () => {
    const md = buildLlmPrompt(
      makeRun({
        topIssues: [makeIssue({ severity: "critical", summary: "crit issue" })],
      }),
    );
    expect(md).toContain("🔴");
  });

  it("includes evidence paths when present", () => {
    const md = buildLlmPrompt(
      makeRun({
        topIssues: [
          makeIssue({
            summary: "with-evidence",
            evidence: [{ kind: "screenshot", path: "/tmp/x.png", label: "prod" }],
          }),
        ],
      }),
    );
    expect(md).toContain("/tmp/x.png");
    expect(md).toContain("prod");
  });

  it("includes fixed instruction footer with Fresh→TanStack hints", () => {
    const md = buildLlmPrompt(makeRun());
    expect(md).toMatch(/registerSections/);
    expect(md).toMatch(/useDevice/);
  });
});
