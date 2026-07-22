import type { BrowserContext, Locator, Page } from "playwright";
import type { Platform } from "../../learned/platform.ts";
import type { LearnedSelectors } from "../../learned/repo.ts";
import { pickCategoryLink } from "../../llm/pick-plp.ts";
import { suggestRecovery } from "../../llm/recover-step.ts";
import type { PageCapture, ParityRc, Side, StepCapture, Viewport } from "../../types/schema.ts";
import { stabilizeCarousels } from "../carousel-stabilizer.ts";
import { selectorsFor } from "../selectors.ts";
import type { SelectorKey } from "../selectors.ts";

/**
 * Stabilize any carousel/slider on the page and then take a screenshot.
 * All step screenshots in the journey go through this so that prod and
 * cand frames match at compare-time (issue #22).
 *
 * The stabilizer is raced against a 3s cap — if the page's JS queue is
 * wedged we'd rather snap a possibly-mis-framed shot than burn the
 * step's budget here. Cubic flagged the unbounded await on PR #32.
 * Errors are swallowed for the same reason: a screenshot missing is
 * worse than a screenshot mis-timed.
 */
export async function screenshotStable(
  page: Page,
  opts: { path: string; fullPage?: boolean },
): Promise<void> {
  await Promise.race([
    stabilizeCarousels(page).catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
  ]);
  await page
    .screenshot({ path: opts.path, fullPage: opts.fullPage ?? false })
    .catch(() => undefined);
}

export type StepProgressEvent =
  | { phase: "start"; name: string; index: number; total: number }
  | {
      phase: "end";
      name: string;
      index: number;
      total: number;
      status: StepCapture["status"];
      durationMs: number;
      note?: string;
    };

export interface FlowContext {
  baseUrl: string;
  side: Side;
  viewport: Viewport;
  rc: ParityRc;
  ctx: BrowserContext;
  /** Output dir for screenshots/HARs of this flow */
  outDir: string;
  /** Stable identifier for the parent run — used to seed deterministic
   *  artifacts (e.g. the unicode no-results search term). Optional so
   *  legacy callers that didn't propagate it still work. */
  runId?: string;
  /** Optional learned selectors library (cascade integration) */
  learned?: LearnedSelectors;
  /** Optional detected platform for the prod side */
  platform?: Platform;
  /** Max LLM-driven step recoveries per flow */
  recoveryBudget?: number;
  /** Optional progress callback (each step start/end) */
  onStep?: (event: StepProgressEvent) => void;
  /**
   * When true, prod-side steps that get diagnosed as "cart genuinely
   * empty due to session/cookie quirk" (see `detectEmptyCartBanner`)
   * are marked `skipped` instead of `failed` — BUT only when prod and
   * cand agree on `cartRevealMode`. If the modes diverge, the flag is
   * a no-op so we never mask a real markup regression (issue #12).
   */
  acceptProdQuirks?: boolean;
}

const DEBUG_PARITY = process.env.DEBUG_PARITY === "1" || process.env.DEBUG_PARITY === "true";
const DEBUG_START = Date.now();
export function dlog(ctx: FlowContext, msg: string): void {
  if (!DEBUG_PARITY) return;
  const elapsed = ((Date.now() - DEBUG_START) / 1000).toFixed(1);
  process.stderr.write(`[+${elapsed}s ${ctx.viewport}/${ctx.side}] ${msg}\n`);
}

/** Race a Playwright op against a hard timer, since some CDP-backed ops
 *  outlive their declared timeouts when the page is wedged. */
export function withCap<T>(p: Promise<T>, capMs: number, fallback: T): Promise<T> {
  return Promise.race([
    p.catch(() => fallback),
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), capMs)),
  ]);
}

export const VARIANT_REQUIRED_TEXT_PATTERNS: RegExp[] = [
  /selecione um produto/i,
  /selecione um tamanho/i,
  /selecione uma cor/i,
  /selecione uma op[cç][aã]o/i,
  /select a size/i,
  /select a color/i,
  /select an option/i,
  /choose an option/i,
  /please select/i,
  /select size/i,
  /select color/i,
];

