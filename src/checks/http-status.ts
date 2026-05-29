import type { CheckResult, Issue } from "../types/schema.ts";
import type { CheckContext } from "./index.ts";
import { pairCaptures } from "./lib/pairing.ts";

export function httpStatusParity(ctx: CheckContext): CheckResult {
  const start = Date.now();
  // Single-site mode (parity e2e: prod slot empty by convention). With no prod
  // baseline, every captured cand page would otherwise be flagged as "missing
  // in prod" — pure noise. Skip when prod is the empty side. If cand is the
  // empty side (legitimate regression: prod captured but cand didn't), keep
  // the existing comparative behaviour so we still surface the regression.
  if (ctx.prodPages.length === 0 && ctx.candPages.length > 0) {
    return {
      name: "http-status-parity",
      status: "skipped",
      severity: "critical",
      durationMs: Date.now() - start,
      summary: "comparativo desabilitado: rodando em single-site (sem baseline prod)",
      issues: [],
      data: { pairs: 0, orphansProd: 0, orphansCand: 0 },
    };
  }
  const { pairs, orphansProd, orphansCand } = pairCaptures(ctx.prodPages, ctx.candPages);
  const issues: Issue[] = [];

  for (const pair of pairs) {
    if (pair.prod.status !== pair.cand.status) {
      issues.push({
        id: `http-status:${pair.key}`,
        severity: "critical",
        category: "functional",
        page: pair.key,
        check: "http-status-parity",
        summary: `Status divergente em ${pair.key}: prod=${pair.prod.status} cand=${pair.cand.status}`,
        evidence: [
          { kind: "screenshot", path: pair.prod.screenshotPath, label: "prod" },
          { kind: "screenshot", path: pair.cand.screenshotPath, label: "cand" },
        ],
      });
    }
  }

  for (const p of orphansProd) {
    issues.push({
      id: `http-status:missing-cand:${p.url}`,
      severity: "high",
      category: "functional",
      page: p.url,
      check: "http-status-parity",
      summary: `Página presente em prod mas não capturada em cand: ${p.url}`,
      evidence: [{ kind: "screenshot", path: p.screenshotPath, label: "prod" }],
    });
  }
  for (const p of orphansCand) {
    issues.push({
      id: `http-status:missing-prod:${p.url}`,
      severity: "low",
      category: "functional",
      page: p.url,
      check: "http-status-parity",
      summary: `Página presente em cand mas não em prod: ${p.url}`,
      evidence: [{ kind: "screenshot", path: p.screenshotPath, label: "cand" }],
    });
  }

  return {
    name: "http-status-parity",
    status: issues.some((i) => i.severity === "critical") ? "fail" : issues.length ? "warn" : "pass",
    severity: "critical",
    durationMs: Date.now() - start,
    summary: `${pairs.length} pares verificados, ${issues.length} divergência(s)`,
    issues,
    data: { pairs: pairs.length, orphansProd: orphansProd.length, orphansCand: orphansCand.length },
  };
}
