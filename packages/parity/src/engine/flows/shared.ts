import type { BrowserContext, Locator, Page } from "playwright";
import type { Platform } from "../../learned/platform.ts";
import type { LearnedSelectors } from "../../learned/repo.ts";
import { pickCategoryLink } from "../../llm/pick-plp.ts";
import { suggestRecovery } from "../../llm/recover-step.ts";
import type { PageCapture, ParityRc, Side, StepCapture, Viewport } from "../../types/schema.ts";
import { stabilizeCarousels } from "../carousel-stabilizer.ts";
import { mergeInpSnapshot, readVitalsSnapshot } from "../collect.ts";
import { selectorsFor } from "../selectors.ts";
import type { SelectorKey } from "../selectors.ts";

/**
 * Sample `window.__parity_vitals` off `page` right now (no navigation) and
 * merge its `inp` into `cap.vitals` in place. Call this after a real click/
 * keypress and before anything that might navigate the page — `capturePage`
 * only ever reads vitals immediately after its own `page.goto`, so INP from
 * interactions a flow makes mid-visit (add-to-cart, open-minicart, SPA nav
 * click, login submit) was previously discarded (issue #184).
 */
export async function captureInpSnapshot(page: Page, cap: PageCapture): Promise<void> {
  cap.vitals = mergeInpSnapshot(cap.vitals, await readVitalsSnapshot(page));
}

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
  opts: { path: string; fullPage?: boolean; quality?: number },
): Promise<void> {
  await Promise.race([
    stabilizeCarousels(page).catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
  ]);
  // `quality` only applies to JPEG output (Playwright throws if it's passed for
  // a .png path) — gate on the extension so callers can keep shrinking big
  // full-page captures without special-casing at every call site.
  const isJpeg = /\.jpe?g$/i.test(opts.path);
  await page
    .screenshot({
      path: opts.path,
      fullPage: opts.fullPage ?? false,
      ...(isJpeg && opts.quality != null ? { quality: opts.quality } : {}),
    })
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
  diagnostics?: string,
): Promise<{ locator: Locator; selector: string } | null> {
  let html = "";
  try {
    html = await page.content();
  } catch {
    return null;
  }
  const suggestion = await suggestRecovery({
    stepName,
    intendedAction,
    html,
    alreadyTried,
    diagnostics,
  });
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

/**
 * Built-in overlay patterns closed by {@link dismissOverlays}. Deliberately
 * narrow (cookie/consent/toast/alertdialog) — NOT generic `[role='dialog']`
 * or `[class*='modal']`, because this runs after opening the cart and those
 * would match the cart drawer itself. Site-specific popups (newsletter,
 * discount) go in `.parityrc.json` `overlaySelectors` (#145); unnamed popups
 * that actually intercept a click are handled structurally (#146,
 * {@link dismissBlockingOverlay}).
 */
const DEFAULT_OVERLAY_SELECTORS = [
  "[class*='cookie' i][class*='banner' i]",
  "[class*='cookie' i][class*='consent' i]",
  "[id*='cookie' i][class*='banner' i]",
  "[role='alertdialog']:visible",
  "[class*='toast' i]:visible",
  "[class*='snackbar' i]:visible",
  "[class*='added-to-cart' i]:visible",
  "[class*='product-added' i]:visible",
  // Generic signup/discount modals (issue #145) — matched by intent-naming
  // that a cart drawer never uses.
  "[id*='newsletter' i]:visible",
  "[class*='newsletter' i]:visible",
  "[id*='signup-popup' i]:visible",
  "[class*='signup' i][class*='popup' i]:visible",
];

/** Close-button affordances tried when dismissing an overlay (broadened per #146). */
const CLOSE_BUTTON_SELECTOR =
  "button[aria-label*='close' i], [aria-label*='close' i], button[aria-label*='fechar' i], [aria-label*='fechar' i], [data-close], [data-dismiss], [data-qa-dismiss], button[class*='close' i], button:has-text('×'), button:has-text('✕')";

/**
 * Effective overlay-selector list: built-in defaults + user
 * `.parityrc.json` `overlaySelectors`, deduped, defaults first (#145).
 */
export function overlaySelectorsFor(rc: FlowContext["rc"]): string[] {
  const extra = rc?.overlaySelectors ?? [];
  return [...new Set([...DEFAULT_OVERLAY_SELECTORS, ...extra])];
}

/**
 * Structured record of an overlay dismissal, logged into the step's
 * `flowCapture` detail so a report always shows WHY a click was intercepted —
 * even when dismissal succeeded (a silent successful dismiss would otherwise
 * be invisible, and a failed one just reads as "no-signal"). Issue #146.
 */
export interface OverlayDismissal {
  /** Why we acted: the intended click point was covered, or a named overlay matched. */
  reason: "click-point-intercepted" | "selector-match";
  /** Topmost/overlay element descriptor for the report. */
  tag: string;
  id?: string;
  className?: string;
  /** Whether the overlay covers >60% of the viewport (backdrop dismiss won't help). */
  fullViewport?: boolean;
  /** How we tried to close it (last attempt if `dismissed` is false). */
  method: "escape" | "close-button" | "backdrop-click" | "neutralized";
  /** Did the intercepting overlay actually clear? */
  dismissed: boolean;
}

interface BlockerInfo {
  tag: string;
  id?: string;
  className?: string;
  fullViewport: boolean;
}

/**
 * Structural interception check (#146): is something other than `target`
 * (or a descendant of it) the topmost element at `target`'s click point?
 * Shape-agnostic — no class/id name matching. Returns the covering overlay's
 * outermost positioned ancestor, or `null` when the target is clickable.
 */
async function blockerAtTarget(target: Locator): Promise<BlockerInfo | null> {
  return await withCap(
    target
      .evaluate((el) => {
        const node = el as HTMLElement;
        const rect = node.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return null;
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const top = document.elementFromPoint(cx, cy) as HTMLElement | null;
        // Clickable: topmost is the target itself or a descendant of it.
        if (!top || top === node || node.contains(top)) return null;
        // Walk up from the intercepting element to the outermost
        // fixed/sticky/absolute ancestor — the overlay/backdrop root.
        let cur: HTMLElement | null = top;
        let overlay: HTMLElement = top;
        while (cur && cur !== document.body) {
          const pos = getComputedStyle(cur).position;
          if (pos === "fixed" || pos === "sticky" || pos === "absolute") overlay = cur;
          cur = cur.parentElement;
        }
        const r = overlay.getBoundingClientRect();
        const coverage = (r.width * r.height) / (window.innerWidth * window.innerHeight);
        const cls = typeof overlay.className === "string" ? overlay.className : "";
        return {
          tag: overlay.tagName.toLowerCase(),
          id: overlay.id || undefined,
          className: cls ? cls.slice(0, 120) : undefined,
          fullViewport: coverage > 0.6,
        } as BlockerInfo;
      })
      .catch(() => null),
    2_000,
    null,
  );
}

/**
 * Find an icon/close control inside the overlay intercepting `target` — a
 * SMALL clickable (≤72px) near a corner, prioritising ones whose
 * label/class/text looks close-like, then the one nearest the top-right (the
 * conventional close position). Catches unnamed close buttons (e.g. a bare
 * `<button><svg/></button>` with no aria-label) that name-based selectors
 * miss — the montecarlo DaisyUI drawer case. Returns viewport coords to click,
 * or `null`. Issue #146.
 */
async function findOverlayCloseControl(target: Locator): Promise<{ x: number; y: number } | null> {
  return await withCap(
    target
      .evaluate((el) => {
        const node = el as HTMLElement;
        const rect = node.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return null;
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const top = document.elementFromPoint(cx, cy) as HTMLElement | null;
        if (!top || top === node || node.contains(top)) return null;
        let cur: HTMLElement | null = top;
        let overlay: HTMLElement = top;
        while (cur && cur !== document.body) {
          const pos = getComputedStyle(cur).position;
          if (pos === "fixed" || pos === "sticky" || pos === "absolute") overlay = cur;
          cur = cur.parentElement;
        }
        const orect = overlay.getBoundingClientRect();
        const clickables = Array.from(
          overlay.querySelectorAll("button, a, [role='button']"),
        ) as HTMLElement[];
        let best: { x: number; y: number; score: number } | null = null;
        for (const c of clickables) {
          const r = c.getBoundingClientRect();
          if (r.width === 0 || r.height === 0 || r.width > 72 || r.height > 72) continue;
          const label = `${c.getAttribute("aria-label") ?? ""} ${
            typeof c.className === "string" ? c.className : ""
          } ${c.textContent ?? ""}`.toLowerCase();
          const named = /close|fechar|dismiss|×|✕/.test(label);
          // Distance to the overlay's top-right corner (smaller = better).
          const distTopRight = Math.hypot(orect.right - r.right, r.top - orect.top);
          const score = (named ? 0 : 100_000) + distTopRight;
          if (!best || score < best.score) {
            best = { x: r.left + r.width / 2, y: r.top + r.height / 2, score };
          }
        }
        return best ? { x: best.x, y: best.y } : null;
      })
      .catch(() => null),
    2_000,
    null,
  );
}

/**
 * Last resort (#146): when every polite dismissal has failed, hide the
 * overlay that is actually covering `target`'s click point. Guarded — it
 * NEVER hides an ancestor of the target (that would hide the target too), so
 * it only removes a genuinely separate interceptor (a modal backdrop, a promo
 * drawer). Can't manufacture a false success: the add-to-cart step still
 * requires a real confirmation signal afterward. Returns whether it hid
 * something.
 */
async function neutralizeBlockerAtTarget(target: Locator): Promise<boolean> {
  return await withCap(
    target
      .evaluate((el) => {
        const node = el as HTMLElement;
        const rect = node.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return false;
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const top = document.elementFromPoint(cx, cy) as HTMLElement | null;
        if (!top || top === node || node.contains(top)) return false;
        let cur: HTMLElement | null = top;
        let overlay: HTMLElement = top;
        while (cur && cur !== document.body) {
          const pos = getComputedStyle(cur).position;
          if (pos === "fixed" || pos === "sticky" || pos === "absolute") overlay = cur;
          cur = cur.parentElement;
        }
        // Never hide an ancestor of the target (would hide the target too).
        if (overlay.contains(node)) return false;
        overlay.style.setProperty("display", "none", "important");
        return true;
      })
      .catch(() => false),
    2_000,
    false,
  );
}

/**
 * When a click at `target` is being intercepted by an overlay (detected
 * structurally, not by name), try to clear it least-destructive-first —
 * Escape, a named close button, an icon/geometry close control inside the
 * overlay, a backdrop click, and finally (guarded) hiding the interceptor
 * outright — re-checking interception after each. Returns
 * an {@link OverlayDismissal} describing what was found and whether it
 * cleared, or `null` when nothing was blocking the target. Issue #146.
 */
export async function dismissBlockingOverlay(
  page: Page,
  ctx: FlowContext,
  target: Locator,
): Promise<OverlayDismissal | null> {
  const blocker = await blockerAtTarget(target);
  if (!blocker) return null;
  const base = {
    reason: "click-point-intercepted" as const,
    tag: blocker.tag,
    id: blocker.id,
    className: blocker.className,
    fullViewport: blocker.fullViewport,
  };
  const cleared = async () => (await blockerAtTarget(target)) === null;

  // 1. Escape — closes most modal implementations without hunting for a button.
  await page.keyboard.press("Escape").catch(() => undefined);
  await page.waitForTimeout(300);
  if (await cleared()) {
    dlog(ctx, `  overlay: dismissed via Escape (${describe(blocker)})`);
    return { ...base, method: "escape", dismissed: true };
  }

  // 2. Close-like button anywhere on the page (fallback, broadened selectors).
  const closer = page.locator(CLOSE_BUTTON_SELECTOR).first();
  if (
    await withCap(
      closer.isVisible({ timeout: 300 }).catch(() => false),
      500,
      false,
    )
  ) {
    await closer.click({ timeout: 1_500 }).catch(() => undefined);
    await page.waitForTimeout(300);
    if (await cleared()) {
      dlog(ctx, `  overlay: dismissed via close button (${describe(blocker)})`);
      return { ...base, method: "close-button", dismissed: true };
    }
  }

  // 2b. Icon/geometry close control inside the overlay (unnamed X buttons that
  //     name-based selectors miss — e.g. a bare `<button><svg/></button>`).
  const closeXY = await findOverlayCloseControl(target);
  if (closeXY) {
    await page.mouse.click(closeXY.x, closeXY.y).catch(() => undefined);
    await page.waitForTimeout(300);
    if (await cleared()) {
      dlog(ctx, `  overlay: dismissed via icon close control (${describe(blocker)})`);
      return { ...base, method: "close-button", dismissed: true };
    }
  }

  // 3. Backdrop click at a top-left corner. Even a full-viewport overlay is
  //    often a click-to-dismiss backdrop (e.g. a DaisyUI `drawer-overlay`
  //    label that closes the drawer on any click) with the modal panel in the
  //    centre/side — so a corner click lands on the backdrop, not the content.
  await page.mouse.click(5, 5).catch(() => undefined);
  await page.waitForTimeout(300);
  if (await cleared()) {
    dlog(ctx, `  overlay: dismissed via backdrop click (${describe(blocker)})`);
    return { ...base, method: "backdrop-click", dismissed: true };
  }

  // 4. Last resort — hide the confirmed interceptor (guarded: never an
  //    ancestor of the target). This is the "deal with it regardless of what
  //    it's named" path (#146); it's always logged so a genuinely
  //    checkout-blocking modal still shows up as `method: "neutralized"`.
  if (await neutralizeBlockerAtTarget(target)) {
    await page.waitForTimeout(150);
    if (await cleared()) {
      dlog(ctx, `  overlay: neutralized (hidden) as last resort (${describe(blocker)})`);
      return { ...base, method: "neutralized", dismissed: true };
    }
  }

  dlog(ctx, `  overlay: detected but NOT dismissed (${describe(blocker)})`);
  return { ...base, method: "backdrop-click", dismissed: false };
}

function describe(b: BlockerInfo): string {
  return `${b.tag}${b.id ? `#${b.id}` : ""}${b.className ? `.${b.className.split(/\s+/)[0]}` : ""}`;
}

/**
 * Generic pre-interaction sweep: close any currently-visible overlay matching
 * the effective selector list (#145). Structural per-click interception is
 * handled separately by {@link dismissBlockingOverlay} (#146). Returns the
 * dismissals performed (empty when nothing matched).
 */
// Per-selector probe cap for dismissOverlays: how long we wait for each
// selector to report "visible" before skipping it. Kept tight (80ms) so the
// no-overlay case (all 12+ selectors absent) finishes in <1s instead of
// the old 400ms-per-selector ceiling that caused 50-100s stalls (issue #151).
const OVERLAY_PROBE_CAP_MS = 80;

/**
 * Generic pre-interaction sweep: close any currently-visible overlay matching
 * the effective selector list (#145). Structural per-click interception is
 * handled separately by {@link dismissBlockingOverlay} (#146). Returns the
 * dismissals performed (empty when nothing matched).
 *
 * Performance contract (issue #151): each probe is capped at
 * {@link OVERLAY_PROBE_CAP_MS} so the full sweep over N selectors completes in
 * O(N × 80ms) in the no-match case — ~1s for the current 12-selector default
 * list, vs. the old 400ms cap that could stall the step for 50-100s.
 */
export async function dismissOverlays(page: Page, ctx: FlowContext): Promise<OverlayDismissal[]> {
  const sels = overlaySelectorsFor(ctx.rc);
  dlog(ctx, `  dismissOverlays: checking ${sels.length} selector(s)…`);
  const dismissals: OverlayDismissal[] = [];
  for (const sel of sels) {
    try {
      const overlay = page.locator(sel).first();
      // Fast pre-check: count() is cheaper and rarely hangs vs. isVisible().
      // Skip the isVisible probe entirely when count is 0.
      const cnt = await withCap(overlay.count(), OVERLAY_PROBE_CAP_MS, 0);
      if (cnt === 0) continue;
      if (
        !(await withCap(
          overlay.isVisible({ timeout: OVERLAY_PROBE_CAP_MS }).catch(() => false),
          OVERLAY_PROBE_CAP_MS,
          false,
        ))
      )
        continue;
      const closer = overlay.locator(CLOSE_BUTTON_SELECTOR).first();
      if (
        await withCap(
          closer.isVisible({ timeout: OVERLAY_PROBE_CAP_MS }).catch(() => false),
          OVERLAY_PROBE_CAP_MS,
          false,
        )
      ) {
        await closer.click({ timeout: 1_500 }).catch(() => undefined);
        dismissals.push({
          reason: "selector-match",
          tag: sel,
          method: "close-button",
          dismissed: true,
        });
        continue;
      }
      await page.keyboard.press("Escape").catch(() => undefined);
      dismissals.push({ reason: "selector-match", tag: sel, method: "escape", dismissed: true });
    } catch {
      /* try next */
    }
  }
  if (dismissals.length > 0) {
    dlog(ctx, `  dismissed ${dismissals.length} overlay(s) before interacting`);
    await page.waitForTimeout(500);
  }
  return dismissals;
}
