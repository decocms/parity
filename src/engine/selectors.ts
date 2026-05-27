import { getLearnedSelectors, type LearnedSelectors } from "../learned/repo.ts";
import type { Platform } from "../learned/platform.ts";
import type { ParityRc } from "../types/schema.ts";

/**
 * Default selector candidates for common e-commerce platforms (VTEX, Shopify).
 * Each key has an array of selectors to try in order. First match wins.
 * Override per-project via `.parityrc.json`.
 */
export const DEFAULT_SELECTORS = {
  categoryLink: [
    "header nav a[href*='/c/']",
    "header nav a[href*='/category/']",
    "header nav a[href*='/collections/']",
    "[data-mega-menu] a[href*='/c/']",
    "header a[href]:not([href='/']):not([href='#']):not([href*='login']):not([href*='cart'])",
  ],
  productCard: [
    "[data-product-card] a",
    "[data-deco='view-product'] a",
    "[data-testid='product-card'] a",
    ".product-card a",
    "article a[href*='/p/']",
    "a[href*='/products/']",
  ],
  buyButton: [
    "button:has-text('Comprar')",
    "button:has-text('Adicionar')",
    "button:has-text('Add to cart')",
    "button:has-text('Add to bag')",
    "[data-buy-button]",
    "[data-testid='add-to-cart']",
    "button[type='submit']:has-text('Comprar')",
  ],
  minicartTrigger: [
    "[data-minicart-trigger]",
    "[data-testid='minicart-trigger']",
    "[aria-label*='carrinho' i]",
    "[aria-label*='cart' i]",
    "header button:has([data-cart-icon])",
    "header a[href='/checkout']",
  ],
  cepInputPdp: [
    "input[name='shipping-zipcode']",
    "input[name='zipcode']",
    "input[name='cep']",
    "input[placeholder*='CEP' i]",
    "input[placeholder*='Postal' i]",
    "[data-shipping-input] input",
  ],
  cepInputCart: [
    "input[name='cart-zipcode']",
    "[data-minicart] input[name*='zip' i]",
    "[data-cart] input[name*='zip' i]",
    "[role='dialog'] input[name*='cep' i]",
    "[role='dialog'] input[placeholder*='CEP' i]",
  ],
  checkoutButton: [
    "a:has-text('Finalizar compra')",
    "button:has-text('Finalizar compra')",
    "a:has-text('Ir para o checkout')",
    "button:has-text('Ir para o checkout')",
    "[role='dialog'] a:has-text('Finalizar')",
    "[role='dialog'] button:has-text('Finalizar')",
    "[data-minicart] a:has-text('Finalizar')",
    "[data-minicart] button:has-text('Finalizar')",
    "[data-cart-drawer] a:has-text('Finalizar')",
    "[data-cart-drawer] button:has-text('Finalizar')",
    "a:has-text('Checkout')",
    "[data-checkout-button]",
    "a:text-is('Finalizar')",
    "button:text-is('Finalizar')",
  ],
  sizeSwatch: [
    "[data-size]:not([disabled]):not([aria-disabled='true']):not(.unavailable):not(.sold-out)",
    "[data-variant-size]:not([disabled]):not([aria-disabled='true']):not(.unavailable)",
    "button[aria-label*='tamanho' i]:not([aria-disabled='true']):not([disabled])",
    "button[aria-label*='size' i]:not([aria-disabled='true']):not([disabled])",
    "[data-testid='size-selector'] button:not([disabled]):not(.unavailable)",
    ".size-selector button:not([disabled]):not(.unavailable):not(.sold-out)",
    "[class*='size'] button:not([disabled]):not(.unavailable)",
    "label:has(input[name*='size' i]:not([disabled])) ",
  ],
  colorSwatch: [
    "[data-color]:not([disabled]):not([aria-disabled='true']):not(.unavailable):not(.sold-out)",
    "[data-variant-color]:not([disabled]):not([aria-disabled='true']):not(.unavailable)",
    "button[aria-label*='cor' i]:not([aria-disabled='true']):not([disabled])",
    "button[aria-label*='color' i]:not([aria-disabled='true']):not([disabled])",
    "[data-testid='color-selector'] button:not([disabled]):not(.unavailable)",
    ".color-swatch:not(.unavailable):not(.sold-out)",
    "[class*='color'] button:not([disabled]):not(.unavailable)",
  ],
  variantRow: [
    "[data-sku-row]",
    "[data-variant-row]",
    "tr[data-variant]",
    "tr:has([aria-label*='quantidade' i])",
    "tbody tr:has(input[type='number'])",
  ],
  quantityIncrement: [
    "[data-qty-plus]",
    "[data-quantity-plus]",
    "button[aria-label*='aumentar' i]",
    "button[aria-label*='increase' i]",
    "button[aria-label*='increment' i]",
    "button:has-text('+')",
    "[class*='qty'] button:has-text('+')",
  ],
  quantityInput: [
    "input[type='number'][min='0'][value='0']",
    "input[id*='quantity-input' i]",
    "input[name*='qty' i]",
    "input[name*='quantity' i]",
    "input[name*='quantidade' i]",
    "input[aria-label*='quantidade' i]",
    "[data-qty-input]",
    "input[type='number'][min='0']",
    "input[type='number'][min='1']",
  ],
  minicartCount: [
    "[data-minicart-count]",
    "[data-cart-count]",
    ".cart-count",
    ".minicart__count",
    "[class*='cart-count']",
    "[class*='CartCount']",
    "[aria-label*='itens' i][role='status']",
    "header [data-minicart-trigger] [class*='badge']",
    "header [aria-label*='cart' i] [class*='count']",
    "header [aria-label*='sacola' i] [class*='badge']",
    "header [aria-label*='sacola' i] [class*='count']",
    "header a[href*='/cart'] [class*='count']",
    "header a[href*='/checkout'] [class*='count']",
    "[data-fs-cart-icon] + [class*='count']",
    "[class*='Minicart'] [class*='count']",
    "[class*='minicart'] [class*='count']",
  ],
} as const;

export type SelectorKey = keyof typeof DEFAULT_SELECTORS;

export interface SelectorResolutionContext {
  rc?: ParityRc;
  learned?: LearnedSelectors;
  platform?: Platform;
}

/**
 * Returns the effective selector list for a key, following the cascade:
 *   1. user override from .parityrc.json (always first if present)
 *   2. learned-selectors.json entries for the detected platform, ordered by successRate
 *   3. baked-in defaults from DEFAULT_SELECTORS
 *
 * Backwards-compatible: accepts a ParityRc directly as the second arg too.
 */
export function selectorsFor(
  key: SelectorKey,
  ctxOrRc: SelectorResolutionContext | ParityRc = {},
): string[] {
  const ctx: SelectorResolutionContext = isResolutionContext(ctxOrRc)
    ? ctxOrRc
    : { rc: ctxOrRc };

  const out: string[] = [];
  const override = ctx.rc?.selectors?.[key];
  if (override) out.push(override);

  if (ctx.learned && ctx.platform) {
    for (const entry of getLearnedSelectors(ctx.learned, ctx.platform, key)) {
      out.push(entry.selector);
    }
  }

  out.push(...DEFAULT_SELECTORS[key]);
  return [...new Set(out)];
}

function isResolutionContext(v: unknown): v is SelectorResolutionContext {
  if (!v || typeof v !== "object") return false;
  const k = Object.keys(v as object);
  return k.length === 0 || k.some((x) => x === "rc" || x === "learned" || x === "platform");
}

