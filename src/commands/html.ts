import chalk from "chalk";
import * as cheerio from "cheerio";
import * as diff from "diff";
import prettier from "prettier";
import { launchBrowser, newContext } from "../engine/browser.ts";
import type { Viewport } from "../types/schema.ts";

export interface HtmlOptions {
  /** Single-side mode: dump HTML of this URL. */
  url?: string;
  /** Diff mode: compare both URLs. */
  prod?: string;
  /** Diff mode: compare both URLs. */
  cand?: string;
  /** Optional CSS selector to narrow the output to a single element. */
  selector?: string;
  /** Format the HTML with prettier before printing. */
  pretty?: boolean;
  /** Diff mode flag — prints a unified diff between prod and cand. */
  diff?: boolean;
  /** Viewport (controls UA + dimensions; matters for SSR sites). */
  viewport: string;
  /** Extra ms to wait after networkidle before snapshotting (number after commander coercion, but `parseWaitMs` accepts string for tests). */
  wait: number | string;
  /** Emit one-line JSON instead of pretty text. */
  json?: boolean;
}

/**
 * `parity html` — single-page HTML dump or prod-vs-cand HTML diff (issue #31, PR 2).
 *
 * Designed for sub-10s debug loops where `parity run`'s full pipeline is
 * overkill. Two modes:
 *
 *   1. Single-side dump: `parity html --url X [--selector S] [--pretty]`
 *      Loads X, optionally narrows to a CSS selector, prints HTML to stdout.
 *
 *   2. Diff: `parity html --prod P --cand C [--selector S]`
 *      Loads both, narrows to selector (or whole document), prints unified
 *      diff with chalk colors.
 *
 * Uses the same `newContext` + page settle as `capturePage(fast:true)` so the
 * UA pinning and carousel stabilizer are applied uniformly.
 */
export async function htmlCommand(opts: HtmlOptions): Promise<number> {
  const viewport = parseViewport(opts.viewport);
  if (!viewport) {
    console.error(chalk.red(`viewport inválido: ${opts.viewport} (use mobile|desktop|tablet)`));
    return 2;
  }
  // Strict parse: Number.parseInt would silently truncate "5abc" → 5.
  // We refuse anything that isn't a clean non-negative integer string.
  const waitMs = parseWaitMs(opts.wait);
  if (waitMs === null) {
    console.error(chalk.red(`--wait inválido: ${opts.wait} (precisa ser inteiro >= 0)`));
    return 2;
  }

  const mode = resolveMode(opts);
  if (mode.kind === "error") {
    console.error(chalk.red(mode.message));
    return 2;
  }

  const browser = await launchBrowser({ headless: true });
  try {
    if (mode.kind === "single") {
      const html = await fetchSnapshot(browser, mode.url, viewport, waitMs);
      const piece = extractSelector(html, opts.selector);
      if (piece.error) {
        console.error(chalk.red(piece.error));
        return 2;
      }
      if (piece.warning) console.error(chalk.yellow(`  ⚠ ${piece.warning}`));
      const finalText = await maybePretty(piece.html, opts.pretty === true);
      if (opts.json) {
        console.log(
          JSON.stringify({
            url: mode.url,
            viewport,
            selector: opts.selector ?? null,
            html: finalText,
          }),
        );
      } else {
        console.log(finalText);
      }
      return 0;
    }
    // Diff mode
    const [prodHtml, candHtml] = await Promise.all([
      fetchSnapshot(browser, mode.prod, viewport, waitMs),
      fetchSnapshot(browser, mode.cand, viewport, waitMs),
    ]);
    const prodPiece = extractSelector(prodHtml, opts.selector);
    const candPiece = extractSelector(candHtml, opts.selector);
    if (prodPiece.error) {
      console.error(chalk.red(`prod: ${prodPiece.error}`));
      return 2;
    }
    if (candPiece.error) {
      console.error(chalk.red(`cand: ${candPiece.error}`));
      return 2;
    }
    if (prodPiece.warning) console.error(chalk.yellow(`  ⚠ prod: ${prodPiece.warning}`));
    if (candPiece.warning) console.error(chalk.yellow(`  ⚠ cand: ${candPiece.warning}`));
    const [prodFmt, candFmt] = await Promise.all([
      maybePretty(prodPiece.html, opts.pretty !== false),
      maybePretty(candPiece.html, opts.pretty !== false),
    ]);
    if (opts.json) {
      const patch = diff.createPatch(opts.selector ?? "document", prodFmt, candFmt, "prod", "cand");
      console.log(
        JSON.stringify({
          prod: mode.prod,
          cand: mode.cand,
          viewport,
          selector: opts.selector ?? null,
          prodHtml: prodFmt,
          candHtml: candFmt,
          diff: patch,
        }),
      );
    } else {
      const patch = diff.createPatch(opts.selector ?? "document", prodFmt, candFmt, "prod", "cand");
      console.log(formatPatch(patch));
    }
    // Exit 1 if there's any diff content. The previous regex test on the
    // patch text broke for content lines that BEGAN with "--" or "++"
    // (false negatives — `<!-- comment -->` chunks in the diff slipped
    // through). Use the structured form from jsdiff instead: anything
    // marked `added` or `removed` is a real diff.
    const hasDiff = diff
      .diffLines(prodFmt, candFmt)
      .some((part) => part.added === true || part.removed === true);
    return hasDiff ? 1 : 0;
  } finally {
    await browser.close().catch(() => undefined);
  }
}

