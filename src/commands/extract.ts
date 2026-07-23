import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import chalk from "chalk";
import { discoverPlpFromHome } from "../checks/plp-pagination.ts";
import { launchBrowser, newContext } from "../engine/browser.ts";
import { stabilizeCarousels } from "../engine/carousel-stabilizer.ts";
import { scrollFullPage, waitForSkeletonsToResolve } from "../engine/collect.ts";
import { detectComponents } from "../extract/detect-components.ts";
import { jsonExporter } from "../extract/exporters/json.ts";
import { markdownExporter } from "../extract/exporters/markdown.ts";
import { extractComponent } from "../extract/extract-component.ts";
import { componentDirName } from "../extract/naming.ts";
import type { ExtractBundle, ExtractedComponent, ExtractedPage } from "../types/extract.ts";
import type { Viewport } from "../types/schema.ts";
import { firstProductHrefFromPlpHtml } from "./run.ts";
import { parseViewport } from "./section.ts";

/**
 * `parity extract` (M5) — single-site, AI-ready component extraction.
 *
 * Unlike every other command in this CLI, this one does NOT compare prod
 * vs cand. It captures structured data (HTML, computed styles, screenshot,
 * assets, links, text) about ONE site's UI components — meant to feed an
 * AI agent doing a from-scratch migration where there's no source code to
 * read at all.
 *
 * Reuses the single-side capture primitives factored out of
 * `commands/section.ts`'s `gatherSide` (`engine/section-capture.ts`) —
 * see that module's header comment for why the page-level
 * navigate/stabilize/scroll dance stays here rather than moving into the
 * shared helper (it's a once-per-page-load concern, not once-per-selector).
 */
export interface ExtractOptions {
  url: string;
  pages?: string;
  components?: string;
  viewport: string;
  format: string;
  outDir: string;
  /** Skip the optional LLM component-relabeling pass. */
  noLlm?: boolean;
  json?: boolean;
}

interface ResolvedPage {
  /** Original `--pages` token (literal path, or "category-auto"/"pdp-auto"). */
  token: string;
  url: string;
}

export async function extractCommand(opts: ExtractOptions): Promise<number> {
  const viewport = parseViewport(opts.viewport);
  if (!viewport) {
    console.error(chalk.red(`viewport inválido: ${opts.viewport} (use mobile|desktop|tablet)`));
    return 2;
  }
  if (!isValidUrl(opts.url)) {
    console.error(chalk.red(`--url inválido: ${opts.url}`));
    return 2;
  }
  const format = normalizeFormat(opts.format);
  if (!format) {
    console.error(chalk.red(`--format inválido: ${opts.format} (use md|json|both)`));
    return 2;
  }
  const allowlist = parseAllowlist(opts.components);

  const host = safeHost(opts.url);
  const timestamp = new Date().toISOString();
  const runDirTimestamp = timestamp.replace(/[:.]/g, "-");
  const runDir = resolve(opts.outDir, host, runDirTimestamp);
  mkdirSync(runDir, { recursive: true });

  const browser = await launchBrowser({ headless: true });
  try {
    const resolvedPages = await resolvePages(opts.url, opts.pages);
    if (resolvedPages.length === 0) {
      console.error(chalk.red("nenhuma página resolvida a partir de --pages"));
      return 1;
    }

    let globalIndex = 0;
    const pages: ExtractedPage[] = [];
    const allComponents: ExtractedComponent[] = [];

    for (const target of resolvedPages) {
      const ctx = await newContext(browser, { viewport });
      const page = await ctx.newPage();
      try {
        await page.goto(target.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
        await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);

        // Same stabilization dance as `gatherSide` (issue #22 / #51) — a
        // page-level concern run once per navigation, before ANY per-
        // component read.
        await Promise.race([stabilizeCarousels(page).catch(() => undefined), sleep(3_000)]);
        const scrollBudget = 30_000;
        await Promise.race([
          scrollFullPage(page, scrollBudget).catch(() => undefined),
          sleep(scrollBudget + 2_000),
        ]);
        await Promise.race([
          waitForSkeletonsToResolve(page, 5_000).catch(() => undefined),
          sleep(5_000),
        ]);

        let detected = await detectComponents(page, { llm: !opts.noLlm });
        if (allowlist) {
          detected = detected.filter((c) => matchesAllowlist(c.role, allowlist));
        }

        // One full-page screenshot per page load, reused for every
        // detected component's crop (see `section-capture.ts` doc comment
        // on `preCapturedFullPng`).
        const pageScreenshot = await page
          .screenshot({ fullPage: true, animations: "disabled", timeout: 15_000 })
          .catch(() => undefined);

        const pageComponents: ExtractedComponent[] = [];
        for (const component of detected) {
          globalIndex++;
          const dirName = componentDirName(component.role, globalIndex);
          const componentDir = resolve(runDir, "components", dirName);
          const extracted = await extractComponent(page, component, {
            outDir: componentDir,
            index: globalIndex,
            pageScreenshot,
          });
          pageComponents.push(extracted);
          allComponents.push(extracted);
        }
        pages.push({ url: target.url, path: target.token, components: pageComponents });
      } finally {
        await page.close().catch(() => undefined);
        await ctx.close().catch(() => undefined);
      }
    }

    const bundle: ExtractBundle = {
      url: opts.url,
      timestamp,
      viewport,
      components: allComponents,
      pages,
    };

    if (format === "json" || format === "both") await jsonExporter.export(bundle, runDir);
    if (format === "md" || format === "both") await markdownExporter.export(bundle, runDir);

    if (opts.json) {
      console.log(JSON.stringify({ outDir: runDir, componentCount: allComponents.length, bundle }));
      return 0;
    }

    printResults(runDir, bundle);
    return 0;
  } finally {
    await browser.close().catch(() => undefined);
  }
}

