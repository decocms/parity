import type { Locator, Page } from "playwright";
import type { StepCapture, Viewport } from "../../types/schema.ts";
import { isLocalhost } from "../../util/localhost.ts";
import type { FlowContext } from "./shared.ts";
import { dismissBlockingOverlay, dismissOverlays, dlog, firstVisible, selFor, withCap } from "./shared.ts";

export async function readCartCount(page: Page, ctx: FlowContext): Promise<number> {
  const selectors = selFor(ctx, "minicartCount");
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if (!(await el.isVisible({ timeout: 500 }).catch(() => false))) continue;
      const raw = (await el.innerText().catch(() => "")).trim();
      const match = raw.match(/\d+/);
      if (match) return Number.parseInt(match[0], 10);
    } catch {
      /* try next */
    }
  }
  return 0;
}

export async function isCartUiVisible(page: Page, ctx?: FlowContext): Promise<string | null> {
  // Configurable `minicartPanel` (+ the existing `cartOpenedIndicator`) come
  // FIRST — the hardcoded name-based patterns below false-negative on
  // utility-CSS (Tailwind) + `data-qa-*` markup where the drawer root has no
  // "cart"/"minicart"/"open" in its class or a `data-minicart` attribute
  // (issue #149). `selFor` already folds in `.parityrc.json` overrides,
  // learned selectors, and the baked-in defaults.
  const configured = ctx
    ? [...selFor(ctx, "minicartPanel"), ...selFor(ctx, "cartOpenedIndicator")]
    : [];
  return firstVisible(page, [
    ...configured,
    "[role='dialog']:visible",
    "[aria-modal='true']:visible",
    "[data-minicart][aria-hidden='false']",
    "[data-minicart-open]",
    ".minicart--open",
    ".minicart-drawer:not([hidden])",
    "[class*='minicart'][class*='open']",
    "[class*='cart-drawer'][class*='open']",
    "[class*='drawer-cart']:visible",
  ]);
}

/**
 * Classify the minicart trigger by inspecting its markup (issue #12).
 *
 * Returns the INTENT of the trigger, not which strategy our harness will
 * use. Compare prod.cartRevealMode against cand.cartRevealMode to surface
 * markup divergence (e.g. cand turned a hover-drawer trigger into a
 * click-navigate link — a real UX regression, not a quirk).
 *
 * The classification ladder, evaluated in order:
 *
 *  1. drawerAlreadyOpen → "inline-notification"
 *     If add-to-cart already revealed the cart (validateAddToCart caught
 *     a drawer/toast), the trigger is dormant — the markup intent is
 *     "open inline on add-to-cart".
 *
 *  2. `<a href="/checkout..." | "/cart...">` → "click-navigate-checkout|cart"
 *     Trigger is a link that navigates. We can SEE this from the DOM
 *     without interacting.
 *
 *  3. `[onclick]` attribute or known click-binding markers → "click-drawer"
 *     Trigger has a click handler. We attempt to observe hover-vs-click
 *     behaviour to disambiguate from hover-drawer.
 *
 *  4. Hover dry-run (desktop only): hover and watch for DOM mutation
 *     within 600ms. If we see a new dialog/drawer appear → "hover-drawer".
 *
 *  5. Fallback → "unknown".
 *
 * IMPORTANT: this function MUST be side-effect-free w.r.t. cart state.
 * We do NOT click. We may hover briefly (desktop) but immediately move
 * the mouse away so the hover state doesn't leak into the rest of the
 * step's screenshot.
 */
