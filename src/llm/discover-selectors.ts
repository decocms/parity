import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { callTool } from "./client.ts";
import { compactHtmlForSelectors, computeHtmlFingerprint } from "./html-compact.ts";

export { compactHtmlForSelectors } from "./html-compact.ts";

const CACHE_DIR = ".parity-cache";
const CACHE_SCHEMA_VERSION = 1;
const DEFAULT_TTL_DAYS = 7;

export const DiscoveredSelectorsSchema = z.object({
  categoryLink: z.string().optional(),
  productCard: z.string().optional(),
  buyButton: z.string().optional(),
  minicartTrigger: z.string().optional(),
  cepInputPdp: z.string().optional(),
  cepInputCart: z.string().optional(),
  checkoutButton: z.string().optional(),
  // Search flow
  searchTrigger: z.string().optional(),
  searchInput: z.string().optional(),
  searchSuggestions: z.string().optional(),
  // PDP gallery + related (visible on PDP, not home — LLM should leave empty if unsure)
  pdpGalleryThumbnail: z.string().optional(),
  pdpGalleryMain: z.string().optional(),
  pdpRelatedShelf: z.string().optional(),
  // Login (only meaningful when rc.login.enabled === true; LLM may leave empty)
  loginTrigger: z.string().optional(),
  accountMenuTrigger: z.string().optional(),
});
export type DiscoveredSelectors = z.infer<typeof DiscoveredSelectorsSchema>;

/**
 * On-disk cache envelope (issue: the old format was the raw
 * `DiscoveredSelectors` JSON with NO invalidation — host-only key, no TTL,
 * no content awareness; a site redesign silently served stale selectors
 * forever unless someone remembered `--refresh-selectors`).
 *
 * Invalidation rules (any → re-discover):
 *   - `schemaVersion` mismatch (old/legacy format included)
 *   - `createdAt` older than TTL (default 7 days, `PARITY_SELECTOR_CACHE_TTL_DAYS`)
 *   - `htmlFingerprint` differs from the current page's structural fingerprint
 *   - JSON parse / schema validation failure (file is deleted + warned)
 */
export const SelectorCacheEntrySchema = z.object({
  schemaVersion: z.number(),
  createdAt: z.string(),
  htmlFingerprint: z.string(),
  selectors: DiscoveredSelectorsSchema,
  /** Live-validation results (populated by the validate-selectors pass). */
  validated: z.record(z.string(), z.boolean()).optional(),
});
export type SelectorCacheEntry = z.infer<typeof SelectorCacheEntrySchema>;

