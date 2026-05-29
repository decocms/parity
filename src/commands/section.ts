import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import chalk from "chalk";
import * as cheerio from "cheerio";
import * as diff from "diff";
import prettier from "prettier";
import type { BrowserContext, Page } from "playwright";
import { stabilizeCarousels } from "../engine/carousel-stabilizer.ts";
import { launchBrowser, newContext } from "../engine/browser.ts";
import {
  type ComputedStylesNotFound,
  type ComputedStylesResult,
  SECTION_STYLE_KEYS,
  readComputedStyles,
} from "../engine/computed-styles.ts";
import { traceLoadedPage } from "./css-trace.ts";
import { type CssSource, resolveFromTrace } from "../engine/css-source-resolver.ts";
import { diffScreenshots } from "../diff/visual.ts";
import { analyzeHeatmapRegions } from "../diff/heatmap-regions.ts";
import { assembleSectionDiffBundle } from "../diff/section-bundle.ts";
import {
  invokeUnderstandingSummary,
  isUnderstandingAvailable,
} from "../llm/section-understanding.ts";
import type { Viewport } from "../types/schema.ts";

export interface SectionOptions {
  prod: string;
  cand: string;
  selector: string;
  outputHtml?: boolean;
  screenshot?: boolean;
  computedStyles?: boolean;
  /** Run pixelmatch + bounding-box analysis on the two screenshots. */
  heatmap?: boolean;
  /** For every divergent computed-style property, resolve which CSS rule produces it. */
  cssSource?: boolean;
  /** Emit a `<prefix>-bundle.json` + `<prefix>-prompt.md` LLM-ready bundle. */
  prompt?: boolean;
  /** Invoke Claude (Vision) with the bundle and print the 1-paragraph summary. */
  llmSummary?: boolean;
  viewport: string;
  wait: string;
  outDir: string;
  json?: boolean;
}

/**
 * `parity section` — focused prod×cand comparison of a single section
 * (issue #31, PR 3).
 *
 * Three optional facets, all opt-in via flags:
 *
 *   --output-html      Prettier-formatted HTML diff between prod and cand
 *                      (uses jsdiff createPatch + chalk like `parity html`).
 *
 *   --screenshot       page.locator(selector).screenshot() on each side,
 *                      AFTER stabilizeCarousels() pins frames so the
 *                      shots are comparable. Writes to <outDir>/<hash>-{prod,cand}.png.
 *
 *   --computed-styles  Reads SECTION_STYLE_KEYS via readComputedStyles()
 *                      on each side; prints a key-by-key diff with
 *                      hiddenByPlaywright + boundingClientRect for the
 *                      "in DOM but invisible" diagnostic the issue calls
 *                      out as the main motivator.
 *
 * If no facet flag is passed, all three are enabled — the typical "show
 * me everything about this section" invocation.
 */