export const ADD_TO_CART_ERROR_PATTERNS: RegExp[] = [
  ...VARIANT_REQUIRED_TEXT_PATTERNS,
  /estoque esgotado/i,
  /out of stock/i,
  /indispon[ií]vel/i,
  /unavailable/i,
];

export const ADD_TO_CART_SUCCESS_PATTERNS: RegExp[] = [
  /produto adicionado/i,
  /adicionado ao carrinho/i,
  /adicionado [aà]\s+sacola/i,
  /added to cart/i,
  /added to bag/i,
  /item added/i,
  /successfully added/i,
];

export function selFor(ctx: FlowContext, key: SelectorKey): string[] {
  return selectorsFor(key, { rc: ctx.rc, learned: ctx.learned, platform: ctx.platform });
}

export function screenshotPath(ctx: FlowContext, label: string): string {
  const safe = label.replace(/[^a-z0-9_-]+/gi, "-").toLowerCase();
  return `${ctx.outDir}/${safe}-${ctx.viewport}-${ctx.side}.png`;
}

export interface FlowResult {
  pages: PageCapture[];
  steps: StepCapture[];
}

export function makeSkipStep(
  step: number,
  name: string,
  ctx: FlowContext,
  note: string,
): StepCapture {
  return {
    step,
    name,
    side: ctx.side,
    viewport: ctx.viewport,
    status: "skipped",
    durationMs: 0,
    screenshotPath: "",
    note,
  };
}

export async function findCategoryUrl(
  page: Page,
  ctx: FlowContext,
): Promise<{ url: string; selector: string } | null> {
  const selectors = selFor(ctx, "categoryLink");
  const candidates = await collectCandidateLinks(page, selectors, 12);
  if (candidates.length === 0) return null;
  const picked = await pickCategoryLink(candidates.map((c) => ({ text: c.text, href: c.href })));
  if (!picked) return null;
  const original = candidates.find((c) => c.href === picked.href);
  return original ? { url: original.href, selector: original.selector } : null;
}

export async function findProductUrl(
  page: Page,
  ctx: FlowContext,
): Promise<{ url: string; selector: string } | null> {
  return await firstVisibleHref(page, selFor(ctx, "productCard"));
}

async function firstVisibleHref(
  page: Page,
  selectors: string[],
): Promise<{ url: string; selector: string } | null> {
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 1_000 }).catch(() => false)) {
        const href = await el.getAttribute("href");
        if (href) {
          try {
            return { url: new URL(href, page.url()).toString(), selector: sel };
          } catch {
            return null;
          }
        }
      }
    } catch {
      /* try next selector */
    }
  }
  return null;
}

export async function firstVisible(page: Page, selectors: string[]): Promise<string | null> {
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 1_000 }).catch(() => false)) {
        return sel;
      }
    } catch {
      /* try next */
    }
  }
  return null;
}

export async function firstVisibleLocator(
  page: Page,
  selectors: string[],
): Promise<{ locator: Locator; selector: string } | null> {
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 1_000 }).catch(() => false)) {
        return { locator: el, selector: sel };
      }
    } catch {
      /* try next */
    }
  }
  return null;
}

export async function collectCandidateLinks(
  page: Page,
  selectors: string[],
  limit = 12,
): Promise<{ text: string; href: string; selector: string }[]> {
  const out: { text: string; href: string; selector: string }[] = [];
  const seenHrefs = new Set<string>();
  for (const sel of selectors) {
    if (out.length >= limit) break;
    try {
      const elements = page.locator(sel);
      const count = await elements.count();
      for (let i = 0; i < count && out.length < limit; i++) {
        const el = elements.nth(i);
        if (!(await el.isVisible({ timeout: 250 }).catch(() => false))) continue;
        const href = await el.getAttribute("href").catch(() => null);
        if (!href) continue;
        let abs = href;
        try {
          abs = new URL(href, page.url()).toString();
        } catch {
          continue;
        }
        if (seenHrefs.has(abs)) continue;
        seenHrefs.add(abs);
        const text = (await el.innerText().catch(() => "")).slice(0, 60).trim();
        out.push({ text, href: abs, selector: sel });
      }
    } catch {
      /* try next */
    }
  }
  return out;
}

