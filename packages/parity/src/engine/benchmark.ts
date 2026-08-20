// User Navigation Benchmark driver — the warm before/after story for a
// Fresh→TanStack migration. Three phases, in order (per the spec):
//   1. SCOUT (once, on prod): explore like a shopper — open the hamburger, drill
//      the menu to a real product listing, then find the first in-stock product
//      with a switchable variant. Returns the PLP + PDP paths so BOTH sides are
//      measured over the exact same pages.
//   2. WARM + MEASURE (each side, ONE context — the "returning visitor" model):
//      replay the flow a few times to warm BOTH the edge (Cloudflare) cache AND
//      the browser cache (so the SPA's JS bundle + shared assets are cached, like
//      a shopper who's been here before), then run the measured passes (median)
//      in that same warm context: home → hamburger → PLP → paginate → PDP →
//      shelf SPA hop → variant. Timings come from live wall-clock deltas measured
//      to a real "content ready" signal (the product image), not `networkidle`
//      (Fresh's ad trackers never idle). HAR records the whole session (forensic);
//      the reported numbers are the measured medians. Web Vitals via Lighthouse.
//
// Re-composes existing flow helpers (findCategoryUrl, findProductUrl,
// selectVariant, scrollPageInChunks, countProductCards, dismissOverlays…).
import type { Browser } from "playwright";
import type { Platform } from "../learned/platform.ts";
import type { LearnedSelectors } from "../learned/repo.ts";
import { isLlmAvailable } from "../llm/client.ts";
import { browserFetchBytes, collectSiteAssets } from "../migrate/assets.ts";
import type { ParityRc, Side, Viewport } from "../types/schema.ts";
import { newContext } from "./browser.ts";
import { selectVariant } from "./flows/purchase-journey.ts";
import {
  type FlowContext,
  attemptStepAction,
  clickAndMaybeWait,
  collectCandidateLinks,
  dismissOverlays,
  findCategoryUrl,
  findProductUrl,
  screenshotPath,
  screenshotStable,
  selFor,
  withCap,
} from "./flows/shared.ts";
import { countProductCards, scrollPageInChunks } from "./flows/simple.ts";
import { type LhResult, measureLighthouse } from "./lighthouse.ts";

export interface StepTiming {
  /** Stable key: home-load | home-to-plp | pagination | pdp-entry | variant-switch | pagination-N */
  step: string;
  /** Wall-clock milliseconds the phase took. */
  ms: number;
  url?: string;
  note?: string;
  /** False when the phase couldn't complete (element missing, timeout…). */
  ok: boolean;
}

export type PageVitals = Record<"home" | "plp" | "pdp", LhResult>;

export interface SideBenchmark {
  side: Side;
  viewport: Viewport;
  base: string;
  /** The five headline phases (median across measured runs). */
  steps: StepTiming[];
  /** Per-scroll pagination timings (median per index across measured runs). */
  paginationSteps: StepTiming[];
  /** Sum of the five phase medians — the hero "total journey time". */
  totalMs: number;
  /** Lighthouse per key page, or `{ error }` if it failed / was skipped. */
  vitals: PageVitals;
  /** Absolute path to the recorded HAR (empty if recording failed). */
  harPath: string;
  /**
   * Absolute screenshot paths captured on the last measured pass. Commerce uses
   * the fixed slots; the content journey keys by step (e.g. `nav-especialidades`),
   * so an index signature allows arbitrary step-keyed shots too.
   */
  screenshots: Partial<
    Record<"home" | "plp" | "plpPaginated" | "pdp" | "pdpVariant" | "shelf", string>
  > &
    Record<string, string | undefined>;
}

/** The full benchmark payload written to report.json and fed to the renderer. */
export interface BenchmarkReport {
  prodUrl: string;
  candUrl: string;
  timestamp: string;
  viewports: Viewport[];
  warmupRuns: number;
  measuredRuns: number;
  paginations: number;
  runVitals: boolean;
  /** Site favicon + logo (base64 data URIs) for the report cover, if captured. */
  favicon?: string | null;
  logo?: string | null;
  /** One entry per (viewport × side). Pair by viewport in the report. */
  sides: SideBenchmark[];
}

export interface RunSideOptions {
  browser: Browser;
  base: string;
  side: Side;
  viewport: Viewport;
  rc: ParityRc;
  learned?: LearnedSelectors;
  platform?: Platform;
  /** Directory for step screenshots. */
  outDir: string;
  /** Absolute path where the HAR is written. */
  harPath: string;
  /** Directory for Lighthouse raw JSON + temp dirs. */
  lighthouseDir: string;
  warmupRuns: number;
  measuredRuns: number;
  paginations: number;
  runVitals: boolean;
  /**
   * PLP + PDP paths discovered ONCE (on prod) and reused verbatim on both sides,
   * so the warmup and the measurement exercise the exact same flow over the same
   * pages. When omitted, the side resolves its own pages (legacy/fallback).
   */
  targetPaths?: TargetPaths;
  onEvent?: (msg: string) => void;
}

/** Path (`/cat` / `/produto…/p?skuId=…`) reused across sides against each base. */
export interface TargetPaths {
  categoryPath: string;
  productPath: string;
}

const NAV_CAP_MS = 12_000;
const READY_CAP_MS = 8_000;

export function median(values: number[]): number {
  const clean = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (clean.length === 0) return 0;
  const mid = Math.floor(clean.length / 2);
  return clean.length % 2 ? clean[mid]! : (clean[mid - 1]! + clean[mid]!) / 2;
}

/** CSS-attribute-selector-safe: only `"` and `\` are meaningful inside `[href="…"]`. */
function cssAttrEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** load + networkidle (both capped) + a short settle — fair for SPA and MPA nav. */
export async function waitReady(page: import("playwright").Page, cap = READY_CAP_MS): Promise<void> {
  await withCap(page.waitForLoadState("load"), cap, undefined);
  await withCap(
    page.waitForLoadState("networkidle", { timeout: cap }).catch(() => undefined),
    cap,
    undefined,
  );
  await page.waitForTimeout(400);
}

/**
 * Wait until a real product image has actually LOADED and rendered (decoded,
 * ≥120px on screen). This is the user's "the product image showed up, the page
 * worked" signal — a far better readiness/success check than `networkidle`
 * (which on ad/tracker-heavy Fresh never settles and just inflates the timing).
 * Returns true if an image loaded within `capMs`, false on timeout.
 */
async function waitForProductImage(
  page: import("playwright").Page,
  capMs = 8_000,
): Promise<boolean> {
  return page
    .waitForFunction(
      () => {
        for (const el of Array.from(document.querySelectorAll("img"))) {
          const im = el as HTMLImageElement;
          const r = im.getBoundingClientRect();
          if (im.complete && im.naturalWidth > 100 && r.width >= 120 && r.height >= 120)
            return true;
        }
        return false;
      },
      { timeout: capMs },
    )
    .then(() => true)
    .catch(() => false);
}

/** Poll the product-card count until it GROWS past `before` (real pagination
 *  loaded more products) or the cap elapses. Returns the final count. Meaningful
 *  where `networkidle` isn't — it measures products appearing, not ad chatter. */
async function waitForCardGrowth(
  page: import("playwright").Page,
  before: number,
  capMs: number,
): Promise<number> {
  const deadline = Date.now() + capMs;
  let cur = before;
  while (Date.now() < deadline) {
    cur = await countProductCards(page).catch(() => cur);
    if (cur > before) return cur;
    await page.waitForTimeout(400);
  }
  return cur;
}

