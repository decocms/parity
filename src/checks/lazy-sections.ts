import type { CheckResult, Issue, NetworkEntry } from "../types/schema.ts";
import type { CheckContext } from "./index.ts";
import { pairCaptures } from "./lib/pairing.ts";

const LAZY_URL_PATTERN = /\/(deco\/render|_loader)\b/;
/** Marker the framework (or the user) can emit when ALL sections render eagerly by design. */
const EAGER_RENDERING_MARKER =
  /data-deco-async-rendering=["']eager["']|<meta\s+name=["']parity:async-rendering["']\s+content=["']eager["']/i;

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
            '  2. Ou adicione `<html data-deco-async-rendering="eager">` no SSR pra deixar',
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
 * Detect "intentional eager rendering" (`setAsyncRenderingConfig({
 * respectCmsLazy: false })`). Review feedback on PR #63 surfaced that an
 * earlier raw-`<section>`-count heuristic had two false-negative paths:
 *
 *  1. A regression that inlined the WRONG sections (stale build,
 *     fallback layout, generic error page with header/footer/sidebar
 *     wrappers) would still satisfy a tag-count threshold.
 *  2. Sites with lazy-heavy prod have very few inline `<section>`
 *     tags as baseline, collapsing the threshold to "any 4+ sections
 *     passes" — trivially met by generic templates.
 *
 * Now we count nodes carrying deco-specific markers ONLY:
 *  - `data-manifest-key` (the inline marker emitted by deco SSR)
 *  - `data-deco-section` (alt marker)
 *  - `data-deco` (broader marker; used as fallback signal)
 *
 * The explicit `data-deco-async-rendering="eager"` marker still wins
 * as a 1-line opt-in for sites that want to skip the heuristic.
 *
 * Conservative bias: if NEITHER the explicit marker nor a meaningful
 * count of deco markers is present, fall through to the normal `high`
 * path so genuine regressions still surface.
 */
function detectIntentionalEager(args: EagerDetectArgs): boolean {
  if (args.candSections.size > 0) return false; // cand IS doing lazy → not eager-by-design
  if (EAGER_RENDERING_MARKER.test(args.candHtml)) return true;
  const candDecoCount = countDecoMarkers(args.candHtml);
  const prodDecoCount = countDecoMarkers(args.prodHtml);
  // Require cand to have at least as many deco-marked nodes as prod's
  // inline count. If prod's inline markers are too few to be useful as a
  // baseline (e.g. prod is mostly lazy), demand at least 4 cand markers
  // — that's enough to rule out a generic fallback layout.
  const meaningfulProdBaseline = prodDecoCount >= 3;
  if (meaningfulProdBaseline) {
    return candDecoCount >= prodDecoCount;
  }
  return candDecoCount >= 4;
}

/**
 * Count nodes carrying deco-specific section markers. Prefers
 * `data-manifest-key` (canonical for deco SSR). Falls through to
 * `data-deco-section` and `data-deco` as alt forms emitted by some
 * apps. Raw `<section>` tags are NOT counted — they include footers,
 * accordions, etc. and would trivially inflate the count.
 */
function countDecoMarkers(html: string): number {
  if (!html) return 0;
  const manifestKey = (html.match(/data-manifest-key\s*=/gi) ?? []).length;
  if (manifestKey > 0) return manifestKey;
  const decoSection = (html.match(/data-deco-section\s*=/gi) ?? []).length;
  if (decoSection > 0) return decoSection;
  // Last-resort: `data-deco="..."` markers. Lower precision (catches
  // analytics markers) but better than nothing on sites that don't
  // emit manifest-key in SSR.
  return (html.match(/data-deco\s*=/gi) ?? []).length;
}

/**
 * Issue #118: Fresh names lazy-section chunks `render` while TanStack/Vite
 * emits `render.ts` (extension included) — same section, different id, false
 * "missing in cand" on every page. Strip bundler extensions before comparing.
 */
export function normalizeSectionId(seg: string): string {
  return seg.replace(/\.(tsx|ts|jsx|js|mjs)$/i, "").toLowerCase();
}

function extractSectionIds(entries: NetworkEntry[]): Set<string> {
  const out = new Set<string>();
  for (const e of entries) {
    if (e.decoSection) out.add(normalizeSectionId(e.decoSection));
    if (LAZY_URL_PATTERN.test(e.url)) {
      // Use last path segment as a stable id when header is absent
      try {
        const u = new URL(e.url);
        const seg = u.pathname.split("/").filter(Boolean).pop();
        if (seg) out.add(normalizeSectionId(seg));
      } catch {
        /* skip malformed */
      }
    }
  }
  return out;
}