export async function fillCep(page: Page, selector: string, cep: string): Promise<boolean> {
  try {
    await page.locator(selector).first().fill(cep, { timeout: 3_000 });
    await page
      .locator(selector)
      .first()
      .press("Enter")
      .catch(() => undefined);
    await page.waitForTimeout(3_000);
    return true;
  } catch {
    return false;
  }
}

/**
 * Heuristic: does this page actually look like a PDP, or is it a landing
 * page that happens to live under a product URL? Used to skip add-to-cart
 * honestly (and stop burning LLM recovery budget) when the runner lands
 * on the wrong page type. Returns `isLanding: true` only when MULTIPLE
 * signals agree — a real PDP missing one signal (rare) shouldn't be
 * mis-flagged.
 *
 *   PDP signals (any of these = "looks like a PDP"):
 *     - schema:Product JSON-LD in <head>
 *     - itemtype containing "Product"
 *     - any <form> with a CTA-looking button inside
 *     - price-ish text near the top (R$ NN.NN, $XX, EUR, etc)
 *     - a <select>/<input type="number"> for variant/quantity
 *
 * If FEWER THAN 2 PDP signals are present AND no buy button was found,
 * treat as landing.
 */
export async function detectLandingPage(
  page: Page,
): Promise<{ isLanding: boolean; reasons: string[] }> {
  const reasons: string[] = [];
  let pdpSignalCount = 0;

  try {
    const hasSchema = await page
      .locator("script[type='application/ld+json']:has-text('\"@type\":\"Product\"')")
      .first()
      .count()
      .catch(() => 0);
    if (hasSchema > 0) pdpSignalCount++;
    else reasons.push("no schema:Product JSON-LD");
  } catch {
    reasons.push("no schema:Product JSON-LD");
  }

  try {
    const hasItemtype = await page.locator("[itemtype*='Product']").first().count();
    if (hasItemtype > 0) pdpSignalCount++;
  } catch {
    /* skip */
  }

  try {
    const hasForm = await page.locator("form:has(button)").first().count();
    if (hasForm > 0) pdpSignalCount++;
    else reasons.push("no <form> with button");
  } catch {
    reasons.push("no <form> with button");
  }

  try {
    const bodyText = await page.locator("body").innerText({ timeout: 500 });
    if (/R\$\s*\d+|\$\s*\d+\.\d{2}|€\s*\d+|\bUSD\s*\d+/i.test(bodyText)) {
      pdpSignalCount++;
    } else {
      reasons.push("no price text (R$ / $ / €)");
    }
  } catch {
    reasons.push("no price text (R$ / $ / €)");
  }

  try {
    const hasVariantInput = await page
      .locator("select, input[type='number'], input[type='radio']")
      .first()
      .count();
    if (hasVariantInput > 0) pdpSignalCount++;
  } catch {
    /* skip */
  }

  return { isLanding: pdpSignalCount < 2, reasons };
}

/**
 * Click a locator and, if the click triggered a navigation, wait for the
 * new page to settle. Used for variant pickers that are rendered as
 * `<a href=".../p?skuId=N">` links (Deco TanStack pattern) instead of
 * radio buttons — clicking navigates to a different SKU URL and the next
 * step needs to run against the new page, not the pre-nav one.
 *
 * When the click doesn't navigate (button radio case), the
 * `waitForNavigation` rejects on the timeout and we just continue.
 */
export async function clickAndMaybeWait(
  page: Page,
  locator: Locator,
  _label: string,
): Promise<void> {
  await Promise.allSettled([
    page.waitForNavigation({ timeout: 5_000, waitUntil: "domcontentloaded" }),
    locator.click({ timeout: 2_000 }),
  ]);
  // Brief settle period for SPAs that update via History API without
  // firing a full navigation but still need a tick to re-render.
  await page.waitForTimeout(600);
}