function printResults(runDir: string, bundle: ExtractBundle): void {
  console.log(chalk.bold("\n  parity extract"));
  console.log(chalk.dim(`  url:      ${bundle.url}`));
  console.log(chalk.dim(`  viewport: ${bundle.viewport}`));
  console.log(chalk.dim(`  pages:    ${bundle.pages?.length ?? 0}`));
  console.log(chalk.dim(`  out:      ${runDir}`));
  console.log("");
  console.log(chalk.bold(`  ${bundle.components.length} component(s) detected:`));
  for (const c of bundle.components) {
    console.log(`    ${chalk.cyan(c.role.padEnd(24))} ${chalk.dim(c.selector)}`);
  }
  console.log("");
}

async function resolvePages(baseUrl: string, pagesSpec?: string): Promise<ResolvedPage[]> {
  const tokens = (pagesSpec ?? "/")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const specs = tokens.length > 0 ? tokens : ["/"];

  const out: ResolvedPage[] = [];
  let cachedPlp: string | null | undefined;
  const resolvePlp = async (): Promise<string | null> => {
    if (cachedPlp === undefined) cachedPlp = await discoverPlpFromHome(baseUrl);
    return cachedPlp;
  };

  for (const token of specs) {
    if (token === "category-auto") {
      const plp = await resolvePlp();
      if (plp) out.push({ token, url: plp });
      continue;
    }
    if (token === "pdp-auto") {
      const plp = await resolvePlp();
      if (!plp) continue;
      const html = await fetchText(plp);
      if (!html) continue;
      const pdp = firstProductHrefFromPlpHtml(html, plp);
      if (pdp) out.push({ token, url: pdp });
      continue;
    }
    try {
      out.push({ token, url: new URL(token, baseUrl).toString() });
    } catch {
      // Skip unparseable literal path/URL rather than failing the whole run.
    }
  }
  return out;
}

async function fetchText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

function parseAllowlist(spec?: string): Set<string> | null {
  if (!spec || spec.trim().length === 0) return null;
  const set = new Set(
    spec
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  return set.size > 0 ? set : null;
}

function matchesAllowlist(role: string, allowlist: Set<string>): boolean {
  const lower = role.toLowerCase();
  if (allowlist.has(lower)) return true;
  for (const name of allowlist) {
    if (lower.startsWith(`${name}-`)) return true;
  }
  return false;
}

function normalizeFormat(raw: string): "md" | "json" | "both" | null {
  if (raw === "md" || raw === "json" || raw === "both") return raw;
  return null;
}

function safeHost(url: string): string {
  try {
    return new URL(url).host || "site";
  } catch {
    return "site";
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolveTimeout) => setTimeout(resolveTimeout, ms));
}

// Re-exported so tests/tools can annotate the viewport type without reaching
// into `types/schema.ts` directly for this command's option surface.
export type { Viewport };