const DISCOVER_SELECTORS_TOOL = {
  name: "report_selectors",
  description:
    "Report CSS selectors discovered from the page HTML, for an e-commerce parity crawler.",
  input_schema: {
    type: "object" as const,
    properties: {
      category_link: {
        type: "string",
        description:
          "CSS selector for a link in the header/mega-menu that navigates to a category/PLP (e.g. 'header nav a[href*=\"/c/\"]'). MUST be visible on the homepage.",
      },
      product_card: {
        type: "string",
        description:
          "CSS selector for an <a> wrapping a product card in a shelf/PLP (e.g. '[data-product-card] a'). Used to click into a PDP.",
      },
      buy_button: {
        type: "string",
        description:
          "CSS selector for the 'Buy' / 'Add to cart' primary CTA on a PDP (e.g. \"button:has-text('Comprar agora')\").",
      },
      minicart_trigger: {
        type: "string",
        description:
          "CSS selector for the CART ICON / SACOLA icon in the HEADER that opens the mini-cart drawer or navigates to the cart page when clicked (e.g. '[data-minicart-trigger]', or 'header a[aria-label*=\"sacola\" i]', or 'header a[href*=\"cart\"]'). This is the icon ALWAYS visible in the page header.",
      },
      cep_input_pdp: {
        type: "string",
        description:
          "CSS selector for the CEP / zipcode <input> on a PDP — the input where the customer types their ADDRESS POSTAL CODE to calculate shipping. Placeholder is typically 'CEP', 'Digite seu CEP', 'Cód. postal'. Do NOT return a coupon input ('Digite o cupom') or email/newsletter field. Empty string if the PDP has no shipping calculator.",
      },
      cep_input_cart: {
        type: "string",
        description:
          "CSS selector for the CEP / zipcode <input> inside the mini-cart drawer or cart page — for shipping calculation. Same rules: ADDRESS postal code, NOT coupon, NOT email. Empty string if cart has no shipping calculator.",
      },
      checkout_button: {
        type: "string",
        description:
          "CSS selector for the FINAL 'Go to checkout' / 'Finalizar compra' / 'Finalizar' button INSIDE the mini-cart drawer or cart page — the one user clicks AFTER reviewing cart items to proceed to checkout/payment. **IMPORTANT**: this is DIFFERENT from `minicart_trigger` (which is the cart ICON in the header). The checkout button is typically a big colored button at the bottom of the cart drawer or cart page. If you cannot see it on the home page (which is common — it's only rendered after add-to-cart), return EMPTY STRING. NEVER return the same selector as `minicart_trigger`.",
      },
      search_trigger: {
        type: "string",
        description:
          "CSS selector for the SEARCH ICON / LUPA in the header that opens the search input — typically only on MOBILE (desktop usually has the input always visible). Return EMPTY STRING if the search input is already visible on the home and no trigger is needed.",
      },
      search_input: {
        type: "string",
        description:
          "CSS selector for the SEARCH <input> (e.g. \"input[type='search']\", \"input[name='q']\", or \"[role='searchbox']\"). MUST be reachable from the home — either directly visible or after clicking `search_trigger`. NEVER return an email/newsletter/CEP input.",
      },
      search_suggestions: {
        type: "string",
        description:
          'CSS selector for the container that shows AUTOCOMPLETE suggestions while typing (e.g. "[role=\'listbox\']", ".vtex-search-bar__autocomplete", "[data-search-suggestions]"). May not exist on the home (lazy-rendered after typing). Return EMPTY STRING if you cannot detect it.',
      },
      pdp_gallery_thumbnail: {
        type: "string",
        description:
          "CSS selector for thumbnail images in the PDP image gallery. Typically lives on the PDP — return EMPTY STRING if you only have the home HTML and cannot infer the platform convention safely.",
      },
      pdp_gallery_main: {
        type: "string",
        description:
          "CSS selector for the MAIN image in the PDP image gallery (the large central image). Return EMPTY STRING if unsure — defaults handle it.",
      },
      pdp_related_shelf: {
        type: "string",
        description:
          "CSS selector for the 'Related products' / 'Você também pode gostar' shelf on a PDP. Return EMPTY STRING if uncertain.",
      },
      login_trigger: {
        type: "string",
        description:
          "CSS selector for the LOGIN / 'Entrar' / account-icon link in the header. EMPTY STRING if the site appears to have no login surface.",
      },
      account_menu_trigger: {
        type: "string",
        description:
          "CSS selector for the LOGGED-IN account menu trigger in the header (e.g. 'Olá, João' link, account avatar). EMPTY STRING when only a 'Login' link is visible.",
      },
      reasoning: {
        type: "string",
        description: "1-2 sentence rationale describing what was inferred from the markup.",
      },
    },
    required: ["category_link", "product_card", "buy_button", "minicart_trigger"],
  },
};

