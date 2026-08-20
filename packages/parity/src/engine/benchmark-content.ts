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
  pageLooksBroken,
  waitReady,
} from "./benchmark.ts";

/** Max internal content pages to include in the journey (home + these). */
const MAX_CONTENT_PAGES = 2;

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
    const candidates = await discoverNavLinks(page);
    emit(`content: ${candidates.length} link(s) de nav candidatos`);

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
  const shot = async (label: keyof SideBenchmark["screenshots"]): Promise<void> => {
    if (!measure) return;
    const p = screenshotPath(flowCtx, `bench-${label}`).replace(/\.png$/, ".jpg");
    await screenshotStable(page, { path: p, fullPage: true, quality: 92 });
    screenshots[label] = p;
  };

  // ── home-load ── time to first content-ready (not networkidle).
  let t = Date.now();
  await page.goto(base, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => undefined);
  await waitReady(page);
  const homeOk = !(await pageLooksBroken(page));
  const steps: StepTiming[] = [
    { step: "home-load", ms: Date.now() - t, url: page.url(), ok: homeOk },
  ];
  await dismissAll(page, flowCtx).catch(() => undefined);
  await shot("home");

  // ── home → each content page (hover-prefetch, then click→content) ──
  for (const path of paths) {
    const target = new URL(path, base).toString();
    const { ok, navMs } = await navigateWithHover(page, target, false);
    steps.push({ step: stepKeyForPath(path), ms: navMs, url: page.url(), ok, note: path });
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
