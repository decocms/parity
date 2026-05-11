import { diffDom, snapshotDom } from "../diff/dom.ts";
import type { CheckResult, Issue } from "../types/schema.ts";
import type { CheckContext } from "./index.ts";
import { pairCaptures } from "./lib/pairing.ts";

export function htmlStructuralDiff(ctx: CheckContext): CheckResult {
  const start = Date.now();
  const { pairs } = pairCaptures(ctx.prodPages, ctx.candPages);
  const issues: Issue[] = [];

  for (const pair of pairs) {
    const prodSnap = snapshotDom(pair.prod.html);
    const candSnap = snapshotDom(pair.cand.html);
    const diff = diffDom(prodSnap, candSnap, { countTolerance: 2 });

    const deltaEntries = Object.entries(diff.countsDelta);
    if (deltaEntries.length > 0) {
      const summary = deltaEntries
        .map(([k, v]) => `${k}: ${v?.prod}→${v?.cand} (Δ${v?.delta})`)
        .join(", ");
      issues.push({
        id: `html-structural:counts:${pair.key}`,
        severity: "high",
        category: "functional",
        page: pair.key,
        check: "html-structural-diff",
        summary: `Contagem de elementos divergente em ${pair.key}: ${summary}`,
        evidence: [
          { kind: "screenshot", path: pair.prod.screenshotPath, label: "prod" },
          { kind: "screenshot", path: pair.cand.screenshotPath, label: "cand" },
        ],
      });
    }

    if (diff.decoSectionsOnlyProd.length > 0) {
      issues.push({
        id: `html-structural:deco-missing:${pair.key}`,
        severity: "high",
        category: "functional",
        page: pair.key,
        check: "html-structural-diff",
        summary: `Sections renderizadas em prod ausentes em cand (${pair.key}): ${diff.decoSectionsOnlyProd.join(", ")}`,
      });
    }
  }

  return {
    name: "html-structural-diff",
    status: issues.length > 0 ? "fail" : "pass",
    severity: "high",
    durationMs: Date.now() - start,
    summary: `${issues.length} divergência(s) estrutural(is) detectada(s)`,
    issues,
  };
}