export async function detectCartRevealMode(
  page: Page,
  trigger: Locator,
  drawerAlreadyOpen: boolean,
  viewport: Viewport,
): Promise<NonNullable<StepCapture["cartRevealMode"]>> {
  if (drawerAlreadyOpen) return "inline-notification";

  // 2. Link inspection — works for both viewports, no interaction needed.
  try {
    const href = (await trigger.getAttribute("href").catch(() => null)) ?? "";
    const lower = href.toLowerCase();
    if (/\/checkout(\b|\/|\?|#)/i.test(lower)) return "click-navigate-checkout";
    if (/\/cart(\b|\/|\?|#)/i.test(lower) || /\/carrinho(\b|\/|\?|#)/i.test(lower)) {
      return "click-navigate-cart";
    }
  } catch {
    /* trigger may have detached */
  }

  // 3. Onclick / click-binding attribute markers.
  let hasClickAttr = false;
  try {
    const onclick = await trigger.getAttribute("onclick").catch(() => null);
    if (onclick && onclick.trim().length > 0) hasClickAttr = true;
  } catch {
    /* ignore */
  }

  // 4. Hover dry-run — only on desktop where pointer hover is meaningful.
  //    Watch for new role=dialog / minicart-class element added in ~600ms.
  if (viewport === "desktop") {
    try {
      const observedHoverDrawer = await page.evaluate(async () => {
        return await new Promise<boolean>((resolve) => {
          const selectorMatch = (el: Element): boolean => {
            if (!(el instanceof HTMLElement)) return false;
            if (el.getAttribute("role") === "dialog") return true;
            const cls = `${el.className || ""}`;
            return /minicart|drawer|cart-popup|cart-modal/i.test(cls);
          };
          const observer = new MutationObserver((muts) => {
            for (const m of muts) {
              for (const n of Array.from(m.addedNodes)) {
                if (n instanceof Element && selectorMatch(n)) {
                  observer.disconnect();
                  resolve(true);
                  return;
                }
              }
              if (
                m.type === "attributes" &&
                m.target instanceof Element &&
                selectorMatch(m.target)
              ) {
                observer.disconnect();
                resolve(true);
                return;
              }
            }
          });
          observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ["class", "style", "aria-expanded", "open"],
          });
          setTimeout(() => {
            observer.disconnect();
            resolve(false);
          }, 600);
        });
      });
      // Trigger the hover that the observer above is listening for.
      const hoverPromise = trigger.hover({ timeout: 1_500 }).catch(() => undefined);
      await hoverPromise;
      const result = await observedHoverDrawer;
      // Move the mouse away to clear any hover state we left behind.
      await page.mouse.move(0, 0).catch(() => undefined);
      if (result) return "hover-drawer";
    } catch {
      /* fall through */
    }
  }

  if (hasClickAttr) return "click-drawer";
  return "unknown";
}

export async function isCartRevealed(
  page: Page,
  expectedProductTitle: string | null,
  ctx?: FlowContext,
): Promise<string | null> {
  if (expectedProductTitle) {
    const v = await validateCartContainsTitleQuick(page, expectedProductTitle, ctx);
    if (v) return `title-found:${v}`;
  }
  return isCartUiVisible(page, ctx);
}

/** Default reveal budgets: prod drawers animate fast; dev servers are slow. */
const CART_REVEAL_BUDGET_MS = 4_000;
const CART_REVEAL_BUDGET_LOCALHOST_MS = 8_000;
const CART_REVEAL_POLL_INTERVAL_MS = 200;
/** Speculative desktop hover-open probe — short so click owns the full budget. */
const CART_REVEAL_HOVER_PROBE_MS = 1_500;

export type CartRevealDiagnostics = NonNullable<StepCapture["diagnostics"]>;
type CartRevealProbe = NonNullable<CartRevealDiagnostics["probes"]>[number];

/**
 * Snapshot, per candidate cart selector, whether it EXISTS in the DOM vs
 * whether it's actually VISIBLE right now. Run once when a reveal wait times
 * out — the distinction is the single most useful diagnostic for "why didn't
 * the cart open": `present && !visible` means the correct selector matched a
 * node that's still hidden (slow transition / data-gated render), which is a
 * completely different fix than "selector is wrong" (`!present`).
 */
async function probeCartSelectors(page: Page, ctx: FlowContext): Promise<CartRevealProbe[]> {
  const selectors = [...new Set([...selFor(ctx, "minicartPanel"), ...selFor(ctx, "cartOpenedIndicator")])];
  const probes: CartRevealProbe[] = [];
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel);
      const present = (await withCap(loc.count(), 300, 0)) > 0;
      const visible = present
        ? await withCap(loc.first().isVisible().catch(() => false), 300, false)
        : false;
      probes.push({ selector: sel, present, visible });
    } catch {
      probes.push({ selector: sel, present: false, visible: false });
    }
  }
  return probes;
}

