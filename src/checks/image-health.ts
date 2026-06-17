import { snapshotDom } from "../diff/dom.ts";
import type { CheckResult, Issue, NetworkEntry } from "../types/schema.ts";
import type { CheckContext } from "./index.ts";
import { pairCaptures } from "./lib/pairing.ts";

export function imageLoadingHealth(ctx: CheckContext): CheckResult {
  const start = Date.now();
  const { pairs } = pairCaptures(ctx.prodPages, ctx.candPages);
  const issues: Issue[] = [];

  for (const pair of pairs) {
    const prodSnap = snapshotDom(pair.prod.html);
    const candSnap = snapshotDom(pair.cand.html);

    const candFailedImgs = countFailedImageRequests(pair.cand.network);
    if (candFailedImgs > 0) {
      issues.push({
        id: `images:failed:${pair.key}`,
        severity: "medium",
        category: "network",
        page: pair.key,
        check: "image-loading-health",
        summary: `${candFailedImgs} imagem(ns) com falha de carregamento em cand (${pair.key})`,
      });
    }

    if (candSnap.imageStats.withoutAlt - prodSnap.imageStats.withoutAlt > 1) {
      issues.push({
        id: `images:alt:${pair.key}`,
        severity: "low",
        category: "seo",
        page: pair.key,
        check: "image-loading-health",
        summary: `Mais imagens sem alt em cand: prod=${prodSnap.imageStats.withoutAlt} cand=${candSnap.imageStats.withoutAlt}`,
      });
    }

    const srcsetLoss = prodSnap.imageStats.withSrcset - candSnap.imageStats.withSrcset;
    if (srcsetLoss > 2) {
      issues.push({
        id: `images:srcset:${pair.key}`,
        severity: "medium",
        category: "performance",
        page: pair.key,
        check: "image-loading-health",
        summary: `Perda de srcset em cand (${pair.key}): prod=${prodSnap.imageStats.withSrcset}, cand=${candSnap.imageStats.withSrcset}`,
      });
    }
  }

  return {
    name: "image-loading-health",
    status: issues.length > 0 ? "warn" : "pass",
    severity: "medium",
    durationMs: Date.now() - start,
    summary: `${issues.length} problema(s) de imagem detectado(s)`,
    issues,
  };
}

function countFailedImageRequests(entries: NetworkEntry[]): number {
  return entries.filter((e) => e.resourceType === "image" && (e.status === 0 || e.status >= 400))
    .length;
}
