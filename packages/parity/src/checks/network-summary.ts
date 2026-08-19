import { diffNetwork } from "../diff/network.ts";
import type { CheckResult, Issue } from "../types/schema.ts";
import type { CheckContext } from "./index.ts";
import { pairCaptures } from "./lib/pairing.ts";

export function networkSummaryDelta(ctx: CheckContext): CheckResult {
  const start = Date.now();
  const { pairs } = pairCaptures(ctx.prodPages, ctx.candPages);
  const issues: Issue[] = [];

  for (const pair of pairs) {
    const diff = diffNetwork(pair.prod.network, pair.cand.network, {
      ignorePatterns: ctx.ignore.ignoreRequestPatterns,
      maxTotalPct: 0.3,
    });

    if (diff.anyFailed) {
      issues.push({
        id: `network:volume:${pair.key}`,
        severity: "medium",
        category: "network",
        page: pair.key,
        check: "network-summary-delta",
        summary: `Volume de requests divergente em ${pair.key}: prod=${diff.prod.total}, cand=${diff.cand.total} (Δ ${(diff.delta.totalPct * 100).toFixed(0)}%)`,
        details: [
          `Bytes Δ ${(diff.delta.bytesPct * 100).toFixed(0)}%`,
          `Cache hit rate prod=${(diff.prod.cacheHitRate * 100).toFixed(0)}%, cand=${(diff.cand.cacheHitRate * 100).toFixed(0)}%`,
          `URLs apenas em prod (${diff.urls.onlyProd.length} primeiras 5): ${diff.urls.onlyProd.slice(0, 5).join(", ")}`,
          `URLs apenas em cand (${diff.urls.onlyCand.length} primeiras 5): ${diff.urls.onlyCand.slice(0, 5).join(", ")}`,
        ].join("\n"),
      });
    }

    // Critical endpoint disappearance
    const prodApi = new Set(diff.prod.decoSectionsHit);
    for (const sec of prodApi) {
      if (!diff.cand.decoSectionsHit.includes(sec)) {
        issues.push({
          id: `network:deco-section-gone:${pair.key}:${sec}`,
          severity: "high",
          category: "network",
          page: pair.key,
          check: "network-summary-delta",
          summary: `Deco section renderizada em prod ausente em cand: "${sec}" (${pair.key})`,
        });
      }
    }
  }

  return {
    name: "network-summary-delta",
    status: issues.length > 0 ? "warn" : "pass",
    severity: "medium",
    durationMs: Date.now() - start,
    summary: `${issues.length} divergência(s) de network`,
    issues,
  };
}
