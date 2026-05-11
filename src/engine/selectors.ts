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
    "a:has-text('Checkout')",
    "[data-checkout-button]",
  ],
} as const;

export type SelectorKey = keyof typeof DEFAULT_SELECTORS;

/**
 * Returns the effective selector list for a key: user overrides first (if any),
 * then defaults.
 */
export function selectorsFor(key: SelectorKey, rc?: ParityRc): string[] {
  const override = rc?.selectors?.[key];
  const defaults = DEFAULT_SELECTORS[key];
  if (override) return [override, ...defaults];
  return [...defaults];
}
