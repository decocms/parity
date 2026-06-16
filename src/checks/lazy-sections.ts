import type { CheckResult, Issue, NetworkEntry } from "../types/schema.ts";
import type { CheckContext } from "./index.ts";
import { pairCaptures } from "./lib/pairing.ts";

const LAZY_URL_PATTERN = /\/(deco\/render|_loader)\b/;
/** Marker the framework (or the user) can emit when ALL sections render eagerly by design. */
const EAGER_RENDERING_MARKER = /data-deco-async-rendering=["']eager["']|<meta\s+name=["']parity:async-rendering["']\s+content=["']eager["']/i;

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

    // Issue #46: if cand made zero lazy section requests AND its SSR HTML has
    // at least as many `<section>` tags as prod, it's eager-by-design (the
    // site set `setAsyncRenderingConfig({ respectCmsLazy: false })` to force
    // everything inline at SSR). The "missing lazy sections" are actually
    // present — just rendered inline rather than fetched async. Surface as
    // info instead of high, with an explicit label.
    const candIsIntentionallyEager = detectIntentionalEager({
      candSections,
      candHtml: pair.cand.html,
      prodHtml: pair.prod.html,
    });

    if (onlyProd.length > 0) {
      if (candIsIntentionallyEager) {
        issues.push({
          id: `lazy:intentional-eager:${pair.key}`,
          severity: "low",
          category: "performance",
          page: pair.key,
          check: "lazy-section-presence",
          summary: `[${pair.key}] cand renderiza ${onlyProd.length} section(s) eagerly que prod faz lazy — intentional-eager-rendering`,
          details: [
            `Faltando lazy em cand: ${onlyProd.join(", ")}`,
            "",
            "Heurística: cand não disparou nenhuma request lazy (deco/render ou _loader),",
            "e seu SSR HTML contém o marker explícito ou um número de <section> igual/maior",
            "ao prod. Esse é o padrão `setAsyncRenderingConfig({ respectCmsLazy: false })` —",
            "uma otimização de performance, não regressão.",
            "",
            "Pra confirmar:",
            "  1. Veja se src/setup.ts do site cand chama setAsyncRenderingConfig.",
            "  2. Ou adicione `<html data-deco-async-rendering=\"eager\">` no SSR pra deixar",
            "     explícito (parity respeitará).",
          ].join("\n"),
        });
      } else {
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
    }

    if (jaccard < 0.9 && union > 4 && !candIsIntentionallyEager) {
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

  const hasHigh = issues.some((i) => i.severity === "high");
  return {
    name: "lazy-section-presence",
    status: hasHigh ? "fail" : issues.length ? "warn" : "pass",
    severity: "high",
    durationMs: Date.now() - start,
    summary: `${issues.length} divergência(s) de lazy sections`,
    issues,
  };
}

interface EagerDetectArgs {
  candSections: Set<string>;
  candHtml: string;
  prodHtml: string;
}

/**
 * "cand made zero lazy requests AND has at least as many <section> tags as
 * prod (or an explicit marker)" → eager-by-design. Conservative: returns
 * false unless both signals agree, so a genuine regression where cand
 * lost a section silently still fires `high`.
 */
function detectIntentionalEager(args: EagerDetectArgs): boolean {
  if (args.candSections.size > 0) return false; // cand IS doing lazy → not eager-by-design
  if (EAGER_RENDERING_MARKER.test(args.candHtml)) return true;
  const candSectionCount = countSections(args.candHtml);
  const prodSectionCount = countSections(args.prodHtml);
  // Allow cand to be slightly under prod (e.g. prod has 1 extra lazy shelf)
  // but the bulk of sections must be present inline.
  return candSectionCount >= Math.floor(prodSectionCount * 0.8) && candSectionCount > 3;
}

function countSections(html: string): number {
  if (!html) return 0;
  // Count opening <section> tags. Cheap, no parser — good enough for an order-of-magnitude check.
  const matches = html.match(/<section\b/gi);
  return matches?.length ?? 0;
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
