import { buildCacheReport, type CacheReport } from "../diff/cache.ts";
import type { CheckResult, Issue, NetworkEntry } from "../types/schema.ts";
import type { CheckContext } from "./index.ts";

/**
 * Check #12 — cache coverage in cand.
 *
 * Focus: cand only. Prod (Fresh on K8s/Cloudflare CDN) is reference but the
 * goal of migration to Cloudflare Workers is maximizing edge cache hits in cand.
 *
 * Surfaces:
 * - Static assets/images/fonts with hash in filename that MISS in cand → opportunity (high)
 * - Overall hit rate vs prod (informational)
 * - Per-category breakdown
 */
export function cacheCoverage(ctx: CheckContext): CheckResult {
  const start = Date.now();
  const issues: Issue[] = [];

  // Aggregate cand network across all captures
  const candEntries: NetworkEntry[] = [];
  let baseUrl = "";
  for (const p of ctx.candPages) {
    candEntries.push(...p.network);
    if (!baseUrl) baseUrl = p.url;
  }
  if (candEntries.length === 0) {
    return {
      name: "cache-coverage",
      status: "skipped",
      severity: "high",
      durationMs: Date.now() - start,
      summary: "Nenhum dado de network em cand",
      issues: [],
    };
  }

  const report = buildCacheReport(candEntries, baseUrl);
  const prodEntries: NetworkEntry[] = [];
  for (const p of ctx.prodPages) prodEntries.push(...p.network);
  const prodReport = prodEntries.length > 0 ? buildCacheReport(prodEntries, ctx.prodPages[0]?.url ?? "") : undefined;

  // Top-level summary issue (informational unless many opportunities)
  const oppCount = report.opportunities.length;
  const oppBytes = report.opportunities.reduce((s, r) => s + (r.entry.bytes ?? 0), 0);

  if (oppCount > 0) {
    const severity = oppCount >= 10 || oppBytes > 1_000_000 ? "high" : "medium";
    const isSingleSite = ctx.prodPages.length === 0;
    const target = isSingleSite ? "no site" : "em cand";
    issues.push({
      id: "cache:opportunities-summary",
      severity,
      category: "performance",
      check: "cache-coverage",
      summary: `${oppCount} requests cacheable ${target} não estão sendo cacheadas (${(oppBytes / 1024).toFixed(0)} KB)`,
      details: buildOpportunityDetails(report, prodReport),
    });
  }

  // Hit rate regression issue (vs prod baseline)
  if (prodReport && prodReport.hitRate - report.hitRate > 0.15) {
    issues.push({
      id: "cache:hit-rate-regression",
      severity: "medium",
      category: "performance",
      check: "cache-coverage",
      summary: `Cache hit rate em cand caiu ${((prodReport.hitRate - report.hitRate) * 100).toFixed(0)} pontos vs prod (${(report.hitRate * 100).toFixed(0)}% vs ${(prodReport.hitRate * 100).toFixed(0)}%)`,
    });
  }

  // Per-opportunity issues (capped: top 5 biggest)
  for (const opp of report.opportunities.slice(0, 5)) {
    const sizeKb = ((opp.entry.bytes ?? 0) / 1024).toFixed(0);
    issues.push({
      id: `cache:miss:${hashString(opp.entry.url)}`,
      severity: "medium",
      category: "performance",
      check: "cache-coverage",
      summary: `[${opp.category}] ${humanizeUrl(opp.entry.url)} — ${sizeKb} KB, ${opp.decision.toUpperCase()} em cand`,
      details: `URL: ${opp.entry.url}\nTipo: ${opp.entry.resourceType}\nCache-Control: ${opp.entry.cacheControl ?? "(missing)"}\nStatus: ${opp.entry.status}`,
    });
  }

  const status: CheckResult["status"] =
    issues.some((i) => i.severity === "high")
      ? "fail"
      : issues.length > 0
        ? "warn"
        : "pass";

  return {
    name: "cache-coverage",
    status,
    severity: "high",
    durationMs: Date.now() - start,
    summary: `Cache hit rate cand: ${(report.hitRate * 100).toFixed(0)}% · ${oppCount} oportunidade(s) (${(oppBytes / 1024).toFixed(0)} KB)`,
    issues,
    data: {
      hitRate: report.hitRate,
      prodHitRate: prodReport?.hitRate,
      totalRequests: report.total,
      totalBytes: report.totalBytes,
      opportunityCount: oppCount,
      opportunityBytes: oppBytes,
      byCategory: report.byCategory,
    },
  };
}

function buildOpportunityDetails(report: CacheReport, prodReport: CacheReport | undefined): string {
  const lines: string[] = [];
  lines.push(`Cache hit rate cand: ${(report.hitRate * 100).toFixed(0)}%`);
  if (prodReport) lines.push(`Cache hit rate prod: ${(prodReport.hitRate * 100).toFixed(0)}%`);
  lines.push("");
  lines.push("Por categoria (cand):");
  for (const [cat, info] of Object.entries(report.byCategory)) {
    if (info.count === 0) continue;
    lines.push(
      `  ${cat.padEnd(14)} ${info.count.toString().padStart(3)} req · ${(info.bytes / 1024).toFixed(0)} KB · ${(info.hitRate * 100).toFixed(0)}% hit`,
    );
  }
  lines.push("");
  lines.push("Top 10 oportunidades (assets hasheados sem cache):");
  for (const opp of report.opportunities.slice(0, 10)) {
    const sizeKb = ((opp.entry.bytes ?? 0) / 1024).toFixed(0);
    lines.push(`  ${sizeKb.padStart(5)} KB · ${humanizeUrl(opp.entry.url)}`);
  }
  return lines.join("\n");
}

function humanizeUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + (u.search ? u.search.slice(0, 30) : "");
  } catch {
    return url.slice(0, 100);
  }
}

function hashString(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}
