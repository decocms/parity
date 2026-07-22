import type { Locator, Page } from "playwright";
import type { StepCapture, Viewport } from "../../types/schema.ts";
import type { FlowContext } from "./shared.ts";
import { dismissOverlays, dlog, firstVisible, selFor, withCap } from "./shared.ts";

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

export async function isCartUiVisible(page: Page): Promise<string | null> {
  return firstVisible(page, [
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
): Promise<string | null> {
  if (expectedProductTitle) {
    const v = await validateCartContainsTitleQuick(page, expectedProductTitle);
    if (v) return `title-found:${v}`;
  }
  return isCartUiVisible(page);
}

async function validateCartContainsTitleQuick(
  page: Page,
  expectedTitle: string,
): Promise<string | null> {
  const quickSelectors = [
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
}> {
  const beforeUrl = page.url();
  await dismissOverlays(page, ctx);
  await page.waitForTimeout(800);
  const alreadyOpen = await isCartRevealed(page, expectedProductTitle);
  if (alreadyOpen) {
    dlog(ctx, `  openMinicart: already-open (matched ${alreadyOpen})`);
    return { method: "already-open", url: beforeUrl, visibleMarker: alreadyOpen };
  }
  const triggerHref = await trigger.locator.getAttribute("href").catch(() => null);
  const hrefHasCartTarget = !!triggerHref && /\/(checkout|cart|carrinho)/i.test(triggerHref);

  // Strategy 1: hover FIRST on desktop (Miess prod opens drawer on hover).
  if (ctx.viewport === "desktop") {
    dlog(
      ctx,
      `  openMinicart: trying hover first on ${trigger.selector}${triggerHref ? ` (href=${triggerHref})` : ""}`,
    );
    await trigger.locator.hover({ timeout: 3_000 }).catch(() => undefined);
    await page.waitForTimeout(1_500);
    const hoverOpened = await isCartRevealed(page, expectedProductTitle);
    if (hoverOpened) {
      dlog(ctx, `  openMinicart: hover opened drawer (${hoverOpened})`);
      return { method: "hover", url: page.url(), visibleMarker: hoverOpened };
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
    await page.waitForTimeout(800);
    const tapOpened = await isCartRevealed(page, expectedProductTitle);
    if (tapOpened) {
      dlog(ctx, `  openMinicart: tap opened drawer (${tapOpened})`);
      return { method: "click", url: page.url(), visibleMarker: tapOpened };
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
  await page.waitForTimeout(1_500);
  const clickOpened = await isCartRevealed(page, expectedProductTitle);
  if (clickOpened) {
    dlog(ctx, `  openMinicart: click opened drawer (${clickOpened})`);
    return { method: "click", url: afterClickUrl, visibleMarker: clickOpened };
  }
  // Strategy 3 (mobile only): hover as fallback.
  if (ctx.viewport !== "desktop") {
    dlog(ctx, `  openMinicart: click didn't reveal cart, trying hover (mobile)`);
    await trigger.locator.hover({ timeout: 3_000 }).catch(() => undefined);
    await page.waitForTimeout(1_500);
    const hoverOpened = await isCartRevealed(page, expectedProductTitle);
    if (hoverOpened) {
      dlog(ctx, `  openMinicart: hover opened drawer (${hoverOpened})`);
      return { method: "hover", url: page.url(), visibleMarker: hoverOpened };
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
  dlog(ctx, "  openMinicart: failed — no cart revealed by hover/click/goto");
  return { method: "failed", url: page.url(), visibleMarker: null };
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
  const titleSelectors = [
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

/**
 * Read the quantity input value + total price from an open minicart/cart.
 *
 * Best-effort: any selector miss returns undefined for that field.
 */
export async function parseCartTotals(
  page: Page,
  ctx: FlowContext,
): Promise<{ qty?: number; price?: string }> {
  const out: { qty?: number; price?: string } = {};
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
