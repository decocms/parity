import { snapshotDom } from "../diff/dom.ts";
import type { BannerImage } from "../diff/dom.ts";
import type { CheckResult, Issue } from "../types/schema.ts";
import type { CheckContext } from "./index.ts";
import { pairCaptures } from "./lib/pairing.ts";

/**
 * Banner aspect ratio parity check (issue #23).
 *
 * Catches a class of bug that visual-regression-keyframes misses: hero/
 * banner images rendered at the wrong proportions after a Fresh → TanStack
 * migration. Two failure modes show up in real migrations:
 *
 *   1. Mobile banner rendered at desktop proportions (or vice-versa) because
 *      `isMobile` was undefined in the migrated section, so the wrong asset
 *      variant was picked.
 *   2. width/height attributes dropped on cand even though prod declares
 *      them — CLS goes up because the browser can no longer reserve the
 *      slot before the image decodes.
 *
 * Strategy: extract `width`/`height` attributes from images that look like
 * banners (inside a carousel/slider/banner/hero data-section, or wider than
 * BANNER_WIDTH_THRESHOLD), pair by index across prod and cand, and flag
 * aspect-ratio deltas above the tolerance.
 */

/** Aspect-ratio delta below which we don't bother reporting. */
const ASPECT_RATIO_TOLERANCE = 0.15; // 15%

interface BannerCmp {
  index: number;
  prod: BannerImage;
  cand: BannerImage;
}

export function bannerAspectRatio(ctx: CheckContext): CheckResult {
  const start = Date.now();
  const { pairs } = pairCaptures(ctx.prodPages, ctx.candPages);
  const issues: Issue[] = [];
  let pagesChecked = 0;
  let pagesWithIssues = 0;

  for (const pair of pairs) {
    if (!pair.prod.html || !pair.cand.html) continue;
    pagesChecked++;
    const prodBanners = snapshotDom(pair.prod.html).imageStats.banners;
    const candBanners = snapshotDom(pair.cand.html).imageStats.banners;
    if (prodBanners.length === 0 && candBanners.length === 0) continue;

    const pageIssuesBefore = issues.length;
    const len = Math.min(prodBanners.length, candBanners.length);
    const comparisons: BannerCmp[] = [];
    for (let i = 0; i < len; i++) {
      const prod = prodBanners[i];
      const cand = candBanners[i];
      if (prod && cand) comparisons.push({ index: i, prod, cand });
    }

    for (const cmp of comparisons) {
      issues.push(...issuesForPair(pair.key, cmp));
    }

    if (prodBanners.length !== candBanners.length) {
      issues.push({
        id: `banner-aspect:count:${pair.key}`,
        severity: "medium",
        category: "visual",
        page: pair.key,
        check: "banner-aspect-ratio",
        summary: `Banner count divergente em ${pair.key}: prod=${prodBanners.length}, cand=${candBanners.length}`,
      });
    }

    if (issues.length > pageIssuesBefore) pagesWithIssues++;
  }

  const status: CheckResult["status"] = issues.some(
    (i) => i.severity === "high" || i.severity === "critical",
  )
    ? "fail"
    : issues.length > 0
      ? "warn"
      : "pass";

  return {
    name: "banner-aspect-ratio",
    status,
    severity: "medium",
    durationMs: Date.now() - start,
    summary: `${pagesChecked} página(s) analisada(s), ${pagesWithIssues} com diferença de aspect ratio em banner`,
    issues,
    data: { pagesChecked, pagesWithIssues },
  };
}

function issuesForPair(pageKey: string, cmp: BannerCmp): Issue[] {
  const { prod, cand, index } = cmp;
  const out: Issue[] = [];
  const label = describeBanner(prod) || describeBanner(cand) || `banner #${index + 1}`;

  // 1. cand dropped width/height attrs that prod had.
  const prodHasDims = prod.width !== null && prod.height !== null;
  const candHasDims = cand.width !== null && cand.height !== null;
  if (prodHasDims && !candHasDims) {
    out.push({
      id: `banner-aspect:missing-dims:${pageKey}:${index}`,
      severity: "medium",
      category: "performance",
      page: pageKey,
      check: "banner-aspect-ratio",
      summary: `Atributos width/height ausentes em cand para ${label} (prod=${prod.width}×${prod.height}). Aumenta CLS porque o navegador não consegue reservar o slot antes da imagem decodificar.`,
    });
  }

  // 2. aspect-ratio drifted beyond tolerance.
  //    HIGH severity is reserved for a true wide↔tall orientation flip
  //    (e.g. prod renders a landscape banner where cand renders a portrait
  //    one — strongest signal that the mobile variant was rendered at
  //    desktop dimensions or vice-versa). Any other shape change
  //    (wide↔near-square, tall↔near-square) is `medium`.
  if (prod.aspectRatio !== null && cand.aspectRatio !== null) {
    const ratioDelta = Math.abs(prod.aspectRatio - cand.aspectRatio) / prod.aspectRatio;
    if (ratioDelta >= ASPECT_RATIO_TOLERANCE) {
      const shape = (r: number) => (r > 1.5 ? "wide" : r < 0.8 ? "tall" : "near-square");
      const prodShape = shape(prod.aspectRatio);
      const candShape = shape(cand.aspectRatio);
      const orientationFlipped =
        (prodShape === "wide" && candShape === "tall") ||
        (prodShape === "tall" && candShape === "wide");
      out.push({
        id: `banner-aspect:ratio:${pageKey}:${index}`,
        severity: orientationFlipped ? "high" : "medium",
        category: "visual",
        page: pageKey,
        check: "banner-aspect-ratio",
        summary: `Aspect ratio divergente em ${label}: prod=${prod.width}×${prod.height} (${prod.aspectRatio.toFixed(2)}) vs cand=${cand.width}×${cand.height} (${cand.aspectRatio.toFixed(2)}) — Δ${(ratioDelta * 100).toFixed(0)}%${orientationFlipped ? ` (${prodShape} ↔ ${candShape}, provável variante mobile/desktop trocada)` : ""}`,
      });
    }
  }

  return out;
}

function describeBanner(b: BannerImage): string | null {
  if (b.sectionName) return `${b.sectionName} banner`;
  const fname = b.src.split("?")[0]?.split("/").pop();
  return fname ? `banner '${fname.slice(0, 40)}'` : null;
}
