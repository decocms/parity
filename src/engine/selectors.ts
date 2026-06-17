import type { Platform } from "../learned/platform.ts";
import { type LearnedSelectors, getLearnedSelectors } from "../learned/repo.ts";
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
  // ── Search flow ────────────────────────────────────────────────────────
  searchTrigger: [
    "header [aria-label*='busca' i]",
    "header [aria-label*='search' i]",
    "header [aria-label*='pesquisar' i]",
    "header button:has(svg[class*='search' i])",
    "header [data-search-trigger]",
    "[data-testid*='search-trigger']",
    "[data-testid='search-toggle']",
    "header button:has(svg[aria-label*='busca' i])",
    "header [class*='search-icon' i]",
    "header [class*='searchIcon' i]",
    "header [class*='SearchIcon']",
  ],
  searchInput: [
    "input[type='search']",
    "input[name='ft']", // VTEX Intelligent Search query param
    "input[name='q']",
    "input[name='query']",
    "[role='searchbox']",
    "input[placeholder*='busca' i]",
    "input[placeholder*='pesquisar' i]",
    "input[placeholder*='o que' i]", // "O que você procura?"
    "input[placeholder*='search' i]",
    "input[placeholder*='procur' i]",
    ".vtex-search-bar__input",
    "[class*='searchBar' i] input",
    "[class*='SearchBar'] input",
    "[class*='search-bar' i] input",
    "header form input[type='text']",
    "header form input:not([type='hidden']):not([type='submit'])",
    "[data-testid='search-input']",
  ],
  searchSuggestions: [
    "[role='listbox']",
    "[data-search-suggestions]",
    "[data-testid='search-suggestions']",
    ".vtex-search-bar__autocomplete",
    "[class*='autocomplete' i]:visible",
    "[class*='Autocomplete']:visible",
    "[class*='search-suggestions' i]:visible",
    "[class*='searchSuggestions']:visible",
    "[class*='suggestions' i] [class*='item' i]",
  ],
  // ── Cart interactions flow ─────────────────────────────────────────────
  cartItemRow: [
    "[data-cart-item]",
    "[data-testid='cart-item']",
    "[role='dialog'] [class*='cart-item' i]",
    "[role='dialog'] [class*='CartItem']",
    ".vtex-minicart-2-x-item",
    "[data-fs-cart-item]",
  ],
  cartQuantityIncrement: [
    "[role='dialog'] [data-qty-plus]",
    "[role='dialog'] button[aria-label*='aumentar' i]",
    "[role='dialog'] button[aria-label*='increase' i]",
    "[role='dialog'] button:has-text('+')",
    "[data-cart-item] button[aria-label*='aumentar' i]",
    "[data-cart-item] button:has-text('+')",
  ],
  cartQuantityDecrement: [
    "[role='dialog'] [data-qty-minus]",
    "[role='dialog'] button[aria-label*='diminuir' i]",
    "[role='dialog'] button[aria-label*='decrease' i]",
    "[role='dialog'] button:has-text('-')",
    "[data-cart-item] button[aria-label*='diminuir' i]",
    "[data-cart-item] button:has-text('-')",
  ],
  cartRemoveItem: [
    "[role='dialog'] [aria-label*='remover' i]",
    "[role='dialog'] [aria-label*='remove' i]",
    "[role='dialog'] button:has-text('Remover')",
    "[role='dialog'] button:has-text('Excluir')",
    "[data-testid*='remove-from-cart']",
    "[data-cart-item] button[aria-label*='remover' i]",
  ],
  cartCouponInput: [
    "input[name*='coupon' i]",
    "input[name*='cupom' i]",
    "input[placeholder*='cupom' i]",
    "input[placeholder*='coupon' i]",
    "input[placeholder*='código' i]",
    "[data-coupon-input]",
  ],
  cartCouponSubmit: [
    "button:has-text('Aplicar')",
    "button:has-text('Apply')",
    "button[aria-label*='aplicar cupom' i]",
    "[data-coupon-submit]",
    "form:has(input[name*='coupon' i]) button[type='submit']",
  ],
  cartTotalPrice: [
    "[data-cart-total]",
    "[data-testid='cart-total']",
    "[role='dialog'] [class*='total' i]:not([class*='subtotal' i])",
    ".vtex-minicart-2-x-totalValue",
    "[data-fs-cart-total]",
  ],
  // ── PDP gallery + related ──────────────────────────────────────────────
  pdpGalleryThumbnail: [
    "[data-gallery-thumb]",
    "[data-testid='gallery-thumbnail']",
    ".product-gallery__thumb",
    "[role='tab'][aria-controls*='gallery' i]",
    ".vtex-store-components-3-x-productImagesThumb",
    "[class*='gallery' i] [role='button']:has(img)",
  ],
  pdpGalleryMain: [
    "[data-gallery-main]",
    "[data-testid='gallery-main']",
    ".product-gallery__main",
    "[class*='gallery' i] [aria-hidden='false'] img",
    ".vtex-store-components-3-x-productImageTag--main",
    "[data-fs-product-images]",
  ],
  pdpRelatedShelf: [
    "[data-related-products]",
    "[data-testid='related-products']",
    "[data-shelf='related']",
    "section:has-text('Você também pode gostar')",
    "section:has-text('Produtos relacionados')",
    "section:has-text('Related products')",
    "[class*='related-products' i]",
    "[class*='cross-sell' i]",
  ],
  // ── Login flow ─────────────────────────────────────────────────────────
  loginTrigger: [
    "[aria-label*='entrar' i]",
    "[aria-label*='login' i]",
    "[aria-label*='minha conta' i]",
    "header a[href*='/login']",
    "header a[href*='/account']",
    "header button:has-text('Entrar')",
    "header a:has-text('Entrar')",
    "[data-testid='login-trigger']",
  ],
  loginEmailInput: [
    "input[type='email']",
    "input[name='email']",
    "input[name='username']",
    "input[autocomplete='email']",
    "input[placeholder*='e-mail' i]",
    "[data-testid='email-input']",
  ],
  loginPasswordInput: [
    "input[type='password']",
    "input[name='password']",
    "input[name='senha']",
    "input[autocomplete='current-password']",
    "[data-testid='password-input']",
  ],
  loginSubmit: [
    "button[type='submit']:has-text('Entrar')",
    "button[type='submit']:has-text('Acessar')",
    "button[type='submit']:has-text('Login')",
    "button[type='submit']:has-text('Sign in')",
    "form:has(input[type='password']) button[type='submit']",
    "[data-testid='login-submit']",
  ],
  loginErrorMessage: [
    "[role='alert']",
    "[aria-live='polite'][class*='error' i]",
    "[class*='error-message' i]:visible",
    "[class*='login-error' i]",
    "[data-testid='login-error']",
    "form:has(input[type='password']) [class*='error' i]:visible",
  ],
  accountMenuTrigger: [
    "[aria-label*='minha conta' i]",
    "header a[href*='/account']",
    "header a[href*='/minha-conta']",
    "header [data-account-menu]",
    "header button:has-text('Olá')",
    "[data-testid='account-menu']",
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
  const ctx: SelectorResolutionContext = isResolutionContext(ctxOrRc) ? ctxOrRc : { rc: ctxOrRc };

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
