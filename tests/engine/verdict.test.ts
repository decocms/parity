import { describe, expect, it } from "vitest";
import {
  FAIL_SCORE_CAP,
  SCORE_VERSION,
  computeCompositeVerdict,
  computeModuleVerdicts,
  computeScore,
  computeVerdict,
  derivePagesAnalyzed,
} from "../../src/engine/verdict.ts";
import type { CheckResult, Issue } from "../../src/types/schema.ts";
import { makeIssue } from "../helpers/make-run.ts";

function makeCheck(over: Partial<CheckResult> = {}): CheckResult {
  return {
    name: "demo-check",
    status: "pass",
    severity: "medium",
    durationMs: 10,
    summary: "demo",
    issues: [],
    ...over,
  };
}

/**
 * Issue mix shaped like the real granadobr migration run #1 (122 issues:
 * 18 critical / 50 high / 40 medium / 14 low) spread over 20 page-keys —
 * the workload where the old linear formula sat at score 0 for 15 runs.
 */
function granadobrFixture(): { issues: Issue[]; pages: number } {
  const pages = Array.from({ length: 20 }, (_, i) => `/page-${i}::mobile`);
  const issues: Issue[] = [];
  const push = (severity: Issue["severity"], count: number) => {
    for (let i = 0; i < count; i++) {
      issues.push(
        makeIssue({
          id: `${severity}-${i}`,
          severity,
          page: pages[issues.length % pages.length],
        }),
      );
    }
  };
  push("critical", 18);
  push("high", 50);
  push("medium", 40);
  push("low", 14);
  return { issues, pages: pages.length };
}

/** Deterministic shuffle (LCG) — random-ish removal order without flakiness. */
function shuffled<T>(items: T[], seed = 42): T[] {
  const arr = [...items];
  let s = seed;
  for (let i = arr.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) % 4294967296;
    const j = s % (i + 1);
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}

describe("computeScore", () => {
  it("clean run scores 100", () => {
    expect(computeScore([], { pagesAnalyzed: 20 }).score).toBe(100);
  });

  it("score is non-decreasing as issues are fixed one at a time (monotonicity)", () => {
    const { issues, pages } = granadobrFixture();
    let remaining = shuffled(issues);
    let prev = computeScore(remaining, { pagesAnalyzed: pages }).score;
    while (remaining.length > 0) {
      remaining = remaining.slice(1);
      const next = computeScore(remaining, { pagesAnalyzed: pages }).score;
      expect(next).toBeGreaterThanOrEqual(prev);
      prev = next;
    }
    expect(prev).toBe(100);
  });

  it("real-world scale: mid-migration runs land in a useful mid-range, not 0", () => {
    // granadobr run #1 (122 issues, 18 crit) — old formula: 0
    const start = granadobrFixture();
    const startScore = computeScore(start.issues, { pagesAnalyzed: start.pages }).score;
    expect(startScore).toBeGreaterThanOrEqual(10);
    expect(startScore).toBeLessThanOrEqual(35);

    // granadobr run #15 (~40 issues, 0 crit: 15H/18M/7L) — old formula: 0
    const later: Issue[] = [];
    for (let i = 0; i < 15; i++)
      later.push(makeIssue({ id: `h${i}`, severity: "high", page: `/p${i % 20}::mobile` }));
    for (let i = 0; i < 18; i++)
      later.push(makeIssue({ id: `m${i}`, severity: "medium", page: `/p${i % 20}::mobile` }));
    for (let i = 0; i < 7; i++)
      later.push(makeIssue({ id: `l${i}`, severity: "low", page: `/p${i % 20}::mobile` }));
    const laterScore = computeScore(later, { pagesAnalyzed: 20 }).score;
    expect(laterScore).toBeGreaterThanOrEqual(60);
    expect(laterScore).toBeLessThanOrEqual(90);

    // The migration progress must be VISIBLE: ≥30 points of movement.
    expect(laterScore - startScore).toBeGreaterThanOrEqual(30);
  });

  it("is sample-size invariant: same per-page issue density → same score", () => {
    const mkDensity = (pages: number): Issue[] => {
      const issues: Issue[] = [];
      for (let p = 0; p < pages; p++) {
        issues.push(makeIssue({ id: `h-${p}`, severity: "high", page: `/p${p}::mobile` }));
        issues.push(makeIssue({ id: `m-${p}`, severity: "medium", page: `/p${p}::mobile` }));
      }
      return issues;
    };
    const at10 = computeScore(mkDensity(10), { pagesAnalyzed: 10 }).score;
    const at30 = computeScore(mkDensity(30), { pagesAnalyzed: 30 }).score;
    expect(at10).toBe(at30);
  });

  it("computeScore is the pure density formula — the fail cap lives in computeVerdict", () => {
    const one = [makeIssue({ severity: "critical", page: "/p1::mobile" })];
    const { score } = computeScore(one, { pagesAnalyzed: 20 });
    expect(score).toBeGreaterThan(FAIL_SCORE_CAP);
  });

  it("pageless (site-level) issues still lower the score", () => {
    const site = [
      makeIssue({ id: "s1", severity: "high", page: undefined }),
      makeIssue({ id: "s2", severity: "high", page: undefined }),
    ];
    const { score } = computeScore(site, { pagesAnalyzed: 1 });
    expect(score).toBeLessThan(100);
  });

  it("inconclusive issues contribute nothing to the penalty", () => {
    const issues = [
      makeIssue({ severity: "critical", inconclusive: true, page: "/p1::mobile" }),
      makeIssue({ id: "i2", severity: "high", inconclusive: true }),
    ];
    expect(computeScore(issues, { pagesAnalyzed: 5 }).score).toBe(100);
  });
});

