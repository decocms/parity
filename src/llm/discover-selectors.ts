import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as cheerio from "cheerio";
import { LLM_MODEL, getLlmClient } from "./client.ts";

const CACHE_DIR = ".parity-cache";

export interface DiscoveredSelectors {
  categoryLink?: string;
  productCard?: string;
  buyButton?: string;
  minicartTrigger?: string;
  cepInputPdp?: string;
  cepInputCart?: string;
  checkoutButton?: string;
}

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
          "CSS selector for the element that opens the mini-cart drawer/popup (e.g. '[data-minicart-trigger]', or a header cart icon).",
      },
      cep_input_pdp: {
        type: "string",
        description:
          "CSS selector for the CEP / zipcode <input> on a PDP. Empty string if the PDP has no shipping calculator.",
      },
      cep_input_cart: {
        type: "string",
        description:
          "CSS selector for the CEP / zipcode <input> inside the mini-cart/cart drawer. Empty string if cart has no shipping calculator.",
      },
      checkout_button: {
        type: "string",
        description:
          "CSS selector for the 'Go to checkout' / 'Finalizar compra' button inside the mini-cart/cart (e.g. \"a:has-text('Finalizar compra')\").",
      },
      reasoning: {
        type: "string",
        description: "1-2 sentence rationale describing what was inferred from the markup.",
      },
    },
    required: ["category_link", "product_card", "buy_button", "minicart_trigger", "checkout_button"],
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
   - Se tem \`data-deco\`, \`data-section\`, \`data-product-card\` → Deco storefront (variantes custom).
   - Caso desconhecido, use heurísticas genéricas.

4. Para "cep_input_pdp" e "cep_input_cart": retorne string vazia se não existir esse recurso na plataforma.
   Não invente.

5. Sempre teste mentalmente: "este seletor pegaria o elemento certo na home E também em PDPs/cart?"

Responda SEMPRE via tool_use report_selectors. Não escreva texto livre fora da tool call.
`.trim();

/**
 * Reduce HTML to the chunks the LLM actually needs to infer selectors,
 * to fit comfortably in a Sonnet context.
 */
export function compactHtmlForSelectors(html: string, maxChars = 30_000): string {
  try {
    const $ = cheerio.load(html);
    // Drop irrelevant heavy parts
    $("script, style, noscript, svg, picture source, link[rel='stylesheet']").remove();
    $("[type='application/ld+json']").remove();

    const sections: string[] = [];

    // Always include the head meta (helps detect platform)
    const head = $("head").clone();
    head.find("title, meta[name='generator'], meta[name='vtex'], meta[name='platform'], link[rel='canonical']").each(
      (_, el) => {
        sections.push($.html(el)!);
      },
    );

    // Header + nav
    $("header, nav, [role='banner']").each((_, el) => {
      sections.push($.html(el)!);
    });

    // First "shelf"/product list-like region
    const shelf = $("[data-product-card], [data-deco='view-product'], article a[href*='/p/'], article a[href*='/products/']")
      .closest("section, ul, div")
      .first();
    if (shelf.length > 0) sections.push($.html(shelf)!);

    // Forms (search, newsletter, login) — may contain useful affordances
    $("form").each((_, el) => {
      sections.push($.html(el)!);
    });

    // Footer for completeness
    const footer = $("footer").first();
    if (footer.length > 0) sections.push($.html(footer)!);

    const joined = sections.join("\n<!-- ── section break ── -->\n");
    if (joined.length <= maxChars) return joined;
    return `${joined.slice(0, maxChars)}\n<!-- TRUNCATED -->`;
  } catch {
    return html.slice(0, maxChars);
  }
}

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

  if (!opts.noCache && existsSync(cachePath)) {
    try {
      const cached = JSON.parse(readFileSync(cachePath, "utf8")) as DiscoveredSelectors;
      return cached;
    } catch {
      /* ignore corrupt cache */
    }
  }

  const client = getLlmClient();
  if (!client) return null;

  const compacted = compactHtmlForSelectors(html);

  try {
    const response = await client.messages.create({
      model: LLM_MODEL,
      max_tokens: 1500,
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      tools: [DISCOVER_SELECTORS_TOOL],
      tool_choice: { type: "tool", name: "report_selectors" },
      messages: [
        {
          role: "user",
          content: `URL: ${url}\n\nHTML compactado da home:\n\`\`\`html\n${compacted}\n\`\`\``,
        },
      ],
    });

    for (const block of response.content) {
      if (block.type === "tool_use" && block.name === "report_selectors") {
        const input = block.input as Record<string, string>;
        const selectors: DiscoveredSelectors = {
          categoryLink: emptyToUndef(input.category_link),
          productCard: emptyToUndef(input.product_card),
          buyButton: emptyToUndef(input.buy_button),
          minicartTrigger: emptyToUndef(input.minicart_trigger),
          cepInputPdp: emptyToUndef(input.cep_input_pdp),
          cepInputCart: emptyToUndef(input.cep_input_cart),
          checkoutButton: emptyToUndef(input.checkout_button),
        };
        // Persist cache
        if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
        writeFileSync(cachePath, `${JSON.stringify(selectors, null, 2)}\n`, "utf8");
        return selectors;
      }
    }
  } catch (err) {
    console.error(`[llm-discover] failed: ${(err as Error).message}`);
  }
  return null;
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