/**
 * Ask the LLM to recover from a failed selector lookup. Returns a usable
 * locator + the suggested selector string, or null if the recovery failed.
 */
/**
 * Universal "find this element" helper.
 *
 * Cascade:
 *   1. If `key` is set, try the SelectorKey cascade (override → learned → defaults).
 *   2. If `extraSelectors` is set, try those next.
 *   3. If `budget.remaining > 0`, ask the LLM to find an element matching `intent`.
 *
 * Returns `{ locator, selector, recoveredByLlm }` on first match, `null` otherwise.
 * Mutates `budget.remaining` (decrements) only when the LLM recovery succeeds —
 * matches the existing `attemptRecovery` calling convention.
 *
 * Usage:
 *   const hit = await findElement(page, ctx, {
 *     key: "searchInput",
 *     intent: "Input <input> de busca onde o usuário digita o termo (não confundir com email/CEP).",
 *     budget,
 *   });
 *   if (hit) await hit.locator.click();
 */
export async function findElement(
  page: Page,
  ctx: FlowContext,
  opts: {
    /** Optional selector key — when set, runs the override→learned→defaults cascade first. */
    key?: SelectorKey;
    /** Description of what we want, in PT-BR (used as the LLM recovery prompt). */
    intent: string;
    /** Optional explicit selectors to try AFTER the key's cascade. */
    extraSelectors?: string[];
    /** Shared LLM-recovery budget for the parent flow. Decremented on successful recovery. */
    budget: { remaining: number };
    /** Optional name surfaced in trace logs. Defaults to "find-element". */
    stepName?: string;
  },
): Promise<{ locator: Locator; selector: string; recoveredByLlm: boolean } | null> {
  const tried: string[] = [];

  if (opts.key) {
    const cascade = selFor(ctx, opts.key);
    tried.push(...cascade);
    const hit = await firstVisibleLocator(page, cascade);
    if (hit) return { ...hit, recoveredByLlm: false };
  }

  if (opts.extraSelectors && opts.extraSelectors.length > 0) {
    tried.push(...opts.extraSelectors);
    const hit = await firstVisibleLocator(page, opts.extraSelectors);
    if (hit) return { ...hit, recoveredByLlm: false };
  }

  if (opts.budget.remaining > 0) {
    const recovered = await attemptRecovery(
      page,
      ctx,
      opts.stepName ?? "find-element",
      opts.intent,
      tried,
    );
    if (recovered) {
      opts.budget.remaining--;
      return { ...recovered, recoveredByLlm: true };
    }
  }
  return null;
}

export async function attemptRecovery(
  page: Page,
  _ctx: FlowContext,
  stepName: string,
  intendedAction: string,
  alreadyTried: string[],
): Promise<{ locator: Locator; selector: string } | null> {
  let html = "";
  try {
    html = await page.content();
  } catch {
    return null;
  }
  const suggestion = await suggestRecovery({ stepName, intendedAction, html, alreadyTried });
  if (!suggestion) return null;
  try {
    const el = page.locator(suggestion.selector).first();
    if (await el.isVisible({ timeout: 2_000 }).catch(() => false)) {
      return { locator: el, selector: suggestion.selector };
    }
  } catch {
    /* selector invalid or not found */
  }
  return null;
}

export interface StepActionResult {
  /** True if some action was actually performed (click/fill/press). */
  performed: boolean;
  /** Selector string that worked (CSS or Playwright). Empty if nothing matched. */
  selector: string;
  /** Action actually executed. */
  action: "click" | "fill" | "press";
  /** Whether the selector came from LLM recovery (so the caller can promote). */
  recoveredByLlm: boolean;
}