describe("derivePagesAnalyzed", () => {
  it("prefers the max data.pairs recorded by checks", () => {
    const checks = [
      makeCheck({ data: { pairs: 4 } }),
      makeCheck({ name: "b", data: { pairs: 12 } }),
      makeCheck({ name: "c" }),
    ];
    expect(derivePagesAnalyzed(checks, [])).toBe(12);
  });

  it("falls back to distinct issue.page values", () => {
    const issues = [
      makeIssue({ id: "1", page: "/a::mobile" }),
      makeIssue({ id: "2", page: "/a::mobile" }),
      makeIssue({ id: "3", page: "/b::mobile" }),
    ];
    expect(derivePagesAnalyzed([], issues)).toBe(2);
  });

  it("returns 1 when nothing is known", () => {
    expect(derivePagesAnalyzed([], [])).toBe(1);
  });
});

describe("computeVerdict", () => {
  it("keeps the status logic: critical or failed check → fail", () => {
    const v = computeVerdict(
      [makeCheck({ status: "fail" })],
      [makeIssue({ severity: "critical", page: "/p::mobile" })],
      { pagesAnalyzed: 10 },
    );
    expect(v.status).toBe("fail");
    expect(v.critical).toBe(1);
  });

  it("any critical issue caps the score at FAIL_SCORE_CAP", () => {
    const v = computeVerdict(
      [makeCheck()],
      [makeIssue({ severity: "critical", page: "/p1::mobile" })],
      { pagesAnalyzed: 20 },
    );
    expect(v.status).toBe("fail");
    expect(v.score).toBe(FAIL_SCORE_CAP);
  });

  it("a failed check with only non-critical issues also caps the score (no 'FAIL · score 91')", () => {
    // e.g. meta-seo-parity fails on a single medium divergence across many pages —
    // the raw density score would be ~100, but the FAIL verdict must cap it.
    const v = computeVerdict(
      [makeCheck({ status: "fail" })],
      [makeIssue({ severity: "medium", page: "/p1::mobile" })],
      { pagesAnalyzed: 40 },
    );
    expect(v.status).toBe("fail");
    expect(v.score).toBeLessThanOrEqual(FAIL_SCORE_CAP);
  });

  it("warn verdicts are not capped", () => {
    const v = computeVerdict([makeCheck()], [makeIssue({ severity: "high", page: "/p::mobile" })], {
      pagesAnalyzed: 20,
    });
    expect(v.status).toBe("warn");
    expect(v.score).toBeGreaterThan(FAIL_SCORE_CAP);
  });

  it("high issues or warn checks → warn; otherwise pass", () => {
    expect(computeVerdict([makeCheck()], [makeIssue({ severity: "high" })]).status).toBe("warn");
    expect(computeVerdict([makeCheck()], []).status).toBe("pass");
  });

  it("stamps scoreVersion and pagesAnalyzed on the verdict", () => {
    const v = computeVerdict([makeCheck()], [], { pagesAnalyzed: 7 });
    expect(v.scoreVersion).toBe(SCORE_VERSION);
    expect(v.pagesAnalyzed).toBe(7);
  });

  it("counts all severities in the verdict counters (including inconclusive)", () => {
    const v = computeVerdict(
      [makeCheck()],
      [
        makeIssue({ id: "1", severity: "high" }),
        makeIssue({ id: "2", severity: "high", inconclusive: true }),
        makeIssue({ id: "3", severity: "low" }),
      ],
    );
    expect(v.high).toBe(2);
    expect(v.low).toBe(1);
  });
});

