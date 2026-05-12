import { existsSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { snapshotDom } from "../diff/dom.ts";
import { diffScreenshots } from "../diff/visual.ts";
import { isLlmAvailable } from "../llm/client.ts";
import { visualSemanticDiff } from "../llm/visual-semantic-diff.ts";
import type {
  CheckResult,
  Issue,
  VisualDiffPage,
  VisualDiffSummary,
  VisualDifference,
} from "../types/schema.ts";
import type { CheckContext } from "./index.ts";
import { pairCaptures } from "./lib/pairing.ts";

/** Pixelmatch threshold — pixels that differ by this much are flagged. */
const PIXEL_THRESHOLD = 0.1;
/** Hard cap on LLM visual-diff calls per run to keep cost bounded. */
const MAX_LLM_CALLS_PER_RUN = 12;
/** Pages below this pct diff get verdict "pass" (skip LLM call to save budget). */
const PASS_PCT_THRESHOLD = 0.005;

/**
 * Classify pageKey like `/::mobile` into a human label.
 */
function labelForKey(key: string): string {
  const [path = "/", viewport = ""] = key.split("::");
  const niceName = path === "/" || path === "" ? "Home" : path;
  return viewport ? `${niceName} · ${viewport}` : niceName;
}

function pathFromKey(key: string): string {
  return key.split("::")[0] ?? "/";
}

function severityForDiff(d: VisualDifference): Issue["severity"] {
  return d.severity;
}

export async function visualRegressionKeyframes(ctx: CheckContext): Promise<CheckResult> {
  const start = Date.now();
  const { pairs } = pairCaptures(ctx.prodPages, ctx.candPages);
  const issues: Issue[] = [];
  const diffDir = join(ctx.outDir, "screenshots");
  if (!existsSync(diffDir)) mkdirSync(diffDir, { recursive: true });

  const useLlm = isLlmAvailable();
  let llmCallsUsed = 0;
  const results: VisualDiffPage[] = [];

  for (const pair of pairs) {
    if (!existsSync(pair.prod.screenshotPath) || !existsSync(pair.cand.screenshotPath)) {
      continue;
    }
    const heatmapName = `diff-${pair.viewport}-${basename(pair.key.replace(/[/:]/g, "_"))}.png`;
    const heatmapPath = join(diffDir, heatmapName);

    let pctDiff = 0;
    let heatmapWritten = false;
    try {
      const r = diffScreenshots(pair.prod.screenshotPath, pair.cand.screenshotPath, heatmapPath, {
        maxPctDiff: 999, // never "fail" on pixelmatch — we use LLM for the real verdict
        threshold: PIXEL_THRESHOLD,
      });
      pctDiff = r.pctDiff;
      heatmapWritten = true;
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

    // Extract sections from both sides via DOM snapshot
    const prodSnapshot = pair.prod.html ? snapshotDom(pair.prod.html) : null;
    const candSnapshot = pair.cand.html ? snapshotDom(pair.cand.html) : null;
    const prodSections = prodSnapshot?.decoSectionsRendered ?? [];
    const candSections = candSnapshot?.decoSectionsRendered ?? [];
    const candSet = new Set(candSections);
    const prodSet = new Set(prodSections);
    const sectionsOnlyInProd = prodSections.filter((s) => !candSet.has(s));
    const sectionsOnlyInCand = candSections.filter((s) => !prodSet.has(s));

    // Always call LLM (if available) — pixelmatch is no longer the gate.
    // Skip only if pctDiff is extremely small AND no section mismatch (likely identical).
    const trivial = pctDiff < PASS_PCT_THRESHOLD && sectionsOnlyInProd.length === 0;
    let differences: VisualDifference[] = [];
    let llmCalled = false;
    let llmError: string | undefined;

    if (useLlm && !trivial && llmCallsUsed < MAX_LLM_CALLS_PER_RUN) {
      llmCallsUsed++;
      llmCalled = true;
      try {
        const diffs = await visualSemanticDiff({
          prodPath: pair.prod.screenshotPath,
          candPath: pair.cand.screenshotPath,
          pageContext: pair.key,
          viewport: pair.viewport,
          prodSections,
          candSections,
          sectionsOnlyInProd,
        });
        differences = diffs ?? [];
      } catch (err) {
        llmError = (err as Error).message;
      }
    }

    // Decide verdict
    let verdict: VisualDiffPage["verdict"];
    const hasCritical = differences.some((d) => d.severity === "critical" || d.severity === "high");
    const hasAnyDiff = differences.length > 0 || sectionsOnlyInProd.length > 0;
    if (llmError) verdict = "failed";
    else if (hasCritical) verdict = "diffs";
    else if (hasAnyDiff) verdict = "diffs";
    else verdict = "pass";

    results.push({
      pageKey: pair.key,
      pagePath: pathFromKey(pair.key),
      pageLabel: labelForKey(pair.key),
      viewport: pair.viewport,
      prodUrl: pair.prod.finalUrl || pair.prod.url,
      candUrl: pair.cand.finalUrl || pair.cand.url,
      prodScreenshotPath: pair.prod.screenshotPath,
      candScreenshotPath: pair.cand.screenshotPath,
      heatmapPath: heatmapWritten ? heatmapPath : undefined,
      pctDiff,
      verdict,
      prodSections,
      candSections,
      sectionsOnlyInProd,
      sectionsOnlyInCand,
      differences,
      llmCalled,
      llmError,
    });

    // Emit Issues for backwards compat with the Issues tab + aggregation
    if (sectionsOnlyInProd.length > 0) {
      issues.push({
        id: `visual:sections:${pair.key}`,
        severity: "high",
        category: "visual",
        page: pair.key,
        check: "visual-regression-keyframes",
        summary: `${sectionsOnlyInProd.length} section(s) ausente(s) em cand: ${sectionsOnlyInProd.join(", ")}`,
        details: `Sections detectadas no DOM de prod via data-section, mas ausentes em cand:\n${sectionsOnlyInProd.map((s) => `- ${s}`).join("\n")}\n\nProvavelmente faltam em registerSections() em src/setup.ts, ou o CMS não está resolvendo essas keys em cand.`,
        evidence: [
          { kind: "screenshot", path: pair.prod.screenshotPath, label: "prod" },
          { kind: "screenshot", path: pair.cand.screenshotPath, label: "cand" },
          ...(heatmapWritten ? [{ kind: "screenshot" as const, path: heatmapPath, label: "heatmap" }] : []),
        ],
      });
    }
    for (const [i, d] of differences.entries()) {
      issues.push({
        id: `visual:semantic:${pair.key}:${i}`,
        severity: severityForDiff(d),
        category: "visual",
        page: pair.key,
        check: "visual-regression-keyframes",
        summary: `[${d.region}] ${d.description}`,
        details: `Tipo: ${d.type}\nRegião: ${d.region}\nSeveridade: ${d.severity}`,
        evidence: [
          { kind: "screenshot", path: pair.prod.screenshotPath, label: "prod" },
          { kind: "screenshot", path: pair.cand.screenshotPath, label: "cand" },
          ...(heatmapWritten ? [{ kind: "screenshot" as const, path: heatmapPath, label: "heatmap" }] : []),
        ],
      });
    }
  }

  const summary: VisualDiffSummary = {
    results,
    pagesChecked: results.length,
    pagesWithDiffs: results.filter((r) => r.verdict === "diffs").length,
    pagesPassed: results.filter((r) => r.verdict === "pass").length,
    pagesFailed: results.filter((r) => r.verdict === "failed").length,
    llmCallsUsed,
  };

  const summaryText = useLlm
    ? `${results.length} par(es) comparado(s), ${summary.pagesWithDiffs} com diffs, ${summary.pagesPassed} OK, ${llmCallsUsed} análise(s) via LLM`
    : `${results.length} par(es) comparado(s), ${summary.pagesWithDiffs} com diffs · LLM desabilitado (set ANTHROPIC_API_KEY pra análise semântica)`;

  return {
    name: "visual-regression-keyframes",
    status: summary.pagesWithDiffs > 0
      ? issues.some((i) => i.severity === "critical" || i.severity === "high")
        ? "fail"
        : "warn"
      : "pass",
    severity: "high",
    durationMs: Date.now() - start,
    summary: summaryText,
    issues,
    data: { visualDiff: summary },
  };
}