export async function sectionCommand(opts: SectionOptions): Promise<number> {
  const viewport = parseViewport(opts.viewport);
  if (!viewport) {
    console.error(chalk.red(`viewport inválido: ${opts.viewport} (use mobile|desktop|tablet)`));
    return 2;
  }
  const waitMs = Number.parseInt(opts.wait, 10);
  if (!Number.isFinite(waitMs) || waitMs < 0) {
    console.error(chalk.red(`--wait inválido: ${opts.wait}`));
    return 2;
  }
  if (!opts.selector || opts.selector.trim().length === 0) {
    console.error(chalk.red("--selector é obrigatório"));
    return 2;
  }
  if (!isValidUrl(opts.prod) || !isValidUrl(opts.cand)) {
    console.error(chalk.red("--prod ou --cand inválido"));
    return 2;
  }
  // Default behaviour: if user passed NONE of the facet flags, enable all.
  // The bundle/heatmap/css-source/prompt/llm-summary flags are ADDITIVE — they
  // never count as "facets asked"; without them the command stays identical
  // to its pre-bundle behavior.
  const facetsAsked =
    Boolean(opts.outputHtml) || Boolean(opts.screenshot) || Boolean(opts.computedStyles);
  const want = {
    html: facetsAsked ? Boolean(opts.outputHtml) : true,
    screenshot: facetsAsked ? Boolean(opts.screenshot) : true,
    styles: facetsAsked ? Boolean(opts.computedStyles) : true,
    heatmap: Boolean(opts.heatmap),
    cssSource: Boolean(opts.cssSource),
    prompt: Boolean(opts.prompt) || Boolean(opts.llmSummary),
    llmSummary: Boolean(opts.llmSummary),
  };
  // Screenshots are a hard prerequisite for the heatmap; force them on
  // silently so `--heatmap` alone "just works".
  if (want.heatmap) want.screenshot = true;

  mkdirSync(opts.outDir, { recursive: true });
  const hash = hashSelector(opts.selector);
  const filePrefix = `section-${hash}-${viewport}`;
  const screenshotPaths = {
    prod: resolve(opts.outDir, `${filePrefix}-prod.png`),
    cand: resolve(opts.outDir, `${filePrefix}-cand.png`),
  };
  const heatmapPath = resolve(opts.outDir, `${filePrefix}-heatmap.png`);

  const browser = await launchBrowser({ headless: true });
  try {
    const [prodSide, candSide] = await Promise.all([
      gatherSide(browser, {
        url: opts.prod,
        viewport,
        waitMs,
        selector: opts.selector,
        wantScreenshot: want.screenshot,
        wantStyles: want.styles,
        wantHtml: want.html,
        wantCssSource: want.cssSource,
        screenshotPath: screenshotPaths.prod,
      }),
      gatherSide(browser, {
        url: opts.cand,
        viewport,
        waitMs,
        selector: opts.selector,
        wantScreenshot: want.screenshot,
        wantStyles: want.styles,
        wantHtml: want.html,
        wantCssSource: want.cssSource,
        screenshotPath: screenshotPaths.cand,
      }),
    ]);

    const heatmap = want.heatmap
      ? computeHeatmap(prodSide, candSide, screenshotPaths, heatmapPath)
      : null;

    const bundlePaths = want.prompt
      ? await buildPromptBundle({
          opts,
          viewport,
          prodSide,
          candSide,
          screenshotPaths,
          heatmapPath: heatmap?.wrote ? heatmapPath : undefined,
          heatmap: heatmap?.analysis ?? undefined,
          filePrefix,
        })
      : null;

    let llmSummary: string | null = null;
    if (want.llmSummary && bundlePaths) {
      llmSummary = await maybeRunLlmSummary({
        markdownPath: bundlePaths.markdownPath,
        screenshotPaths,
        heatmapPath: heatmap?.wrote ? heatmapPath : undefined,
      });
    }

    if (opts.json) {
      console.log(
        JSON.stringify({
          prod: opts.prod,
          cand: opts.cand,
          selector: opts.selector,
          viewport,
          prodSide,
          candSide,
          screenshotPaths: want.screenshot ? screenshotPaths : null,
          heatmap: heatmap?.analysis ?? null,
          heatmapPath: heatmap?.wrote ? heatmapPath : null,
          bundle: bundlePaths,
          llmSummary,
        }),
      );
      return verdict(prodSide, candSide);
    }
    await printResults({ opts, viewport, prodSide, candSide, screenshotPaths, want });
    if (heatmap) printHeatmap(heatmap, heatmapPath);
    if (bundlePaths) printBundlePaths(bundlePaths);
    if (llmSummary) printLlmSummary(llmSummary);
    return verdict(prodSide, candSide);
  } finally {
    await browser.close().catch(() => undefined);
  }
}

export interface SideData {
  html: string | null;
  htmlError?: string;
  styles: ComputedStylesResult | ComputedStylesNotFound | null;
  screenshotTaken: boolean;
  screenshotError?: string;
  /** Map<property, CssSource | null> when --css-source was on. */
  cssSources?: Map<string, CssSource | null>;
  cssSourceError?: string;
}

