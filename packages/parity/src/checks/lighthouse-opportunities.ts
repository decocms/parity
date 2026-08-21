import { diffOpportunities, opportunitySeverity } from "../diff/lighthouse.ts";
import type { CheckResult, Issue, LhOpportunity } from "../types/schema.ts";
import type { CheckContext } from "./index.ts";

/**
 * Lighthouse opportunities as issues. Issue #264.
 *
 * The vitals module already runs Lighthouse and already extracts the actionable audits with the
 * savings Lighthouse estimated — then reported only LCP/CLS/FCP numbers. The most actionable part
 * of the run (render-blocking CSS, a lazy-loaded LCP image, unused preconnects) never reached
 * `issues`, so it never reached the score, the report's issue list, or `parity prompt`.
 *
 * Only `parity vitals` captures Lighthouse today; a plain `parity run` measures vitals in the
 * browser instead. So this check skips cleanly rather than reporting "no problems" when there is
 * simply no Lighthouse data — an empty result and a clean result must not look alike.
 */
export function lighthouseOpportunities(ctx: CheckContext): CheckResult {
  const start = Date.now();
  const name = "lighthouse-opportunities";

  const hasLighthouse = ctx.candPages.some((p) => p.lhOpportunities !== undefined);
  if (!hasLighthouse) {
    return {
      name,
      status: "skipped",
      severity: "medium",
      durationMs: Date.now() - start,
      summary: "Sem dados de Lighthouse em cand (capturados por `parity vitals`)",
      issues: [],
    };
  }

  const deltas = diffOpportunities(ctx.prodPages, ctx.candPages);
  const reportable = deltas.filter((d) => opportunitySeverity(d.cand.savingsMs) !== "low");
  const issues: Issue[] = reportable.map((d) => {
    const sev = opportunitySeverity(d.cand.savingsMs);
    return {
      id: `lh:${d.cand.id}`,
      // A regression the migration introduced outranks the same waste prod already had.
      severity: d.regression && sev === "medium" ? "high" : sev,
      category: "performance",
      check: name,
      summary: `${d.cand.title} — ${fmtMs(d.cand.savingsMs)} recuperáveis${
        d.regression ? " (regressão: prod não tem, ou tem bem menos)" : ""
      }`,
      details: buildDetails(d.cand, d.prod, d.regression),
    };
  });

  const dropped = deltas.length - reportable.length;
  const worst = reportable[0]?.cand;
  const summaryParts = [
    `${reportable.length} oportunidade(s) acima de 200ms`,
    reportable.filter((d) => d.regression).length > 0
      ? `${reportable.filter((d) => d.regression).length} regressão(ões)`
      : null,
    worst ? `maior: ${worst.title} (${fmtMs(worst.savingsMs)})` : null,
    // Never let a threshold hide work silently.
    dropped > 0 ? `${dropped} abaixo do limite, não reportada(s)` : null,
  ].filter(Boolean);

  return {
    name,
    status: issues.length > 0 ? "fail" : "pass",
    severity: "medium",
    durationMs: Date.now() - start,
    summary: summaryParts.join(", "),
    data: { total: deltas.length, reported: issues.length, belowThreshold: dropped },
    issues,
  };
}

function buildDetails(
  cand: LhOpportunity,
  prod: LhOpportunity | null,
  regression: boolean,
): string {
  const lines = [`audit: ${cand.id}`];
  if (cand.displayValue) lines.push(`cand: ${cand.displayValue}`);
  lines.push(
    `economia estimada: ${fmtMs(cand.savingsMs)}${
      cand.savingsBytes > 0 ? `, ${fmtKb(cand.savingsBytes)}` : ""
    }`,
  );
  if (prod) {
    lines.push(`prod: ${fmtMs(prod.savingsMs)} na mesma audit`);
  } else {
    lines.push("prod: audit não acionada");
  }
  if (regression) {
    lines.push("→ introduzido (ou agravado) pela migração");
  }
  return lines.join("\n");
}

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

function fmtKb(bytes: number): string {
  return `${(bytes / 1024).toFixed(0)} KB`;
}
