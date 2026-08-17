import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import chalk from "chalk";
import open from "open";
import type { Page } from "playwright";
import { pickPlpFromHomeHtml } from "../checks/plp-pagination.ts";
import { parseSitemap } from "../diff/sitemap.ts";
import { launchBrowser, newContext } from "../engine/browser.ts";
import { stabilizeCarousels } from "../engine/carousel-stabilizer.ts";
import { scrollFullPage, waitForSkeletonsToResolve } from "../engine/collect.ts";
import { firstProductHref } from "../migrate/pdp-discovery.ts";
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
import { browserFetchText } from "../migrate/browser-fetch.ts";
import { isGlobalRole, planComponentDedup, toMigratedComponent } from "../migrate/bundle.ts";
import { jsonExporter } from "../migrate/exporters/json.ts";
import { markdownExporter } from "../migrate/exporters/markdown.ts";
import { htmlExporter } from "../migrate/exporters/html.ts";
import { buildMigrationPrompt } from "../migrate/prompt.ts";
import { buildFastStoreTheme } from "../migrate/targets/faststore.ts";
import { getTargetPlaybook, TARGET_NAMES } from "../migrate/targets/index.ts";
import { aggregateTheme, mergeRawThemeSamples, scrapeThemeSamples } from "../migrate/theme.ts";
import {
  collectImageRefs,
  countContentImages,
  downloadContentImages,
  rewriteBlockUrls,
} from "../migrate/vtex/content-assets.ts";
import { mapVtexBlocksToFastStore } from "../migrate/vtex/faststore-map.ts";
import { type VtexBlock, readVtexBlockTree } from "../migrate/vtex/runtime.ts";
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
  /** Comma-separated viewports for theme + site screenshots (default: --viewport). */
  viewports?: string;
  format: string;
  outDir: string;
  target?: string;
  refresh?: boolean;
  /** Open the generated index.html in the browser when done. */
  open?: boolean;
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
  // Multi-viewport for theme + site screenshots. Defaults to --viewport; the
  // primary (first) viewport is used for component capture (Phase 3).
  const viewports = (opts.viewports ? opts.viewports.split(",") : [opts.viewport])
    .map((v) => parseViewport(v.trim()))
    .filter((v): v is Viewport => Boolean(v));
  if (viewports.length === 0) {
    console.error(chalk.red(`--viewports inválido: ${opts.viewports}`));
    return 2;
  }
  const primaryViewport = viewports[0]!;
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
    type Phase1Meta = {
      platform: Platform;
      assets: SiteAssets;
      screenshots: { viewport: string; path: string }[];
    };
    const blocksPath = resolve(runDir, "blocks.json");
    let theme: ThemeBundle;
    let platform: Platform;
    let assets: SiteAssets;
    let screenshots: { viewport: string; path: string }[];
    let vtexBlocks: VtexBlock[] | null = null;
    if (!opts.refresh && existsSync(themePath) && existsSync(assetsPath)) {
      theme = readJson<ThemeBundle>(themePath)!;
      const meta = readJson<Phase1Meta>(assetsPath)!;
      platform = meta.platform;
      assets = meta.assets;
      screenshots = meta.screenshots ?? [];
      if (existsSync(blocksPath)) vtexBlocks = readJson<VtexBlock[]>(blocksPath);
      console.log(chalk.dim("  phase 1 theme+assets: cached"));
    } else {
      console.log(chalk.dim(`  phase 1 theme+assets: scraping (${viewports.join(", ")})…`));
      mkdirSync(resolve(runDir, "screenshots"), { recursive: true });
      const samples: Awaited<ReturnType<typeof scrapeThemeSamples>>[] = [];
      screenshots = [];
      let platformSeen: Platform | null = null;
      let assetsResolved: SiteAssets | null = null;
      // Theme aggregates across all viewports; assets/platform captured once.
      for (const vp of viewports) {
        const ctx = await newContext(browser, { viewport: vp });
        const page = await ctx.newPage();
        try {
          await page.goto(opts.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
          await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
          // Scroll to trigger lazy sections (footer etc.) BEFORE the screenshot
          // + theme scrape, so below-the-fold content isn't blank.
          await Promise.race([stabilizeCarousels(page).catch(() => undefined), sleep(3_000)]);
          await Promise.race([scrollFullPage(page, 30_000).catch(() => undefined), sleep(32_000)]);
          await Promise.race([
            waitForSkeletonsToResolve(page, 5_000).catch(() => undefined),
            sleep(5_000),
          ]);
          samples.push(await scrapeThemeSamples(page));
          const shot = resolve(runDir, "screenshots", `${vp}.png`);
          await page
            .screenshot({ path: shot, fullPage: true, animations: "disabled", timeout: 15_000 })
            .then(() => screenshots.push({ viewport: vp, path: `screenshots/${vp}.png` }))
            .catch(() => undefined);
          if (!assetsResolved) {
            platformSeen = detectPlatform({ url: opts.url, html: await page.content().catch(() => "") });
            const rawAssets = await collectSiteAssets(page);
            const fetchBytes = async (url: string) =>
              (await browserFetchBytes(page, url)) ?? (await nodeFetchBytes(url));
            assetsResolved = await downloadSiteAssets(rawAssets, runDir, fetchBytes);
            // Logo: screenshot the rendered element (robust against sprite
            // `<use>` logos that save blank as markup). `collectSiteAssets`
            // tagged it with `data-parity-logo`.
            if (rawAssets.logo) {
              const logoPng = resolve(runDir, "assets", "logo.png");
              const ok = await page
                .locator("[data-parity-logo]")
                .first()
                .screenshot({ path: logoPng, timeout: 8_000 })
                .then(() => true)
                .catch(() => false);
              if (ok) {
                assetsResolved.logo = "assets/logo.png";
                assetsResolved.logoSource = assetsResolved.logoSource ?? "screenshot";
              }
            }
            // VTEX IO block tree — the store's real declarative structure.
            vtexBlocks = await readVtexBlockTree(page);
            if (vtexBlocks) {
              // Content images in block props are often site-relative pointers
              // (/img/x, /arquivos/ids/…). Resolve them to the real absolute
              // content URL in blocks.json, and ALSO download them locally with
              // a url→file map (content-assets.json).
              const refMap = collectImageRefs(vtexBlocks, opts.url);
              vtexBlocks = rewriteBlockUrls(vtexBlocks, refMap);
              const absUrls = [...new Set(Object.values(refMap))];
              const { map, downloaded, skipped } = await downloadContentImages(
                absUrls,
                runDir,
                fetchBytes,
              );
              if (Object.keys(map).length)
                writeFileSync(
                  resolve(runDir, "content-assets.json"),
                  `${JSON.stringify(map, null, 2)}\n`,
                  "utf8",
                );
              if (absUrls.length)
                console.log(
                  chalk.dim(`  vtex content: ${absUrls.length} image URLs resolved · ${downloaded} downloaded${skipped ? ` (${skipped} over cap skipped)` : ""}`),
                );
            }
          }
        } finally {
          await page.close().catch(() => undefined);
          await ctx.close().catch(() => undefined);
        }
      }
      theme = aggregateTheme(mergeRawThemeSamples(samples));
      platform = platformSeen ?? "custom";
      assets = assetsResolved!;
      writeFileSync(themePath, `${JSON.stringify(theme, null, 2)}\n`, "utf8");
      writeFileSync(
        assetsPath,
        `${JSON.stringify({ platform, assets, screenshots } satisfies Phase1Meta, null, 2)}\n`,
        "utf8",
      );
      if (vtexBlocks) {
        writeFileSync(blocksPath, `${JSON.stringify(vtexBlocks, null, 2)}\n`, "utf8");
        console.log(chalk.dim(`  vtex io: ${vtexBlocks.length} blocks read from runtime`));
      }
    }

    // ── Phase 2: SITEMAP ────────────────────────────────────────────
    const sitemapPath = resolve(runDir, "sitemap.json");
    let resolvedPages: ResolvedPage[];
    if (!opts.refresh && existsSync(sitemapPath)) {
      resolvedPages = readJson<{ pages: ResolvedPage[] }>(sitemapPath)!.pages;
      console.log(chalk.dim(`  phase 2 sitemap: cached (${resolvedPages.length} page(s))`));
    } else {
      console.log(chalk.dim("  phase 2 sitemap: resolving pages…"));
      // Discover through the BROWSER (bypasses bot 403s that would degrade a
      // bare node fetch to home-only).
      const ctx = await newContext(browser, { viewport: primaryViewport });
      const page = await ctx.newPage();
      let sitemapUrls: string[] = [];
      try {
        await page.goto(opts.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
        await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
        const homeHtml = await page.content().catch(() => "");
        resolvedPages = await resolvePages(page, opts.url, opts.pages, homeHtml, platform);
        sitemapUrls = await discoverSitemapUrls(page, opts.url);
      } finally {
        await page.close().catch(() => undefined);
        await ctx.close().catch(() => undefined);
      }
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
      ({ pages, components } = await capturePages(browser, primaryViewport, resolvedPages, theme, {
        allowlist,
        llm: !opts.noLlm,
        runDir,
      }));
      writeFileSync(capturePath, `${JSON.stringify({ pages, components }, null, 2)}\n`, "utf8");
    }

    const bundle: MigrationBundle = {
      url: opts.url,
      timestamp: new Date().toISOString(),
      viewport: primaryViewport,
      viewports,
      screenshots,
      platform,
      target: opts.target,
      theme,
      assets,
      vtex: vtexBlocks ? { blocks: vtexBlocks, map: mapVtexBlocksToFastStore(vtexBlocks) } : undefined,
      pages,
      components,
    };

    // ── Emit ────────────────────────────────────────────────────────
    if (format === "json" || format === "both") await jsonExporter.export(bundle, runDir);
    if (format === "md" || format === "both") {
      await markdownExporter.export(bundle, runDir);
      await htmlExporter.export(bundle, runDir); // human-friendly visual view
      writeFileSync(
        resolve(runDir, "MIGRATION_PROMPT.md"),
        buildMigrationPrompt(bundle, playbook),
        "utf8",
      );
    }
    // FastStore-specific starter theme (deterministic token mapping).
    if (opts.target === "faststore") {
      writeFileSync(resolve(runDir, "custom-theme.scss"), buildFastStoreTheme(theme), "utf8");
    }
    // VTEX IO → FastStore component map (when the block tree was read).
    if (bundle.vtex) {
      writeFileSync(
        resolve(runDir, "component-map.json"),
        `${JSON.stringify(bundle.vtex.map, null, 2)}\n`,
        "utf8",
      );
    }

    if (opts.json) {
      console.log(JSON.stringify({ outDir: runDir, componentCount: components.length, bundle }));
      return 0;
    }
    printResults(runDir, bundle);
    if (opts.open && format !== "json") {
      // report.html is fully self-contained (images inlined) — always renders.
      await open(resolve(runDir, "report.html")).catch(() => undefined);
    }
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

async function resolvePages(
  page: Page,
  baseUrl: string,
  pagesSpec: string | undefined,
  homeHtml: string,
  platform: Platform,
): Promise<ResolvedPage[]> {
  // Default to the canonical e-commerce trio: home + a PLP + a PDP.
  const tokens = (pagesSpec ?? "/,category-auto,pdp-auto")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const out: ResolvedPage[] = [];
  // PLP comes from the home HTML we already loaded via the browser — no fetch.
  const plp = pickPlpFromHomeHtml(homeHtml, baseUrl);

  for (const token of tokens) {
    if (token === "category-auto") {
      if (plp) out.push({ path: token, url: plp, kind: "plp" });
      else console.warn(chalk.yellow("  ⚠ category-auto: nenhuma PLP descoberta na home"));
      continue;
    }
    if (token === "pdp-auto") {
      if (!plp) {
        console.warn(chalk.yellow("  ⚠ pdp-auto: sem PLP pra derivar PDP"));
        continue;
      }
      // Navigate + read the RENDERED PLP DOM (client-rendered product grids
      // aren't in the raw HTML), then pick the first product link.
      let html: string | null = null;
      try {
        await page.goto(plp, { waitUntil: "domcontentloaded", timeout: 30_000 });
        await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
        html = await page.content();
      } catch {
        html = await browserFetchText(page, plp);
      }
      const pdp = html ? firstProductHref(html, plp, platform) : null;
      if (pdp) out.push({ path: token, url: pdp, kind: "pdp" });
      else console.warn(chalk.yellow("  ⚠ pdp-auto: nenhum produto encontrado na PLP"));
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

/** Fetch + parse sitemap.xml through the browser (follows one index level). */
async function discoverSitemapUrls(page: Page, baseUrl: string): Promise<string[]> {
  try {
    const origin = new URL(baseUrl).origin;
    const rootXml = await browserFetchText(page, `${origin}/sitemap.xml`);
    if (!rootXml) return [];
    const root = parseSitemap(rootXml);
    if (!root.isIndex) return root.urls;
    // Sitemap index — fetch a few children and flatten.
    const urls: string[] = [];
    for (const child of root.childSitemaps.slice(0, 5)) {
      const xml = await browserFetchText(page, child);
      if (xml) urls.push(...parseSitemap(xml).urls);
      if (urls.length >= 500) break;
    }
    return urls;
  } catch {
    return [];
  }
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
  console.log(chalk.dim(`  viewports:${(bundle.viewports ?? [bundle.viewport]).join(", ")}`));
  console.log(chalk.dim(`  theme:    primary=${bundle.theme.colors.primary ?? "—"} text=${bundle.theme.colors.text ?? "—"}`));
  console.log(chalk.dim(`  assets:   logo=${bundle.assets.logo ? "✓" : "✗"} favicon=${bundle.assets.favicon ? "✓" : "✗"} icons=${bundle.assets.icons.length} fonts=${bundle.assets.fontFiles.length}`));
  if (bundle.vtex) {
    const mapped = bundle.vtex.map.filter((m) => m.strategy === "mapped").length;
    const withContent = bundle.vtex.blocks.filter((x) => x.props).length;
    const contentImgs = countContentImages(bundle.vtex.blocks);
    console.log(
      chalk.dim(`  vtex io:  ${bundle.vtex.blocks.length} blocks (${withContent} with CMS content, ${contentImgs} content images local) · ${mapped}/${bundle.vtex.map.length} mapped`),
    );
  }
  console.log(chalk.dim(`  pages:    ${bundle.pages.map((p) => p.kind).join(", ") || "—"}`));
  console.log(chalk.dim(`  out:      ${runDir}`));
  console.log("");
  console.log(chalk.bold(`  ${bundle.components.length} component(s):`));
  for (const c of bundle.components) {
    console.log(`    ${chalk.cyan(`${c.scope}/${c.role}`.padEnd(28))} ${chalk.dim(`${c.tailwind.length} tw · ${c.interactions.length} interactions`)}`);
  }
  console.log("");
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
