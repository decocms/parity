import type { CheckResult, Issue } from "../types/schema.ts";
import type { CheckContext } from "./index.ts";
import { pairCaptures } from "./lib/pairing.ts";

const CATEGORIES = [
  { key: "performance", label: "Performance" },
  { key: "accessibility", label: "Acessibilidade" },
  { key: "bestPractices", label: "Práticas recomendadas" },
  { key: "seo", label: "SEO" },
] as const;

/** A drop this small is jitter, not a regression. Lighthouse scores are integers 0..100. */
const REGRESSION_DELTA = 3;

/**
 * Enforce "equal or better" on Lighthouse category scores, not just performance.
 * The migration's goal is parity-or-better everywhere — a cand that ships a lower
 * accessibility / best-practices / SEO score than prod is a regression worth
 * flagging even when Core Web Vitals improved. Only runs when scores were
 * captured (Lighthouse mode); `--no-lighthouse` has no scores → skipped.
 */
export function lighthouseScores(ctx: CheckContext): CheckResult {
  const start = Date.now();
  const { pairs } = pairCaptures(ctx.prodPages, ctx.candPages);
  const issues: Issue[] = [];

  for (const pair of pairs) {
    const prod = pair.prod.lhScores;
    const cand = pair.cand.lhScores;
    if (!prod || !cand) continue;
    for (const { key, label } of CATEGORIES) {
      const p = prod[key];
      const c = cand[key];
      if (p == null || c == null) continue;
      const delta = c - p;
      if (delta >= -REGRESSION_DELTA) continue; // equal or better (within jitter)
      issues.push({
        id: `lh-score:${key}:${pair.key}`,
        severity: -delta >= 10 ? "high" : "medium",
        category: key === "seo" ? "seo" : key === "accessibility" ? "a11y" : "performance",
        page: pair.key,
        check: "lighthouse-scores",
        summary: `${label} regrediu em ${pair.key}: cand ${c} vs prod ${p} (${delta})`,
        details: `Objetivo da migração é igual ou melhor. ${label}: prod=${p}, cand=${c}. Recupere pelo menos o nível de prod.`,
      });
    }
  }

  const hasScores = pairs.some((p) => p.prod.lhScores && p.cand.lhScores);
  return {
    name: "lighthouse-scores",
    status: !hasScores ? "skipped" : issues.length > 0 ? "fail" : "pass",
    severity: "medium",
    durationMs: Date.now() - start,
    summary: !hasScores
      ? "Sem scores Lighthouse (rode sem --no-lighthouse)"
      : `${pairs.length} página(s), ${issues.length} regressão(ões) de categoria`,
    issues,
  };
}
