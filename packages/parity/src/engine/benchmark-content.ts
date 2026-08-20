// Content-site navigation benchmark — the counterpart to the commerce journey in
// benchmark.ts. A content site (blog/marketing, no PLP/PDP) can't be measured
// with home→PLP→PDP→variant. Instead we measure the journey a reader actually
// takes: home → internal content page → another internal content page, timing
// each click→content-ready with the same hover-prefetch model.
//
// Reuses the shared primitives from benchmark.ts (navigateWithHover, waitReady,
// dismissAll, aggregatePhase, median) so warm/measure/vitals behave identically
// to the commerce path — only the journey (which pages, which phases) differs.
import type { Browser } from "playwright";
import { newContext } from "./browser.ts";
import {
  type FlowContext,
  screenshotPath,
  screenshotStable,
} from "./flows/shared.ts";
import { type LhResult, measureLighthouse } from "./lighthouse.ts";
import {
  type RunSideOptions,
  type SideBenchmark,
  type StepTiming,
  aggregatePhase,
  dismissAll,
  navigateWithHover,
  openMenu,
  pageLooksBroken,
  waitReady,
} from "./benchmark.ts";

/** Max internal content pages to include in the journey (home + these). When the
 *  orchestrator passes an authoritative `--pages` list from .deco, all of them are
 *  used (capped here to keep runtime sane). */
const MAX_CONTENT_PAGES = 6;

/**
 * "The user sees the first content" signal — First Contentful Paint. This is the
 * only fair home-load metric across sites with DIFFERENT rendering strategies:
 * - networkidle (waitReady) never settles on a heavy section (Maps geocoding
 *   100+ addresses) → inflates the SSR candidate to the full cap.
 * - a visible-element selector times out on a fully-DEFERRED site (Fresh prod
 *   lazy-loads everything) → inflates prod instead.
 * FCP fires when the browser paints the first content (header/shell) — both an
 * SSR and a deferred site reach it early, so it's apples-to-apples. Matches the
 * vitals module's definition.
 */
async function waitForContentReady(page: import("playwright").Page, cap = 8_000): Promise<boolean> {
  return page
    .evaluate((capMs: number) => {
      return new Promise<boolean>((resolve) => {
        const seen = performance.getEntriesByName?.("first-contentful-paint")[0];
        if (seen) return resolve(true);
        let done = false;
        const finish = (ok: boolean) => {
          if (done) return;
          done = true;
          resolve(ok);
        };
        try {
          const obs = new PerformanceObserver((list) => {
            if (list.getEntries().some((e) => e.name === "first-contentful-paint")) {
              obs.disconnect();
              finish(true);
            }
          });
          obs.observe({ type: "paint", buffered: true });
          setTimeout(() => {
            obs.disconnect();
            finish(false);
          }, capMs);
        } catch {
          finish(false);
        }
      });
    }, cap)
    .catch(() => false);
}

/** kebab a path into a stable step key: /blog/foo → nav-blog-foo. */
function stepKeyForPath(path: string): string {
  const slug = path.replace(/^\/+|\/+$/g, "").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  return `nav-${slug || "home"}`;
}

/**
 * Internal, same-page-worthy nav links from the header/nav — the routes a reader
 * browses in sequence. Excludes external, #anchors, and the current path.
 */
async function discoverNavLinks(page: import("playwright").Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const seen = new Set<string>();
    const els = document.querySelectorAll("header a[href], nav a[href]");
    for (const a of Array.from(els) as HTMLAnchorElement[]) {
      const href = a.getAttribute("href") || "";
      if (!href.startsWith("/") || href.startsWith("//")) continue; // internal only
      if (href.startsWith("/#") || href === "/") continue; // skip anchors + home
      // Skip dropdown-PARENT links (e.g. "Especialidades"): a nav item that owns a
      // submenu is a hover/toggle trigger — clicking it opens the submenu instead
      // of navigating, so it can't be prefetched or measured. The REAL pages are
      // the submenu leaves (sourced authoritatively from .deco/blocks).
      if (a.parentElement?.querySelector("ul, [class*='dropdown'], [class*='submenu']")) continue;
      const path = href.split("#")[0].split("?")[0];
      if (path === "/" || seen.has(path)) continue;
      seen.add(path);
      out.push(path);
    }
    return out;
  });
}

