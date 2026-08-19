import { diffDom, snapshotDom } from "../diff/dom.ts";
import type { CheckResult, Issue } from "../types/schema.ts";
import type { CheckContext } from "./index.ts";
import { pairCaptures } from "./lib/pairing.ts";

export function metaSeoParity(ctx: CheckContext): CheckResult {
  const start = Date.now();
  const { pairs } = pairCaptures(ctx.prodPages, ctx.candPages);
  const ignoreKeys = new Set(ctx.ignore.ignoreMetaKeys);
  const issues: Issue[] = [];

  for (const pair of pairs) {
    const prodSnap = snapshotDom(pair.prod.html);
    const candSnap = snapshotDom(pair.cand.html);
    const diff = diffDom(prodSnap, candSnap);

    const divergent = diff.metaDelta.filter((m) => !m.equal && !ignoreKeys.has(m.key));
    if (divergent.length > 0) {
      const summary = divergent
        .slice(0, 5)
        .map((m) => `${m.key}`)
        .join(", ");
      issues.push({
        id: `meta-seo:${pair.key}`,
        severity: divergent.some((d) => d.key === "title" || d.key === "canonical")
          ? "high"
          : "medium",
        category: "seo",
        page: pair.key,
        check: "meta-seo-parity",
        summary: `Meta/SEO divergente em ${pair.key} (${divergent.length} key(s) com diferença): ${summary}${divergent.length > 5 ? "…" : ""}`,
        details: divergent
          .map((d) => `• ${d.key}\n  prod: ${d.prod ?? "—"}\n  cand: ${d.cand ?? "—"}`)
          .join("\n\n"),
      });
    }
  }

  return {
    name: "meta-seo-parity",
    status: issues.length > 0 ? "fail" : "pass",
    severity: "high",
    durationMs: Date.now() - start,
    summary: `${issues.length} página(s) com divergência de meta/SEO`,
    issues,
  };
}
