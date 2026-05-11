import { existsSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { diffScreenshots } from "../diff/visual.ts";
import { isLlmAvailable } from "../llm/client.ts";
import { visualSemanticDiff } from "../llm/visual-semantic-diff.ts";
import type { CheckResult, Issue } from "../types/schema.ts";
import type { CheckContext } from "./index.ts";
import { pairCaptures } from "./lib/pairing.ts";

/** When pixel-diff exceeds this fraction, ask the LLM for a semantic interpretation. */
const SEMANTIC_DIFF_TRIGGER_PCT = 0.02;
/** Hard cap on LLM visual-diff calls per run to keep cost bounded. */
const MAX_LLM_CALLS_PER_RUN = 6;

export async function visualRegressionKeyframes(ctx: CheckContext): Promise<CheckResult> {
  const start = Date.now();
  const { pairs } = pairCaptures(ctx.prodPages, ctx.candPages);
  const issues: Issue[] = [];
  const diffDir = join(ctx.outDir, "screenshots");
  if (!existsSync(diffDir)) mkdirSync(diffDir, { recursive: true });

  const useLlm = isLlmAvailable();
  let llmCallsUsed = 0;

  for (const pair of pairs) {
    if (!existsSync(pair.prod.screenshotPath) || !existsSync(pair.cand.screenshotPath)) {
      continue;
    }
    const heatmapName = `diff-${pair.viewport}-${basename(pair.key.replace(/[/:]/g, "_"))}.png`;
    const heatmapPath = join(diffDir, heatmapName);
    try {
      const result = diffScreenshots(pair.prod.screenshotPath, pair.cand.screenshotPath, heatmapPath, {
        maxPctDiff: SEMANTIC_DIFF_TRIGGER_PCT,
        threshold: 0.1,
      });
      if (!result.passed) {
        // Base issue from pixelmatch
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

        // LLM-driven semantic analysis (only when budget allows + API key present)
        if (useLlm && llmCallsUsed < MAX_LLM_CALLS_PER_RUN) {
          llmCallsUsed++;
          const diffs = await visualSemanticDiff({
            prodPath: pair.prod.screenshotPath,
            candPath: pair.cand.screenshotPath,
            pageContext: pair.key,
            viewport: pair.viewport,
          });
          if (diffs && diffs.length > 0) {
            for (const [i, d] of diffs.entries()) {
              issues.push({
                id: `visual:semantic:${pair.key}:${i}`,
                severity: d.severity,
                category: "visual",
                page: pair.key,
                check: "visual-regression-keyframes",
                summary: `[${d.region}] ${d.description}`,
                details: `Tipo: ${d.type}\nRegião: ${d.region}\nSeveridade: ${d.severity}`,
                evidence: [
                  { kind: "screenshot", path: pair.prod.screenshotPath, label: "prod" },
                  { kind: "screenshot", path: pair.cand.screenshotPath, label: "cand" },
                  { kind: "screenshot", path: heatmapPath, label: "heatmap" },
                ],
              });
            }
          }
        }
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

  const summary = useLlm
    ? `${pairs.length} pares comparados, ${issues.length} issue(s), ${llmCallsUsed} análise(s) semântica(s) via LLM`
    : `${pairs.length} pares comparados, ${issues.length} regressão(ões) (LLM desabilitado — set ANTHROPIC_API_KEY pra análise semântica)`;

  return {
    name: "visual-regression-keyframes",
    status: issues.some((i) => i.severity === "critical" || i.severity === "high")
      ? "fail"
      : issues.length
        ? "warn"
        : "pass",
    severity: "high",
    durationMs: Date.now() - start,
    summary,
    issues,
  };
}
