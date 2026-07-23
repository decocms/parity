import { type ModuleName, moduleOfCheck } from "../checks/modules.ts";
import type { CheckResult, Issue, Verdict } from "../types/schema.ts";

/**
 * Shared verdict/score computation — single source of truth for
 * `parity run`, `parity vitals` and `parity cache` (previously three
 * drifting copies).
 *
 * Score v2 formula (see PR for the empirical motivation):
 *
 *   totalPenalty = Σ weight(severity) over non-inconclusive issues
 *   normalized   = totalPenalty / max(1, pagesAnalyzed)
 *   score        = round(100 · e^(-normalized / DECAY_K))
 *   if verdict status is "fail" → score = min(score, FAIL_SCORE_CAP)
 *
 * Why not the old linear `100 - Σweights`: checks emit one issue per
 * occurrence — per (page × viewport) pair, per robots.txt user-agent,
 * per broken link — so real mid-migration runs carry 40-120 issues and
 * the linear score saturated at 0. In 15 real runs of one migration the
 * issues fell 122 → 39 and the score never left 0. Dividing the total
 * penalty by the number of analyzed page-pairs makes the score reflect
 * average page health (sampling more pages doesn't punish thoroughness),
 * and the exponential never clamps, so every fixed issue moves the number.
 *
 * ALL issues are divided by page count, including pageless (site-level)
 * ones: real runs showed one robots.txt divergence emitting 10 pageless
 * issues (one per user-agent), which would crush the score if counted
 * undivided. The trade-off — a single genuinely-global issue is diluted
 * on large runs — is covered by `status`/`--fail-on`, which stay
 * severity-based; the score is a progress meter, not a CI gate.
 *
 * `inconclusive` issues contribute nothing (schema declares them
 * informational).
 */
export const SEVERITY_WEIGHTS: Record<Issue["severity"], number> = {
  critical: 20,
  high: 8,
  medium: 3,
  low: 1,
};

/**
 * e-folding constant, calibrated on real migration runs whose penalty
 * density ranged 37-92 per page: density 9 ≈ 77, 40 ≈ 32, 90 ≈ 8.
 */
export const DECAY_K = 35;

/**
 * Any FAIL verdict — a critical issue OR a failed check (checks like
 * meta-seo/html-structural set status "fail" on non-critical issues) —
 * caps the score below 80 so "status FAIL, score 91" can't happen.
 * Applied in `computeVerdict`, where the status is known.
 */
export const FAIL_SCORE_CAP = 79;

/** Bumped when the formula changes — fences cross-version score deltas. */
export const SCORE_VERSION = 2;

export interface ScoreBreakdown {
  score: number;
  totalPenalty: number;
  normalizedPenalty: number;
  pagesAnalyzed: number;
}

/**
 * Pure penalty-density formula — no fail cap here, since "fail" depends
 * on check statuses that this function doesn't see. Callers that know
 * the verdict status apply `FAIL_SCORE_CAP` (see `computeVerdict`).
 */
export function computeScore(issues: Issue[], opts: { pagesAnalyzed: number }): ScoreBreakdown {
  const pagesAnalyzed = Math.max(1, opts.pagesAnalyzed);
  let totalPenalty = 0;
  for (const issue of issues) {
    if (issue.inconclusive) continue;
    totalPenalty += SEVERITY_WEIGHTS[issue.severity];
  }
  const normalizedPenalty = totalPenalty / pagesAnalyzed;
  const score = Math.round(100 * Math.exp(-normalizedPenalty / DECAY_K));
  return { score, totalPenalty, normalizedPenalty, pagesAnalyzed };
}

/**
 * Best-effort page count when the caller can't provide one (partial runs,
 * older callers): the pair-iterating checks record `data.pairs`, and
 * failing that the distinct `issue.page` values bound it from below.
 */
export function derivePagesAnalyzed(checks: CheckResult[], issues: Issue[]): number {
  let fromChecks = 0;
  for (const check of checks) {
    const pairs = check.data?.pairs;
    if (typeof pairs === "number" && pairs > fromChecks) fromChecks = pairs;
  }
  if (fromChecks > 0) return fromChecks;
  const distinctPages = new Set(issues.filter((i) => i.page).map((i) => i.page));
  return Math.max(1, distinctPages.size);
}

export function computeVerdict(
  checks: CheckResult[],
  issues: Issue[],
  opts?: { pagesAnalyzed?: number },
): Verdict {
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const i of issues) counts[i.severity]++;

  const checksPassed = checks.filter((c) => c.status === "pass").length;
  const checksFailed = checks.filter((c) => c.status === "fail").length;
  const checksSkipped = checks.filter((c) => c.status === "skipped").length;
  const checksWarn = checks.filter((c) => c.status === "warn").length;

  const pagesAnalyzed = opts?.pagesAnalyzed ?? derivePagesAnalyzed(checks, issues);
  let { score } = computeScore(issues, { pagesAnalyzed });

  const status: Verdict["status"] =
    counts.critical > 0 || checksFailed > 0
      ? "fail"
      : counts.high > 0 || checksWarn > 0
        ? "warn"
        : "pass";
  if (status === "fail") score = Math.min(score, FAIL_SCORE_CAP);

  return {
    status,
    score,
    scoreVersion: SCORE_VERSION,
    pagesAnalyzed,
    critical: counts.critical,
    high: counts.high,
    medium: counts.medium,
    low: counts.low,
    checksRun: checks.length,
    checksPassed,
    checksFailed,
    checksSkipped,
  };
}

