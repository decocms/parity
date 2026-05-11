import type { CheckResult, Issue } from "../types/schema.ts";
import type { CheckContext } from "./index.ts";
import { pairCaptures } from "./lib/pairing.ts";

export function httpStatusParity(ctx: CheckContext): CheckResult {
  const start = Date.now();
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