describe("computeModuleVerdicts", () => {
  it("a module with no checks present is absent from the result (not zero-scored)", () => {
    const checks = [makeCheck({ name: "cache-coverage" })];
    const verdicts = computeModuleVerdicts(checks, []);
    expect(verdicts.map((v) => v.module)).toEqual(["cache"]);
  });

  it("checks not registered to any module are ignored (no crash, no bogus module)", () => {
    const checks = [makeCheck({ name: "some-unregistered-future-check" })];
    const verdicts = computeModuleVerdicts(checks, []);
    expect(verdicts).toEqual([]);
  });

  it("scopes issues to their owning module via issue.check, independent of other modules' issues", () => {
    const checks = [makeCheck({ name: "cache-coverage" }), makeCheck({ name: "meta-seo-parity" })];
    const issues = [
      makeIssue({ id: "1", check: "cache-coverage", severity: "critical", page: "/p::mobile" }),
      makeIssue({ id: "2", check: "meta-seo-parity", severity: "low", page: "/p::mobile" }),
    ];
    const verdicts = computeModuleVerdicts(checks, issues);
    const cache = verdicts.find((v) => v.module === "cache")!;
    const seo = verdicts.find((v) => v.module === "seo")!;
    expect(cache.critical).toBe(1);
    expect(cache.status).toBe("fail");
    expect(cache.score).toBeLessThanOrEqual(FAIL_SCORE_CAP);
    expect(seo.critical).toBe(0);
    expect(seo.low).toBe(1);
    expect(seo.status).toBe("pass");
    expect(seo.score).toBeGreaterThan(FAIL_SCORE_CAP);
  });

  it("derives pagesAnalyzed per-module from that module's own checks/issues", () => {
    const checks = [
      makeCheck({ name: "cache-coverage", data: { pairs: 5 } }),
      makeCheck({ name: "meta-seo-parity", data: { pairs: 20 } }),
    ];
    const verdicts = computeModuleVerdicts(checks, []);
    expect(verdicts.find((v) => v.module === "cache")!.pagesAnalyzed).toBe(5);
    expect(verdicts.find((v) => v.module === "seo")!.pagesAnalyzed).toBe(20);
  });

  it("a module with all-pass checks and zero issues still appears (empty issue list, not absent)", () => {
    const checks = [makeCheck({ name: "cache-coverage", status: "pass" })];
    const verdicts = computeModuleVerdicts(checks, []);
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]!.status).toBe("pass");
    expect(verdicts[0]!.score).toBe(100);
  });

  it("result is sorted by module name (deterministic order)", () => {
    const checks = [
      makeCheck({ name: "web-vitals-mobile" }),
      makeCheck({ name: "cache-coverage" }),
    ];
    const verdicts = computeModuleVerdicts(checks, []);
    expect(verdicts.map((v) => v.module)).toEqual(["cache", "vitals"]);
  });
});

