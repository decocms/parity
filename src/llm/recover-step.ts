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
    selector: { type: "string", description: "CSS or Playwright selector that targets the element" },
    action: { type: "string", enum: ["click", "fill", "press"] },
    value: { type: "string", description: "For 'fill' or 'press', the text/key to use" },
    reasoning: { type: "string" },
  },
  required: ["selector", "action"],
} as const;

/**
 * Compact HTML to just interactive elements for the recovery prompt.
 * Drops scripts/styles/SVG; keeps forms, buttons, links and inputs.
 */
export function compactHtmlForRecovery(html: string, maxChars = 12_000): string {
  try {
    const $ = cheerio.load(html);
    $("script, style, noscript, svg, picture source, link, meta").remove();
    // Keep only elements likely to be interactive or contain them
    const allowed = $("header, nav, main, footer, dialog, [role='dialog'], form, button, a, input, [data-buy-button], [data-checkout], [data-minicart], [role='button']")
      .map((_, el) => $.html(el))
      .get()
      .join("\n");
    const truncated = allowed.length > maxChars ? `${allowed.slice(0, maxChars)}\n<!-- TRUNCATED -->` : allowed;
    return truncated;
  } catch {
    return html.slice(0, maxChars);
  }
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

4. **Seletores preferidos** (nesta ordem):
   - Text-based Playwright: \`button:has-text('Finalizar')\`, \`a:has-text('Continuar para pagamento')\`
   - data-attributes específicos: \`[data-checkout-button]\`, \`[data-cart-finalize]\`, \`[data-fs-cart-button]\`
   - ARIA: \`[aria-label*='finalizar' i]\`, \`[role='button'][aria-label*='checkout' i]\`
   - Classes específicas de plataforma: \`.vtex-minicart-2-x-checkoutButton\`, \`.fs-cart__checkout\`
   - Por último, escopo hierárquico curto: \`[role='dialog'] button.cta\`, \`.minicart-drawer button[type='submit']\`

5. **EVITE:**
   - IDs hash-gerados (\`#r-abc123\`)
   - Tailwind utility classes encadeadas (\`.flex.items-center.bg-blue\`)
   - Seletores genéricos sem qualificador (\`a[href*=...]\`, \`button[type=submit]\` sozinho)
   - Seletores que casam o ELEMENTO ERRADO em outra parte do DOM (ex: link de "checkout your reviews" no footer)
   - Seletores muito profundos (>4 níveis hierárquicos)

6. **Quando incerto, retorne selector="" (string vazia).** É preferível que o flow declare a falha honestamente a chutar um seletor errado que apenas clica em coisa aleatória.

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
