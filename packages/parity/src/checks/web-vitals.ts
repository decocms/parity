import { DEFAULT_THRESHOLDS, diffVitals } from "../diff/vitals.ts";
import type { CheckResult, Issue } from "../types/schema.ts";
import type { CheckContext } from "./index.ts";
import { pairCaptures } from "./lib/pairing.ts";

export function webVitalsMobile(ctx: CheckContext): CheckResult {
  const start = Date.now();
  const { pairs } = pairCaptures(ctx.prodPages, ctx.candPages);
  const mobilePairs = pairs.filter((p) => p.viewport === "mobile");
  const issues: Issue[] = [];

  for (const pair of mobilePairs) {
    const diff = diffVitals(pair.prod.vitals, pair.cand.vitals, DEFAULT_THRESHOLDS);
    if (!diff.anyFailed) continue;

    const failed = (["lcp", "fcp", "ttfb", "inp", "cls"] as const).filter((k) => !diff[k].passed);
    const details = failed
      .map((k) => {
        const v = diff[k];
        return `${k.toUpperCase()}: prod=${fmt(v.prod)}, cand=${fmt(v.cand)} (${v.reason})`;
      })
      .join("\n");
    issues.push({
      id: `vitals:${pair.key}`,
      severity: "high",
      category: "performance",
      page: pair.key,
      check: "web-vitals-mobile",
      summary: `Regressão Web Vitals mobile em ${pair.key}: ${failed.map((f) => f.toUpperCase()).join(", ")}`,
      details,
      evidence: [
        { kind: "screenshot", path: pair.prod.screenshotPath, label: "prod" },
        { kind: "screenshot", path: pair.cand.screenshotPath, label: "cand" },
      ],
    });
  }

  return {
    name: "web-vitals-mobile",
    status: issues.length > 0 ? "fail" : "pass",
    severity: "high",
    durationMs: Date.now() - start,
    summary: `${mobilePairs.length} página(s) mobile, ${issues.length} regressão(ões)`,
    issues,
  };
}

function fmt(n: number | null): string {
  if (n == null) return "—";
  if (n >= 100) return `${n.toFixed(0)}ms`;
  return n.toFixed(3);
}