/**
 * Navigate to `targetUrl` the way a user would: if a visible link exists, HOVER
 * it (fires `preload="intent"` prefetch on TanStack; a fair no-op on Fresh),
 * let the prefetch land, then click. Falls back to `goto` when no anchor is
 * visible (still fair — identical treatment both sides).
 *
 * Returns `{ ok, navMs }`. **`navMs` is timed from the CLICK to the first product
 * image rendering** — i.e. the navigation the user actually perceives. The hover
 * and the fixed prefetch-settle are deliberately EXCLUDED (they're background
 * prep, not the click→content time); including them added ~700ms of fixed wait
 * and made a warm prefetched SPA hop look like ~1s instead of its real ~300ms.
 * `ok=false` ⇒ no product image appeared (broken/empty page).
 */
export async function navigateWithHover(
  page: import("playwright").Page,
  targetUrl: string,
  productImage = false,
): Promise<{ ok: boolean; navMs: number; landed: boolean }> {
  const targetPath = new URL(targetUrl).pathname;
  const sel = `a[href="${cssAttrEscape(targetUrl)}"], a[href="${cssAttrEscape(targetPath)}"], a[href^="${cssAttrEscape(`${targetPath}?`)}"]`;
  const anchor = page.locator(sel).first();
  const visible = await anchor.isVisible({ timeout: 1_500 }).catch(() => false);
  let t: number;
  let viaFallback = false;
  if (visible) {
    // Prep (UNTIMED): hover so the SPA prefetches, then let it land.
    await anchor.hover({ timeout: 1_500 }).catch(() => undefined);
    await page.waitForTimeout(500);
    t = Date.now(); // ⏱ start the clock at the CLICK
    await Promise.allSettled([
      // Shorter cap than NAV_CAP_MS: a link that hasn't navigated in 6s is a
      // dropdown parent / intercepted click, not a slow page — fall back to goto
      // instead of waiting the full cap (which read as a bogus ~20s timing).
      page
        .waitForURL((u) => u.toString().includes(targetPath), { timeout: 6_000 })
        .catch(() => undefined),
      anchor.click({ timeout: 3_000 }),
    ]);
    if (!page.url().includes(targetPath)) {
      // The click didn't navigate (e.g. /especialidades is a dropdown toggle that
      // opens a submenu instead of navigating). Fall back to a direct goto so the
      // page is still measured; reset the clock to time only the goto.
      viaFallback = true;
      t = Date.now();
      await page
        .goto(targetUrl, { waitUntil: "domcontentloaded", timeout: NAV_CAP_MS })
        .catch(() => undefined);
    }
  } else {
    t = Date.now(); // ⏱ no anchor to hover — time the goto
    await page
      .goto(targetUrl, { waitUntil: "domcontentloaded", timeout: NAV_CAP_MS })
      .catch(() => undefined);
  }
  let ok = true;
  if (productImage) {
    await withCap(page.waitForLoadState("domcontentloaded"), 5_000, undefined);
    ok = await waitForProductImage(page);
  } else {
    await waitReady(page);
  }
  const navMs = Date.now() - t;
  const landed = page.url().includes(targetPath);
  return { ok: ok && landed, navMs, landed, viaFallback };
}

// ── realistic-navigation helpers ─────────────────────────────────────────────

// Cookie-consent accept buttons (OneTrust + common PT/EN variants). Dismissing
// these is what lets the Fresh side actually navigate — a leftover consent modal
// eats the menu click and the page never leaves home.
const COOKIE_ACCEPT_SELECTORS = [
  "#onetrust-accept-btn-handler",
  'button:has-text("Accept All Cookies")',
  'button:has-text("Aceitar todos")',
  'button:has-text("Aceitar tudo")',
  'button:has-text("Aceitar")',
  'button[id*="accept" i][id*="cookie" i]',
];

// Mobile hamburger / menu triggers (aria/text-based so it generalises).
const HAMBURGER_SELECTORS = [
  'button[aria-label*="menu" i]',
  '[aria-label*="abrir menu" i]',
  '[aria-label*="open menu" i]',
  'header [aria-label*="menu" i]',
  "button.hamburger",
  ".hamburger",
  'label[for*="menu" i]',
];

// Links that are never the category we want to drill into.
const MENU_JUNK =
  /login|entrar|minha conta|conta|account|carrinho|\bcart\b|wishlist|desejos|lojas|stores|blog|ajuda|\bsac\b|central|contato|whatsapp|instagram|facebook|tiktok|pinterest|youtube|troca|frete|rastre|pedido|desconto|cupom|baixar|download|\bselo\b|sustentab|transparen|trabalhe|imprensa|termos|privacidade|pol[ií]tica|%|off/i;
// "See all" links inside a submenu lead straight to the full listing.
const SEE_ALL = /ver tudo|ver todos|ver todas|see all|shop all|todos os produtos/i;
// Prefer a real apparel category (colour-rich PDPs, a clean grid) over the
// accessories / campaign sub-brands that pollute the "biggest grid" heuristic.
const CATEGORY_PREFER =
  /novidades|mais vendidos|new in|roupas|vestidos?|blusas?|saias?|shorts?|cal[cç]as?|macac|conjuntos?|moda praia|biqu[ií]nis?|mai[oô]s?|feminin|clothing|dress/i;
const CATEGORY_DEMOTE =
  /\betc\b|collab|acess[oó]ri|cal[cç]ados|bolsas?|beauty|casa|kids|infantil|\bpet\b|zee\.?dog|bazar|presente|\bgift\b/i;

/** Dismiss overlays AND accept the cookie banner (the FARM-navigation blocker). */
export async function dismissAll(page: import("playwright").Page, ctx: FlowContext): Promise<void> {
  await dismissOverlays(page, ctx).catch(() => undefined);
  for (const sel of COOKIE_ACCEPT_SELECTORS) {
    const b = page.locator(sel).first();
    if (await b.isVisible({ timeout: 400 }).catch(() => false)) {
      await b.click({ timeout: 1_500 }).catch(() => undefined);
      await page.waitForTimeout(300);
      break;
    }
  }
}

export async function scrollToTop(page: import("playwright").Page): Promise<void> {
  await page.evaluate(() => window.scrollTo({ top: 0 })).catch(() => undefined);
  await page.waitForTimeout(200);
}

/** Open the mobile hamburger menu. Returns true if a trigger was clicked. */
export async function openMenu(page: import("playwright").Page): Promise<boolean> {
  for (const sel of HAMBURGER_SELECTORS) {
    const btn = page.locator(sel).first();
    if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
      await btn.click({ timeout: 2_000 }).catch(() => undefined);
      await page.waitForTimeout(700);
      return true;
    }
  }
  return false;
}

/** Pick the next link to click while drilling toward a listing. Prefers the
 *  category chain of `preferPath`, then a "ver tudo" link, else the first
 *  non-junk category link in DOM order (menu drawer comes before the footer). */
