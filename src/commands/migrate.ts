import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import chalk from "chalk";
import type { Page } from "playwright";
import { discoverPlpFromHome } from "../checks/plp-pagination.ts";
import { resolveSitemapUrls } from "../diff/sitemap.ts";
import { launchBrowser, newContext } from "../engine/browser.ts";
import { stabilizeCarousels } from "../engine/carousel-stabilizer.ts";
import { scrollFullPage, waitForSkeletonsToResolve } from "../engine/collect.ts";
import { firstProductHrefFromPlpHtml } from "../engine/selector-discovery-pass.ts";
import { type PageKind, classifyPath } from "../engine/sitemap-discover.ts";
import { detectComponents } from "../extract/detect-components.ts";
import { extractComponent } from "../extract/extract-component.ts";
import { componentDirName } from "../extract/naming.ts";
import { type Platform, detectPlatform } from "../learned/platform.ts";
import {
  browserFetchBytes,
  collectSiteAssets,
  downloadSiteAssets,
  nodeFetchBytes,
} from "../migrate/assets.ts";
import { isGlobalRole, planComponentDedup, toMigratedComponent } from "../migrate/bundle.ts";
import { jsonExporter } from "../migrate/exporters/json.ts";
import { markdownExporter } from "../migrate/exporters/markdown.ts";
import { buildMigrationPrompt } from "../migrate/prompt.ts";
import { getTargetPlaybook, TARGET_NAMES } from "../migrate/targets/index.ts";
import { aggregateTheme, scrapeThemeSamples } from "../migrate/theme.ts";
import { captureInteractions } from "../migrate/interactions.ts";
import type {
  MigratedComponent,
  MigratedPage,
  MigrationBundle,
  SiteAssets,
  ThemeBundle,
} from "../types/migrate.ts";
import type { Viewport } from "../types/schema.ts";
import { parseViewport } from "./section.ts";

/**
 * `parity migrate` — phased, single-site migration capture.
 *
 * Orchestrates three resumable phases (theme → sitemap → components) reusing
 * the `extract` capture primitives. Output is a target-agnostic, token-lean
 * bundle + prompt for a migration agent. Not a prod×cand command — it looks
 * at ONE live site (works whether or not the source code exists).
 *
 * Resume: the out dir is stable per host (no timestamp), so a re-run skips a
 * phase whose artifact already exists unless `--refresh` is passed.
 */
export interface MigrateOptions {
  url: string;
  pages?: string;
  components?: string;
  viewport: string;
  format: string;
  outDir: string;
  target?: string;
  refresh?: boolean;
  noLlm?: boolean;
  json?: boolean;
}

interface ResolvedPage {
  path: string;
  url: string;
  kind: PageKind;
}