/** Render diagnostics into a compact, LLM/human-readable line. */
export function summarizeCartRevealDiagnostics(d: CartRevealDiagnostics): string {
  const parts = [`waited ${d.elapsedMs}ms/${d.budgetMs}ms (${d.pollCount} poll(s))`];
  const hidden = d.probes?.filter((p) => p.present && !p.visible) ?? [];
  const missing = d.probes?.filter((p) => !p.present) ?? [];
  if (hidden.length) {
    parts.push(`present-but-hidden: ${hidden.map((p) => p.selector).join(", ")}`);
  }
  if (missing.length) {
    parts.push(`not-in-dom: ${missing.map((p) => p.selector).join(", ")}`);
  }
  return parts.join(" — ");
}

/**
 * Poll `isCartRevealed` until it returns a marker or the budget expires.
 *
 * `isCartRevealed` (via Playwright's `isVisible()`) is a one-shot snapshot: it
 * reports the drawer's *current* state and does not wait. Many drawers reveal
 * asynchronously — a CSS `allow-discrete` visibility/opacity transition, a
 * data-gated render (react-query cart), or a slow dev-mode click handler — so a
 * single snapshot taken right after clicking lands inside the hidden window and
 * wrongly concludes the cart never opened. Polling absorbs that latency
 * generically, regardless of how a given site animates its minicart.
 *
 * On timeout, also probes the candidate selectors (present vs visible) so the
 * caller has concrete evidence to report and to hand an LLM recovery attempt,
 * instead of a bare "not found".
 */
export async function waitForCartReveal(
  page: Page,
  expectedProductTitle: string | null,
  ctx: FlowContext,
  timeoutMs: number,
): Promise<{ marker: string | null; diagnostics: CartRevealDiagnostics }> {
  const start = Date.now();
  const deadline = start + timeoutMs;
  let pollCount = 0;
  for (;;) {
    pollCount++;
    const marker = await isCartRevealed(page, expectedProductTitle, ctx);
    if (marker) {
      dlog(ctx, `    waitForCartReveal: revealed after ${pollCount} poll(s) (${marker})`);
      return {
        marker,
        diagnostics: { timedOut: false, budgetMs: timeoutMs, elapsedMs: Date.now() - start, pollCount },
      };
    }
    if (Date.now() >= deadline) {
      const probes = await probeCartSelectors(page, ctx);
      const diagnostics: CartRevealDiagnostics = {
        timedOut: true,
        budgetMs: timeoutMs,
        elapsedMs: Date.now() - start,
        pollCount,
        probes,
      };
      dlog(ctx, `    waitForCartReveal: ${summarizeCartRevealDiagnostics(diagnostics)}`);
      return { marker: null, diagnostics };
    }
    await page.waitForTimeout(CART_REVEAL_POLL_INTERVAL_MS);
  }
}

async function validateCartContainsTitleQuick(
  page: Page,
  expectedTitle: string,
  ctx?: FlowContext,
): Promise<string | null> {
  const quickSelectors = [
    // Configurable panel first (issue #149) — a `data-qa-*`/utility-class
    // drawer has no name-based class the hardcoded scopes below can match.
    ...(ctx ? selFor(ctx, "minicartPanel") : []),
    "[role='dialog']",
    "[class*='minicart' i]",
    "[class*='cart' i]",
    "[class*='checkout' i]",
    "#cart-fixed",
    "table.cart-items",
  ];
  for (const scope of quickSelectors) {
    try {
      const scopeLoc = page.locator(scope);
      if ((await withCap(scopeLoc.count(), 800, 0)) === 0) continue;
      const text = await withCap(
        scopeLoc
          .first()
          .innerText()
          .catch(() => ""),
        800,
        "",
      );
      if (text && titlesMatch(text, expectedTitle)) return scope;
    } catch {
      /* try next */
    }
  }
  return null;
}