async function pickMenuLink(
  page: import("playwright").Page,
  preferPath: string | undefined,
): Promise<import("playwright").Locator | null> {
  const anchors = page.locator("a[href]");
  const total = await anchors.count().catch(() => 0);
  const max = Math.min(total, 50);
  let best: { loc: import("playwright").Locator; score: number } | null = null;
  for (let i = 0; i < max; i++) {
    const a = anchors.nth(i);
    if (!(await a.isVisible({ timeout: 120 }).catch(() => false))) continue;
    const href = await a.getAttribute("href").catch(() => null);
    if (!href) continue;
    let path: string;
    try {
      path = new URL(href, page.url()).pathname;
    } catch {
      continue;
    }
    if (path.length < 2 || path === "/") continue;
    const text = ((await a.innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
    if (MENU_JUNK.test(`${text} ${path}`)) continue;
    const hay = `${text} ${path}`;
    let score = 0;
    if (preferPath) {
      if (path === preferPath) score = 100;
      else if (preferPath.startsWith(`${path}/`))
        score = 60; // parent on the chain
      else if (path.startsWith(preferPath)) score = 55;
    }
    if (SEE_ALL.test(text)) score += 40;
    if (!preferPath) {
      // Auto-discovery: bias toward a real apparel category, away from
      // accessories/campaign sub-brands, then fall back to DOM order.
      if (CATEGORY_PREFER.test(hay)) score += 35;
      if (CATEGORY_DEMOTE.test(hay)) score -= 30;
      if (score <= 0) score = 15 - i * 0.2;
    }
    if (score > 0 && (!best || score > best.score)) best = { loc: a, score };
  }
  return best?.loc ?? null;
}

/**
 * True when the page is a 404 / not-found / empty-search error page — e.g. the
 * candidate site doesn't have a route the prod site does. Used to FAIL a step
 * instead of silently reporting a fake-fast time for a broken page.
 */
export async function pageLooksBroken(page: import("playwright").Page): Promise<boolean> {
  return page
    .getByText(
      /n[ãa]o foi encontrad|p[áa]gina n[ãa]o encontrada|not found|erro 404|\bops[,!]? sua busca|nenhum (produto|resultado) encontrado|no results found/i,
    )
    .first()
    .isVisible({ timeout: 600 })
    .catch(() => false);
}

/**
 * Navigate home → listing like a user: open the hamburger, click a category and
 * keep following the first link (or "ver tudo") until a real product grid
 * appears. `preferUrl` (the scouted PLP) biases the drill and is the goto
 * fallback if the menu path can't be followed. Returns true once on a grid.
 */
async function drillToPlp(
  page: import("playwright").Page,
  ctx: FlowContext,
  preferUrl?: string,
): Promise<boolean> {
  const preferPath = preferUrl ? new URL(preferUrl).pathname : undefined;
  const homePath = new URL(ctx.baseUrl).pathname;
  // A real listing is NOT the home (whose shelves also have product cards), is
  // NOT an error/not-found page, and has a proper grid. (We require real
  // products even when the URL matches the scouted PLP — the candidate site may
  // 404 a route the prod site has; matching the path is not enough.)
  const isPlp = async () => {
    let p = "/";
    try {
      p = new URL(page.url()).pathname;
    } catch {}
    if (p === homePath) return false;
    if (await pageLooksBroken(page)) return false;
    return (await countProductCards(page).catch(() => 0)) >= 4;
  };

  const started = Date.now();
  const visited = new Set<string>();
  if (await openMenu(page)) {
    // A shopper taps at most a couple of menu levels (category → "ver tudo").
    // Bound it hard so a fussy MPA menu can't inflate the home→PLP timing — the
    // goto fallback below still guarantees we reach the same PLP.
    for (let depth = 0; depth < 3 && Date.now() - started < 12_000; depth++) {
      if (await isPlp()) return true;
      const next = await pickMenuLink(page, preferPath);
      if (!next) break;
      // Don't click the same href twice (the loop that inflated Fresh's timing).
      const nextHref = (await next.getAttribute("href").catch(() => null)) ?? "";
      if (visited.has(nextHref)) break;
      visited.add(nextHref);
      // Fast click: a submenu panel slide fires no navigation, so don't burn a
      // 5s waitForNavigation on it — race the click against a short URL-change
      // wait and move on.
      const before = page.url();
      await Promise.allSettled([
        next.click({ timeout: 2_500 }),
        page.waitForURL((u) => u.toString() !== before, { timeout: 2_500 }).catch(() => undefined),
      ]);
      await page.waitForTimeout(500);
      // Settle on DOM-ready, NOT networkidle — Fresh's ad trackers never idle
      // and would add a fixed ~6s cap per menu hop, burying the real nav time.
      if (page.url() !== before) {
        await withCap(page.waitForLoadState("domcontentloaded"), 4_000, undefined);
        await page.waitForTimeout(300);
      }
      await dismissAll(page, ctx);
    }
  }
  if (await isPlp()) return true;

  // Fallback: go straight to the scouted PLP (still same page on both sides).
  if (preferUrl) {
    await page
      .goto(preferUrl, { waitUntil: "domcontentloaded", timeout: 30_000 })
      .catch(() => undefined);
    await waitReady(page);
    await dismissAll(page, ctx);
  }
  return isPlp();
}

/** Best-effort src of the PDP's main/first product image — used to detect a
 *  gallery swap when a colour variant is selected. */
async function mainImageSrc(page: import("playwright").Page): Promise<string | null> {
  return page
    .evaluate(() => {
      const imgs = Array.from(document.querySelectorAll("main img, [data-product] img, img"));
      for (const el of imgs) {
        const img = el as HTMLImageElement;
        const r = img.getBoundingClientRect();
        if (r.width >= 150 && r.height >= 150) return img.currentSrc || img.src || null;
      }
      return null;
    })
    .catch(() => null);
}

interface PassResult {
  home: StepTiming;
  homeToPlp: StepTiming;
  pagination: StepTiming[];
  pdp: StepTiming;
  /** SPA test: click a product in the PDP's recommendation shelf (always available). */
  shelf: StepTiming;
  variant: StepTiming;
  screenshots: SideBenchmark["screenshots"];
}

/**
 * Click a product in the PDP's recommendation shelf ("você também pode gostar")
 * — a product→product navigation that ALWAYS exists, so it's the reliable SPA
 * test (SPA nav on TanStack vs full reload on Fresh), independent of whether the
 * product has switchable variants. Hovers first so the SPA prefetches. Returns
 * the destination URL, or null if no shelf product was found.
 */
async function clickShelfProduct(
  page: import("playwright").Page,
  ctx: FlowContext,
): Promise<{ url: string; imgOk: boolean; navMs: number } | null> {
  let curPath = "/";
  try {
    curPath = new URL(page.url()).pathname;
  } catch {}
  const cards = await collectCandidateLinks(page, selFor(ctx, "productCard"), 30).catch(() => []);
  const target = cards.find((c) => {
    try {
      const p = new URL(c.href).pathname;
      return p.endsWith("/p") && p !== curPath;
    } catch {
      return false;
    }
  });
  if (!target) return null;
  const nav = await navigateWithHover(page, target.href, true); // navMs = click → product image
  const now = (() => {
    try {
      return new URL(page.url()).pathname;
    } catch {
      return "";
    }
  })();
  return now !== curPath ? { url: page.url(), imgOk: nav.ok, navMs: nav.navMs } : null;
}

/**
 * One realistic user-navigation pass. When `measure` is false it's a warmup
 * (no screenshots/HAR needed). The flow, per the spec: land on home → scroll to
 * the end (full-page print) → back to top → hamburger → drill to a listing →
 * scroll to trigger paginations (print) → open the product (print) → switch a
 * variant. Every big print is a FULL-PAGE screenshot so the report can show the
 * whole mobile page in a scrollable frame.
 */
async function onePass(
  page: import("playwright").Page,
  ctx: FlowContext,
  targets: { category: string; product: string },
  paginations: number,
  measure: boolean,
): Promise<PassResult> {
  const shot = async (label: string, fullPage: boolean): Promise<string> => {
    if (!measure) return "";
    // High-quality JPEG (user opted for heavier HTML in exchange for crisp
    // prints). Base64-inlined into the single shareable file.
    const p = screenshotPath(ctx, `bench-${label}`).replace(/\.png$/, ".jpg");
    await screenshotStable(page, { path: p, fullPage, quality: 92 });
    return p;
  };

  // ── home-load ── measured to the first hero/product IMAGE rendering (an
  // FCP/LCP-ish "the user sees the page" signal), NOT `networkidle` — Fresh's
  // ad/tracker requests never settle, so networkidle would just measure our cap
  // and even make the SPA look "slower". This is the meaningful, fair number.
  let t = Date.now();
  await page
    .goto(ctx.baseUrl, { waitUntil: "domcontentloaded", timeout: 30_000 })
    .catch(() => undefined);
  const homeImg = await waitForProductImage(page, 12_000);
  const home: StepTiming = {
    step: "home-load",
    ms: Date.now() - t,
    url: page.url(),
    ok: homeImg && !(await pageLooksBroken(page)),
    note: homeImg ? undefined : "home não renderizou imagem",
  };
  await dismissAll(page, ctx);
  await scrollPageInChunks(page).catch(() => undefined); // scroll to the end (lazy content)
  const homeShot = await shot("home", true); // full-page print of the whole home
  await scrollToTop(page);

  // ── home → PLP (via hamburger menu, drilling submenus) ──
  t = Date.now();
  const reachedGrid = await drillToPlp(page, ctx, targets.category);
  // The listing only "worked" if a product IMAGE actually loaded (the user's
  // "vi a foto do produto, deu certo" signal) — and it's not a not-found page.
  const plpImg = reachedGrid ? await waitForProductImage(page, 6_000) : false;
  const plpBroken = await pageLooksBroken(page);
  const plpCards = await countProductCards(page).catch(() => 0);
  const onPlp = reachedGrid && plpImg && !plpBroken;
  const homeToPlp: StepTiming = {
    step: "home-to-plp",
    ms: Date.now() - t,
    url: page.url(),
    ok: onPlp,
    note: onPlp
      ? undefined
      : plpBroken
        ? "página não encontrada / erro (rota inexistente neste site)"
        : !reachedGrid
          ? `PLP sem produtos (${plpCards})`
          : "imagens de produto não carregaram",
  };
  const plpShot = await shot("plp", true);

  // ── pagination (scroll to the end N times) ── a scroll only "passes" if the
  //    product count actually GREW (a broken/empty PLP would otherwise pass at
  //    0→0). Skip entirely when the PLP itself failed.
  const pagination: StepTiming[] = [];
  let before = await countProductCards(page).catch(() => 0);
  for (let i = 0; i < paginations; i++) {
    const pt = Date.now();
    if (!onPlp) {
      pagination.push({
        step: `pagination-${i + 1}`,
        ms: 0,
        ok: false,
        note: "PLP falhou — paginação não executada",
      });
      continue;
    }
    // Jump straight to the bottom to trigger the next batch, then measure the
    // time until those products actually appear — that's the real pagination
    // load speed (Fresh API+render vs TanStack). Using a fixed chunked-scroll
    // animation here would just measure our own ~3s scroll, identical on both.
    await page
      .evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
      .catch(() => undefined);
    const after = await waitForCardGrowth(page, before, 5_000);
    if (after <= before) {
      // No more products — a finite grid we've exhausted. Don't keep eating the
      // cap on further scrolls (that inflated the number); stop and mark the rest.
      pagination.push({
        step: `pagination-${i + 1}`,
        ms: Date.now() - pt,
        ok: i > 0, // ok if at least one earlier scroll paginated
        note: `sem mais produtos (${after})`,
      });
      for (let j = i + 1; j < paginations; j++) {
        pagination.push({
          step: `pagination-${j + 1}`,
          ms: 0,
          ok: true,
          note: "sem mais produtos",
        });
      }
      break;
    }
    pagination.push({
      step: `pagination-${i + 1}`,
      ms: Date.now() - pt,
      ok: true,
      note: `${after} cards (+${after - before})`,
    });
    before = after;
  }
  // Scroll through once (untimed) so lazy images decode for the full-page print.
  if (measure) await scrollPageInChunks(page).catch(() => undefined);
  const plpPaginatedShot = await shot("plp-paginated", true);
  await scrollToTop(page);

  // ── PDP entry (open the scouted product from the listing) — retry once on
  //    "produto não encontrado" (the card wasn't there / nav didn't land). ──
  const productPath = new URL(targets.product).pathname;
  const reachedPdp = () => page.url().includes(productPath);
  let pdpNav = await navigateWithHover(page, targets.product, true); // navMs = click → product image
  if (!reachedPdp() || !pdpNav.ok) {
    await page.waitForTimeout(500);
    pdpNav = await navigateWithHover(page, targets.product, true);
  }
  await dismissAll(page, ctx);
  const pdpBroken = await pageLooksBroken(page);
  const pdpOk = reachedPdp() && !pdpBroken && pdpNav.ok;
  const pdp: StepTiming = {
    step: "pdp-entry",
    ms: pdpNav.navMs,
    url: page.url(),
    ok: pdpOk,
    note: pdpOk
      ? undefined
      : pdpBroken
        ? "página não encontrada / erro"
        : !reachedPdp()
          ? "produto não encontrado (após retry)"
          : "imagem do produto não carregou",
  };
  await scrollPageInChunks(page).catch(() => undefined); // scroll the whole PDP
  const pdpShot = await shot("pdp", true);
  await scrollToTop(page);

  // ── variant switch — ONLY if the product actually has a switchable COLOUR
  //    variant (a colourway sibling to navigate to, or ≥2 colour swatches).
  //    Size-only / single-colour products have nothing to switch → skip the
  //    step honestly instead of faking an in-place toggle. ──
  const sibling = await findColorwaySibling(page);
  let colorSwatchCount = 0;
  for (const sel of selFor(ctx, "colorSwatch")) {
    colorSwatchCount = await page
      .locator(sel)
      .count()
      .catch(() => 0);
    if (colorSwatchCount > 0) break;
  }
  const hasColorVariant = !!sibling || colorSwatchCount >= 2;
  let variant: StepTiming;
  let pdpVariantShot = "";
  if (!hasColorVariant) {
    variant = {
      step: "variant-switch",
      ms: 0,
      url: page.url(),
      ok: true,
      note: "produto sem variante de cor — etapa não aplicável",
    };
  } else {
    const beforeUrl = page.url();
    const beforeImg = await mainImageSrc(page);
    t = Date.now();
    const variantBudget = { remaining: measure && isLlmAvailable() ? 2 : 0 };
    const switched = await switchVariant(page, ctx, variantBudget);
    await waitReady(page, 6_000);
    const afterUrl = page.url();
    const afterImg = await mainImageSrc(page);
    const changed =
      afterUrl !== beforeUrl
        ? "URL/SKU mudou (nav)"
        : beforeImg && afterImg && afterImg !== beforeImg
          ? "imagem trocada"
          : "seleção in-place";
    variant = {
      step: "variant-switch",
      ms: Date.now() - t,
      url: afterUrl,
      ok: switched.ok,
      note: switched.ok ? `${switched.note} — ${changed}` : switched.note,
    };
    pdpVariantShot = await shot("pdp-variant", true);
    await scrollToTop(page);
  }

  // ── shelf SPA test — click a product in the PDP's recommendation shelf. This
  //    ALWAYS exists, so it's the dependable SPA-vs-reload demonstrator (SPA nav
  //    on TanStack vs full reload on Fresh). Retry once if no product is found. ──
  let shelfHit = await clickShelfProduct(page, ctx).catch(() => null);
  if (!shelfHit || !shelfHit.imgOk) {
    await page.waitForTimeout(500);
    shelfHit = (await clickShelfProduct(page, ctx).catch(() => null)) ?? shelfHit;
  }
  await dismissAll(page, ctx);
  const shelfBroken = shelfHit ? await pageLooksBroken(page) : false;
  const shelfOk = !!shelfHit && shelfHit.imgOk && !shelfBroken;
  const shelf: StepTiming = {
    step: "shelf-nav",
    ms: shelfHit?.navMs ?? 0, // click → product image
    url: page.url(),
    ok: shelfOk,
    note: shelfBroken
      ? "página não encontrada / erro"
      : !shelfHit
        ? "shelf sem produto (após retry)"
        : !shelfHit.imgOk
          ? "imagem do produto da shelf não carregou"
          : "produto da shelf (SPA→SPA)",
  };
  await scrollPageInChunks(page).catch(() => undefined);
  const shelfShot = await shot("shelf", true);
  await scrollToTop(page);

  const screenshots: SideBenchmark["screenshots"] = measure
    ? {
        home: homeShot,
        plp: plpShot,
        plpPaginated: plpPaginatedShot,
        pdp: pdpShot,
        pdpVariant: pdpVariantShot,
        shelf: shelfShot,
      }
    : {};
  return { home, homeToPlp, pagination, pdp, shelf, variant, screenshots };
}

// Heuristic triggers that OPEN a size/variant selector (drawer/modal patterns
// like FARM's "Selecione um tamanho"), so hidden size options become clickable.
// Kept text/aria-based (not site-specific ids) so it generalises across stores.
const OPEN_VARIANT_SELECTORS = [
  'button:has-text("Selecione um tamanho")',
  'button:has-text("Selecione o tamanho")',
  'button:has-text("Escolha o tamanho")',
  'button:has-text("Escolha seu tamanho")',
  '[aria-label*="selecione" i][aria-label*="tamanho" i]',
  '[data-testid*="size" i][role="button"]',
];

/**
 * Find a sibling *colourway* of the current product — a different colour of the
 * same style, which on many stores (FARM included) is a SEPARATE product page.
 * Colourways share the product reference id in the slug (…-<ref>-<sku>/p) but
 * differ elsewhere. Switching to one is a real page navigation, which is exactly
 * where a SPA (TanStack) beats an MPA reload (Fresh) — the headline of the
 * variant step. Returns the sibling URL + a short colour label, or null.
 */
async function findColorwaySibling(
  page: import("playwright").Page,
): Promise<{ url: string; label: string } | null> {
  let cur: URL;
  try {
    cur = new URL(page.url());
  } catch {
    return null;
  }
  const m = cur.pathname.match(/-(\d{4,})-\d+\/p$/); // …-315920-05020/p → ref 315920
  if (!m) return null;
  const ref = m[1];
  const curPath = cur.pathname;
  const hrefs = await page
    .evaluate(() =>
      Array.from(document.querySelectorAll("a[href]")).map(
        (a) => (a as HTMLAnchorElement).getAttribute("href") || "",
      ),
    )
    .catch(() => [] as string[]);
  for (const h of hrefs) {
    let u: URL;
    try {
      u = new URL(h, cur.origin);
    } catch {
      continue;
    }
    if (!u.pathname.endsWith("/p")) continue;
    if (u.pathname === curPath) continue; // skip self (incl. own ?skuId links)
    if (!u.pathname.includes(`-${ref}-`)) continue; // same product family
    // Colour ≈ the slug words between the style name and the ref number.
    const label =
      u.pathname.replace(/\/p$/, "").split(`-${ref}-`)[0]?.split("-").slice(-2).join(" ") ||
      "outra cor";
    return { url: u.toString(), label };
  }
  return null;
}

/** Click the last visible/enabled swatch of a kind (not the pre-selected first). */
async function clickDifferentSwatch(
  page: import("playwright").Page,
  ctx: FlowContext,
  kind: "colorSwatch" | "sizeSwatch",
): Promise<{ ok: boolean; note: string } | null> {
  const kindLabel = kind === "colorSwatch" ? "Cor" : "Tamanho";
  for (const sel of selFor(ctx, kind)) {
    const loc = page.locator(sel);
    const count = await loc.count().catch(() => 0);
    for (let i = count - 1; i >= 0; i--) {
      const sw = loc.nth(i);
      if (!(await sw.isVisible({ timeout: 500 }).catch(() => false))) continue;
      if (await sw.isDisabled().catch(() => false)) continue;
      const raw =
        (await sw.getAttribute("aria-label").catch(() => null)) ||
        (await sw.innerText().catch(() => "")) ||
        "";
      const label = raw.replace(/\s+/g, " ").trim().slice(0, 40);
      await clickAndMaybeWait(page, sw, kind);
      return { ok: true, note: label ? `${kindLabel}: ${label}` : `${kindLabel} trocada` };
    }
  }
  return null;
}

/**
 * Switch to a *different* variant so the change is real and visible. Detection,
 * from cheapest to most general (the answer to "como melhoramos a detecção"):
 *   1. Inline swatches — COLOR first (changes the gallery), else SIZE; clicks a
 *      swatch that is NOT the pre-selected first one.
 *   2. Open a closed size/variant selector (drawer/modal trigger), then retry (1)
 *      — stores like FARM hide sizes behind "Selecione um tamanho".
 *   3. LLM fallback (budget-gated, same machinery `purchase-journey` uses): reads
 *      the DOM and clicks the right control on any custom markup, then retries (1).
 * Falls back to the generic `selectVariant` heuristic (variant rows / quantity).
 */
async function switchVariant(
  page: import("playwright").Page,
  ctx: FlowContext,
  budget: { remaining: number },
): Promise<{ ok: boolean; note: string }> {
  // 0) COLOURWAY navigation — the headline switch: go to a different colour of
  // the same style (a separate product page). HOVER first so TanStack's
  // preload="intent" prefetches it, then click → the SPA nav vs the Fresh reload
  // is exactly the difference we want to time. Same hover applied to both sides.
  const sibling = await findColorwaySibling(page);
  if (sibling) {
    await navigateWithHover(page, sibling.url);
    return { ok: true, note: `Cor trocada → ${sibling.label}` };
  }

  // 1) inline swatches
  for (const kind of ["colorSwatch", "sizeSwatch"] as const) {
    const hit = await clickDifferentSwatch(page, ctx, kind);
    if (hit) return hit;
  }

  // 2) open a closed selector, then retry inline swatches
  for (const sel of OPEN_VARIANT_SELECTORS) {
    const trigger = page.locator(sel).first();
    if (!(await trigger.isVisible({ timeout: 400 }).catch(() => false))) continue;
    await trigger.click({ timeout: 2_000 }).catch(() => undefined);
    await page.waitForTimeout(600);
    const hit =
      (await clickDifferentSwatch(page, ctx, "sizeSwatch")) ??
      (await clickDifferentSwatch(page, ctx, "colorSwatch"));
    if (hit) return { ok: true, note: `${hit.note} (via seletor)` };
    break; // one open attempt is enough
  }

  // 3) LLM fallback — reads the DOM and picks the control on any markup
  if (budget.remaining > 0) {
    const act = await attemptStepAction({
      page,
      ctx,
      stepName: "switch-variant",
      intendedAction:
        "Trocar a variante do produto: se houver um seletor de tamanho/cor fechado, abra-o e escolha uma opção DISPONÍVEL diferente da selecionada; ou clique numa cor/tamanho diferente. NÃO clique no botão de comprar.",
      selectorKey: "sizeSwatch",
      action: "click",
      recoveryBudget: budget,
    }).catch(() => null);
    if (act?.performed) {
      await page.waitForTimeout(600);
      const hit =
        (await clickDifferentSwatch(page, ctx, "sizeSwatch")) ??
        (await clickDifferentSwatch(page, ctx, "colorSwatch"));
      return hit ?? { ok: true, note: "variante selecionada (via IA)" };
    }
  }

  // Fallback: generic heuristic (variant rows / quantity steppers).
  const res = await selectVariant(page, ctx).catch(() => null);
  return {
    ok: !!res && res.actions.length > 0,
    note:
      res?.actions[0] ??
      (res?.variantRequired ? "variante exigida, não selecionada" : "sem variantes na PDP"),
  };
}

/** Resolve the category (PLP) and product (PDP) URLs once, up front. */
async function resolveTargets(
  page: import("playwright").Page,
  ctx: FlowContext,
): Promise<{ category: string; product: string } | null> {
  await page
    .goto(ctx.baseUrl, { waitUntil: "domcontentloaded", timeout: 30_000 })
    .catch(() => undefined);
  await waitReady(page);
  await dismissAll(page, ctx);

  // Scout the listing reliably (this decides the pages BOTH sides use, so it
  // must be deterministic — the fragile part, the hamburger drill, is left to
  // the measured pass where a goto fallback guarantees the same PLP anyway).
  // A pinned --plp wins; otherwise pick the best real apparel grid.
  const category: string | null = ctx.rc.plpUrlHint
    ? new URL(ctx.rc.plpUrlHint, ctx.baseUrl).toString()
    : await pickBestPlp(page, ctx);
  if (!category) return null;
  await page
    .goto(category, { waitUntil: "domcontentloaded", timeout: 30_000 })
    .catch(() => undefined);
  await waitReady(page);
  await dismissAll(page, ctx);

  // Probe several products and pick the BEST for a variant-switch demo:
  //   2 = ≥2 color swatches (switching changes the gallery image — ideal)
  //   1 = in-stock with some variant control (size drawer / single color)
  //   0 = out of stock or single-SKU (nothing to switch)
  // Short-circuit on the first score-2 product; otherwise keep the first score-1
  // as a fallback; else fall back to the first card.
  const candidates = await collectCandidateLinks(page, selFor(ctx, "productCard"), 30).catch(
    () => [],
  );
  const productHrefs = candidates.map((c) => c.href).filter((h, i, a) => a.indexOf(h) === i);
  const firstHref =
    productHrefs[0] ?? (await findProductUrl(page, ctx).catch(() => null))?.url ?? null;

  // Probe more products (up to 20) — a COLOUR-switchable one (score 2: has a
  // colourway sibling → switching colour is a page nav, the SPA-vs-reload story)
  // is the best demo, and print-heavy categories bury the solids, so look deep.
  let bestVariant: string | null = null;
  for (const href of productHrefs.slice(0, 20)) {
    await page
      .goto(href, { waitUntil: "domcontentloaded", timeout: 30_000 })
      .catch(() => undefined);
    await waitReady(page, 6_000);
    await dismissOverlays(page, ctx).catch(() => undefined);
    const score = await variantScore(page, ctx);
    if (score >= 2) return { category, product: href }; // ideal: color-switchable
    if (score === 1 && !bestVariant) bestVariant = href; // keep first usable fallback
  }

  const product = bestVariant ?? firstHref;
  if (!product) return null;
  return { category, product };
}

/**
 * Pick a real PLP (product-listing grid), not a banner CTA that jumps to a
 * curated sub-home. We gather category candidates (the LLM's semantic pick +
 * the header-nav category links), open each, and keep the one with the LARGEST
 * product grid after a scroll — a true listing has far more cards than a
 * campaign shelf. Returns null if nothing has a real grid.
 */
async function pickBestPlp(
  page: import("playwright").Page,
  ctx: FlowContext,
): Promise<string | null> {
  const seen = new Set<string>();
  const candidates: string[] = [];
  const push = (u: string | null | undefined) => {
    if (u && !seen.has(u)) {
      seen.add(u);
      candidates.push(u);
    }
  };
  // The LLM's semantic pick first, then header-nav category links, then a few
  // common apparel-category slugs — many stores (FARM included) don't use `/c/`
  // paths, so the header-nav selectors find nothing and we'd otherwise be stuck
  // with only the LLM's (often campaign) pick.
  push((await findCategoryUrl(page, ctx).catch(() => null))?.url);
  for (const c of await collectCandidateLinks(page, selFor(ctx, "categoryLink"), 12).catch(
    () => [],
  )) {
    push(c.href);
  }
  for (const slug of ["/novidades", "/mais-vendidos", "/roupas", "/vestidos", "/new-in"]) {
    push(new URL(slug, ctx.baseUrl).toString());
  }

  const homeUrl = page.url();
  // Score = product-grid size, but strongly prefer apparel categories and
  // demote accessories/campaign sub-brands (ETC/Collabs/Bazar) so we don't
  // "win" on the biggest-but-wrong grid.
  let best: { url: string; score: number; count: number } | null = null;
  for (const url of candidates.slice(0, 6)) {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => undefined);
    await waitReady(page, 6_000);
    await dismissOverlays(page, ctx).catch(() => undefined);
    await scrollPageInChunks(page).catch(() => undefined);
    const count = await countProductCards(page).catch(() => 0);
    const hay = new URL(url).pathname;
    let score = count;
    if (CATEGORY_PREFER.test(hay)) score += 1000;
    if (CATEGORY_DEMOTE.test(hay)) score -= 1000;
    if (!best || score > best.score) best = { url, score, count };
    // A preferred category with a real grid is a clear win — stop early.
    if (CATEGORY_PREFER.test(hay) && count >= 12) break;
  }
  await page
    .goto(homeUrl, { waitUntil: "domcontentloaded", timeout: 30_000 })
    .catch(() => undefined);
  // Require a real grid (≥12); a curated sub-home/shelf won't clear this.
  if (best && best.count >= 12) return best.url;
  return best?.url ?? candidates[0] ?? null;
}

/**
 * Rank a PDP for the variant-switch demo: 2 = a real COLOUR switch is possible
 * (a colourway sibling to navigate to, or ≥2 colour swatches — the switch
 * changes the page/gallery, the SPA-vs-reload story), 1 = in-stock with only a
 * size control (in-place, no nav), 0 = out of stock or single-SKU. Keeps
 * discovery off "Avise-me quando voltar" pages and single-size accessories.
 */
async function variantScore(page: import("playwright").Page, ctx: FlowContext): Promise<0 | 1 | 2> {
  const outOfStock = await page
    .getByText(/avise[- ]?me quando voltar|produto esgotado|indisponível|não está mais disponível/i)
    .first()
    .isVisible({ timeout: 800 })
    .catch(() => false);
  if (outOfStock) return 0;

  // Best: a colourway sibling exists → switching colour is a page navigation.
  if (await findColorwaySibling(page)) return 2;

  let colorCount = 0;
  for (const sel of selFor(ctx, "colorSwatch")) {
    colorCount = await page
      .locator(sel)
      .count()
      .catch(() => 0);
    if (colorCount > 0) break;
  }
  if (colorCount >= 2) return 2;

  if (colorCount === 1) return 1;
  for (const sel of selFor(ctx, "sizeSwatch")) {
    if (
      await page
        .locator(sel)
        .first()
        .isVisible({ timeout: 500 })
        .catch(() => false)
    ) {
      return 1;
    }
  }
  for (const sel of OPEN_VARIANT_SELECTORS) {
    if (
      await page
        .locator(sel)
        .first()
        .isVisible({ timeout: 400 })
        .catch(() => false)
    ) {
      return 1;
    }
  }
  return 0;
}

/**
 * Load `url` and decide if it's a WORKING listing. Candidate SPA sites (TanStack)
 * return HTTP 200 with an empty SSR shell and CLIENT-render either products or a
 * "não foi encontrada" error — so we can't judge from the response; we POLL the
 * live DOM until products OR an error appears (whichever comes first).
 */
async function loadAndCheckPlp(
  page: import("playwright").Page,
  ctx: FlowContext,
  url: string,
): Promise<boolean> {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => undefined);
  await withCap(page.waitForLoadState("load"), 8_000, undefined);
  await dismissAll(page, ctx);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await pageLooksBroken(page)) return false;
    if ((await countProductCards(page).catch(() => 0)) >= 4) return true;
    await page.waitForTimeout(600);
  }
  return (await countProductCards(page).catch(() => 0)) >= 4;
}