export async function migrateCommand(opts: MigrateOptions): Promise<number> {
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
  let playbook: string | undefined;
  if (opts.target) {
    playbook = getTargetPlaybook(opts.target);
    if (!playbook) {
      console.error(
        chalk.red(`--target inválido: ${opts.target} (disponíveis: ${TARGET_NAMES.join(", ")})`),
      );
      return 2;
    }
  }
  const allowlist = parseAllowlist(opts.components);

  const host = safeHost(opts.url);
  const runDir = resolve(opts.outDir, host);
  mkdirSync(runDir, { recursive: true });

  const browser = await launchBrowser({ headless: true });
  try {
    // ── Phase 1: THEME + ASSETS ─────────────────────────────────────
    const themePath = resolve(runDir, "theme.json");
    const assetsPath = resolve(runDir, "assets.json");
    let theme: ThemeBundle;
    let platform: Platform;
    let assets: SiteAssets;
    if (!opts.refresh && existsSync(themePath) && existsSync(assetsPath)) {
      theme = readJson<ThemeBundle>(themePath)!;
      const meta = readJson<{ platform: Platform; assets: SiteAssets }>(assetsPath)!;
      platform = meta.platform;
      assets = meta.assets;
      console.log(chalk.dim("  phase 1 theme+assets: cached"));
    } else {
      console.log(chalk.dim("  phase 1 theme+assets: scraping…"));
      const ctx = await newContext(browser, { viewport });
      const page = await ctx.newPage();
      let assetsResolved: SiteAssets;
      try {
        await page.goto(opts.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
        await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
        const html = await page.content().catch(() => "");
        platform = detectPlatform({ url: opts.url, html });
        theme = aggregateTheme(await scrapeThemeSamples(page));
        const rawAssets = await collectSiteAssets(page);
        // Download through the BROWSER (already past bot protection), node fallback.
        const fetchBytes = async (url: string) =>
          (await browserFetchBytes(page, url)) ?? (await nodeFetchBytes(url));
        assetsResolved = await downloadSiteAssets(rawAssets, runDir, fetchBytes);
      } finally {
        await page.close().catch(() => undefined);
        await ctx.close().catch(() => undefined);
      }
      assets = assetsResolved;
      writeFileSync(themePath, `${JSON.stringify(theme, null, 2)}\n`, "utf8");
      writeFileSync(assetsPath, `${JSON.stringify({ platform, assets }, null, 2)}\n`, "utf8");
    }

    // ── Phase 2: SITEMAP ────────────────────────────────────────────
    const sitemapPath = resolve(runDir, "sitemap.json");
    let resolvedPages: ResolvedPage[];
    if (!opts.refresh && existsSync(sitemapPath)) {
      resolvedPages = readJson<{ pages: ResolvedPage[] }>(sitemapPath)!.pages;
      console.log(chalk.dim(`  phase 2 sitemap: cached (${resolvedPages.length} page(s))`));
    } else {
      console.log(chalk.dim("  phase 2 sitemap: resolving pages…"));
      resolvedPages = await resolvePages(opts.url, opts.pages);
      const sitemapUrls = await resolveSitemapUrls(opts.url).catch(() => [] as string[]);
      const classified = sitemapUrls.slice(0, 500).map((u) => ({ url: u, kind: kindOf(u) }));
      writeFileSync(
        sitemapPath,
        `${JSON.stringify({ pages: resolvedPages, sitemapUrls: classified }, null, 2)}\n`,
        "utf8",
      );
    }
    if (resolvedPages.length === 0) {
      console.error(chalk.red("nenhuma página resolvida a partir de --pages"));
      return 1;
    }

    // ── Phase 3: COMPONENTS ─────────────────────────────────────────
    const capturePath = resolve(runDir, "capture.json");
    let pages: MigratedPage[];
    let components: MigratedComponent[];
    if (!opts.refresh && existsSync(capturePath)) {
      const cached = readJson<{ pages: MigratedPage[]; components: MigratedComponent[] }>(capturePath)!;
      pages = cached.pages;
      components = cached.components;
      console.log(chalk.dim(`  phase 3 components: cached (${components.length})`));
    } else {
      console.log(chalk.dim("  phase 3 components: capturing…"));
      ({ pages, components } = await capturePages(browser, viewport, resolvedPages, theme, {
        allowlist,
        llm: !opts.noLlm,
        runDir,
      }));
      writeFileSync(capturePath, `${JSON.stringify({ pages, components }, null, 2)}\n`, "utf8");
    }

    const bundle: MigrationBundle = {
      url: opts.url,
      timestamp: new Date().toISOString(),
      viewport,
      platform,
      target: opts.target,
      theme,
      assets,
      pages,
      components,
    };

    // ── Emit ────────────────────────────────────────────────────────
    if (format === "json" || format === "both") await jsonExporter.export(bundle, runDir);
    if (format === "md" || format === "both") {
      await markdownExporter.export(bundle, runDir);
      writeFileSync(
        resolve(runDir, "MIGRATION_PROMPT.md"),
        buildMigrationPrompt(bundle, playbook),
        "utf8",
      );
    }

    if (opts.json) {
      console.log(JSON.stringify({ outDir: runDir, componentCount: components.length, bundle }));
      return 0;
    }
    printResults(runDir, bundle);
    return 0;
  } finally {
    await browser.close().catch(() => undefined);
  }
}

async function capturePages(
  browser: Awaited<ReturnType<typeof launchBrowser>>,
  viewport: Viewport,
  resolvedPages: ResolvedPage[],
  theme: ThemeBundle,
  cfg: { allowlist: Set<string> | null; llm: boolean; runDir: string },
): Promise<{ pages: MigratedPage[]; components: MigratedComponent[] }> {
  const pages: MigratedPage[] = [];
  const components: MigratedComponent[] = [];
  const seenGlobalRoles = new Set<string>();

  for (const target of resolvedPages) {
    const ctx = await newContext(browser, { viewport });
    const page = await ctx.newPage();
    const pageComponents: MigratedComponent[] = [];
    try {
      await page.goto(target.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
      await Promise.race([stabilizeCarousels(page).catch(() => undefined), sleep(3_000)]);
      await Promise.race([scrollFullPage(page, 30_000).catch(() => undefined), sleep(32_000)]);
      await Promise.race([
        waitForSkeletonsToResolve(page, 5_000).catch(() => undefined),
        sleep(5_000),
      ]);

      let detected = await detectComponents(page, { llm: cfg.llm });
      if (cfg.allowlist) detected = detected.filter((c) => matchesAllowlist(c.role, cfg.allowlist!));

      // Collapse structurally-identical repeated components (e.g. a row of
      // shelves) BEFORE the expensive per-component extraction/screenshot.
      const signatures = await structuralSignatures(page, detected.map((d) => d.selector));
      const plan = planComponentDedup(
        detected.map((d, i) => ({ role: d.role, signature: signatures[i] ?? "" })),
      );

      const pageScreenshot = await page
        .screenshot({ fullPage: true, animations: "disabled", timeout: 15_000 })
        .catch(() => undefined);

      for (const { index, repeated } of plan) {
        const component = detected[index]!;
        const global = isGlobalRole(component.role);
        // Capture each global role once (first page it appears on).
        if (global && seenGlobalRoles.has(component.role)) continue;
        if (global) seenGlobalRoles.add(component.role);

        const idx = components.length + 1; // matches exporter's componentDirName(role, i+1)
        const componentDir = resolve(cfg.runDir, "components", componentDirName(component.role, idx));
        const extracted = await extractComponent(page, component, {
          outDir: componentDir,
          index: idx,
          pageScreenshot,
        });
        const interactions = await captureInteractions(page, component.selector);
        const migrated = toMigratedComponent(
          extracted,
          interactions,
          global ? "global" : "page",
          theme.tokens,
          repeated,
        );
        components.push(migrated);
        if (!global) pageComponents.push(migrated);
      }
      pages.push({ url: target.url, path: target.path, kind: target.kind, components: pageComponents });
    } finally {
      await page.close().catch(() => undefined);
      await ctx.close().catch(() => undefined);
    }
  }
  return { pages, components };
}

async function resolvePages(baseUrl: string, pagesSpec?: string): Promise<ResolvedPage[]> {
  // Default to the canonical e-commerce trio: home + a PLP + a PDP.
  const tokens = (pagesSpec ?? "/,category-auto,pdp-auto")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const out: ResolvedPage[] = [];
  let cachedPlp: string | null | undefined;
  const resolvePlp = async (): Promise<string | null> => {
    if (cachedPlp === undefined) cachedPlp = await discoverPlpFromHome(baseUrl);
    return cachedPlp;
  };

  for (const token of tokens) {
    if (token === "category-auto") {
      const plp = await resolvePlp();
      if (plp) out.push({ path: token, url: plp, kind: "plp" });
      continue;
    }
    if (token === "pdp-auto") {
      const plp = await resolvePlp();
      if (!plp) continue;
      const html = await fetchText(plp);
      if (!html) continue;
      const pdp = firstProductHrefFromPlpHtml(html, plp);
      if (pdp) out.push({ path: token, url: pdp, kind: "pdp" });
      continue;
    }
    try {
      const url = new URL(token, baseUrl).toString();
      out.push({ path: token, url, kind: kindOf(url) });
    } catch {
      /* skip unparseable literal */
    }
  }
  return out;
}

/**
 * Cheap in-page structural signature per selector (tag + digit-free class set
 * + direct-child count). Same signature ⇒ treated as the same component for
 * dedup. Digits are stripped so hashed/utility class variants still match.
 */
async function structuralSignatures(page: Page, selectors: string[]): Promise<string[]> {
  try {
    return await page.evaluate((sels: string[]) => {
      return sels.map((s) => {
        let el: Element | null = null;
        try {
          el = document.querySelector(s);
        } catch {
          return "";
        }
        if (!el) return "";
        const cls = Array.from(el.classList)
          .filter((c) => !/\d/.test(c))
          .sort()
          .join(".");
        return `${el.tagName}|${cls}|${el.children.length}`;
      });
    }, selectors);
  } catch {
    return selectors.map(() => "");
  }
}

function kindOf(url: string): PageKind {
  try {
    return classifyPath(new URL(url).pathname);
  } catch {
    return "other";
  }
}

function printResults(runDir: string, bundle: MigrationBundle): void {
  console.log(chalk.bold("\n  parity migrate"));
  console.log(chalk.dim(`  url:      ${bundle.url}`));
  console.log(chalk.dim(`  platform: ${bundle.platform}${bundle.target ? ` → ${bundle.target}` : ""}`));
  console.log(chalk.dim(`  theme:    primary=${bundle.theme.colors.primary ?? "—"} text=${bundle.theme.colors.text ?? "—"}`));
  console.log(chalk.dim(`  assets:   logo=${bundle.assets.logo ? "✓" : "✗"} favicon=${bundle.assets.favicon ? "✓" : "✗"} icons=${bundle.assets.icons.length}`));
  console.log(chalk.dim(`  pages:    ${bundle.pages.map((p) => p.kind).join(", ") || "—"}`));
  console.log(chalk.dim(`  out:      ${runDir}`));
  console.log("");
  console.log(chalk.bold(`  ${bundle.components.length} component(s):`));
  for (const c of bundle.components) {
    console.log(`    ${chalk.cyan(`${c.scope}/${c.role}`.padEnd(28))} ${chalk.dim(`${c.tailwind.length} tw · ${c.interactions.length} interactions`)}`);
  }
  console.log("");
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

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
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