async function gatherSide(
  browser: Awaited<ReturnType<typeof launchBrowser>>,
  opts: {
    url: string;
    viewport: Viewport;
    waitMs: number;
    selector: string;
    wantHtml: boolean;
    wantScreenshot: boolean;
    wantStyles: boolean;
    wantCssSource: boolean;
    screenshotPath: string;
  },
): Promise<SideData> {
  const ctx: BrowserContext = await newContext(browser, { viewport: opts.viewport });
  const page = await ctx.newPage();
  const result: SideData = {
    html: null,
    styles: null,
    screenshotTaken: false,
  };
  try {
    await page.goto(opts.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
    if (opts.waitMs > 0) await page.waitForTimeout(opts.waitMs);

    // Stabilize carousels BEFORE both the screenshot AND the computed-style
    // read — the issue's motivating bug involves a section that shifts
    // between visible/invisible mid-rotation. Cap at 3s so we never wedge.
    await Promise.race([
      stabilizeCarousels(page).catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
    ]);

    if (opts.wantHtml) {
      try {
        const fullHtml = await page.content();
        const $ = cheerio.load(fullHtml);
        const matches = $(opts.selector);
        if (matches.length === 0) {
          result.htmlError = `seletor '${opts.selector}' não casou nenhum elemento`;
        } else {
          result.html = $.html(matches.first());
        }
      } catch (err) {
        result.htmlError = `falha lendo HTML: ${(err as Error).message}`;
      }
    }

    if (opts.wantStyles) {
      result.styles = await readComputedStyles(page, opts.selector);
    }

    if (opts.wantCssSource) {
      try {
        const trace = await traceLoadedPage(page, opts.url, opts.selector);
        if (trace.found) {
          result.cssSources = resolveFromTrace(trace, SECTION_STYLE_KEYS);
        } else {
          result.cssSourceError = `tracePage não encontrou '${opts.selector}'`;
        }
      } catch (err) {
        result.cssSourceError = `tracePage falhou: ${(err as Error).message}`;
      }
    }

    if (opts.wantScreenshot) {
      await captureSectionScreenshot(page, opts.selector, opts.screenshotPath).then(
        (err) => {
          if (err) result.screenshotError = err;
          else result.screenshotTaken = true;
        },
      );
    }
  } finally {
    await page.close().catch(() => undefined);
    await ctx.close().catch(() => undefined);
  }
  return result;
}

async function captureSectionScreenshot(
  page: Page,
  selector: string,
  outPath: string,
): Promise<string | null> {
  try {
    const loc = page.locator(selector).first();
    if ((await loc.count()) === 0) {
      return `seletor '${selector}' não casou nenhum elemento`;
    }
    await loc.scrollIntoViewIfNeeded({ timeout: 3_000 }).catch(() => undefined);
    await loc.screenshot({ path: outPath, timeout: 8_000 });
    return null;
  } catch (err) {
    return `falha no screenshot: ${(err as Error).message}`;
  }
}

function isValidUrl(s: string): boolean {
  try {
    new URL(s);
    return true;
  } catch {
    return false;
  }
}

export function parseViewport(raw: string): Viewport | null {
  if (raw === "mobile" || raw === "desktop" || raw === "tablet") return raw;
  return null;
}

/**
 * 8-char hex hash of a selector — used to name screenshot files so multiple
 * `parity section` runs in the same outDir don't clobber each other. Not a
 * cryptographic hash; just enough to dedupe.
 */
export function hashSelector(selector: string): string {
  let h = 0;
  for (let i = 0; i < selector.length; i++) {
    h = (h << 5) - h + selector.charCodeAt(i);
    h |= 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0").slice(0, 8);
}

export function verdict(prod: SideData, cand: SideData): number {
  // Exit 1 when prod and cand disagree on ANYTHING the pretty output
  // surfaces — HTML, styles, hidden status, OR bounding rect. Cubic
  // flagged that the previous verdict missed boundingRect even though
  // `printStylesDiff` prints it as a row: a section that grew by 200px
  // would show in the human output but a CI script reading the exit
  // code would still see 0. Now consistent.
  if (prod.htmlError || cand.htmlError) return 1;
  if (prod.styles && "found" in prod.styles && cand.styles && "found" in cand.styles) {
    if (prod.styles.found && cand.styles.found) {
      for (const k of SECTION_STYLE_KEYS) {
        if (prod.styles.styles[k] !== cand.styles.styles[k]) return 1;
      }
      if (prod.styles.hiddenByPlaywright !== cand.styles.hiddenByPlaywright) return 1;
      // Bounding-rect dimensions: same predicate `printStylesDiff` uses
      // to decide whether to surface the (boundingRect) row.
      const pr = prod.styles.rect;
      const cr = cand.styles.rect;
      if (pr && cr && (pr.width !== cr.width || pr.height !== cr.height)) return 1;
    } else if (prod.styles.found !== cand.styles.found) {
      return 1;
    }
  }
  if (prod.html && cand.html) {
    // Quick equality first to skip the formatter cost when HTML matches.
    if (prod.html !== cand.html) return 1;
  }
  return 0;
}

async function printResults(args: {
  opts: SectionOptions;
  viewport: Viewport;
  prodSide: SideData;
  candSide: SideData;
  screenshotPaths: { prod: string; cand: string };
  want: { html: boolean; screenshot: boolean; styles: boolean };
}): Promise<void> {
  const { opts, viewport, prodSide, candSide, screenshotPaths, want } = args;

  console.log(chalk.bold("\n  parity section"));
  console.log(chalk.dim(`  selector: ${opts.selector}`));
  console.log(chalk.dim(`  viewport: ${viewport}`));
  console.log(chalk.dim(`  prod:     ${opts.prod}`));
  console.log(chalk.dim(`  cand:     ${opts.cand}`));
  console.log("");

  if (want.html) await printHtmlDiff(prodSide, candSide, opts.selector);
  if (want.styles) printStylesDiff(prodSide, candSide);
  if (want.screenshot) printScreenshotPaths(prodSide, candSide, screenshotPaths);
}

async function printHtmlDiff(prod: SideData, cand: SideData, selector: string): Promise<void> {
  console.log(chalk.bold("  HTML diff"));
  if (prod.htmlError) {
    console.log(chalk.red(`    prod: ${prod.htmlError}`));
    return;
  }
  if (cand.htmlError) {
    console.log(chalk.red(`    cand: ${cand.htmlError}`));
    return;
  }
  if (!prod.html || !cand.html) {
    console.log(chalk.dim("    (nenhum lado tem HTML disponível)"));
    return;
  }
  const [prodFmt, candFmt] = await Promise.all([formatHtml(prod.html), formatHtml(cand.html)]);
  if (prodFmt === candFmt) {
    console.log(chalk.green("    ✓ idêntico após pretty-print"));
    console.log("");
    return;
  }
  const patch = diff.createPatch(selector, prodFmt, candFmt, "prod", "cand");
  console.log(colorPatch(patch));
  console.log("");
}

function printStylesDiff(prod: SideData, cand: SideData): void {
  console.log(chalk.bold("  Computed styles diff"));
  if (!prod.styles || !cand.styles) {
    console.log(chalk.dim("    (styles não foram coletados)"));
    return;
  }
  if (!prod.styles.found) {
    console.log(chalk.red(`    prod: ${prod.styles.error}`));
    return;
  }
  if (!cand.styles.found) {
    console.log(chalk.red(`    cand: ${cand.styles.error}`));
    return;
  }
  const rows: Array<{ key: string; prod: string; cand: string }> = [];
  for (const k of SECTION_STYLE_KEYS) {
    const p = prod.styles.styles[k] ?? "";
    const c = cand.styles.styles[k] ?? "";
    if (p !== c) rows.push({ key: k, prod: p, cand: c });
  }
  if (prod.styles.hiddenByPlaywright !== cand.styles.hiddenByPlaywright) {
    rows.unshift({
      key: "(playwright isVisible)",
      prod: prod.styles.hiddenByPlaywright ? "hidden" : "visible",
      cand: cand.styles.hiddenByPlaywright ? "hidden" : "visible",
    });
  }
  const prodRect = prod.styles.rect;
  const candRect = cand.styles.rect;
  if (prodRect && candRect && (prodRect.width !== candRect.width || prodRect.height !== candRect.height)) {
    rows.unshift({
      key: "(boundingRect)",
      prod: `${prodRect.width}×${prodRect.height} @ ${prodRect.x},${prodRect.y}`,
      cand: `${candRect.width}×${candRect.height} @ ${candRect.x},${candRect.y}`,
    });
  }
  if (rows.length === 0) {
    console.log(chalk.green("    ✓ todos os SECTION_STYLE_KEYS são iguais"));
    console.log("");
    return;
  }
  const keyWidth = Math.max(...rows.map((r) => r.key.length));
  for (const r of rows) {
    console.log(
      `    ${chalk.cyan(r.key.padEnd(keyWidth))}  ${chalk.red(`prod=${r.prod || "(vazio)"}`)}  ${chalk.green(`cand=${r.cand || "(vazio)"}`)}`,
    );
  }
  console.log("");
}

function printScreenshotPaths(
  prod: SideData,
  cand: SideData,
  paths: { prod: string; cand: string },
): void {
  console.log(chalk.bold("  Screenshots"));
  if (prod.screenshotError) {
    console.log(chalk.red(`    prod: ${prod.screenshotError}`));
  } else if (prod.screenshotTaken) {
    console.log(`    prod: ${chalk.dim(paths.prod)}`);
  }
  if (cand.screenshotError) {
    console.log(chalk.red(`    cand: ${cand.screenshotError}`));
  } else if (cand.screenshotTaken) {
    console.log(`    cand: ${chalk.dim(paths.cand)}`);
  }
  console.log("");
}

async function formatHtml(raw: string): Promise<string> {
  try {
    return await prettier.format(raw, {
      parser: "html",
      printWidth: 100,
      htmlWhitespaceSensitivity: "ignore",
    });
  } catch {
    return raw;
  }
}

/**
 * Color a unified diff patch: green for added lines, red for removed,
 * cyan for hunk headers, dim for the file header rows.
 */
function colorPatch(patch: string): string {
  const lines = patch.split("\n");
  const out: string[] = [];
  for (const line of lines) {
    if (line.startsWith("Index:") || line.startsWith("===")) continue;
    if (line.startsWith("---") || line.startsWith("+++")) out.push(chalk.dim(line));
    else if (line.startsWith("@@")) out.push(chalk.cyan(line));
    else if (line.startsWith("+")) out.push(chalk.green(line));
    else if (line.startsWith("-")) out.push(chalk.red(line));
    else out.push(line);
  }
  return out.join("\n");
}

interface HeatmapState {
  wrote: boolean;
  analysis: ReturnType<typeof analyzeHeatmapRegions> | null;
  error?: string;
}

function computeHeatmap(
  prod: SideData,
  cand: SideData,
  paths: { prod: string; cand: string },
  heatmapPath: string,
): HeatmapState {
  if (!prod.screenshotTaken || !cand.screenshotTaken) {
    return {
      wrote: false,
      analysis: null,
      error: "heatmap pulado: um dos screenshots falhou",
    };
  }
  try {
    diffScreenshots(paths.prod, paths.cand, heatmapPath, { maxPctDiff: 1 });
    const analysis = analyzeHeatmapRegions(heatmapPath);
    return { wrote: true, analysis };
  } catch (err) {
    return { wrote: false, analysis: null, error: (err as Error).message };
  }
}

async function buildPromptBundle(args: {
  opts: SectionOptions;
  viewport: Viewport;
  prodSide: SideData;
  candSide: SideData;
  screenshotPaths: { prod: string; cand: string };
  heatmapPath?: string;
  heatmap?: ReturnType<typeof analyzeHeatmapRegions>;
  filePrefix: string;
}): Promise<{ jsonPath: string; markdownPath: string; summary: string }> {
  const { opts, viewport, prodSide, candSide, screenshotPaths, heatmapPath, heatmap, filePrefix } =
    args;

  let htmlBundle: { prod: string; cand: string; diffPatch: string } | undefined;
  if (prodSide.html && candSide.html) {
    const [pFmt, cFmt] = await Promise.all([formatHtml(prodSide.html), formatHtml(candSide.html)]);
    htmlBundle = {
      prod: pFmt,
      cand: cFmt,
      diffPatch: diff.createPatch(opts.selector, pFmt, cFmt, "prod", "cand"),
    };
  }

  const computedStyles =
    prodSide.styles && candSide.styles
      ? { prod: prodSide.styles, cand: candSide.styles }
      : undefined;

  const cssSources =
    prodSide.cssSources && candSide.cssSources
      ? { prod: prodSide.cssSources, cand: candSide.cssSources }
      : undefined;

  const screenshots =
    prodSide.screenshotTaken && candSide.screenshotTaken
      ? {
          prodPath: screenshotPaths.prod,
          candPath: screenshotPaths.cand,
          heatmapPath,
        }
      : undefined;

  return assembleSectionDiffBundle({
    selector: opts.selector,
    pageKey: `${new URL(opts.prod).pathname}::${viewport}`,
    viewport,
    prodUrl: opts.prod,
    candUrl: opts.cand,
    html: htmlBundle,
    screenshots,
    heatmap,
    computedStyles,
    cssSources,
    outDir: opts.outDir,
    filePrefix,
  });
}

async function maybeRunLlmSummary(args: {
  markdownPath: string;
  screenshotPaths: { prod: string; cand: string };
  heatmapPath?: string;
}): Promise<string | null> {
  if (!isUnderstandingAvailable()) {
    console.warn(
      chalk.yellow(
        "  --llm-summary pulado: nenhum ANTHROPIC_API_KEY ou OPENROUTER_API_KEY configurado.",
      ),
    );
    return null;
  }
  const result = await invokeUnderstandingSummary({
    markdownPath: args.markdownPath,
    prodScreenshotPath: args.screenshotPaths.prod,
    candScreenshotPath: args.screenshotPaths.cand,
    heatmapPath: args.heatmapPath,
  });
  return result?.summary ?? null;
}

function printHeatmap(state: HeatmapState, heatmapPath: string): void {
  console.log(chalk.bold("  Heatmap"));
  if (state.error) {
    console.log(chalk.yellow(`    ${state.error}`));
    console.log("");
    return;
  }
  if (!state.analysis) {
    console.log(chalk.dim("    (sem dados de heatmap)"));
    console.log("");
    return;
  }
  const a = state.analysis;
  const pct = (a.pctDiff * 100).toFixed(2);
  console.log(`    ${chalk.cyan("diffPixels")}: ${a.diffPixels} (${pct}%)`);
  if (a.boundingBox) {
    const bb = a.boundingBox;
    console.log(
      `    ${chalk.cyan("boundingBox")}: x=${bb.x} y=${bb.y} w=${bb.width} h=${bb.height}`,
    );
  }
  if (a.hotspots.length > 0) {
    console.log(`    ${chalk.cyan("hotspots")}:`);
    for (const h of a.hotspots.slice(0, 5)) {
      console.log(`      (${h.x}, ${h.y}) ${h.width}×${h.height} — ${h.pixelCount} px`);
    }
  }
  console.log(`    ${chalk.dim(`heatmap: ${heatmapPath}`)}`);
  console.log("");
}

function printBundlePaths(b: { jsonPath: string; markdownPath: string; summary: string }): void {
  console.log(chalk.bold("  Bundle"));
  console.log(`    ${chalk.cyan("summary")}: ${b.summary}`);
  console.log(`    ${chalk.cyan("json")}:    ${chalk.dim(b.jsonPath)}`);
  console.log(`    ${chalk.cyan("prompt")}:  ${chalk.dim(b.markdownPath)}`);
  console.log("");
}

function printLlmSummary(summary: string): void {
  console.log(chalk.bold("  What the LLM understood"));
  console.log(`    ${summary.split("\n").join("\n    ")}`);
  console.log("");
}