/**
 * Per-module verdict (M3 phase B — see docs/ROADMAP-1.0.md). Scopes the
 * SAME `computeScore`/`derivePagesAnalyzed`/status-derivation logic used
 * by `computeVerdict` to just the checks (and their issues) that belong to
 * one module, so a run that only selected a subset of modules (`--only`)
 * produces a score that reflects only what actually ran.
 */
export interface ModuleVerdict {
  module: ModuleName;
  score: number;
  status: "pass" | "warn" | "fail";
  critical: number;
  high: number;
  medium: number;
  low: number;
  checksRun: number;
  pagesAnalyzed: number;
}

/**
 * Groups `checks`/`issues` by owning module and computes a `ModuleVerdict`
 * for each module that has at least one check present in `checks` — a
 * module with zero checks present is simply ABSENT from the result (not a
 * zero-score entry), which is what makes the composite "reflect only what
 * ran". Issues are attributed via `issue.check` (every check consistently
 * sets this to its own name — verified across all check modules), falling
 * back to `moduleOfCheck` on the owning `CheckResult.name` for checks with
 * no issues at all (so an all-pass module still shows up).
 */
export function computeModuleVerdicts(checks: CheckResult[], issues: Issue[]): ModuleVerdict[] {
  const checksByModule = new Map<ModuleName, CheckResult[]>();
  for (const check of checks) {
    const mod = moduleOfCheck(check.name);
    if (!mod) continue; // unregistered/legacy check name — not scoreable per-module
    if (!checksByModule.has(mod)) checksByModule.set(mod, []);
    checksByModule.get(mod)!.push(check);
  }

  const issuesByModule = new Map<ModuleName, Issue[]>();
  for (const issue of issues) {
    const mod = moduleOfCheck(issue.check);
    if (!mod) continue;
    if (!issuesByModule.has(mod)) issuesByModule.set(mod, []);
    issuesByModule.get(mod)!.push(issue);
  }

  const result: ModuleVerdict[] = [];
  for (const [mod, modChecks] of checksByModule) {
    const modIssues = issuesByModule.get(mod) ?? [];
    const counts = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const i of modIssues) counts[i.severity]++;

    const checksFailed = modChecks.filter((c) => c.status === "fail").length;
    const checksWarn = modChecks.filter((c) => c.status === "warn").length;

    const pagesAnalyzed = derivePagesAnalyzed(modChecks, modIssues);
    let { score } = computeScore(modIssues, { pagesAnalyzed });

    const status: ModuleVerdict["status"] =
      counts.critical > 0 || checksFailed > 0
        ? "fail"
        : counts.high > 0 || checksWarn > 0
          ? "warn"
          : "pass";
    if (status === "fail") score = Math.min(score, FAIL_SCORE_CAP);

    result.push({
      module: mod,
      score,
      status,
      critical: counts.critical,
      high: counts.high,
      medium: counts.medium,
      low: counts.low,
      checksRun: modChecks.length,
      pagesAnalyzed,
    });
  }

  // Deterministic order for rendering/tests.
  result.sort((a, b) => a.module.localeCompare(b.module));
  return result;
}

/**
 * Composite verdict built from per-module verdicts — a weighted average
 * (weight = each module's `pagesAnalyzed`, floored at 1 so a module with 0
 * analyzed pages still counts instead of dividing by zero / being
 * silently dropped) rather than a flat mean, so modules that covered more
 * ground contribute proportionally more to the headline score.
 *
 * The returned `Verdict` keeps the EXACT same shape `computeVerdict`
 * returns (drop-in replacement) — `checksRun`/`checksPassed`/`checksFailed`/
 * `checksSkipped` stay GLOBAL counts across ALL checks passed in (not just
 * the ones that mapped to a module), for backward-compat clarity: a
 * consumer reading `verdict.checksRun` should still see "how many checks
 * ran in this run", not "how many were scoreable".
 */
export function computeCompositeVerdict(
  moduleVerdicts: ModuleVerdict[],
  checks: CheckResult[],
  issues: Issue[],
): Verdict {
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const i of issues) counts[i.severity]++;

  const checksPassed = checks.filter((c) => c.status === "pass").length;
  const checksFailed = checks.filter((c) => c.status === "fail").length;
  const checksSkipped = checks.filter((c) => c.status === "skipped").length;
  const checksWarn = checks.filter((c) => c.status === "warn").length;

  let weightedScoreSum = 0;
  let weightSum = 0;
  let totalPagesAnalyzed = 0;
  for (const mv of moduleVerdicts) {
    const weight = Math.max(1, mv.pagesAnalyzed);
    weightedScoreSum += mv.score * weight;
    weightSum += weight;
    totalPagesAnalyzed = Math.max(totalPagesAnalyzed, mv.pagesAnalyzed);
  }
  let score = weightSum > 0 ? Math.round(weightedScoreSum / weightSum) : 100;

  const status: Verdict["status"] =
    counts.critical > 0 || checksFailed > 0 || moduleVerdicts.some((mv) => mv.status === "fail")
      ? "fail"
      : counts.high > 0 || checksWarn > 0 || moduleVerdicts.some((mv) => mv.status === "warn")
        ? "warn"
        : "pass";
  if (status === "fail") score = Math.min(score, FAIL_SCORE_CAP);

  return {
    status,
    score,
    scoreVersion: SCORE_VERSION,
    pagesAnalyzed: totalPagesAnalyzed || derivePagesAnalyzed(checks, issues),
    critical: counts.critical,
    high: counts.high,
    medium: counts.medium,
    low: counts.low,
    checksRun: checks.length,
    checksPassed,
    checksFailed,
    checksSkipped,
    modulesRun: moduleVerdicts.map((mv) => mv.module).sort(),
  };
}
