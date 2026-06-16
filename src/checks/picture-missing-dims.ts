import * as cheerio from "cheerio";
import type { CheckResult, Issue, PageCapture } from "../types/schema.ts";
import type { CheckContext } from "./index.ts";

/**
 * Picture-without-dimensions CLS detector (issue #54, Tier 0).
 *
 * Root cause from the bagaggio migration: components rendered
 *
 *   <Picture>
 *     <Source media="..." srcset="..."/>
 *     <Source media="..." srcset="..."/>
 *     <img src="fallback.jpg" />                  ← no width/height
 *   </Picture>
 *
 * The browser uses `<source>` to pick a srcset but has no fallback
 * dimensions for layout reservation. On slow networks the surrounding
 * content shifted 100–300 px when each image finished decoding.
 *
 * This check is a static HTML scan of the candidate side. It does NOT
 * compare against prod because the goal is to catch dimensions missing
 * in cand REGARDLESS of whether prod had them — those are real CLS
 * sources for the cand user. Severity `medium` because CLS already
 * has its own check; this complements with per-element attribution.
 *
 * Tier 0 of the issue #54 epic. Other Tier 0 checks
 * (hydration-mutation, pre-hydration MutationObserver, CLS attribution)
 * need browser-side instrumentation and ship as separate PRs.
 */

export function pictureMissingDims(ctx: CheckContext): CheckResult {
  const start = Date.now();
  const issues: Issue[] = [];
  const offendersByPage = new Map<string, string[]>();

  for (const cand of ctx.candPages) {
    const offenders = scanForPictureMissingDims(cand);
    if (offenders.length > 0) {
      offendersByPage.set(`${cand.viewport}:${cand.url}`, offenders);
    }
  }

  for (const [key, offenders] of offendersByPage) {
    issues.push({
      id: `picture-missing-dims:${key}`,
      severity: "medium",
      category: "performance",
      page: key,
      check: "picture-missing-dims",
      summary: `${offenders.length} <Picture><img/> sem width/height em ${key} — risco de CLS`,
      details: [
        "Picture/img fallbacks sem width+height fazem o browser não reservar espaço",
        "antes do decode. Em network lento, isso vira layout-shift visível.",
        "",
        "Elementos afetados (até 10 mostrados):",
        ...offenders.slice(0, 10).map((s, i) => `  ${i + 1}. ${s}`),
        offenders.length > 10 ? `  … e mais ${offenders.length - 10}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
      suggestedFix:
        "Adicione width + height (ou aspect-ratio) ao <img> dentro do <Picture>. Use as dimensões intrínsecas da imagem ou as do design (a media query é tratada pelo <source>).",
    });
  }

  const status: CheckResult["status"] = issues.length > 0 ? "warn" : "pass";
  return {
    name: "picture-missing-dims",
    status,
    severity: "medium",
    durationMs: Date.now() - start,
    summary:
      issues.length === 0
        ? `${ctx.candPages.length} página(s) sem <Picture><img/> sem dimensões`
        : `${issues.length} página(s) com <Picture><img/> sem width/height`,
    issues,
    data: { pagesScanned: ctx.candPages.length, pagesWithOffenders: issues.length },
  };
}

/**
 * Scan the HTML of a single page for `<picture>` elements whose inner
 * `<img>` is missing width or height attributes. Returns a short
 * description per offender (selector hint + src) so the user can
 * locate it in the source quickly.
 */
export function scanForPictureMissingDims(page: PageCapture): string[] {
  if (!page.html) return [];
  const $ = cheerio.load(page.html);
  const offenders: string[] = [];
  $("picture").each((_, pic) => {
    $(pic)
      .find("img")
      .each((_imgIdx, img) => {
        const $img = $(img);
        if (hasReservedSpace($img)) return;
        const src = $img.attr("src") ?? $img.attr("data-src") ?? "(no src)";
        const cls = $img.attr("class");
        const desc = cls ? `<img class="${cls.slice(0, 40)}"… src="${src.slice(0, 80)}">` : `<img src="${src.slice(0, 80)}">`;
        offenders.push(desc);
      });
  });
  return offenders;
}

/**
 * True when the `<img>` has *any* form of layout-reservation hint that
 * the browser can use to avoid CLS. We accept three signals (review
 * feedback on PR #65):
 *
 *  1. `width` AND `height` HTML attributes (classic, explicit).
 *  2. Inline `style="aspect-ratio: …"` (modern CSS path; case-
 *     insensitive match. The check's own `suggestedFix` recommends
 *     this approach — flagging it would be ironic).
 *  3. Inline `style="width:…; height:…"` (functionally equivalent to (1)).
 *
 * Empty-string attrs (e.g. `width=""`) are treated as MISSING — they
 * don't reserve space either.
 */
type CheerioImg = ReturnType<cheerio.CheerioAPI>;
function hasReservedSpace($img: CheerioImg): boolean {
  const w = $img.attr("width");
  const h = $img.attr("height");
  if (w && h) return true;
  const style = $img.attr("style") ?? "";
  if (/aspect-ratio\s*:/i.test(style)) return true;
  // both width and height in style
  const styleHasWidth = /(^|;)\s*width\s*:/i.test(style);
  const styleHasHeight = /(^|;)\s*height\s*:/i.test(style);
  if (styleHasWidth && styleHasHeight) return true;
  return false;
}
