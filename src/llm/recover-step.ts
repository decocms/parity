import * as cheerio from "cheerio";
import { callTool } from "./client.ts";

export type RecoveryAction = "click" | "fill" | "press";

export interface RecoverySuggestion {
  selector: string;
  action: RecoveryAction;
  value?: string;
  reasoning?: string;
}

const RECOVER_STEP_INPUT_SCHEMA = {
  type: "object",
  properties: {
    selector: {
      type: "string",
      description: "CSS or Playwright selector that targets the element",
    },
    action: { type: "string", enum: ["click", "fill", "press"] },
    value: { type: "string", description: "For 'fill' or 'press', the text/key to use" },
    reasoning: { type: "string" },
  },
  required: ["selector", "action"],
} as const;

/**
 * Compact HTML to just interactive elements for the recovery prompt.
 * Drops scripts/styles/SVG and strips Tailwind utility-class soup +
 * URL-encoded JSON noise in data-event attrs so the LLM sees the
 * structural cues (data-*, aria-*, role, semantic class names, text)
 * without drowning in `class="w-full h-12 flex items-center ..."`.
 */
export function compactHtmlForRecovery(html: string, maxChars = 12_000): string {
  try {
    const $ = cheerio.load(html);
    $("script, style, noscript, svg, picture source, link, meta").remove();
    // Strip noisy attrs and Tailwind utility classes — same logic as
    // compactHtmlForSelectors. Keeps the prompt focused on semantic
    // attributes (data-*, aria-*, role, name, type, semantic class).
    $("*").each((_, el) => {
      const attrs = (el as { attribs?: Record<string, string> }).attribs ?? {};
      for (const name of Object.keys(attrs)) {
        if (name === "data-event" || name === "data-track" || name === "data-analytics") {
          const value = attrs[name] ?? "";
          if (value.length > 100) attrs[name] = "[…]";
        }
        if (name === "style") delete attrs[name];
      }
      if (attrs.class) {
        const tokens = attrs.class.split(/\s+/).filter(Boolean);
        const kept = tokens.filter((t) => isSemanticClassToken(t));
        const joined = kept.join(" ");
        if (joined) {
          attrs.class = joined;
        } else {
          // biome-ignore lint/performance/noDelete: cheerio attribs need the key gone, not undefined.
          delete attrs.class;
        }
      }
    });
    // Keep only elements likely to be interactive or contain them. Added
    // `[aria-label]` so static text-only elements (like Bagaggio's
    // `[aria-label='Tamanho P - Disponível']` size buttons) survive even
    // when they don't carry a role/button tag explicitly.
    const allowed = $(
      "header, nav, main, footer, dialog, [role='dialog'], form, button, a, input, [data-buy-button], [data-checkout], [data-minicart], [data-product-list], [role='button'], [aria-label]",
    )
      .map((_, el) => $.html(el))
      .get()
      .join("\n");
    const truncated =
      allowed.length > maxChars ? `${allowed.slice(0, maxChars)}\n<!-- TRUNCATED -->` : allowed;
    return truncated;
  } catch {
    return html.slice(0, maxChars);
  }
}

/**
 * Same heuristic as `discover-selectors.ts:isSemanticClass`. Kept inline
 * here to avoid coupling the two files; the rules are simple enough that
 * duplication beats an import cycle.
 */
function isSemanticClassToken(token: string): boolean {
  if (token.length === 0 || token.length > 40) return false;
  if (token.includes(":") || token.includes("[") || token.includes("/")) return false;
  if (/^[a-z]{1,4}(-[a-z]{1,3})?-\d/.test(token)) return false;
  if (/^[a-z]{1,2}\d+$/.test(token)) return false;
  if (
    /^(w|h|p|m|px|py|pt|pb|pl|pr|mt|mb|ml|mr|gap|flex|grid|text|bg|border|rounded|shadow|opacity|cursor|min|max)-/i.test(
      token,
    ) &&
    !/^(text|bg|border)-(primary|secondary|accent|brand|warning|error|success|muted|base|surface)$/i.test(
      token,
    )
  ) {
    return false;
  }
  if (
    /^(flex|grid|block|inline|hidden|relative|absolute|fixed|static|sticky|visible|invisible|truncate|uppercase|lowercase|capitalize|italic|underline|overline|line-through|no-underline|antialiased|subpixel-antialiased|whitespace|break-words|break-all|object-cover|object-contain|object-fill|object-none|object-scale-down|select-none|select-text|select-all|pointer-events-none|pointer-events-auto|appearance-none|resize-none|leading-none|font-bold|font-medium|font-semibold|font-light|tracking-wide|tracking-tight)$/.test(
      token,
    )
  ) {
    return false;
  }
  return true;
}