const SYSTEM_PROMPT = `
Você é um especialista em CSS selectors para crawlers/E2E de sites de e-commerce
(VTEX, Shopify, Wake, Nuvemshop, custom).

Dado o HTML de uma página inicial e a URL do site, identifique seletores robustos
para os 7 elementos pedidos pela ferramenta report_selectors. Você só vê a HOME —
inferir seletores de PDP, minicart, cart e checkout requer reconhecer convenções
da plataforma (ex: VTEX usa "vtex-cart" classes, "vtex-store-components" etc).

REGRAS:

1. Prefira seletores robustos NESTA ordem:
   a. data-attributes específicos (\`[data-product-card]\`, \`[data-buy-button]\`, \`data-fs-cart\`)
   b. ARIA labels (\`[aria-label*="carrinho" i]\`)
   c. Text-based via Playwright (\`button:has-text('Comprar')\`, \`a:has-text('Finalizar compra')\`)
   d. Classes estáveis específicas da plataforma (\`.vtex-minicart-2-x-arrowIcon\`)
   e. Por último, estrutura hierárquica curta (\`header nav a[href*='/c/']\`)

2. EVITE:
   - IDs gerados com hash (\`#r-xyz123\`)
   - Classes utility de Tailwind (\`.flex.items-center.bg-blue-500\`)
   - Seletores muito profundos (>4 níveis)
   - Seletores que pegam múltiplos elementos não-relacionados (use .first() implícito)

3. Detecção de plataforma:
   - Se o HTML tem classes \`vtex-\` → VTEX. Use convenções VTEX (\`.vtex-cart-item, .vtex-minicart\`).
   - Se tem \`fs-\` ou \`data-fs-*\` → FastStore/VTEX IO.
   - Se tem \`shopify-\` ou usa Liquid markup → Shopify.
   - Se tem \`data-deco\`, \`data-section\`, \`data-product-card\` → Deco storefront classic (Fresh/Preact).
   - Se tem \`data-product-list\`, \`<a aria-label="view product">\`, e Tailwind utility classes
     (\`card w-full card-compact ...\`) → **Deco TanStack** (React port). Patterns conhecidos:
       * product card: \`[data-product-list] a[aria-label='view product']\` ou \`a[href$='/p']\`
       * minicart trigger: \`[aria-label='Sacola']\` (note: nome em português)
       * post-add-to-cart drawer/toast: \`[aria-label='Fechar carrinho']\` ou \`[aria-label='Fechar notificação']\`
       * CTAs ficam lowercase no markup (\`comprar\`, não \`Comprar\`) com text-transform via CSS
   - Caso desconhecido, use heurísticas genéricas.

4. Para "cep_input_pdp" e "cep_input_cart": retorne string vazia se não existir esse recurso na plataforma.
   Não invente.

5. **NUNCA confunda \`minicart_trigger\` (ícone do carrinho no HEADER) com \`checkout_button\`
   (botão "Finalizar" DENTRO do drawer ou na página de cart).** Se você só vê o ícone do
   carrinho na home e não consegue ver o botão de checkout (caso comum — ele só renderiza
   depois de add-to-cart), retorne STRING VAZIA pra \`checkout_button\`. NUNCA retorne o
   mesmo seletor para os dois — isso quebra o fluxo de teste.

6. Para CEP: \`cep_input_pdp\` e \`cep_input_cart\` são pra ENDEREÇO (CEP / Postal Code).
   NÃO confunda com input de CUPOM ('Digite o cupom', 'Insira código', 'Promo code') —
   cupom é desconto, não frete.

7. Sempre teste mentalmente: "este seletor pegaria o elemento certo na home E também em PDPs/cart?"

8. **Search**: \`search_input\` deve apontar pro INPUT de busca (não pra um <a> que vai pra página de busca).
   \`search_trigger\` só faz sentido se o input fica oculto até clicar (mobile). Se o input já está
   visível na header desktop, retorne string vazia em \`search_trigger\`.
   \`search_suggestions\` quase nunca está visível na home (só após digitar); se você não detectar,
   retorne string vazia — NUNCA chute.

9. **PDP gallery / related**: você está vendo a HOME, então NÃO consegue ver thumbnails de PDP nem
   shelf de "Related Products". Só preencha esses 3 campos se você reconhecer a plataforma e tiver
   alta confiança no padrão (ex: VTEX usa \`.vtex-store-components-3-x-productImageTag--main\`).
   Caso contrário, deixe string vazia — defaults cuidam disso.

10. **Login**: \`login_trigger\` é o link "Entrar" / "Login" / ícone de pessoa na header (anônimo).
    \`account_menu_trigger\` é o que aparece QUANDO LOGADO ("Olá, João", avatar) — provavelmente
    NÃO está na home anônima. Se você só vê "Login", retorne string vazia para \`account_menu_trigger\`.

Responda SEMPRE via tool_use report_selectors. Não escreva texto livre fora da tool call.
`.trim();

export interface DiscoverOptions {
  /** Skip cache and always hit the LLM */
  noCache?: boolean;
  /** Override cache directory */
  cacheDir?: string;
}

export async function discoverSelectorsFromUrl(
  url: string,
  html: string,
  opts: DiscoverOptions = {},
): Promise<DiscoveredSelectors | null> {
  const host = safeHost(url);
  const cacheDir = opts.cacheDir ?? CACHE_DIR;
  const cachePath = join(cacheDir, `selectors-${host}.json`);
  const fingerprint = computeHtmlFingerprint(html);

  if (!opts.noCache && existsSync(cachePath)) {
    const cached = readCacheEntry(cachePath, fingerprint);
    if (cached) return cached.selectors;
  }

  const compacted = compactHtmlForSelectors(html);
  const input = await callTool<Record<string, string>>({
    feature: "selector-discovery",
    systemPrompt: SYSTEM_PROMPT,
    userText: `URL: ${url}\n\nHTML compactado da home:\n\`\`\`html\n${compacted}\n\`\`\``,
    maxTokens: 1500,
    tool: {
      name: DISCOVER_SELECTORS_TOOL.name,
      description: DISCOVER_SELECTORS_TOOL.description,
      inputSchema: DISCOVER_SELECTORS_TOOL.input_schema as unknown as Record<string, unknown>,
    },
  });
  if (!input) return null;
  const selectors: DiscoveredSelectors = {
    categoryLink: emptyToUndef(input.category_link),
    productCard: emptyToUndef(input.product_card),
    buyButton: emptyToUndef(input.buy_button),
    minicartTrigger: emptyToUndef(input.minicart_trigger),
    cepInputPdp: emptyToUndef(input.cep_input_pdp),
    cepInputCart: emptyToUndef(input.cep_input_cart),
    checkoutButton: emptyToUndef(input.checkout_button),
    searchTrigger: emptyToUndef(input.search_trigger),
    searchInput: emptyToUndef(input.search_input),
    searchSuggestions: emptyToUndef(input.search_suggestions),
    pdpGalleryThumbnail: emptyToUndef(input.pdp_gallery_thumbnail),
    pdpGalleryMain: emptyToUndef(input.pdp_gallery_main),
    pdpRelatedShelf: emptyToUndef(input.pdp_related_shelf),
    loginTrigger: emptyToUndef(input.login_trigger),
    accountMenuTrigger: emptyToUndef(input.account_menu_trigger),
  };
  // Sanity: the LLM commonly confuses the header cart icon with the
  // checkout button. If it returned the SAME selector (or a prefix match)
  // for both, drop checkoutButton — the cascade will fall back to defaults
  // / learned / LLM recovery at step 9 instead of clicking the cart icon
  // and going nowhere.
  if (
    selectors.checkoutButton &&
    selectors.minicartTrigger &&
    selectorsLikelyConflict(selectors.checkoutButton, selectors.minicartTrigger)
  ) {
    console.warn(
      `[discover-selectors] checkout_button == minicart_trigger (\`${selectors.checkoutButton}\`); dropping to avoid step-9 misclick`,
    );
    selectors.checkoutButton = undefined;
  }
  if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
  const entry: SelectorCacheEntry = {
    schemaVersion: CACHE_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    htmlFingerprint: fingerprint,
    selectors,
  };
  writeFileSync(cachePath, `${JSON.stringify(entry, null, 2)}\n`, "utf8");
  return selectors;
}

