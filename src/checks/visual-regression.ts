import { existsSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { snapshotDom } from "../diff/dom.ts";
import { diffScreenshots } from "../diff/visual.ts";
import { isLlmAvailable } from "../llm/client.ts";
import { LLM_PROMPT_VERSION, visualSemanticDiff } from "../llm/visual-semantic-diff.ts";
import type {
  CheckResult,
  Issue,
  VisualDiffPage,
  VisualDiffSummary,
  VisualDifference,
} from "../types/schema.ts";
import type { CheckContext } from "./index.ts";
import { pairCaptures, type PagePair } from "./lib/pairing.ts";
import {
  getCacheEntry,
  hashScreenshotPair,
  readCache,
  setCacheEntry,
  writeCache,
  type ParityCache,
} from "./lib/parity-cache.ts";

/** Pixelmatch threshold — pixels that differ by this much are flagged. */
const PIXEL_THRESHOLD = 0.1;
/**
 * Hard cap on LLM visual-diff calls per run. Override via the
 * `PARITY_MAX_LLM_CALLS` env var when you need a deeper sweep — the cache
 * means re-runs typically stay well under the cap anyway.
 */
const DEFAULT_MAX_LLM_CALLS_PER_RUN = 24;
/** Pages below this pct diff get verdict "pass" (skip LLM call to save budget). */
const PASS_PCT_THRESHOLD = 0.005;
/**
 * When the LLM is skipped (budget exhausted) AND pctDiff is at or above this
 * threshold, mark the page as "diffs" instead of falling through to "pass".
 *
 * Set at 15% as a deliberate compromise: real storefronts routinely show
 * 30–60% pctDiff from anti-aliasing, font loading, image compression, and
 * carousel/banner rotation, so any threshold smaller than ~15% would flood
 * the report with false positives when the LLM is skipped. Picking 15%
 * means: if it's THIS much different and we couldn't get a semantic read,
 * surface it for human review rather than silently labeling it OK.
 */
const SUSPICIOUS_PCT_DIFF_WHEN_LLM_SKIPPED = 0.15;

function getMaxLlmCalls(): number {
  const env = process.env.PARITY_MAX_LLM_CALLS;
  if (env === undefined || env === "") return DEFAULT_MAX_LLM_CALLS_PER_RUN;
  const n = Number.parseInt(env, 10);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_MAX_LLM_CALLS_PER_RUN;
  return n; // 0 explicitly disables LLM calls (cap honored as-is)
}

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

/**
 * Section names rendered into `data-section` that strongly suggest a rotating
 * carousel / slider in the hero region. When the SAME pattern appears on both
 * prod and cand, slide-state mismatches at screenshot time are timing noise,
 * not real regressions — both sides legitimately have the same component, the
 * carousel just auto-advanced to a different frame on each side.
 */
const CAROUSEL_SECTION_RE = /(carousel|slider)/i;

function hasCarouselSection(sections: string[]): boolean {
  return sections.some((s) => CAROUSEL_SECTION_RE.test(s));
}

/**
 * SAFETY NET (issue #22). The primary defense is in
 * `src/engine/carousel-stabilizer.ts` which pins every detected carousel
 * to slide 0 BEFORE the screenshot fires. The stabilizer covers the
 * common libraries (Swiper, Splide, slick, KeenSlider) plus the
 * generic [data-section] scroll-reset fallback. Exotic carousels can
 * still slip through.
 *
 * For those, when BOTH sides expose a carousel-named section, we
 * downgrade hero-region diffs to `low` — BUT only the diff types that
 * are inherent to slide-framing/timing.
 *
 * Cubic flagged on PR #32 that the previous version also downgraded
 * `missing-component` and `extra-component`. Those are STRUCTURAL —
 * "a whole banner/section is gone" is a real regression, not framing.
 * They are now excluded from the safety net so the original severity
 * (typically `critical`/`high` from the LLM) survives.
 *
 * Types kept in the safety net (framing/timing only):
 *  - different-component:  same slot, different visible content (= different slide)
 *  - image-diff:           same slot, different image at compare time (= different slide)
 *  - text-changed:         same slot, different caption text (= different slide)
 */
function downgradeCarouselFramingDiffs(
  diffs: VisualDifference[],
  bothHaveCarousel: boolean,
): VisualDifference[] {
  if (!bothHaveCarousel) return diffs;
  const CAROUSEL_FRAME_TYPES = new Set<VisualDifference["type"]>([
    "different-component",
    "image-diff",
    "text-changed",
  ]);
  return diffs.map((d) => {
    if (d.region !== "hero") return d;
    if (!CAROUSEL_FRAME_TYPES.has(d.type)) return d;
    if (d.severity === "low") return d;
    return {
      ...d,
      severity: "low" as const,
      description: `${d.description} [downgraded: ambos os lados expõem um carousel/slider — provável diferença só de slide ativo no momento da captura]`,
    };
  });
}

/**
 * Detection that the LLM-reported description likely refers to a
 * skeleton/loading state rather than a missing component. Catches both
 * Portuguese and English wording the model tends to emit, since the prompt
 * mixes languages.
 */
const SKELETON_DESCRIPTION_RE =
  /skeleton|placeholder|shimmer|loading|carregando|esqueleto|esquemático|cinza|gray box|gray card|empty card|empty placeholder|loader/i;

/**
 * Safety net for skeleton-vs-loaded diffs the LLM emits as critical/high
 * despite the prompt rule. When the two sides have an imbalanced skeleton
 * count AND the description hints at a loading state, downgrade to `low`.
 *
 * Mirrors the carousel downgrade in spirit — we'd rather over-downgrade a
 * flaky-timing diff than have it pollute the parity verdict. Real
 * "missing-component" diffs (whole section truly absent) don't match this
 * pattern because the LLM describes them with concrete component names,
 * not "skeleton" / "placeholder".
 */
function downgradeSkeletonImbalanceDiffs(
  diffs: VisualDifference[],
  prodSkeletonCount: number,
  candSkeletonCount: number,
): VisualDifference[] {
  if (Math.abs(prodSkeletonCount - candSkeletonCount) < SKELETON_IMBALANCE_THRESHOLD) {
    return diffs;
  }
  const heavier = prodSkeletonCount > candSkeletonCount ? "prod" : "cand";
  return diffs.map((d) => {
    if (d.severity === "low") return d;
    // Only downgrade missing/different-component patterns — color/style
    // diffs aren't usually skeleton-related and shouldn't get muted.
    const eligible: VisualDifference["type"][] = [
      "missing-component",
      "different-component",
      "extra-component",
    ];
    if (!eligible.includes(d.type)) return d;
    if (!SKELETON_DESCRIPTION_RE.test(d.description)) return d;
    return {
      ...d,
      severity: "low" as const,
      description: `${d.description} [downgraded: skeleton-vs-loaded — ${heavier} ainda tinha placeholders carregando quando a screenshot foi tirada; provável timing noise]`,
    };
  });
}

/**
 * When the difference between the two sides' skeleton counts crosses this
 * threshold, we treat the imbalance as a real timing signal (one side hadn't
 * resolved its fetch). Used both to inform the LLM prompt and to gate the
 * post-process downgrade. 5 is chosen empirically: a typical Deco home page
 * has 1-2 skeleton-flavored elements baseline (loading SVGs, brand
 * shimmers), and a single missing shelf adds 4+ skeleton cards.
 */
const SKELETON_IMBALANCE_THRESHOLD = 5;

/**
 * Per-pair intermediate state computed in pass 1 (pixelmatch + DOM extraction
 * + cache lookup) and consumed in pass 2 (priorized LLM calls).
 */
interface PreparedPair {
  pair: PagePair;
  heatmapPath: string;
  heatmapWritten: boolean;
  pctDiff: number;
  prodSections: string[];
  candSections: string[];
  sectionsOnlyInProd: string[];
  sectionsOnlyInCand: string[];
  bothHaveCarousel: boolean;
  prodSkeletonCount: number;
  candSkeletonCount: number;
  hash?: string;
  cacheHit?: {
    differences: VisualDifference[];
    cachedAt: string;
    verdict: VisualDiffPage["verdict"];
  };
  preflightIssues: Issue[];
}

function decideVerdict(args: {
  llmError?: string;
  llmCalled: boolean;
  differences: VisualDifference[];
  sectionsOnlyInProd: string[];
  pctDiff: number;
}): VisualDiffPage["verdict"] {
  const hasCritical = args.differences.some(
    (d) => d.severity === "critical" || d.severity === "high",
  );
  const hasAnyDiff = args.differences.length > 0 || args.sectionsOnlyInProd.length > 0;
  if (args.llmError) return "failed";
  if (hasCritical) return "diffs";
  if (hasAnyDiff) return "diffs";
  // Fix for the silent-OK bug: when the LLM didn't run, we don't have a
  // semantic read on the page. If pctDiff is meaningfully large we can't
  // claim "pass" with a straight face — fall through to "diffs" so the
  // page surfaces in the report for human inspection.
  if (!args.llmCalled && args.pctDiff >= SUSPICIOUS_PCT_DIFF_WHEN_LLM_SKIPPED) return "diffs";
  return "pass";
}

export async function visualRegressionKeyframes(ctx: CheckContext): Promise<CheckResult> {
  const start = Date.now();
  const { pairs } = pairCaptures(ctx.prodPages, ctx.candPages);
  const issues: Issue[] = [];
  const diffDir = join(ctx.outDir, "screenshots");
  if (!existsSync(diffDir)) mkdirSync(diffDir, { recursive: true });

  const useLlm = isLlmAvailable();
  const maxLlmCalls = getMaxLlmCalls();
  let llmCallsUsed = 0;

  // ─── Pass 1 ── pixelmatch + DOM + cache lookup, no LLM yet ────────────
  const cache: ParityCache = ctx.cacheDir && !ctx.noCache ? readCache(ctx.cacheDir) : {};
  const prepared: PreparedPair[] = [];

  for (const pair of pairs) {
    if (!existsSync(pair.prod.screenshotPath) || !existsSync(pair.cand.screenshotPath)) {
      continue;
    }
    const heatmapName = `diff-${pair.viewport}-${basename(pair.key.replace(/[/:]/g, "_"))}.png`;
    const heatmapPath = join(diffDir, heatmapName);
    const preflightIssues: Issue[] = [];

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
      preflightIssues.push({
        id: `visual:error:${pair.key}`,
        severity: "low",
        category: "visual",
        page: pair.key,
        check: "visual-regression-keyframes",
        summary: `Falha ao comparar screenshots em ${pair.key}: ${(err as Error).message}`,
      });
    }

    const prodSnapshot = pair.prod.html ? snapshotDom(pair.prod.html) : null;
    const candSnapshot = pair.cand.html ? snapshotDom(pair.cand.html) : null;
    const prodSections = prodSnapshot?.decoSectionsRendered ?? [];
    const candSections = candSnapshot?.decoSectionsRendered ?? [];
    const candSet = new Set(candSections);
    const prodSet = new Set(prodSections);
    const sectionsOnlyInProd = prodSections.filter((s) => !candSet.has(s));
    const sectionsOnlyInCand = candSections.filter((s) => !prodSet.has(s));
    const prodSkeletonCount = prodSnapshot?.skeletonCount ?? 0;
    const candSkeletonCount = candSnapshot?.skeletonCount ?? 0;

    const bothHaveCarousel =
      hasCarouselSection(prodSections) && hasCarouselSection(candSections);

    let hash: string | undefined;
    let cacheHit: PreparedPair["cacheHit"];
    if (ctx.cacheDir && !ctx.noCache) {
      try {
        hash = hashScreenshotPair(
          pair.prod.screenshotPath,
          pair.cand.screenshotPath,
          LLM_PROMPT_VERSION,
        );
        const entry = getCacheEntry(cache, hash, LLM_PROMPT_VERSION);
        if (entry) {
          cacheHit = {
            differences: entry.differences,
            cachedAt: entry.cachedAt,
            verdict: entry.verdict,
          };
        }
      } catch {
        // Hashing failed (e.g. file disappeared mid-run) — proceed without cache.
      }
    }

    prepared.push({
      pair,
      heatmapPath,
      heatmapWritten,
      pctDiff,
      prodSections,
      candSections,
      sectionsOnlyInProd,
      sectionsOnlyInCand,
      bothHaveCarousel,
      prodSkeletonCount,
      candSkeletonCount,
      hash,
      cacheHit,
      preflightIssues,
    });
  }

  // ─── Pass 2 ── pick which prepared pairs need a (fresh) LLM call ──────
  // Order: pages with section drift first, then by descending pctDiff. We
  // spend the LLM budget on the pages most likely to surface real diffs,
  // not just the first N entries of the crawl order.
  const llmCandidates = prepared
    .filter((p) => !p.cacheHit) // cache hit already has a verdict, no LLM needed
    .filter((p) => {
      const trivial =
        p.pctDiff < PASS_PCT_THRESHOLD && p.sectionsOnlyInProd.length === 0;
      return !trivial;
    })
    .sort((a, b) => {
      const aMissing = a.sectionsOnlyInProd.length > 0 ? 1 : 0;
      const bMissing = b.sectionsOnlyInProd.length > 0 ? 1 : 0;
      if (aMissing !== bMissing) return bMissing - aMissing;
      return b.pctDiff - a.pctDiff;
    });

  const llmTargets = new Set(useLlm ? llmCandidates.slice(0, maxLlmCalls) : []);

  // ─── Pass 3 ── execute LLM calls + finalize each result ──────────────
  const results: VisualDiffPage[] = [];
  let pagesFromCache = 0;

  for (const p of prepared) {
    issues.push(...p.preflightIssues);

    let differences: VisualDifference[] = [];
    let llmCalled = false;
    let llmError: string | undefined;
    let cachedAt: string | undefined;

    if (p.cacheHit) {
      differences = p.cacheHit.differences;
      cachedAt = p.cacheHit.cachedAt;
      pagesFromCache++;
    } else if (llmTargets.has(p)) {
      llmCallsUsed++;
      llmCalled = true;
      try {
        const diffs = await visualSemanticDiff({
          prodPath: p.pair.prod.screenshotPath,
          candPath: p.pair.cand.screenshotPath,
          heatmapPath: p.heatmapWritten ? p.heatmapPath : undefined,
          pctDiff: p.pctDiff,
          pageContext: p.pair.key,
          viewport: p.pair.viewport,
          prodSections: p.prodSections,
          candSections: p.candSections,
          sectionsOnlyInProd: p.sectionsOnlyInProd,
          bothHaveCarousel: p.bothHaveCarousel,
          prodSkeletonCount: p.prodSkeletonCount,
          candSkeletonCount: p.candSkeletonCount,
        });
        differences = diffs ?? [];
      } catch (err) {
        llmError = (err as Error).message;
      }
    }

    if (differences.length > 0) {
      differences = downgradeCarouselFramingDiffs(differences, p.bothHaveCarousel);
      differences = downgradeSkeletonImbalanceDiffs(
        differences,
        p.prodSkeletonCount,
        p.candSkeletonCount,
      );
    }

    const verdict = decideVerdict({
      llmError,
      llmCalled: llmCalled || Boolean(p.cacheHit),
      differences,
      sectionsOnlyInProd: p.sectionsOnlyInProd,
      pctDiff: p.pctDiff,
    });

    // Store fresh verdicts in the cache. We skip "failed" (LLM error) so a
    // transient outage doesn't pin a bad verdict, and we also skip pages we
    // didn't actually evaluate (no cache hit and no LLM call) since their
    // verdict is purely heuristic from pctDiff alone.
    if (ctx.cacheDir && !ctx.noCache && !p.cacheHit && p.hash && llmCalled && !llmError) {
      setCacheEntry(cache, p.hash, {
        verdict,
        differences,
        sectionsOnlyInProd: p.sectionsOnlyInProd,
        sectionsOnlyInCand: p.sectionsOnlyInCand,
        pctDiff: p.pctDiff,
        llmPromptVersion: LLM_PROMPT_VERSION,
        cachedAt: new Date().toISOString(),
      });
    }

    results.push({
      pageKey: p.pair.key,
      pagePath: pathFromKey(p.pair.key),
      pageLabel: labelForKey(p.pair.key),
      viewport: p.pair.viewport,
      prodUrl: p.pair.prod.finalUrl || p.pair.prod.url,
      candUrl: p.pair.cand.finalUrl || p.pair.cand.url,
      prodScreenshotPath: p.pair.prod.screenshotPath,
      candScreenshotPath: p.pair.cand.screenshotPath,
      heatmapPath: p.heatmapWritten ? p.heatmapPath : undefined,
      pctDiff: p.pctDiff,
      verdict,
      prodSections: p.prodSections,
      candSections: p.candSections,
      sectionsOnlyInProd: p.sectionsOnlyInProd,
      sectionsOnlyInCand: p.sectionsOnlyInCand,
      differences,
      llmCalled,
      llmError,
      cachedAt,
    });

    if (p.sectionsOnlyInProd.length > 0) {
      issues.push({
        id: `visual:sections:${p.pair.key}`,
        severity: "high",
        category: "visual",
        page: p.pair.key,
        check: "visual-regression-keyframes",
        summary: `${p.sectionsOnlyInProd.length} section(s) ausente(s) em cand: ${p.sectionsOnlyInProd.join(", ")}`,
        details: `Sections detectadas no DOM de prod via data-section, mas ausentes em cand:\n${p.sectionsOnlyInProd.map((s) => `- ${s}`).join("\n")}\n\nProvavelmente faltam em registerSections() em src/setup.ts, ou o CMS não está resolvendo essas keys em cand.`,
        evidence: [
          { kind: "screenshot", path: p.pair.prod.screenshotPath, label: "prod" },
          { kind: "screenshot", path: p.pair.cand.screenshotPath, label: "cand" },
          ...(p.heatmapWritten
            ? [{ kind: "screenshot" as const, path: p.heatmapPath, label: "heatmap" }]
            : []),
        ],
      });
    }
    for (const [i, d] of differences.entries()) {
      issues.push({
        id: `visual:semantic:${p.pair.key}:${i}`,
        severity: severityForDiff(d),
        category: "visual",
        page: p.pair.key,
        check: "visual-regression-keyframes",
        summary: `[${d.region}] ${d.description}`,
        details: `Tipo: ${d.type}\nRegião: ${d.region}\nSeveridade: ${d.severity}`,
        evidence: [
          { kind: "screenshot", path: p.pair.prod.screenshotPath, label: "prod" },
          { kind: "screenshot", path: p.pair.cand.screenshotPath, label: "cand" },
          ...(p.heatmapWritten
            ? [{ kind: "screenshot" as const, path: p.heatmapPath, label: "heatmap" }]
            : []),
        ],
      });
    }
  }

  // Persist the (possibly updated) cache. Best-effort — a write failure
  // shouldn't fail the run, just disable caching for next time.
  if (ctx.cacheDir && !ctx.noCache) {
    try {
      writeCache(ctx.cacheDir, cache);
    } catch (err) {
      console.error(`[parity-cache] write failed: ${(err as Error).message}`);
    }
  }

  const pagesWithDiffs = results.filter((r) => r.verdict === "diffs").length;
  const pagesFailed = results.filter((r) => r.verdict === "failed").length;
  const pagesPassed = results.filter((r) => r.verdict === "pass").length;

  const summary: VisualDiffSummary = {
    results,
    pagesChecked: results.length,
    pagesWithDiffs,
    pagesPassed,
    pagesFailed,
    llmCallsUsed,
    parityOk: pagesWithDiffs === 0 && pagesFailed === 0,
    pagesFromCache,
  };

  const cacheNote = pagesFromCache > 0 ? `, ${pagesFromCache} via cache` : "";
  const summaryText = useLlm
    ? `${results.length} par(es) comparado(s), ${pagesWithDiffs} com diffs, ${pagesPassed} OK, ${llmCallsUsed} análise(s) via LLM${cacheNote}`
    : `${results.length} par(es) comparado(s), ${pagesWithDiffs} com diffs · LLM desabilitado (set ANTHROPIC_API_KEY pra análise semântica)`;

  return {
    name: "visual-regression-keyframes",
    status: pagesWithDiffs > 0
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