/** Load `url` and decide if it's a WORKING product page (poll for a product
 *  image vs an error, same client-render reason as the PLP check). */
async function loadAndCheckProduct(
  page: import("playwright").Page,
  ctx: FlowContext,
  url: string,
): Promise<boolean> {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => undefined);
  await withCap(page.waitForLoadState("load"), 8_000, undefined);
  await dismissAll(page, ctx);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await pageLooksBroken(page)) return false;
    if (await waitForProductImage(page, 1_200)) return true;
    await page.waitForTimeout(300);
  }
  return false;
}

/** Ordered category-path candidates to try (pinned --plp first, then the LLM
 *  pick, header-nav links, and common apparel slugs; apparel-preferred). */
async function plpCandidatePaths(
  page: import("playwright").Page,
  ctx: FlowContext,
): Promise<string[]> {
  const seen = new Set<string>();
  const out: string[] = [];
  const toPath = (u: string): string | null => {
    try {
      const url = new URL(u, ctx.baseUrl);
      return url.pathname + url.search;
    } catch {
      return null;
    }
  };
  const push = (u: string | null | undefined) => {
    const p = u ? toPath(u) : null;
    if (p && p !== "/" && !seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  };
  if (ctx.rc.plpUrlHint) push(ctx.rc.plpUrlHint);
  push((await findCategoryUrl(page, ctx).catch(() => null))?.url);
  for (const c of await collectCandidateLinks(page, selFor(ctx, "categoryLink"), 16).catch(
    () => [],
  )) {
    push(c.href);
  }
  for (const slug of ["/novidades", "/mais-vendidos", "/roupas", "/vestidos", "/new-in"])
    push(slug);
  const rank = (p: string) => (CATEGORY_PREFER.test(p) ? 0 : CATEGORY_DEMOTE.test(p) ? 2 : 1);
  // A pinned --plp wins outright; otherwise sort ALL candidates apparel-first so
  // a real clothing category (/novidades) beats an accessories sub-home
  // (/farm-etc) even when the LLM's semantic pick was the latter.
  if (ctx.rc.plpUrlHint) {
    const [hint, ...rest] = out;
    rest.sort((a, b) => rank(a) - rank(b));
    return [hint!, ...rest];
  }
  return out.sort((a, b) => rank(a) - rank(b));
}

/**
 * Discovery run — the "batedor". Finds a PLP + PDP that WORK ON BOTH SITES
 * (prod AND candidate): it validates each candidate page loads a real product
 * image with no error, on both bases, before committing. This is what keeps the
 * benchmark from ever measuring a broken page (e.g. a category route the
 * candidate doesn't have). Returns null if nothing validates on both.
 */
/** Site favicon + logo as base64 data URIs, for the report cover (brand-level,
 * identical on prod/cand, so grabbed once from whichever home is already open). */
export interface Brand {
  favicon: string | null;
  logo: string | null;
}

async function captureBrand(page: import("playwright").Page): Promise<Brand> {
  const dataUri = async (url: string | null): Promise<string | null> => {
    if (!url) return null;
    const got = await browserFetchBytes(page, url);
    return got ? `data:${got.contentType ?? "image/png"};base64,${got.buf.toString("base64")}` : null;
  };
  try {
    const a = await collectSiteAssets(page);
    const favicon = await dataUri(a.favicon);
    let logo: string | null = null;
    if (a.logo?.type === "img") logo = await dataUri(a.logo.url);
    else if (a.logo?.type === "svg")
      logo = `data:image/svg+xml;base64,${Buffer.from(a.logo.markup).toString("base64")}`;
    return { favicon, logo };
  } catch {
    return { favicon: null, logo: null };
  }
}

export async function resolveTargetPaths(opts: {
  browser: Browser;
  prodBase: string;
  candBase: string;
  viewport: Viewport;
  rc: ParityRc;
  learned?: LearnedSelectors;
  platform?: Platform;
  outDir: string;
  onEvent?: (msg: string) => void;
}): Promise<(TargetPaths & Brand) | null> {
  const mk = (base: string) =>
    newContext(opts.browser, {
      viewport: opts.viewport,
      diskCacheDisabled: true,
      deviceScaleFactor: 1,
      cohortCookieValue: "control",
    }).then(async (ctx) => {
      const page = await ctx.newPage();
      const flow: FlowContext = {
        baseUrl: base,
        side: "prod",
        viewport: opts.viewport,
        rc: opts.rc,
        ctx,
        outDir: opts.outDir,
        learned: opts.learned,
        platform: opts.platform,
      };
      return { ctx, page, flow };
    });

  const prod = await mk(opts.prodBase);
  const cand = await mk(opts.candBase);
  try {
    await prod.page
      .goto(opts.prodBase, { waitUntil: "domcontentloaded", timeout: 30_000 })
      .catch(() => undefined);
    await waitReady(prod.page);
    await dismissAll(prod.page, prod.flow);

    // Brand assets (favicon/logo) for the report cover — home is loaded now.
    const brand = await captureBrand(prod.page);

    const catPaths = await plpCandidatePaths(prod.page, prod.flow);
    for (const catPath of catPaths.slice(0, 8)) {
      opts.onEvent?.(`validando categoria ${catPath} nos dois sites…`);
      if (
        !(await loadAndCheckPlp(prod.page, prod.flow, new URL(catPath, opts.prodBase).toString()))
      )
        continue;
      if (
        !(await loadAndCheckPlp(cand.page, cand.flow, new URL(catPath, opts.candBase).toString()))
      ) {
        opts.onEvent?.(`  ${catPath} não existe/quebra no candidato — tentando outra`);
        continue;
      }
      // Both PLPs work. Find a product that also works on BOTH.
      await scrollPageInChunks(prod.page).catch(() => undefined);
      const cards = await collectCandidateLinks(
        prod.page,
        selFor(prod.flow, "productCard"),
        20,
      ).catch(() => []);
      const productPaths = cards
        .map((c) => {
          try {
            const u = new URL(c.href);
            return u.pathname + u.search;
          } catch {
            return null;
          }
        })
        .filter((p): p is string => !!p && p.endsWith("/p"))
        .filter((p, i, a) => a.indexOf(p) === i);
      for (const pPath of productPaths.slice(0, 12)) {
        if (
          !(await loadAndCheckProduct(
            prod.page,
            prod.flow,
            new URL(pPath, opts.prodBase).toString(),
          ))
        )
          continue;
        if (
          !(await loadAndCheckProduct(
            cand.page,
            cand.flow,
            new URL(pPath, opts.candBase).toString(),
          ))
        )
          continue;
        opts.onEvent?.(`  ✓ PLP ${catPath} + PDP ${pPath} funcionam nos dois`);
        return { categoryPath: catPath, productPath: pPath, ...brand };
      }
    }
    return null;
  } finally {
    await prod.ctx.close().catch(() => undefined);
    await cand.ctx.close().catch(() => undefined);
  }
}

export async function runSideBenchmark(opts: RunSideOptions): Promise<SideBenchmark> {
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

  const flowCtxFor = (ctx: import("playwright").BrowserContext): FlowContext => ({
    baseUrl: opts.base,
    side: opts.side,
    viewport: opts.viewport,
    rc: opts.rc,
    ctx,
    outDir: opts.outDir,
    learned: opts.learned,
    platform: opts.platform,
  });

  const screenshots: SideBenchmark["screenshots"] = {};
  const measured: PassResult[] = [];
  let targets: { category: string; product: string } | null = null;

  // ── Model A (returning visitor): ONE context, browser cache ON. The warmup
  // passes warm BOTH the edge (CF, server-side) AND the browser cache — so by
  // the measured passes the SPA's JS bundle and shared assets are already
  // cached, exactly like a shopper who has visited before. This is the fair,
  // stable comparison; disabling the browser cache instead would force the SPA
  // to re-download its bundle on every full page load and make it look slower
  // than it is. HAR records the whole session (warmup + measured); the reported
  // timings are the measured medians (live `Date.now`), so the extra HAR entries
  // are only forensic context.
  const ctx = await newContext(opts.browser, {
    viewport: opts.viewport,
    harPath: opts.harPath,
    deviceScaleFactor: 1,
    cohortCookieValue: "control",
  });
  try {
    const page = await ctx.newPage();
    const flowCtx = flowCtxFor(ctx);
    if (opts.targetPaths) {
      targets = {
        category: new URL(opts.targetPaths.categoryPath, opts.base).toString(),
        product: new URL(opts.targetPaths.productPath, opts.base).toString(),
      };
    } else {
      emit(`[${opts.viewport}/${opts.side}] resolvendo PLP + PDP…`);
      targets = await resolveTargets(page, flowCtx);
    }
    if (targets) {
      for (let r = 0; r < opts.warmupRuns; r++) {
        emit(
          `[${opts.viewport}/${opts.side}] aquecendo (borda + navegador) — passe ${r + 1}/${opts.warmupRuns}`,
        );
        await onePass(page, flowCtx, targets, opts.paginations, false);
      }
      const runs = Math.max(1, opts.measuredRuns);
      for (let r = 0; r < runs; r++) {
        emit(`[${opts.viewport}/${opts.side}] medindo navegação — passe ${r + 1}/${runs}`);
        const res = await onePass(page, flowCtx, targets, opts.paginations, true);
        measured.push(res);
        Object.assign(screenshots, res.screenshots);
      }
    }
    await page.close().catch(() => undefined);
  } catch (err) {
    emit(`[${opts.viewport}/${opts.side}] erro na medição: ${(err as Error).message}`);
  } finally {
    // HAR flushes on context close. Do this BEFORE Lighthouse so no resident
    // Chromium competes with Lighthouse's devtools-throttled CPU measurement.
    await ctx.close().catch(() => undefined);
  }

  if (!targets) {
    emit(`[${opts.viewport}/${opts.side}] não achou PLP/PDP — abortando lado`);
    return empty;
  }
  if (measured.length === 0) return { ...empty, screenshots };

  // Aggregate the five phases (median across measured passes).
  const steps: StepTiming[] = [
    aggregatePhase(
      "home-load",
      measured.map((m) => m.home),
    ),
    aggregatePhase(
      "home-to-plp",
      measured.map((m) => m.homeToPlp),
    ),
    aggregatePaginationTotal(measured),
    aggregatePhase(
      "pdp-entry",
      measured.map((m) => m.pdp),
    ),
    aggregatePhase(
      "shelf-nav",
      measured.map((m) => m.shelf),
    ),
    aggregatePhase(
      "variant-switch",
      measured.map((m) => m.variant),
    ),
  ];
  const paginationSteps = aggregatePaginationSteps(measured);
  const totalMs = steps.reduce((a, s) => a + s.ms, 0);

  // Web Vitals via Lighthouse (cold lab), after the context is closed.
  let vitals = empty.vitals;
  if (opts.runVitals) {
    emit(`[${opts.viewport}/${opts.side}] Lighthouse (home/PLP/PDP)…`);
    const ff = opts.viewport === "desktop" ? "desktop" : "mobile";
    const lh = (id: string, url: string) =>
      measureLighthouse(url, {
        outDir: opts.lighthouseDir,
        id: `${opts.side}-${opts.viewport}-${id}`,
        formFactor: ff,
      });
    const [home, plp, pdp] = await Promise.all([
      lh("home", opts.base),
      lh("plp", targets.category),
      lh("pdp", targets.product),
    ]);
    vitals = { home, plp, pdp };
  }

  return {
    side: opts.side,
    viewport: opts.viewport,
    base: opts.base,
    steps,
    paginationSteps,
    totalMs,
    vitals,
    harPath: opts.harPath,
    screenshots,
  };
}

export function aggregatePhase(step: string, samples: StepTiming[]): StepTiming {
  return {
    step,
    ms: median(samples.map((s) => s.ms)),
    url: samples[0]?.url,
    ok: samples.some((s) => s.ok),
    note: samples.find((s) => s.note)?.note,
  };
}

function aggregatePaginationTotal(measured: PassResult[]): StepTiming {
  // Total pagination time per pass = sum of its scrolls; median across passes.
  const perPass = measured.map((m) => m.pagination.reduce((a, p) => a + p.ms, 0));
  return {
    step: "pagination",
    ms: median(perPass),
    ok: measured.some((m) => m.pagination.some((p) => p.ok)),
    note: `${measured[0]?.pagination.length ?? 0} scroll(s)`,
  };
}

function aggregatePaginationSteps(measured: PassResult[]): StepTiming[] {
  const maxLen = Math.max(0, ...measured.map((m) => m.pagination.length));
  const out: StepTiming[] = [];
  for (let i = 0; i < maxLen; i++) {
    const atI = measured.map((m) => m.pagination[i]).filter((p): p is StepTiming => !!p);
    out.push({
      step: `pagination-${i + 1}`,
      ms: median(atI.map((p) => p.ms)),
      ok: atI.some((p) => p.ok),
      note: atI[atI.length - 1]?.note,
    });
  }
  return out;
}