type Mode =
  | { kind: "single"; url: string }
  | { kind: "diff"; prod: string; cand: string }
  | { kind: "error"; message: string };

export function resolveMode(opts: HtmlOptions): Mode {
  const hasUrl = Boolean(opts.url);
  const hasPair = Boolean(opts.prod && opts.cand);
  if (hasUrl && hasPair) {
    return {
      kind: "error",
      message: "use --url SOZINHO (single-side) ou --prod + --cand (diff). Não combine.",
    };
  }
  if (hasUrl && opts.url) {
    if (!isValidUrl(opts.url)) return { kind: "error", message: `--url inválido: ${opts.url}` };
    return { kind: "single", url: opts.url };
  }
  if (hasPair && opts.prod && opts.cand) {
    if (!isValidUrl(opts.prod)) return { kind: "error", message: `--prod inválido: ${opts.prod}` };
    if (!isValidUrl(opts.cand)) return { kind: "error", message: `--cand inválido: ${opts.cand}` };
    if (opts.diff !== true) {
      // Allow --prod/--cand without --diff (just dumps both side-by-side),
      // but warn that --diff is the intended UX.
      return {
        kind: "error",
        message:
          "passe --diff junto com --prod/--cand pra ver o unified diff (ou use --url single-side)",
      };
    }
    return { kind: "diff", prod: opts.prod, cand: opts.cand };
  }
  return {
    kind: "error",
    message: "modo não definido: passe --url (single) ou --prod + --cand + --diff (diff)",
  };
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

async function fetchSnapshot(
  browser: Awaited<ReturnType<typeof launchBrowser>>,
  url: string,
  viewport: Viewport,
  waitMs: number,
): Promise<string> {
  const ctx = await newContext(browser, { viewport });
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
    if (waitMs > 0) await page.waitForTimeout(waitMs);
    return await page.content();
  } finally {
    await page.close().catch(() => undefined);
    await ctx.close().catch(() => undefined);
  }
}

export interface ExtractResult {
  html: string;
  /** Filled when the selector returned zero matches. */
  error?: string;
  /** Set when the selector matched >1 elements (we picked the first). */
  warning?: string;
}

/**
 * Pull the HTML of a CSS selector out of a page snapshot, or return the whole
 * document when no selector is given. Returns `outerHTML` of the first match.
 * Cheerio handles the parse and the selector engine (CSS3-ish).
 */
export function extractSelector(html: string, selector: string | undefined): ExtractResult {
  if (!selector) return { html };
  let $: ReturnType<typeof cheerio.load>;
  try {
    $ = cheerio.load(html);
  } catch (err) {
    return { html: "", error: `falha ao parsear HTML: ${(err as Error).message}` };
  }
  let matches: ReturnType<typeof $>;
  try {
    matches = $(selector);
  } catch (err) {
    return { html: "", error: `seletor inválido '${selector}': ${(err as Error).message}` };
  }
  if (matches.length === 0) {
    return { html: "", error: `seletor '${selector}' não casou nenhum elemento` };
  }
  // Cheerio's .toString() on a wrapped element gives the outerHTML.
  const first = matches.first();
  const out = $.html(first);
  // The previous implementation also printed the warning to stderr inside
  // this function, which made `extractSelector` impure and made callers
  // double-print when they wanted to surface the warning themselves. Pure
  // now: only return the data, let the caller decide how to render.
  const warning =
    matches.length > 1
      ? `seletor '${selector}' casou ${matches.length} elementos — usando o primeiro`
      : undefined;
  return { html: out, warning };
}

/**
 * Strict integer parser for CLI `--wait` arg. Accepts only clean
 * non-negative integers expressed as digits (no trailing junk like
 * "5abc", no NaN, no negatives, no decimals). Returns null on rejection
 * so callers can branch instead of accepting silently-truncated input.
 */
export function parseWaitMs(raw: string | number | undefined): number | null {
  if (typeof raw === "number")
    return Number.isFinite(raw) && raw >= 0 && Number.isInteger(raw) ? raw : null;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

async function maybePretty(html: string, enabled: boolean): Promise<string> {
  if (!enabled) return html;
  try {
    return await prettier.format(html, {
      parser: "html",
      printWidth: 100,
      htmlWhitespaceSensitivity: "ignore",
    });
  } catch {
    // Prettier can choke on invalid/partial HTML — fall back to raw.
    return html;
  }
}

/**
 * Take a unified diff patch text and color it: green for additions, red for
 * removals, dim for hunk headers. Skips the `--- prod` / `+++ cand` header
 * lines pretty-printer emits at the top (we already know which side is which).
 */
function formatPatch(patch: string): string {
  const lines = patch.split("\n");
  const out: string[] = [];
  for (const line of lines) {
    if (line.startsWith("Index:") || line.startsWith("===")) continue;
    if (line.startsWith("---") || line.startsWith("+++")) {
      out.push(chalk.dim(line));
      continue;
    }
    if (line.startsWith("@@")) {
      out.push(chalk.cyan(line));
      continue;
    }
    if (line.startsWith("+")) {
      out.push(chalk.green(line));
      continue;
    }
    if (line.startsWith("-")) {
      out.push(chalk.red(line));
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}