describe("computeCompositeVerdict", () => {
  it("single-module case degenerates to that module's own score", () => {
    const checks = [makeCheck({ name: "cache-coverage" })];
    const issues = [
      makeIssue({ id: "1", check: "cache-coverage", severity: "high", page: "/p::mobile" }),
    ];
    const moduleVerdicts = computeModuleVerdicts(checks, issues);
    const composite = computeCompositeVerdict(moduleVerdicts, checks, issues);
    expect(composite.score).toBe(moduleVerdicts[0]!.score);
    expect(composite.modulesRun).toEqual(["cache"]);
  });

  it("weights modules by pagesAnalyzed (a bigger module dominates the composite)", () => {
    const checks = [
      makeCheck({ name: "cache-coverage", data: { pairs: 1 } }), // small, bad score
      makeCheck({ name: "web-vitals-mobile", data: { pairs: 99 } }), // huge, clean
    ];
    const issues = [
      makeIssue({ id: "1", check: "cache-coverage", severity: "high", page: "/p::mobile" }),
    ];
    const moduleVerdicts = computeModuleVerdicts(checks, issues);
    const composite = computeCompositeVerdict(moduleVerdicts, checks, issues);
    // vitals module is clean (score 100) and has 99x the weight of cache's
    // slightly-dinged module — composite should land close to 100, not a
    // plain average of the two (which would be ~90).
    expect(composite.score).toBeGreaterThan(90);
  });

  it("plain average when weights are equal", () => {
    const checks = [
      makeCheck({ name: "cache-coverage", data: { pairs: 10 } }),
      makeCheck({ name: "console-errors-baseline", data: { pairs: 10 } }),
    ];
    const issues = [
      makeIssue({ id: "1", check: "cache-coverage", severity: "high", page: "/p::mobile" }),
    ];
    const moduleVerdicts = computeModuleVerdicts(checks, issues);
    const composite = computeCompositeVerdict(moduleVerdicts, checks, issues);
    const consoleMv = moduleVerdicts.find((v) => v.module === "console")!;
    const cacheMv = moduleVerdicts.find((v) => v.module === "cache")!;
    expect(consoleMv.score).toBe(100);
    expect(composite.score).toBe(Math.round((consoleMv.score + cacheMv.score) / 2));
  });

  it("any module in fail status caps the composite score, even if the weighted average would be higher", () => {
    const checks = [
      makeCheck({ name: "cache-coverage", status: "fail", data: { pairs: 1 } }),
      makeCheck({ name: "web-vitals-mobile", data: { pairs: 1 } }),
    ];
    const composite = computeCompositeVerdict(computeModuleVerdicts(checks, []), checks, []);
    expect(composite.status).toBe("fail");
    expect(composite.score).toBeLessThanOrEqual(FAIL_SCORE_CAP);
  });

  it("modulesRun is populated and sorted", () => {
    const checks = [
      makeCheck({ name: "web-vitals-mobile" }),
      makeCheck({ name: "cache-coverage" }),
    ];
    const composite = computeCompositeVerdict(computeModuleVerdicts(checks, []), checks, []);
    expect(composite.modulesRun).toEqual(["cache", "vitals"]);
  });

  it("checksRun/checksPassed/etc stay GLOBAL counts across all checks passed in, not just scored ones", () => {
    const checks = [
      makeCheck({ name: "cache-coverage", status: "pass" }),
      makeCheck({ name: "unregistered-check", status: "fail" }),
    ];
    const composite = computeCompositeVerdict(computeModuleVerdicts(checks, []), checks, []);
    expect(composite.checksRun).toBe(2);
    expect(composite.checksFailed).toBe(1);
  });
});