export interface RecoverInput {
  stepName: string;
  intendedAction: string;
  html: string;
  /** Optional: hint of what selectors were already tried */
  alreadyTried?: string[];
}

/**
 * Ask the LLM to suggest a selector + action to recover the failed step.
 * Returns null when no API key is set or LLM call fails.
 */
const RECOVERY_SYSTEM_PROMPT = `
Você ajuda a recuperar passos de teste E2E (Playwright) que falharam contra sites de e-commerce.

Receba o nome do step, a ação desejada e o HTML compactado da página ATUAL. Sugira UM seletor + ação ('click' | 'fill' | 'press') que provavelmente funciona NESTE HTML específico.

REGRAS CRÍTICAS:

1. **Baseie no HTML fornecido.** Encontre o elemento literal no markup. Confirme mentalmente que o seletor que você vai retornar casa um elemento VISÍVEL no HTML compactado.

2. **Se o step é 'go-checkout' ou 'go-checkout-retry':**
   - O alvo é um BOTÃO/LINK CTA com texto visível contendo "Finalizar", "Finalizar compra", "Continuar", "Continuar para pagamento", "Ir para o checkout", "Checkout", "Concluir", "Pagar", "Ir para o pagamento", "Avançar", "Próxima etapa".
   - **NUNCA** sugira o ícone genérico de carrinho do HEADER (texto curto "0", "1", badge counter, ou aria-label "Carrinho" sozinho). Esse é o gatilho que ABRE o drawer/cart-page, não o que finaliza compra.
   - **Selectors com href de checkout (\`a[href*="checkout"]\`, \`a[href="/checkout/#/cart?v=1"]\`) PODEM funcionar** mas SOMENTE quando qualificados — ou seja, garanta uma das duas:
     a. Qualificação por **texto**: \`a[href*="checkout"]:has-text('Finalizar')\`, \`a[href*="checkout"]:has-text('Continuar')\`
     b. Qualificação por **scope**: \`[role='dialog'] a[href*="checkout"]\`, \`[class*='minicart' i] a[href*="checkout"]\`, \`.cart-drawer a[href*="checkout"]\`
     Selectors GENÉRICOS sem qualificador (apenas \`a[href*="checkout"]\` sozinho) casam o ícone do header e devem ser EVITADOS.
   - Se NENHUM elemento com texto/scope plausível existe no HTML, retorne selector="" para sinalizar incerteza honestamente.

3. **Se o step é 'shipping-calc-cart' ou 'shipping-calc-pdp':**
   - O alvo é um \`<input>\` (não button/link) visível com label/placeholder mencionando "CEP", "Frete", "Calcular", "Entrega", "Zip".
   - Prefira inputs cujo container/pai está visível (não escondido em accordion fechado).
   - **Pattern Deco TanStack**: \`<input id="postalCodeInput" name="postalCode" inputMode="numeric" maxLength="8" pattern="\\\\d{8}">\`. Selectors válidos: \`input[name='postalCode']\`, \`#postalCodeInput\`, \`input[inputMode='numeric'][maxLength='8']\`.

4. **Se o step é 'enter-pdp' ou 'navigate-plp' e o alvo é um product card:**
   - **Pattern Deco TanStack**: \`<div data-product-list><div class="card"><a aria-label="view product" href="<product-name>/p">...</a></div></div>\`.
   - Selectors válidos: \`[data-product-list] a[aria-label='view product']\`, \`a[aria-label='view product']\`, \`[data-product-list] a[href$='/p']\`.

5. **Se o step é 'select-variant' (tamanho/cor obrigatório no PDP):**
   - **Pattern Deco TanStack**: \`<button aria-label="Tamanho P - Disponível">\` ou \`<button aria-label="Tamanho M - Disponível">\`. Sufixo " - Disponível" = em estoque; "Esgotado" / sem sufixo = indisponível.
   - Selectors válidos: \`[aria-label*='Tamanho '][aria-label*='Disponível']\`, \`button[aria-label*='Tamanho ']:not([disabled])\`.
   - Para cor: \`[aria-label*='Cor '][aria-label*='Disponível']\`.

6. **Se o step é 'add-to-cart' / 'comprar':**
   - **Pattern Deco TanStack**: o markup é \`<button type="button">comprar</button>\` em lowercase (CSS faz uppercase via \`text-transform\`). Use \`button:has-text('comprar')\` ou \`button[type='button']:has-text('comprar')\`.
   - **NUNCA confunda com "comprar junto"** (botão de cross-sell adjacente) — qualifique pelo texto exato ou pelo \`type='submit'\`.

7. **Seletores preferidos** (nesta ordem):
   - Text-based Playwright: \`button:has-text('Finalizar')\`, \`a:has-text('Continuar para pagamento')\`
   - data-attributes específicos: \`[data-checkout-button]\`, \`[data-cart-finalize]\`, \`[data-fs-cart-button]\`, \`[data-product-list]\`
   - ARIA: \`[aria-label*='finalizar' i]\`, \`[role='button'][aria-label*='checkout' i]\`, \`[aria-label='Sacola']\` (Deco TanStack minicart)
   - Classes específicas de plataforma: \`.vtex-minicart-2-x-checkoutButton\`, \`.fs-cart__checkout\`
   - Por último, escopo hierárquico curto: \`[role='dialog'] button.cta\`, \`.minicart-drawer button[type='submit']\`

8. **EVITE:**
   - IDs hash-gerados (\`#r-abc123\`)
   - Tailwind utility classes encadeadas (\`.flex.items-center.bg-blue\`) — o HTML compactado já tirou essas, então se você só vê tokens utility a class foi removida e essa não é uma âncora confiável
   - Seletores genéricos sem qualificador (\`a[href*=...]\`, \`button[type=submit]\` sozinho)
   - Seletores que casam o ELEMENTO ERRADO em outra parte do DOM (ex: link de "checkout your reviews" no footer)
   - Seletores muito profundos (>4 níveis hierárquicos)

9. **Quando incerto, retorne selector="" (string vazia).** É preferível que o flow declare a falha honestamente a chutar um seletor errado que apenas clica em coisa aleatória. Em especial: se a página parece ser uma LANDING PAGE (sem buy form, sem schema:Product, sem preço) e o step pede um buy/variant/cep selector, retorne string vazia — não force uma sugestão.

Responda SEMPRE via tool_use suggest_recovery.
`.trim();

export async function suggestRecovery(input: RecoverInput): Promise<RecoverySuggestion | null> {
  const compacted = compactHtmlForRecovery(input.html);
  const inp = await callTool<{
    selector?: string;
    action?: RecoveryAction;
    value?: string;
    reasoning?: string;
  }>({
    feature: "step-recovery",
    systemPrompt: RECOVERY_SYSTEM_PROMPT,
    userText: `Step: ${input.stepName}\nAção desejada: ${input.intendedAction}\n${input.alreadyTried?.length ? `Já tentei (não repita estes): ${input.alreadyTried.join(", ")}\n` : ""}\nHTML compactado da página NESTE momento:\n\`\`\`html\n${compacted}\n\`\`\``,
    maxTokens: 400,
    tool: {
      name: "suggest_recovery",
      description: "Suggest a selector and action to recover a failed E2E step",
      inputSchema: RECOVER_STEP_INPUT_SCHEMA,
    },
  });
  // Empty selector = LLM explicitly signaled "I don't know" per the prompt.
  if (inp?.selector?.trim() && inp.action) {
    return {
      selector: inp.selector.trim(),
      action: inp.action,
      value: inp.value,
      reasoning: inp.reasoning,
    };
  }
  return null;
}
