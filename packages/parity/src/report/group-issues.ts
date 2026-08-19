import type { Issue } from "../types/schema.ts";

/**
 * Display-only grouping of issues that share a root cause. Most checks
 * emit one issue per (page × viewport) pair, so a single broken meta tag
 * shows up 10-20 times in the flat list. This groups by check + severity +
 * normalized summary (paths/URLs/viewports/digits stripped) so renderers
 * can show "1 issue × 12 pages" instead of 12 near-identical rows.
 *
 * Deliberately NOT applied to scoring or issue IDs — baselines match by
 * ID (`compareToBaseline`) and the score already normalizes per page.
 */
export interface IssueGroup {
  /** Representative issue (first seen) — render its summary/details. */
  sample: Issue;
  /** Total issues collapsed into this group. */
  count: number;
  /** Distinct `issue.page` values affected, in first-seen order. */
  pages: string[];
  severity: Issue["severity"];
}

const SEVERITY_RANK: Record<Issue["severity"], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

/**
 * Strip everything page-specific from a summary so the same root cause
 * on different pages/viewports produces the same key.
 */
export function normalizeSummary(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/https?:\/\/[^\s)"']+/g, "<url>")
    .replace(/::(mobile|desktop|tablet)/g, "")
    .replace(/\/[a-z0-9à-ú/_%.~-]*/gi, "<path>")
    .replace(/\d+(?:[.,]\d+)?/g, "<n>")
    .replace(/\s+/g, " ")
    .trim();
}

export function groupIssues(issues: Issue[]): IssueGroup[] {
  const groups = new Map<string, IssueGroup>();
  for (const issue of issues) {
    const key = `${issue.check}::${issue.severity}::${normalizeSummary(issue.summary)}`;
    const existing = groups.get(key);
    if (existing) {
      existing.count++;
      if (issue.page && !existing.pages.includes(issue.page)) existing.pages.push(issue.page);
    } else {
      groups.set(key, {
        sample: issue,
        count: 1,
        pages: issue.page ? [issue.page] : [],
        severity: issue.severity,
      });
    }
  }
  return [...groups.values()].sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.count - a.count,
  );
}