/**
 * Generic per-step action driver: tries the baked-in/learned selectors first,
 * then calls the LLM as a fallback when nothing matched (budget permitting),
 * and performs the requested action (click | fill | press) so the caller
 * doesn't have to. Returns what was done + the selector used so the
 * promotion loop can persist it across runs.
 *
 * Use this for ANY step where a missing element should trigger an LLM
 * recovery attempt — the user explicitly wants every failing step retried.
 */
export async function attemptStepAction(args: {
  page: Page;
  ctx: FlowContext;
  stepName: string;
  intendedAction: string;
  selectorKey: SelectorKey;
  action: "click" | "fill" | "press";
  /** Value to fill (for "fill") or key to press (for "press"). */
  value?: string;
  /** Mutable counter — decremented when LLM is invoked. */
  recoveryBudget: { remaining: number };
}): Promise<StepActionResult> {
  const { page, ctx, stepName, intendedAction, selectorKey, action, value, recoveryBudget } = args;
  const selectors = selFor(ctx, selectorKey);

  // Phase 1: try the baked-in/learned cascade.
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if (!(await el.isVisible({ timeout: 800 }).catch(() => false))) continue;
      const ok = await performAction(el, action, value);
      if (ok) {
        return { performed: true, selector: sel, action, recoveredByLlm: false };
      }
    } catch {
      /* try next */
    }
  }

  // Phase 2: LLM fallback (budget-gated).
  if (recoveryBudget.remaining <= 0) {
    return { performed: false, selector: "", action, recoveredByLlm: false };
  }
  let html = "";
  try {
    html = await page.content();
  } catch {
    return { performed: false, selector: "", action, recoveredByLlm: false };
  }
  const suggestion = await suggestRecovery({
    stepName,
    intendedAction,
    html,
    alreadyTried: selectors,
  });
  if (!suggestion) {
    return { performed: false, selector: "", action, recoveredByLlm: false };
  }
  recoveryBudget.remaining--;
  // The LLM is allowed to override the requested action (e.g. it may decide
  // "fill" makes more sense than "click" given the markup). Trust it within
  // the bounds of what performAction supports.
  const llmAction = suggestion.action ?? action;
  const llmValue = suggestion.value ?? value;
  try {
    const el = page.locator(suggestion.selector).first();
    if (!(await el.isVisible({ timeout: 2_000 }).catch(() => false))) {
      return { performed: false, selector: "", action: llmAction, recoveredByLlm: false };
    }
    const ok = await performAction(el, llmAction, llmValue);
    if (ok) {
      return {
        performed: true,
        selector: suggestion.selector,
        action: llmAction,
        recoveredByLlm: true,
      };
    }
  } catch {
    /* invalid selector or runtime error */
  }
  return { performed: false, selector: "", action: llmAction, recoveredByLlm: false };
}

