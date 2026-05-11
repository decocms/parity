import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { diffScreenshots } from "../diff/visual.ts";
import type { CheckResult, Issue } from "../types/schema.ts";
import type { CheckContext } from "./index.ts";
import { pairCaptures } from "./lib/pairing.ts";

export function visualRegressionKeyframes(ctx: CheckContext): CheckResult {
  const start = Date.now();
  const { pairs } = pairCaptures(ctx.prodPages, ctx.candPages);
  const issues: Issue[] = [];
  const diffDir = join(ctx.outDir, "screenshots");
  if (!existsSync(diffDir)) mkdirSync(diffDir, { recursive: true });

  for (const pair of pairs) {
    if (!existsSync(pair.prod.screenshotPath) || !existsSync(pair.cand.screenshotPath)) {
      continue;
    }
    const heatmapName = `diff-${pair.viewport}-${basename(pair.key.replace(/[/:]/g, "_"))}.png`;
    const heatmapPath = join(diffDir, heatmapName);
    try {
      const result = diffScreenshots(pair.prod.screenshotPath, pair.cand.screenshotPath, heatmapPath, {
        maxPctDiff: 0.02,
        threshold: 0.1,
      });
      if (!result.passed) {
        issues.push({
          id: `visual:${pair.key}`,
          severity: "high",
          category: "visual",
          page: pair.key,
          check: "visual-regression-keyframes",
          summary: `Regressão visual em ${pair.key} (${(result.pctDiff * 100).toFixed(2)}% pixels diff)`,
          evidence: [
            { kind: "screenshot", path: pair.prod.screenshotPath, label: "prod" },
            { kind: "screenshot", path: pair.cand.screenshotPath, label: "cand" },
            { kind: "screenshot", path: heatmapPath, label: "heatmap" },
          ],
        });
      }
    } catch (err) {
      issues.push({
        id: `visual:error:${pair.key}`,
        severity: "low",
        category: "visual",
        page: pair.key,
        check: "visual-regression-keyframes",
        summary: `Falha ao comparar screenshots em ${pair.key}: ${(err as Error).message}`,
      });
    }
  }
  void dirname;

  return {
    name: "visual-regression-keyframes",
    status: issues.some((i) => i.severity === "high") ? "fail" : issues.length ? "warn" : "pass",
    severity: "high",
    durationMs: Date.now() - start,
    summary: `${pairs.length} pares comparados, ${issues.length} regressão(ões)`,
    issues,
  };
}
