import type { Issue, WebVitals } from "../types/schema.ts";
import type { VitalMetric } from "../types/vitals.ts";
import { VITAL_LABELS, VITAL_THRESHOLDS, classifyVital, formatVital } from "./thresholds.ts";

/**
 * Audit Web Vitals against Core Web Vitals absolute thresholds.
 *
 * One issue per metric that's NOT in the "good" zone. `null` values (the
 * page didn't surface that metric — typical for INP/CLS when there are
 * no user interactions or layout shifts) are silently skipped: we can't
 * meaningfully judge what we didn't measure.
 *
 * Severity mapping (from thresholds.ts):
 *   good             → no issue
 *   needs improvement → medium
 *   poor              → high
 *   poor × 2          → critical  (LCP/CLS/INP only)
 */
export function auditVitals(pageKey: string, vitals: WebVitals): Issue[] {
  const out: Issue[] = [];
  const metrics: Array<VitalMetric> = ["lcp", "fcp", "cls", "inp", "ttfb"];
  for (const metric of metrics) {
    const v = vitals[metric];
    if (v === null || v === undefined) continue;
    const cls = classifyVital(metric, v);
    if (cls.severity === "ok") continue;
    const label = VITAL_LABELS[metric];
    const formatted = formatVital(metric, v);
    const goodCutoff = formatVital(metric, VITAL_THRESHOLDS[metric].goodMax);
    out.push({
      id: `audit:vitals:${metric}:${pageKey}`,
      severity: cls.severity,
      category: "performance",
      page: pageKey,
      check: "audit-vitals",
      summary: `${label} ${cls.label} em ${pageKey}: ${formatted} (good ≤ ${goodCutoff})`,
      details: detailsFor(metric, v, cls.label),
    });
  }
  return out;
}

function detailsFor(
  metric: VitalMetric,
  value: number,
  label: "good" | "needs-improvement" | "poor" | "critical",
): string {
  const t = VITAL_THRESHOLDS[metric];
  const lines = [
    `Métrica: ${VITAL_LABELS[metric]}`,
    `Valor medido: ${formatVital(metric, value)}`,
    `Faixa "good" (Core Web Vitals): ≤ ${formatVital(metric, t.goodMax)}`,
    `Faixa "needs improvement": ${formatVital(metric, t.goodMax)} - ${formatVital(metric, t.niMax)}`,
    `Faixa "poor": > ${formatVital(metric, t.niMax)}`,
    `Classificação: ${label}`,
    "",
    HINTS[metric],
  ];
  return lines.join("\n");
}

const HINTS: Record<VitalMetric, string> = {
  lcp:
    "Causas comuns: hero image grande sem priority/preload, fontes web carregando lentas, " +
    "JS bloqueando o main thread. Ações: priority+preload no hero image, font-display: swap, " +
    "code-splitting do bundle inicial.",
  fcp:
    "Causas comuns: server response lento (TTFB alto), render-blocking CSS/JS, fontes web " +
    "sem font-display. Ações: reduzir CSS crítico, inline critical CSS, defer non-critical JS.",
  cls:
    "Causas comuns: imagens sem width/height, fontes sem font-display: optional, ads/embeds " +
    "injetados depois do render, animations de layout. Ações: width/height em todo <img>, " +
    "reservar slot pra elementos lazy, transform em vez de top/left.",
  inp:
    "Causas comuns: handlers de click pesados (filtros, busca síncrona), long tasks > 50ms, " +
    "third-party scripts. Ações: yield via scheduler.yield/setTimeout, mover trabalho pesado " +
    "pra web worker, debounce em handlers de input.",
  ttfb:
    "Causas comuns: SSR lento, queries N+1, edge não cacheando, cold start. Ações: cachear " +
    "responses no edge (Cloudflare), reduzir queries no SSR, warm up workers, prerender " +
    "rotas estáticas.",
};