async function performAction(
  el: Locator,
  action: "click" | "fill" | "press",
  value: string | undefined,
): Promise<boolean> {
  try {
    if (action === "click") {
      await el.click({ timeout: 3_000 });
      return true;
    }
    if (action === "fill") {
      await el.fill(value ?? "", { timeout: 3_000 });
      // Some controls only react to keyboard "Enter" (zip-code triggers).
      await el.press("Enter", { timeout: 1_500 }).catch(() => undefined);
      return true;
    }
    if (action === "press") {
      await el.press(value ?? "Enter", { timeout: 1_500 });
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────
// Product title extraction + cart validation
//
// Ported from upstream (PR #10) so this branch keeps the "did the right
// product end up in the cart?" assertion. Without it the cart steps
// only check that a cart UI opened, which lets a broken add-to-cart
// (wrong SKU added, session not persisted, etc) slip through silently.
// ─────────────────────────────────────────────────────────────────────

const GENERIC_TITLE_PATTERNS = [
  /^p[áa]gina de produto/i,
  /^product page/i,
  /^carregando/i,
  /^loading/i,
  /^undefined/i,
  /^home$/i,
];

function looksGeneric(s: string): boolean {
  const t = s.trim();
  return GENERIC_TITLE_PATTERNS.some((re) => re.test(t));
}

export async function extractProductTitle(page: Page): Promise<string | null> {
  await page.waitForSelector("h1", { timeout: 2_500, state: "attached" }).catch(() => undefined);

  const visibleSelectors = [
    "main h1",
    "h1[class*='product' i]",
    "h1.product-title",
    "[itemprop='name'][data-product-name]",
    "[data-product-name]",
    "[data-fs-product-title]",
    "[itemprop='name']",
    ".vtex-store-components-3-x-productNameContainer",
    "h1",
  ];
  for (const sel of visibleSelectors) {
    try {
      const el = page.locator(sel).first();
      const visible = await withCap(
        el.isVisible({ timeout: 250 }).catch(() => false),
        400,
        false,
      );
      if (!visible) continue;
      const text = await withCap(
        el.innerText().catch(() => ""),
        500,
        "",
      );
      const clean = text.trim();
      if (clean.length > 3 && !looksGeneric(clean)) return clean;
    } catch {
      /* try next */
    }
  }
  // JSON-LD Product.name fallback.
  try {
    const jsonLdName = await withCap(
      page.evaluate(() => {
        const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
        for (const s of scripts) {
          try {
            const data = JSON.parse((s as HTMLScriptElement).textContent ?? "{}");
            const items = Array.isArray(data) ? data : [data];
            for (const item of items) {
              const product =
                item?.["@graph"]?.find?.((x: { "@type"?: string }) => x?.["@type"] === "Product") ??
                item;
              if (product?.["@type"] === "Product" && typeof product.name === "string") {
                return product.name as string;
              }
            }
          } catch {
            /* skip malformed */
          }
        }
        return null;
      }),
      1_000,
      null,
    );
    if (jsonLdName && jsonLdName.trim().length > 3 && !looksGeneric(jsonLdName)) {
      return jsonLdName.trim();
    }
  } catch {
    /* fall through */
  }
  try {
    const og = await withCap(
      page
        .locator("meta[property='og:title']")
        .first()
        .getAttribute("content")
        .catch(() => null),
      500,
      null,
    );
    if (og && og.trim().length > 3 && !looksGeneric(og)) return og.trim();
  } catch {
    /* fall through */
  }
  const docTitle = await withCap(
    page.title().catch(() => ""),
    500,
    "",
  );
  if (docTitle.trim().length > 3 && !looksGeneric(docTitle)) return docTitle.trim();
  return null;
}

export async function dismissOverlays(page: Page, ctx: FlowContext): Promise<void> {
  const overlaySelectors = [
    "[class*='cookie' i][class*='banner' i]",
    "[class*='cookie' i][class*='consent' i]",
    "[id*='cookie' i][class*='banner' i]",
    "[role='alertdialog']:visible",
    "[class*='toast' i]:visible",
    "[class*='snackbar' i]:visible",
    "[class*='added-to-cart' i]:visible",
    "[class*='product-added' i]:visible",
  ];
  let dismissedAny = false;
  for (const sel of overlaySelectors) {
    try {
      const overlay = page.locator(sel).first();
      if (
        !(await withCap(
          overlay.isVisible({ timeout: 200 }).catch(() => false),
          400,
          false,
        ))
      )
        continue;
      const closer = overlay
        .locator(
          "button[aria-label*='close' i], button[aria-label*='fechar' i], button[class*='close' i], [data-close], [aria-label='Close']",
        )
        .first();
      if (
        await withCap(
          closer.isVisible({ timeout: 200 }).catch(() => false),
          400,
          false,
        )
      ) {
        await closer.click({ timeout: 1_500 }).catch(() => undefined);
        dismissedAny = true;
        continue;
      }
      await page.keyboard.press("Escape").catch(() => undefined);
      dismissedAny = true;
    } catch {
      /* try next */
    }
  }
  if (dismissedAny) {
    dlog(ctx, "  openMinicart: dismissed overlay(s) before interacting");
    await page.waitForTimeout(500);
  }
}