/** Does this path render real content (not a 404/error) on this base? */
async function pathWorks(
  page: import("playwright").Page,
  base: string,
  path: string,
): Promise<boolean> {
  const res = await page
    .goto(new URL(path, base).toString(), { waitUntil: "domcontentloaded", timeout: 15_000 })
    .catch(() => null);
  if (!res || res.status() >= 400) return false;
  await waitReady(page).catch(() => undefined);
  return !(await pageLooksBroken(page));
}

/**
 * Pick up to MAX_CONTENT_PAGES internal paths that render on BOTH sites, so the
 * journey exercises the exact same pages on prod and cand. Discovered once on prod.
 */
export async function resolveContentPaths(opts: {
  browser: Browser;
  prodBase: string;
  candBase: string;
  viewport: import("../types/schema.ts").Viewport;
  /**
   * Authoritative page paths (e.g. extracted from the target's `.deco/blocks`
   * decofile by the orchestrator). When given, these are used INSTEAD of scraping
   * nav links — the decofile lists every real page, whereas a sitemap may be
   * missing and nav-scraping only sees what's linked in the header.
   */
  pages?: string[];
  onEvent?: (m: string) => void;
}): Promise<string[] | null> {
  const emit = (m: string) => opts.onEvent?.(m);
  const ctx = await newContext(opts.browser, { viewport: opts.viewport });
  try {
    const page = await ctx.newPage();
    await page
      .goto(opts.prodBase, { waitUntil: "domcontentloaded", timeout: 20_000 })
      .catch(() => undefined);
    await dismissAllSafe(page);
    const candidates =
      opts.pages && opts.pages.length > 0 ? opts.pages : await discoverNavLinks(page);
    emit(
      opts.pages && opts.pages.length > 0
        ? `content: ${candidates.length} página(s) do .deco (autoritativo)`
        : `content: ${candidates.length} link(s) de nav candidatos (sem lista .deco)`,
    );

    const picked: string[] = [];
    for (const path of candidates) {
      if (picked.length >= MAX_CONTENT_PAGES) break;
      const onProd = await pathWorks(page, opts.prodBase, path);
      if (!onProd) continue;
      const onCand = await pathWorks(page, opts.candBase, path);
      if (onCand) picked.push(path);
    }
    if (picked.length === 0) {
      emit("content: nenhum link de nav funciona nos dois sites");
      return null;
    }
    emit(`content: páginas escolhidas — ${picked.join(", ")}`);
    return picked;
  } finally {
    await ctx.close().catch(() => undefined);
  }
}

/**
 * Make the target's anchor reachable so navigateWithHover takes the hover→prefetch
 * path instead of a cold goto. Leaf pages often live behind a dropdown (e.g.
 * "Especialidades" → Colorretal) or a mobile hamburger. Deco dropdowns open on
 * CLICK (not hover) — the parent anchor's click is intercepted to toggle the
 * submenu instead of navigating. So: open the hamburger, then CLICK each dropdown
 * trigger until the target leaf is visible, backing out if a click navigates away.
 * Returns true once the target anchor is visible (submenu left open).
 */
