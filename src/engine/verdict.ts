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
 *   if any scored critical → score = min(score, CRITICAL_SCORE_CAP)
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

/** Any live critical caps the score below 80 so "FAIL · score 91" can't happen. */
export const CRITICAL_SCORE_CAP = 79;

/** Bumped when the formula changes — fences cross-version score deltas. */
export const SCORE_VERSION = 2;

export interface ScoreBreakdown {
  score: number;
  totalPenalty: number;
  normalizedPenalty: number;
  pagesAnalyzed: number;
}

export function computeScore(issues: Issue[], opts: { pagesAnalyzed: number }): ScoreBreakdown {
  const pagesAnalyzed = Math.max(1, opts.pagesAnalyzed);
  let totalPenalty = 0;
  let scoredCriticals = 0;
  for (const issue of issues) {
    if (issue.inconclusive) continue;
    totalPenalty += SEVERITY_WEIGHTS[issue.severity];
    if (issue.severity === "critical") scoredCriticals++;
  }
  const normalizedPenalty = totalPenalty / pagesAnalyzed;
  let score = Math.round(100 * Math.exp(-normalizedPenalty / DECAY_K));
  if (scoredCriticals > 0) score = Math.min(score, CRITICAL_SCORE_CAP);
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
  const { score } = computeScore(issues, { pagesAnalyzed });

  const status: Verdict["status"] =
    counts.critical > 0 || checksFailed > 0
      ? "fail"
      : counts.high > 0 || checksWarn > 0
        ? "warn"
        : "pass";

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