function cacheTtlMs(): number {
  const days = Number(process.env.PARITY_SELECTOR_CACHE_TTL_DAYS ?? DEFAULT_TTL_DAYS);
  return (Number.isFinite(days) && days > 0 ? days : DEFAULT_TTL_DAYS) * 24 * 60 * 60 * 1000;
}

/**
 * Load + validate a cache entry, applying every invalidation rule. Returns
 * null on any miss; a corrupt/legacy file is deleted so the next write
 * starts clean instead of silently short-circuiting discovery forever.
 */
function readCacheEntry(cachePath: string, currentFingerprint: string): SelectorCacheEntry | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(cachePath, "utf8"));
  } catch {
    console.warn(`[discover-selectors] cache corrompido em ${cachePath}; redescubrindo`);
    try {
      unlinkSync(cachePath);
    } catch {
      /* best-effort */
    }
    return null;
  }
  const result = SelectorCacheEntrySchema.safeParse(parsed);
  if (!result.success || result.data.schemaVersion !== CACHE_SCHEMA_VERSION) {
    // Legacy format (raw DiscoveredSelectors) or version bump — re-discover.
    console.warn(`[discover-selectors] cache em formato antigo em ${cachePath}; redescubrindo`);
    try {
      unlinkSync(cachePath);
    } catch {
      /* best-effort */
    }
    return null;
  }
  const entry = result.data;
  const age = Date.now() - Date.parse(entry.createdAt);
  if (!Number.isFinite(age) || age > cacheTtlMs()) return null; // TTL expired
  if (entry.htmlFingerprint !== currentFingerprint) return null; // site structure changed
  return entry;
}

/**
 * Merge discovered selectors into an rc-style selectors map. EVERY
 * discovered key lands unless the user's .parityrc.json already sets it —
 * user overrides always win. Mutates and returns `target`.
 *
 * Extracted because run.ts and journey.ts each hand-merged only 7 of the
 * discovered keys (silently discarding search/pdpGallery/login keys), and
 * journey.ts additionally REPLACED the map, dropping unrelated user keys.
 */
export function mergeDiscoveredSelectors<
  T extends Partial<Record<keyof DiscoveredSelectors, string>>,
>(target: T, discovered: DiscoveredSelectors): T {
  for (const key of Object.keys(discovered) as (keyof DiscoveredSelectors)[]) {
    if (discovered[key] && target[key] === undefined) {
      target[key] = discovered[key] as T[keyof DiscoveredSelectors];
    }
  }
  return target;
}

/**
 * Two selectors "likely conflict" when they're identical, or when one is
 * a literal substring of the other (typical LLM mistake: returns the same
 * anchor with an extra attribute for one key and without for the other).
 */
function selectorsLikelyConflict(a: string, b: string): boolean {
  if (a === b) return true;
  const norm = (s: string) => s.replace(/\s+/g, "").toLowerCase();
  const na = norm(a);
  const nb = norm(b);
  return na.includes(nb) || nb.includes(na);
}

function emptyToUndef(v: string | undefined): string | undefined {
  if (v == null) return undefined;
  const trimmed = v.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/[^a-z0-9.-]/gi, "_");
  } catch {
    return url.replace(/[^a-z0-9.-]/gi, "_").slice(0, 60);
  }
}
