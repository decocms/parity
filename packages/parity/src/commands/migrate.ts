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
import { classifyLiveStack, describeStack, type StackSignals } from "../migrate/sources/classify.ts";
import { buildMigrationPrompt } from "../migrate/prompt.ts";
import {
  buildMigrationPlan,
  loadPlan,
  mergePlanDecisions,
  savePlan,
  syntheticSourceComponents,
} from "../migrate/plan.ts";

import { getTargetPlaybook, getTargetTheme, TARGET_NAMES } from "../migrate/targets/index.ts";
import {
  detectSource,
  getSource,
  liveOnly,
  SOURCE_KINDS,
  type Source,
  type SourceInventory,
} from "../migrate/sources/index.ts";
import { aggregateTheme, mergeRawThemeSamples, scrapeThemeSamples } from "../migrate/theme.ts";
import {
  collectImageRefs,
  countContentImages,
  downloadContentImages,
  rewriteBlockUrls,
} from "../migrate/vtex/content-assets.ts";
import { mapVtexBlocksToFastStore } from "../migrate/vtex/faststore-map.ts";
import {
  type VtexBlock,
  dedupeVtexBlocks,
  readVtexBlockTree,
  readVtexStateImages,
} from "../migrate/vtex/runtime.ts";
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
  /** Extra pages to sample from the sitemap by kind, e.g. "plp=2,pdp=2,other=3,search=1". */
  sample?: string;
  format: string;
  outDir: string;
  target?: string;
  /** Path to the source repo. When set, the inventory is read from CODE and the source is detected on disk. */
  source?: string;
  /** Override source detection, e.g. "vtex-io" | "deco-fresh" | "live-only". */
  sourceKind?: string;
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

  // Resolve the SOURCE (input) — the mirror of --target (output). With --source
  // pointing at the repo, the component inventory comes from the code and the
  // VTEX-IO runtime scrape is gated on the source actually being VTEX IO;
  // without it, everything stays live-only (the original behaviour).
  let source: Source = liveOnly;
  let sourceInventory: SourceInventory = liveOnly.inventory("");
  if (opts.sourceKind) {
    const s = getSource(opts.sourceKind);
    if (!s) {
      console.error(
        chalk.red(`--source-kind inválido: ${opts.sourceKind} (disponíveis: ${SOURCE_KINDS.join(", ")})`),
      );
      return 2;
    }
    source = s;
  }
  if (opts.source) {
    if (!existsSync(opts.source)) {
      console.error(chalk.red(`--source não encontrado: ${opts.source}`));
      return 2;
    }
    if (!opts.sourceKind) source = detectSource(opts.source);
    sourceInventory = source.inventory(opts.source);
    console.log(
      chalk.dim(
        `  source: ${source.label} — ${sourceInventory.components.length} component(s) from code`,
      ),
    );
  }

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
      stack: StackSignals | null;
      assets: SiteAssets;
      screenshots: { viewport: string; path: string }[];
    };
    const blocksPath = resolve(runDir, "blocks.json");
    let theme: ThemeBundle;
    let platform: Platform;
    let stack: StackSignals | null = null;
    let assets: SiteAssets;
    let screenshots: { viewport: string; path: string }[];
    // VTEX blocks + content are produced in Phase 3 (read per captured page).
    let vtexBlocks: VtexBlock[] | null = null;
    let contentMap: Record<string, string> = {};
    if (!opts.refresh && existsSync(themePath) && existsSync(assetsPath)) {
      theme = readJson<ThemeBundle>(themePath)!;
      const meta = readJson<Phase1Meta>(assetsPath)!;
      platform = meta.platform;
      stack = meta.stack ?? null;
      assets = meta.assets;
      screenshots = meta.screenshots ?? [];
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
            const pageHtml = await page.content().catch(() => "");
            platformSeen = detectPlatform({ url: opts.url, html: pageHtml });
            // Sharp stack verdict (frontend + htmx + commerce) — drives the
            // orchestrator's path. Custom-domain deco sites are caught here.
            const cookieNames = await ctx
              .cookies()
              .then((cs) => cs.map((c) => c.name).join("; "))
              .catch(() => "");
            stack = classifyLiveStack(pageHtml, cookieNames);
            console.log(chalk.dim(`  stack: ${describeStack(stack)}`));
            const rawAssets = await collectSiteAssets(page);
            const fetchBytes = async (url: string) =>
              (await browserFetchBytes(page, url)) ?? (await nodeFetchBytes(url));
            assetsResolved = await downloadSiteAssets(rawAssets, runDir, fetchBytes);
            // Logo: for a real <img> logo the DOWNLOADED file is the source of
            // truth (downloadSiteAssets already saved it). Only screenshot the
            // rendered element for sprite `<use>`/inline SVG logos, which save
            // blank as markup. Avoids a mis-tagged element leaking a wrong
            // screenshot over a perfectly good <img> logo.
            if (rawAssets.logo?.type === "svg" || (rawAssets.logo && !assetsResolved.logo)) {
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
            // (VTEX block tree + content are now read PER PAGE in Phase 3.)
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
        `${JSON.stringify({ platform, stack, assets, screenshots } satisfies Phase1Meta, null, 2)}\n`,
        "utf8",
      );
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
      // Sample extra pages per kind (incl. institutional) from the sitemap.
      const sampled = sampleFromSitemap(classified, parseSample(opts.sample), resolvedPages);
      resolvedPages = [...resolvedPages, ...sampled].slice(0, MAX_PAGES);
      if (sampled.length) {
        const byKind = sampled.reduce<Record<string, number>>((a, p) => {
          a[p.kind] = (a[p.kind] ?? 0) + 1;
          return a;
        }, {});
        console.log(
          chalk.dim(`  phase 2 sitemap: +${sampled.length} sampled (${Object.entries(byKind).map(([k, n]) => `${n} ${k}`).join(", ")})`),
        );
      }
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
    type CaptureCache = {
      pages: MigratedPage[];
      components: MigratedComponent[];
      vtexBlocks: VtexBlock[] | null;
      contentMap: Record<string, string>;
    };
    if (!opts.refresh && existsSync(capturePath)) {
      const cached = readJson<CaptureCache>(capturePath)!;
      pages = cached.pages;
      components = cached.components;
      vtexBlocks = cached.vtexBlocks ?? null;
      contentMap = cached.contentMap ?? {};
      console.log(chalk.dim(`  phase 3 components: cached (${components.length})`));
    } else {
      console.log(chalk.dim("  phase 3 components: capturing…"));
      ({ pages, components, vtexBlocks, contentMap } = await capturePages(
        browser,
        primaryViewport,
        resolvedPages,
        theme,
        {
          allowlist,
          llm: !opts.noLlm,
          runDir,
          baseUrl: opts.url,
          // The VTEX-IO runtime scrape is meaningful only for a VTEX-IO source.
          // With an explicit non-VTEX source we skip it; otherwise (live-only or
          // no --source) we keep the self-gating scrape (`readVtexBlockTree`
          // returns null off VTEX IO), preserving the original behaviour.
          vtexScrape: opts.source ? source.kind === "vtex-io" : true,
        },
      ));
      writeFileSync(
        capturePath,
        `${JSON.stringify({ pages, components, vtexBlocks, contentMap } satisfies CaptureCache, null, 2)}\n`,
        "utf8",
      );
    }
    // Persist the VTEX artifacts (block tree + content map) after capture.
    if (vtexBlocks) writeFileSync(blocksPath, `${JSON.stringify(vtexBlocks, null, 2)}\n`, "utf8");
    if (Object.keys(contentMap).length)
      writeFileSync(
        resolve(runDir, "content-assets.json"),
        `${JSON.stringify(contentMap, null, 2)}\n`,
        "utf8",
      );

    const bundle: MigrationBundle = {
      url: opts.url,
      timestamp: new Date().toISOString(),
      viewport: primaryViewport,
      viewports,
      screenshots,
      platform,
      stack,
      source: { kind: source.kind, label: source.label, dir: opts.source ?? null },
      target: opts.target,
      theme,
      assets,
      vtex: vtexBlocks ? { blocks: vtexBlocks, map: mapVtexBlocksToFastStore(vtexBlocks) } : undefined,
      pages,
      components,
    };

    // migration-plan.json — the contract the orchestration phases read (source
    // + target + reconciled component list). Always emitted, regardless of
    // --format, since it's machine input, not a human report.
    // Re-capturing must not revert what a human decided. The fresh capture owns the row set;
    // ported/accepted/upgraded/verified state carries over from whatever plan is already here.
    const merged = mergePlanDecisions(
      buildMigrationPlan({
        bundle,
        source: { kind: source.kind, label: source.label, dir: opts.source ?? null },
        inventory: sourceInventory,
      }),
      loadPlan(runDir),
    );
    const plan = merged.plan;
    savePlan(runDir, plan);
    if (merged.carried.length) {
      console.log(
        chalk.gray(`  plan: carried ${merged.carried.length} recorded decision(s) forward`),
      );
    }
    if (merged.droppedWithDecisions.length) {
      console.log(
        chalk.yellow(
          `  plan: ${merged.droppedWithDecisions.length} component(s) with recorded decisions are no longer in the capture — ${merged.droppedWithDecisions.join(", ")}`,
        ),
      );
    }
    // Source-only components (in code, never seen live) join the bundle as
    // synthetic rows so the exporters + MIGRATION_PROMPT list them for porting.
    bundle.components.push(...syntheticSourceComponents(plan));

    // ── Emit ────────────────────────────────────────────────────────
    if (format === "json" || format === "both") await jsonExporter.export(bundle, runDir);
    if (format === "md" || format === "both") {
      await markdownExporter.export(bundle, runDir);
      await htmlExporter.export(bundle, runDir); // human-friendly visual view
      writeFileSync(
        resolve(runDir, "MIGRATION_PROMPT.md"),
        buildMigrationPrompt(bundle, playbook, {
          playbook: source.playbook,
          notes: sourceInventory.notes,
        }),
        "utf8",
      );
    }
    // Starter theme, declared by the target rather than hardcoded here — that hardcoding is why
    // faststore-next and tanstack-deco silently produced no theme at all (#309).
    const targetTheme = opts.target ? getTargetTheme(opts.target) : null;
    if (targetTheme) {
      writeFileSync(resolve(runDir, targetTheme.filename), targetTheme.build(theme), "utf8");
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

/** Global cap on content images downloaded across all captured pages. */
const CONTENT_IMAGE_BUDGET = 200;

async function capturePages(
  browser: Awaited<ReturnType<typeof launchBrowser>>,
  viewport: Viewport,
  resolvedPages: ResolvedPage[],
  theme: ThemeBundle,
  cfg: {
    allowlist: Set<string> | null;
    llm: boolean;
    runDir: string;
    baseUrl: string;
    /** Read the VTEX-IO `window.__RUNTIME__` block tree. Default true (self-gates off VTEX). */
    vtexScrape: boolean;
  },
): Promise<{
  pages: MigratedPage[];
  components: MigratedComponent[];
  vtexBlocks: VtexBlock[] | null;
  contentMap: Record<string, string>;
}> {
  const pages: MigratedPage[] = [];
  const components: MigratedComponent[] = [];
  const seenGlobalRoles = new Set<string>();
  // VTEX block tree + content, merged across ALL captured pages (dedupe by
  // treePath) — so institutional/PLP/PDP content is captured, not just home's.
  const blocksByPath = new Map<string, VtexBlock>();
  const contentMap: Record<string, string> = {};

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

      // VTEX IO block tree + content for THIS page (merged across pages).
      const pageBlocks = cfg.vtexScrape ? await readVtexBlockTree(page) : null;
      if (pageBlocks) {
        const refMap = collectImageRefs(pageBlocks, cfg.baseUrl);
        for (const b of rewriteBlockUrls(pageBlocks, refMap)) {
          if (!blocksByPath.has(b.treePath)) blocksByPath.set(b.treePath, b);
        }
        if (Object.keys(contentMap).length < CONTENT_IMAGE_BUDGET) {
          const stateImages = await readVtexStateImages(page);
          const fetchBytes = async (url: string) =>
            (await browserFetchBytes(page, url)) ?? (await nodeFetchBytes(url));
          const remaining = CONTENT_IMAGE_BUDGET - Object.keys(contentMap).length;
          const absUrls = [...new Set([...Object.values(refMap), ...stateImages])]
            .filter((u) => !(u in contentMap))
            .slice(0, remaining);
          const { map } = await downloadContentImages(absUrls, cfg.runDir, fetchBytes);
          Object.assign(contentMap, map);
        }
      }
    } finally {
      await page.close().catch(() => undefined);
      await ctx.close().catch(() => undefined);
    }
  }
  return {
    pages,
    components,
    // Collapse exact-duplicate blocks (product-summary per product, repeated
    // layout wrappers) — keeps distinct-content blocks, shrinks blocks.json.
    vtexBlocks: blocksByPath.size ? dedupeVtexBlocks([...blocksByPath.values()]) : null,
    contentMap,
  };
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

/** Default extra pages sampled from the sitemap (incl. institutional = "other"). */
const DEFAULT_SAMPLE = "plp=2,pdp=2,other=3,search=1";
/** Hard cap on total captured pages, to keep runs bounded. */
const MAX_PAGES = 15;
/** URL patterns for real institutional pages (vs deep categories that also → "other"). */
const INSTITUTIONAL_URL =
  /(sobre|about|institucional|quem-somos|contato|contact|ajuda|help|faq|blog|trabalhe|careers|carreiras|politica|policy|privacidade|privacy|termos|terms|troca|devolu|garantia|warranty|lojas|stores|imprensa|press|sustentab|acessibilidade|cookies)/i;

/** Parse a `--sample` spec ("plp=2,other=3") into a per-kind count map. */
export function parseSample(spec: string | undefined): Partial<Record<PageKind, number>> {
  const out: Partial<Record<PageKind, number>> = {};
  for (const part of (spec ?? DEFAULT_SAMPLE).split(",")) {
    const [k, n] = part.split("=").map((s) => s.trim());
    const count = Number.parseInt(n ?? "", 10);
    if (k && Number.isFinite(count) && count > 0) out[k as PageKind] = count;
  }
  return out;
}

/** Pick `count` items spread evenly across the list (variety, not first-N cluster). */
export function pickSpread<T>(items: T[], count: number): T[] {
  if (items.length <= count) return items;
  const step = items.length / count;
  const out: T[] = [];
  for (let i = 0; i < count; i++) out.push(items[Math.floor(i * step)]!);
  return out;
}

/**
 * Sample additional pages per kind from the classified sitemap — home + a few
 * PLPs/PDPs + a search page + institutional ("other") pages — skipping any URL
 * already resolved. This is what captures the institutional pages you'll need
 * to rebuild.
 */
export function sampleFromSitemap(
  classified: { url: string; kind: PageKind }[],
  spec: Partial<Record<PageKind, number>>,
  existing: ResolvedPage[],
): ResolvedPage[] {
  const seen = new Set(existing.map((p) => p.url));
  const byKind = new Map<PageKind, string[]>();
  for (const c of classified) {
    if (c.kind === "home" || seen.has(c.url)) continue;
    const list = byKind.get(c.kind) ?? [];
    list.push(c.url);
    byKind.set(c.kind, list);
  }
  // Within "other", prefer real institutional pages (about/contact/policies/…)
  // over deep-category pages that also fall through to "other".
  const other = byKind.get("other");
  if (other) {
    const inst = other.filter((u) => INSTITUTIONAL_URL.test(u));
    byKind.set("other", [...inst, ...other.filter((u) => !INSTITUTIONAL_URL.test(u))]);
  }

  const out: ResolvedPage[] = [];
  for (const [kind, count] of Object.entries(spec) as [PageKind, number][]) {
    // "other" is ordered institutional-first — take the head, don't spread.
    const source = byKind.get(kind) ?? [];
    const chosen = kind === "other" ? source.slice(0, count) : pickSpread(source, count);
    for (const url of chosen) {
      if (seen.has(url)) continue;
      seen.add(url);
      let path = url;
      try {
        path = new URL(url).pathname;
      } catch {
        /* keep url */
      }
      out.push({ path, url, kind });
    }
  }
  return out;
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