export async function waitForCartHydration(page: Page): Promise<void> {
  await Promise.race([
    page
      .waitForResponse(
        (r) => /\/api\/checkout\/pub\/orderForm|orderForm|cart\/api/i.test(r.url()) && r.ok(),
        { timeout: 8_000 },
      )
      .catch(() => undefined),
    page
      .waitForSelector(".cart-items, [class*='cart-item' i], #cart-fixed .item, [data-cart-item]", {
        timeout: 8_000,
      })
      .catch(() => undefined),
  ]);
  await page.waitForTimeout(800);
}

export async function openMinicart(
  page: Page,
  trigger: { locator: Locator; selector: string },
  ctx: FlowContext,
  expectedProductTitle: string | null,
): Promise<{
  method: NonNullable<StepCapture["cartOpenMethod"]>;
  url: string;
  visibleMarker: string | null;
  /** Diagnostics from the LAST reveal attempt — most informative on failure. */
  diagnostics?: CartRevealDiagnostics;
}> {
  const beforeUrl = page.url();
  let lastDiagnostics: CartRevealDiagnostics | undefined;
  // Reveal is often asynchronous (CSS transition / data-gated render / slow dev
  // click handler), so poll rather than snapshot once. Dev servers get a larger
  // budget for the same reason networkidle is disabled on them (issue #55).
  const revealBudget =
    ctx.rc.cartRevealTimeoutMs ??
    (isLocalhost(beforeUrl) ? CART_REVEAL_BUDGET_LOCALHOST_MS : CART_REVEAL_BUDGET_MS);
  dlog(ctx, `  openMinicart: starting — trigger=${trigger.selector} title=${expectedProductTitle?.slice(0, 40) ?? "none"} revealBudget=${revealBudget}ms`);
  // Hard cap on dismissOverlays (issue #151): the sweep runs at most 4s so a
  // pathological page/selector list can't silently stall the whole step.
  await Promise.race([
    dismissOverlays(page, ctx),
    new Promise<void>((resolve) => setTimeout(resolve, 4_000)),
  ]);
  dlog(ctx, "  openMinicart: dismissOverlays done — checking alreadyOpen…");
  await page.waitForTimeout(800);
  const alreadyOpen = await isCartRevealed(page, expectedProductTitle, ctx);
  if (alreadyOpen) {
    dlog(ctx, `  openMinicart: already-open (matched ${alreadyOpen})`);
    return { method: "already-open", url: beforeUrl, visibleMarker: alreadyOpen };
  }
  const triggerHref = await trigger.locator.getAttribute("href").catch(() => null);
  const hrefHasCartTarget = !!triggerHref && /\/(checkout|cart|carrinho)/i.test(triggerHref);

  // Strategy 1: hover FIRST on desktop (Miess prod opens drawer on hover).
  // Speculative — a hover-driven drawer opens quickly or not at all, so cap the
  // probe short and let the real click path (below) own the full reveal budget.
  if (ctx.viewport === "desktop") {
    dlog(
      ctx,
      `  openMinicart: trying hover first on ${trigger.selector}${triggerHref ? ` (href=${triggerHref})` : ""}`,
    );
    await trigger.locator.hover({ timeout: 3_000 }).catch(() => undefined);
    const hoverProbeBudget = Math.min(CART_REVEAL_HOVER_PROBE_MS, revealBudget);
    const hover1 = await waitForCartReveal(page, expectedProductTitle, ctx, hoverProbeBudget);
    lastDiagnostics = hover1.diagnostics;
    if (hover1.marker) {
      dlog(ctx, `  openMinicart: hover opened drawer (${hover1.marker})`);
      return { method: "hover", url: page.url(), visibleMarker: hover1.marker, diagnostics: hover1.diagnostics };
    }
  }

  // Strategy 2a (mobile): real tap.
  if (ctx.viewport === "mobile") {
    dlog(ctx, `  openMinicart: trying tap (mobile) on ${trigger.selector}`);
    await Promise.all([
      page
        .waitForURL((url) => url.toString() !== beforeUrl, { timeout: 4_000 })
        .catch(() => undefined),
      trigger.locator.tap({ timeout: 4_000 }).catch(() => undefined),
    ]);
    if (page.url() !== beforeUrl) {
      await page.waitForLoadState("load", { timeout: 8_000 }).catch(() => undefined);
      await waitForCartHydration(page);
      dlog(ctx, `  openMinicart: tap navigated → ${page.url()} (settled)`);
      return { method: "click-navigate", url: page.url(), visibleMarker: null };
    }
    const tap = await waitForCartReveal(page, expectedProductTitle, ctx, revealBudget);
    lastDiagnostics = tap.diagnostics;
    if (tap.marker) {
      dlog(ctx, `  openMinicart: tap opened drawer (${tap.marker})`);
      return { method: "click", url: page.url(), visibleMarker: tap.marker, diagnostics: tap.diagnostics };
    }
  }

  // Strategy 2b: force click + URL race.
  dlog(
    ctx,
    `  openMinicart: trying force-click on ${trigger.selector}${triggerHref ? ` (href=${triggerHref})` : ""}`,
  );
  await Promise.all([
    page
      .waitForURL((url) => url.toString() !== beforeUrl, { timeout: 4_000 })
      .catch(() => undefined),
    trigger.locator.click({ force: true, timeout: 4_000 }).catch(() => undefined),
  ]);
  const afterClickUrl = page.url();
  if (afterClickUrl !== beforeUrl) {
    await page.waitForLoadState("load", { timeout: 8_000 }).catch(() => undefined);
    await waitForCartHydration(page);
    dlog(ctx, `  openMinicart: click navigated → ${page.url()} (settled)`);
    return { method: "click-navigate", url: page.url(), visibleMarker: null };
  }
  const click = await waitForCartReveal(page, expectedProductTitle, ctx, revealBudget);
  lastDiagnostics = click.diagnostics;
  if (click.marker) {
    dlog(ctx, `  openMinicart: click opened drawer (${click.marker})`);
    return { method: "click", url: afterClickUrl, visibleMarker: click.marker, diagnostics: click.diagnostics };
  }
  // A popup can appear mid-flow (e.g. right after add-to-cart) and intercept
  // the trigger click even though `dismissOverlays` already ran once at the
  // top of this function — confirmed live against a production deploy, where
  // a newsletter modal silently absorbed the click and the drawer never
  // opened. Detect it structurally and retry once, mirroring add-to-cart's
  // #145/#146 handling.
  const blockingOverlay = await dismissBlockingOverlay(page, ctx, trigger.locator);
  if (blockingOverlay?.dismissed) {
    dlog(ctx, `  openMinicart: cleared blocking overlay (${blockingOverlay.method}) — retrying click`);
    await trigger.locator.click({ force: true, timeout: 4_000 }).catch(() => undefined);
    const retry = await waitForCartReveal(page, expectedProductTitle, ctx, revealBudget);
    lastDiagnostics = retry.diagnostics;
    if (retry.marker) {
      dlog(ctx, `  openMinicart: click opened drawer after overlay dismissal (${retry.marker})`);
      return { method: "click", url: page.url(), visibleMarker: retry.marker, diagnostics: retry.diagnostics };
    }
  }
  // Strategy 3 (mobile only): hover as fallback.
  if (ctx.viewport !== "desktop") {
    dlog(ctx, `  openMinicart: click didn't reveal cart, trying hover (mobile)`);
    await trigger.locator.hover({ timeout: 3_000 }).catch(() => undefined);
    const hover2 = await waitForCartReveal(page, expectedProductTitle, ctx, revealBudget);
    lastDiagnostics = hover2.diagnostics;
    if (hover2.marker) {
      dlog(ctx, `  openMinicart: hover opened drawer (${hover2.marker})`);
      return { method: "hover", url: page.url(), visibleMarker: hover2.marker, diagnostics: hover2.diagnostics };
    }
  }
  // Strategy 4: direct goto fallback when trigger has cart href.
  if (hrefHasCartTarget && triggerHref) {
    const targetUrl = (() => {
      try {
        return new URL(triggerHref, page.url()).toString();
      } catch {
        return null;
      }
    })();
    if (targetUrl) {
      dlog(
        ctx,
        `  openMinicart: all interactive strategies failed; navigating directly to ${targetUrl}`,
      );
      await page.goto(targetUrl, { waitUntil: "load", timeout: 15_000 }).catch(() => undefined);
      await waitForCartHydration(page);
      if (page.url() !== beforeUrl) {
        dlog(ctx, `  openMinicart: goto fallback landed on ${page.url()}`);
        return { method: "click-navigate", url: page.url(), visibleMarker: null };
      }
    }
  }
  dlog(
    ctx,
    `  openMinicart: failed — no cart revealed by hover/click/goto${lastDiagnostics ? ` (${summarizeCartRevealDiagnostics(lastDiagnostics)})` : ""}`,
  );
  return { method: "failed", url: page.url(), visibleMarker: null, diagnostics: lastDiagnostics };
}