async function revealLink(page: import("playwright").Page, base: string, path: string): Promise<boolean> {
  const sel = `a[href="${path}"], a[href^="${path}?"]`;
  const isVis = () => page.locator(sel).first().isVisible({ timeout: 400 }).catch(() => false);
  if (await isVis()) return true;
  await openMenu(page).catch(() => undefined); // mobile hamburger (click-based)
  if (await isVis()) return true;
  // Dropdown triggers: header items that own a submenu (aria-haspopup, a
  // .dropdown container, or an <li> with a nested <ul>). Click each to open.
  const triggers = page.locator(
    "header [aria-haspopup] , header .dropdown > a, header .dropdown > button, header li:has(> ul) > a, header li:has(> ul) > button",
  );
  const n = Math.min(await triggers.count().catch(() => 0), 12);
  for (let i = 0; i < n; i++) {
    const before = page.url();
    await triggers.nth(i).click({ timeout: 1_500 }).catch(() => undefined);
    await page.waitForTimeout(300);
    if (page.url() !== before && !page.url().includes(path)) {
      // The click navigated somewhere unrelated — go back and keep trying.
      await page.goto(base, { waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => undefined);
      await waitReady(page).catch(() => undefined);
      continue;
    }
    if (await isVis()) return true;
  }
  return false;
}

async function dismissAllSafe(page: import("playwright").Page): Promise<void> {
  // dismissAll needs a FlowContext; for discovery we only need the cookie/overlay
  // clearing, so call the page-level parts defensively.
  await page.waitForTimeout(400);
  await page
    .locator('button:has-text("Aceitar"), #onetrust-accept-btn-handler')
    .first()
    .click({ timeout: 1_500 })
    .catch(() => undefined);
}

/** One journey pass: home-load, then hover-nav to each content page. */
async function contentPass(
  page: import("playwright").Page,
  flowCtx: FlowContext,
  base: string,
  paths: string[],
  measure: boolean,
): Promise<{ steps: StepTiming[]; screenshots: SideBenchmark["screenshots"] }> {
  const screenshots: SideBenchmark["screenshots"] = {};
  const shot = async (label: string): Promise<void> => {
    if (!measure) return;
    const p = screenshotPath(flowCtx, `bench-${label}`).replace(/\.png$/, ".jpg");
    await screenshotStable(page, { path: p, fullPage: true, quality: 92 });
    screenshots[label] = p;
  };

  // ── home-load ── time to first VISIBLE content, not networkidle (a heavy
  // section like Maps geocoding keeps the network busy long after the page is
  // usable, which would inflate this to the full cap).
  const t = Date.now();
  await page.goto(base, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => undefined);
  const contentOk = await waitForContentReady(page);
  const homeOk = contentOk && !(await pageLooksBroken(page));
  const steps: StepTiming[] = [
    { step: "home-load", ms: Date.now() - t, url: page.url(), ok: homeOk },
  ];
  await dismissAll(page, flowCtx).catch(() => undefined);
  await shot("home");

  // ── home → each content page (hover-prefetch, then click→content) ──
  for (const path of paths) {
    const key = stepKeyForPath(path);
    const target = new URL(path, base).toString();
    // Reveal the anchor (open hamburger / expand dropdown) — UNTIMED prep — so
    // navigateWithHover takes the hover→prefetch path, not a cold goto. Leaf pages
    // behind the "Especialidades" dropdown are only prefetchable once the submenu
    // is open. Mirrors the real flow: open menu/dropdown → hover → click.
    await revealLink(page, base, path).catch(() => undefined);
    const { ok, navMs, landed, viaFallback } = await navigateWithHover(page, target, false);
    steps.push({
      step: key,
      ms: navMs,
      url: page.url(),
      ok,
      note: !landed
        ? `${path} — navegação não trocou de página`
        : viaFallback
          ? `${path} — link não navegou no clique (dropdown/interceptado); medido via goto, sem prefetch`
          : path,
    });
    // Capture the arrived page BEFORE returning home, so the report shows the
    // real content page (not a blank/home frame). Keyed by step so the report
    // renders it under this hop.
    await shot(key);
    // back to home so the next hop starts from the same place (mirrors a reader
    // returning to the menu). Untimed.
    await page.goto(base, { waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => undefined);
    await waitReady(page).catch(() => undefined);
  }
  return { steps, screenshots };
}

/**
 * Run the content journey for ONE side: warm the caches, then take the median of
 * N measured passes. Mirrors runSideBenchmark's returning-visitor model.
 */
export async function runContentSide(
  opts: RunSideOptions & { contentPaths: string[] },
): Promise<SideBenchmark> {
  const emit = (m: string) => opts.onEvent?.(m);
  const empty: SideBenchmark = {
    side: opts.side,
    viewport: opts.viewport,
    base: opts.base,
    steps: [],
    paginationSteps: [],
    totalMs: 0,
    vitals: { home: { error: "not run" }, plp: { error: "not run" }, pdp: { error: "not run" } },
    harPath: opts.harPath,
    screenshots: {},
  };
  const screenshots: SideBenchmark["screenshots"] = {};
  const passes: StepTiming[][] = [];
  const ctx = await newContext(opts.browser, {
    viewport: opts.viewport,
    harPath: opts.harPath,
    deviceScaleFactor: 1,
    cohortCookieValue: "control",
  });
  const flowCtx: FlowContext = {
    baseUrl: opts.base,
    side: opts.side,
    viewport: opts.viewport,
    rc: opts.rc,
    ctx,
    outDir: opts.outDir,
    learned: opts.learned,
    platform: opts.platform,
  };
  try {
    const page = await ctx.newPage();
    for (let r = 0; r < opts.warmupRuns; r++) {
      emit(`[${opts.viewport}/${opts.side}] aquecendo — passe ${r + 1}/${opts.warmupRuns}`);
      await contentPass(page, flowCtx, opts.base, opts.contentPaths, false);
    }
    const runs = Math.max(1, opts.measuredRuns);
    for (let r = 0; r < runs; r++) {
      emit(`[${opts.viewport}/${opts.side}] medindo — passe ${r + 1}/${runs}`);
      const res = await contentPass(page, flowCtx, opts.base, opts.contentPaths, true);
      passes.push(res.steps);
      Object.assign(screenshots, res.screenshots);
    }
    await page.close().catch(() => undefined);
  } catch (err) {
    emit(`[${opts.viewport}/${opts.side}] erro na medição: ${(err as Error).message}`);
  } finally {
    await ctx.close().catch(() => undefined);
  }

  if (passes.length === 0) return { ...empty, screenshots };

  // Aggregate: median per step key across measured passes, preserving pass order.
  const stepKeys = passes[0]!.map((s) => s.step);
  const steps: StepTiming[] = stepKeys.map((key) =>
    aggregatePhase(
      key,
      passes.map((p) => p.find((s) => s.step === key)!).filter(Boolean),
    ),
  );
  const totalMs = steps.reduce((a, s) => a + s.ms, 0);

  // Vitals: home + up to 2 content pages, reusing the report's home/plp/pdp slots.
  let vitals = empty.vitals;
  if (opts.runVitals) {
    emit(`[${opts.viewport}/${opts.side}] Lighthouse (home + conteúdo)…`);
    const ff = opts.viewport === "desktop" ? "desktop" : "mobile";
    const lh = (id: string, url: string): Promise<LhResult> =>
      measureLighthouse(url, { outDir: opts.lighthouseDir, id: `${opts.side}-${opts.viewport}-${id}`, formFactor: ff });
    const urls = [opts.base, ...opts.contentPaths.map((p) => new URL(p, opts.base).toString())];
    const [home, plp, pdp] = await Promise.all([
      lh("home", urls[0]!),
      urls[1] ? lh("content1", urls[1]) : Promise.resolve<LhResult>({ error: "n/a" }),
      urls[2] ? lh("content2", urls[2]) : Promise.resolve<LhResult>({ error: "n/a" }),
    ]);
    vitals = { home, plp, pdp };
  }

  return {
    side: opts.side,
    viewport: opts.viewport,
    base: opts.base,
    steps,
    paginationSteps: [],
    totalMs,
    vitals,
    harPath: opts.harPath,
    screenshots,
  };
}
