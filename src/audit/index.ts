import type { Issue, PageCapture } from "../types/schema.ts";
import { auditConsole } from "./console.ts";
import { auditImages } from "./images.ts";
import { auditNetwork } from "./network.ts";
import { auditSeo } from "./seo.ts";
import { auditVitals } from "./vitals.ts";

export interface PageAuditResult {
  pageKey: string;
  url: string;
  finalUrl: string;
  viewport: string;
  status: number;
  durationMs: number;
  issues: Issue[];
  /** Issue counts grouped by category, for the dashboard summary. */
  byCategory: Record<Issue["category"], number>;
  /** Issue counts grouped by severity. */
  bySeverity: Record<Issue["severity"], number>;
}

export interface AuditResult {
  pages: PageAuditResult[];
  /** Aggregate issue list — flat, sorted by severity desc. */
  allIssues: Issue[];
  totals: {
    pages: number;
    issues: number;
    critical: number;
    high: number;
    medium: number;
    low: number;
  };
}

/**
 * Run all single-side audit checks against one page capture.
 *
 * Each check is independent; one throwing doesn't kill the others. The
 * orchestrator wraps each in a try/catch and folds errors into a low-
 * severity diagnostic issue so the user sees what failed instead of
 * the run crashing.
 */
export function runAuditForPage(capture: PageCapture): PageAuditResult {
  const pageKey = buildKey(capture);
  const issues: Issue[] = [];

  // Navigation status — only one absolute check: did the page load at all?
  if (capture.status >= 400) {
    issues.push({
      id: `audit:nav:${pageKey}`,
      severity: capture.status >= 500 ? "critical" : "high",
      category: "functional",
      page: pageKey,
      check: "audit-navigation",
      summary: `Navigation respondeu HTTP ${capture.status}`,
      details: `URL: ${capture.url}\nFinal URL: ${capture.finalUrl}\n\nA própria página alvo está retornando ${capture.status}. Sem isso, todos os outros checks são executados em página de erro.`,
    });
  }

  pushSafe(issues, "audit-vitals", () => auditVitals(pageKey, capture.vitals));
  pushSafe(issues, "audit-console", () => auditConsole(pageKey, capture.console));
  pushSafe(issues, "audit-network", () => auditNetwork(pageKey, capture.finalUrl || capture.url, capture.network));
  pushSafe(issues, "audit-images", () => auditImages(pageKey, capture.html));
  pushSafe(issues, "audit-seo", () => auditSeo(pageKey, capture.html));

  return {
    pageKey,
    url: capture.url,
    finalUrl: capture.finalUrl,
    viewport: capture.viewport,
    status: capture.status,
    durationMs: capture.durationMs,
    issues: sortIssues(issues),
    byCategory: countBy(issues, (i) => i.category),
    bySeverity: countBy(issues, (i) => i.severity),
  };
}

/**
 * Aggregate results across multiple page captures into a single
 * AuditResult that the CLI/report can consume.
 */
export function aggregateAudit(pageResults: PageAuditResult[]): AuditResult {
  const allIssues = sortIssues(pageResults.flatMap((p) => p.issues));
  return {
    pages: pageResults,
    allIssues,
    totals: {
      pages: pageResults.length,
      issues: allIssues.length,
      critical: allIssues.filter((i) => i.severity === "critical").length,
      high: allIssues.filter((i) => i.severity === "high").length,
      medium: allIssues.filter((i) => i.severity === "medium").length,
      low: allIssues.filter((i) => i.severity === "low").length,
    },
  };
}

function buildKey(c: PageCapture): string {
  try {
    return `${new URL(c.finalUrl || c.url).pathname}::${c.viewport}`;
  } catch {
    return `${c.url}::${c.viewport}`;
  }
}

const SEVERITY_RANK: Record<Issue["severity"], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

function sortIssues(issues: Issue[]): Issue[] {
  return [...issues].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

function pushSafe(target: Issue[], checkName: string, fn: () => Issue[]): void {
  try {
    target.push(...fn());
  } catch (err) {
    target.push({
      id: `audit:check-error:${checkName}`,
      severity: "low",
      category: "functional",
      check: checkName,
      summary: `Check ${checkName} crashou: ${(err as Error).message}`,
    });
  }
}

function countBy<K extends string>(
  arr: Issue[],
  pick: (i: Issue) => K,
): Record<K, number> {
  const out: Partial<Record<K, number>> = {};
  for (const i of arr) {
    const k = pick(i);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out as Record<K, number>;
}
