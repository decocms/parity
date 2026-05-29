import type { CheckResult, Issue, PageCapture } from "../types/schema.ts";
import type { CheckContext } from "./index.ts";

const PDP_PATH_REGEX = /\/p\/|\/products?\//i;

const GALLERY_MAIN_PATTERNS = [
  /data-gallery-main/i,
  /class="[^"]*gallery[^"]*main/i,
  /class="[^"]*productImageTag[^"]*main/i,
  /data-fs-product-images/i,
];
const GALLERY_THUMB_PATTERNS = [
  /data-gallery-thumb/i,
  /class="[^"]*gallery[^"]*thumb/i,
  /role="tab"[^>]+aria-controls="[^"]*gallery/i,
];
const RELATED_PATTERNS = [
  /data-related-products/i,
  /data-shelf="related"/i,
  /class="[^"]*related-products/i,
  /você também pode gostar/i,
  /produtos relacionados/i,
  /related products/i,
];

/**
 * On PDPs: verify gallery main image, thumbnails, and "related products"
 * shelf are present. Critical signals when cand loses gallery (broken
 * product page) or related shelf (lost cross-sell revenue).
 */
export function pdpGalleryRelated(ctx: CheckContext): CheckResult {
  const start = Date.now();
  const issues: Issue[] = [];

  const prodPdps = ctx.prodPages.filter(isPdp);
  const candPdps = ctx.candPages.filter(isPdp);
  if (prodPdps.length === 0 && candPdps.length === 0) {
    return {
      name: "pdp-gallery-related",
      status: "skipped",
      severity: "high",
      durationMs: Date.now() - start,
      summary: "Nenhuma captura de PDP no run",
      issues: [],
    };
  }

  const single = prodPdps.length === 0 || candPdps.length === 0;
  const sourcePages = single ? (candPdps.length > 0 ? candPdps : prodPdps) : candPdps;

  for (const page of sourcePages) {
    const pair = single
      ? undefined
      : prodPdps.find((p) => p.viewport === page.viewport);

    const hasGalleryMain = matchAny(page.html, GALLERY_MAIN_PATTERNS);
    const hasThumb = matchAny(page.html, GALLERY_THUMB_PATTERNS);
    const hasRelated = matchAny(page.html, RELATED_PATTERNS);

    if (single) {
      if (!hasGalleryMain) {
        issues.push({
          id: `pdp-gallery:${page.viewport}:no-main`,
          severity: "critical",
          category: "functional",
          check: "pdp-gallery-related",
          summary: `[${page.viewport}] PDP sem imagem principal de galeria detectável (${page.url})`,
          page: page.url,
        });
      }
      if (!hasThumb) {
        issues.push({
          id: `pdp-gallery:${page.viewport}:no-thumbs`,
          severity: "high",
          category: "functional",
          check: "pdp-gallery-related",
          summary: `[${page.viewport}] PDP sem thumbnails de galeria — usuário não consegue ver outras fotos`,
          page: page.url,
        });
      }
      if (!hasRelated) {
        issues.push({
          id: `pdp-gallery:${page.viewport}:no-related`,
          severity: "medium",
          category: "functional",
          check: "pdp-gallery-related",
          summary: `[${page.viewport}] PDP sem shelf "Related products" — cross-sell perdido`,
          page: page.url,
        });
      }
    } else if (pair) {
      const prodGallery = matchAny(pair.html, GALLERY_MAIN_PATTERNS);
      const prodThumb = matchAny(pair.html, GALLERY_THUMB_PATTERNS);
      const prodRelated = matchAny(pair.html, RELATED_PATTERNS);

      if (prodGallery && !hasGalleryMain) {
        issues.push({
          id: `pdp-gallery:${page.viewport}:lost-main`,
          severity: "critical",
          category: "functional",
          check: "pdp-gallery-related",
          summary: `[${page.viewport}] Imagem principal de PDP ausente em cand (presente em prod)`,
          page: page.url,
        });
      }
      if (prodThumb && !hasThumb) {
        issues.push({
          id: `pdp-gallery:${page.viewport}:lost-thumbs`,
          severity: "high",
          category: "functional",
          check: "pdp-gallery-related",
          summary: `[${page.viewport}] Thumbnails de PDP ausentes em cand (presentes em prod)`,
          page: page.url,
        });
      }
      if (prodRelated && !hasRelated) {
        issues.push({
          id: `pdp-gallery:${page.viewport}:lost-related`,
          severity: "medium",
          category: "functional",
          check: "pdp-gallery-related",
          summary: `[${page.viewport}] Shelf "Related products" ausente em cand — cross-sell perdido`,
          page: page.url,
        });
      }
    }
  }

  const status: CheckResult["status"] =
    issues.some((i) => i.severity === "critical")
      ? "fail"
      : issues.length > 0
        ? "warn"
        : "pass";

  return {
    name: "pdp-gallery-related",
    status,
    severity: "critical",
    durationMs: Date.now() - start,
    summary: `${issues.length} issue(s) — mode: ${single ? "single-site" : "comparative"}`,
    issues,
  };
}

function isPdp(page: PageCapture): boolean {
  return PDP_PATH_REGEX.test(page.url);
}

function matchAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((re) => re.test(text));
}
