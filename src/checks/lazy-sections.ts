import type { CheckResult, Issue, NetworkEntry } from "../types/schema.ts";
import type { CheckContext } from "./index.ts";
import { pairCaptures } from "./lib/pairing.ts";

const LAZY_URL_PATTERN = /\/(deco\/render|_loader)\b/;

export function lazySectionPresence(ctx: CheckContext): CheckResult {
  const start = Date.now();
  const { pairs } = pairCaptures(ctx.prodPages, ctx.candPages);
  const issues: Issue[] = [];

  for (const pair of pairs) {
    const prodSections = extractSectionIds(pair.prod.network);
    const candSections = extractSectionIds(pair.cand.network);

    const onlyProd = [...prodSections].filter((s) => !candSections.has(s));
    const onlyCand = [...candSections].filter((s) => !prodSections.has(s));

    const union = prodSections.size + candSections.size;
    const intersection = [...prodSections].filter((s) => candSections.has(s)).length;
    const jaccard = union === 0 ? 1 : intersection / (union - intersection);

    if (onlyProd.length > 0) {
      issues.push({
        id: `lazy:missing:${pair.key}`,
        severity: "high",
        category: "functional",
        page: pair.key,
        check: "lazy-section-presence",
        summary: `${onlyProd.length} lazy section(s) presentes em prod ausentes em cand (${pair.key})`,
        details: `Faltando: ${onlyProd.join(", ")}\nNovos em cand: ${onlyCand.join(", ") || "—"}`,
      });
    }

    if (jaccard < 0.9 && union > 4) {
      issues.push({
        id: `lazy:overlap:${pair.key}`,
        severity: "medium",
        category: "functional",
        page: pair.key,
        check: "lazy-section-presence",
        summary: `Overlap de lazy sections < 90% em ${pair.key} (Jaccard ${jaccard.toFixed(2)})`,
      });
    }
  }

  return {
    name: "lazy-section-presence",
    status: issues.some((i) => i.severity === "high") ? "fail" : issues.length ? "warn" : "pass",
    severity: "high",
    durationMs: Date.now() - start,
    summary: `${issues.length} divergência(s) de lazy sections`,
    issues,
  };
}

function extractSectionIds(entries: NetworkEntry[]): Set<string> {
  const out = new Set<string>();
  for (const e of entries) {
    if (e.decoSection) out.add(e.decoSection);
    if (LAZY_URL_PATTERN.test(e.url)) {
      // Use last path segment as a stable id when header is absent
      try {
        const u = new URL(e.url);
        const seg = u.pathname.split("/").filter(Boolean).pop();
        if (seg) out.add(seg);
      } catch {
        /* skip malformed */
      }
    }
  }
  return out;
}