function normalizeTitle(s: string): string {
  return s
    .toLowerCase()
    .replace(/[®©™]/g, "")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titlesMatch(observed: string, expected: string): boolean {
  const o = normalizeTitle(observed);
  const e = normalizeTitle(expected);
  if (!o || !e) return false;
  if (o === e) return true;
  if (e.length >= 12 && o.includes(e)) return true;
  if (o.length >= 12 && e.includes(o)) return true;
  return false;
}

export async function validateCartContainsTitle(
  page: Page,
  expectedTitle: string,
  ctx: FlowContext,
): Promise<{ found: boolean; observedTitles: string[]; method: "selector" | "none" }> {
  // Scope title selectors to the configurable minicart panel first (issue
  // #149) — a `data-qa-*`/utility-class drawer has no name-based class the
  // hardcoded scopes below can reach into, so its line-item titles were
  // invisible to the sweep even when the drawer was open.
  const panelScopedTitleSelectors = selFor(ctx, "minicartPanel").flatMap((p) => [
    `${p} a[href*='/p']`,
    `${p} [class*='name' i]`,
    `${p} [class*='title' i]`,
    `${p} [class*='product' i]`,
    `${p} [data-cart-item-name]`,
    `${p} [data-qa-product-name]`,
  ]);
  const titleSelectors = [
    ...panelScopedTitleSelectors,
    "[data-cart-item-name]",
    "[data-cart-item] [class*='title' i]",
    "[data-cart-item] [class*='name' i]",
    "[class*='cart' i] [data-product-name]",
    "[role='dialog'] [data-product-name]",
    "[class*='checkout' i] [data-product-name]",
    "[class*='minicart' i] [data-product-name]",
    "[data-testid='cart-item-name']",
    "[data-testid='product-name']",
    "[role='dialog'] li [class*='product' i]",
    "[role='dialog'] li [class*='name' i]",
    "[role='dialog'] li [class*='title' i]",
    "[role='dialog'] a[href*='/p']",
    "[class*='minicart' i] [class*='item' i] [class*='name' i]",
    "[class*='minicart' i] [class*='item' i] [class*='title' i]",
    "[class*='cart-item' i] [class*='name' i]",
    "[class*='cart-item' i] [class*='title' i]",
    "[class*='checkout' i] [class*='product' i] [class*='name' i]",
    ".vtex-minicart-2-x-itemNameContainer",
    ".vtex-checkout-summary-0-x-itemName",
    ".product-name",
    ".item-name",
    "a.product-name",
    ".cart-items .item-name",
    "tr.product-item .item-name",
    "tr.cart-item .item-name",
    "table.cart-items td a",
    "#cart-fixed .item .product-name",
    "#cart-fixed .item-name",
    ".cart-fixed .item-name",
    ".cart-fixed .product-name",
    "#cart-fixed li a",
    "#minicart-content .item-name",
    "[data-fs-cart-item-summary-title]",
    "[data-fs-cart-item-image] + * a",
    "[class*='cart' i] a[href*='/p']",
    "[class*='checkout' i] a[href*='/p']",
  ];
  const sweepTitles = async (): Promise<string[]> => {
    const observed: string[] = [];
    for (const sel of titleSelectors) {
      try {
        const loc = page.locator(sel);
        const count = await withCap(loc.count(), 1_000, 0);
        const limit = Math.min(count, 10);
        for (let i = 0; i < limit; i++) {
          const el = loc.nth(i);
          const visible = await withCap(
            el.isVisible({ timeout: 200 }).catch(() => false),
            400,
            false,
          );
          if (!visible) continue;
          const text = await withCap(
            el.innerText().catch(() => ""),
            500,
            "",
          );
          const clean = text.trim().slice(0, 200);
          if (clean.length > 2) observed.push(clean);
        }
        if (observed.length > 0) return observed;
      } catch {
        /* try next */
      }
    }
    return observed;
  };

  let observed = await sweepTitles();
  if (observed.length === 0) {
    dlog(ctx, "  validateCartContainsTitle: 0 titles on first pass, retrying after 2s");
    await page.waitForTimeout(2_000);
    observed = await sweepTitles();
  }
  if (observed.length === 0) {
    // Issue #157: panel may be visible but empty because an on-demand cart
    // (react-query, lazy hydration) hasn't fired its fetch yet — e.g. when the
    // drawer opened as a side-effect of a toast rather than via cart-icon click.
    // Wait up to 5s for any child element to appear inside the panel before
    // declaring the cart empty; if one appears, sweep titles one final time.
    const panelSelectors = selFor(ctx, "minicartPanel");
    if (panelSelectors.length > 0) {
      dlog(ctx, "  validateCartContainsTitle: panel empty — waiting up to 5s for hydration");
      await Promise.race(
        panelSelectors.map((p) =>
          page.waitForSelector(`${p} *`, { timeout: 5_000 }).catch(() => undefined),
        ),
      );
      observed = await sweepTitles();
    }
  }
  dlog(ctx, `  validateCartContainsTitle: observed ${observed.length} titles`);
  if (observed.length === 0) {
    return { found: false, observedTitles: [], method: "none" };
  }
  const found = observed.some((o) => titlesMatch(o, expectedTitle));
  return { found, observedTitles: observed, method: "selector" };
}

export async function detectEmptyCartBanner(page: Page): Promise<string | null> {
  const bannerSelectors = [
    ":text-matches('carrinho.*vazio', 'i')",
    ":text-matches('seu carrinho está vazio', 'i')",
    ":text-matches('empty cart', 'i')",
    ":text-matches('cart is empty', 'i')",
    ":text-matches('nenhum item.*carrinho', 'i')",
    "[class*='empty' i][class*='cart' i]",
    "[class*='cart-empty' i]",
  ];
  for (const sel of bannerSelectors) {
    try {
      const loc = page.locator(sel).first();
      if (
        await withCap(
          loc.isVisible({ timeout: 300 }).catch(() => false),
          500,
          false,
        )
      ) {
        const text = await withCap(
          loc.innerText().catch(() => ""),
          500,
          "",
        );
        if (text.trim()) return text.trim().slice(0, 120);
      }
    } catch {
      /* try next */
    }
  }
  return null;
}

export interface CartTotals {
  qty?: number;
  price?: string;
  /** Number of visible cart-item rows (multi-item cart support). */
  items?: number;
  /** Sum of ALL visible quantity inputs found (not just the first row). */
  totalQty?: number;
}

/**
 * Parse a BRL-formatted currency string (e.g. "R$ 1.234,56") into a number
 * (1234.56). Returns null when no currency-shaped number is found.
 *
 * Also tolerates a plain dot-decimal fallback ("129.90") for stores that
 * render prices without thousands separators or currency symbol.
 */
export function parsePriceBRL(text: string): number | null {
  const brl = text.match(/(\d{1,3}(?:\.\d{3})*|\d+),(\d{2})\b/);
  if (brl) {
    const intPart = brl[1]!.replace(/\./g, "");
    const decPart = brl[2]!;
    const n = Number.parseInt(intPart, 10) + Number.parseInt(decPart, 10) / 100;
    return Number.isFinite(n) ? n : null;
  }
  const plain = text.match(/(\d+)\.(\d{2})\b/);
  if (plain) {
    const n = Number.parseInt(plain[1]!, 10) + Number.parseInt(plain[2]!, 10) / 100;
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Read the quantity input value + total price from an open minicart/cart.
 *
 * Best-effort: any selector miss returns undefined for that field. Also
 * reports `items` (visible cart-item-row count) and `totalQty` (sum of ALL
 * visible quantity inputs) to support multi-item cart validation.
 */
export async function parseCartTotals(page: Page, ctx: FlowContext): Promise<CartTotals> {
  const out: CartTotals = {};
  // Qty: try quantityInput inside any cart row, else any visible quantity input.
  const qtySelectors = [
    ...selFor(ctx, "cartItemRow").map((s) => `${s} input[type='number']`),
    ...selFor(ctx, "quantityInput"),
  ];
  for (const sel of qtySelectors) {
    const value = await withCap(
      page
        .locator(sel)
        .first()
        .inputValue()
        .catch(() => ""),
      1_000,
      "",
    );
    const n = Number.parseInt(value, 10);
    if (Number.isFinite(n) && n > 0) {
      out.qty = n;
      break;
    }
  }

  // totalQty: sum across ALL visible quantity inputs (multi-item cart) —
  // stop at the first selector group that yields any matches.
  for (const sel of qtySelectors) {
    try {
      const loc = page.locator(sel);
      const count = await withCap(loc.count(), 1_000, 0);
      if (count === 0) continue;
      let sum = 0;
      let found = false;
      for (let i = 0; i < Math.min(count, 20); i++) {
        const el = loc.nth(i);
        const visible = await withCap(
          el.isVisible({ timeout: 300 }).catch(() => false),
          500,
          false,
        );
        if (!visible) continue;
        const value = await withCap(
          el.inputValue().catch(() => ""),
          500,
          "",
        );
        const n = Number.parseInt(value, 10);
        if (Number.isFinite(n) && n > 0) {
          sum += n;
          found = true;
        }
      }
      if (found) {
        out.totalQty = sum;
        break;
      }
    } catch {
      /* try next */
    }
  }

  // items: count of visible cart-item-row matches.
  for (const sel of selFor(ctx, "cartItemRow")) {
    try {
      const loc = page.locator(sel);
      const count = await withCap(loc.count(), 1_000, 0);
      if (count === 0) continue;
      let visibleCount = 0;
      for (let i = 0; i < Math.min(count, 20); i++) {
        const visible = await withCap(
          loc
            .nth(i)
            .isVisible({ timeout: 300 })
            .catch(() => false),
          500,
          false,
        );
        if (visible) visibleCount++;
      }
      if (visibleCount > 0) {
        out.items = visibleCount;
        break;
      }
    } catch {
      /* try next */
    }
  }

  // Price: cartTotalPrice innerText
  for (const sel of selFor(ctx, "cartTotalPrice")) {
    const text = await withCap(
      page
        .locator(sel)
        .first()
        .innerText()
        .catch(() => ""),
      1_000,
      "",
    );
    if (text.trim()) {
      out.price = text.trim().slice(0, 60);
      break;
    }
  }
  return out;
}

/**
 * Wait for a cart mutation to settle instead of a blind `waitForTimeout`.
 * Races three signals:
 *   (a) polling `parseCartTotals` every ~250ms until `predicate(totals)` is true
 *   (b) a page response matching a cart/checkout API pattern (one extra
 *       settle read is taken afterwards, then we return regardless of the
 *       predicate — the API round-trip completing is itself strong signal)
 *   (c) a hard `capMs` timeout
 *
 * Always returns the last totals it read (never throws).
 */
export async function waitForCartMutation(
  page: Page,
  ctx: FlowContext,
  predicate: (totals: CartTotals) => boolean,
  capMs = 2_500,
): Promise<CartTotals> {
  const deadline = Date.now() + capMs;
  let responseSeen = false;
  page
    .waitForResponse((r) => /api\/checkout|orderForm|\/cart\b/i.test(r.url()), {
      timeout: capMs,
    })
    .then(() => {
      responseSeen = true;
    })
    .catch(() => undefined);

  let totals = await parseCartTotals(page, ctx);
  while (Date.now() < deadline) {
    if (predicate(totals)) return totals;
    if (responseSeen) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return await parseCartTotals(page, ctx);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    totals = await parseCartTotals(page, ctx);
  }
  return totals;
}
