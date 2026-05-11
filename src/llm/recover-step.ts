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
export async function suggestRecovery(input: RecoverInput): Promise<RecoverySuggestion | null> {
  const compacted = compactHtmlForRecovery(input.html);
  const inp = await callTool<{
    selector?: string;
    action?: RecoveryAction;
    value?: string;
    reasoning?: string;
  }>({
    systemPrompt:
      "Você ajuda a recuperar passos de teste E2E (Playwright) que falharam. Receba o nome do step, a ação desejada e o HTML atual da página. Sugira UM seletor e ação ('click' | 'fill' | 'press') que provavelmente funciona. Para 'fill', preferir input visível com label relacionada. Para 'click', preferir botão visível com texto/label que case com a intenção. Use Playwright selectors quando apropriado (`button:has-text('X')`, `[role='button']`). Não invente seletores genéricos; baseie no HTML fornecido.",
    userText: `Step: ${input.stepName}\nAção desejada: ${input.intendedAction}\n${input.alreadyTried?.length ? `Já tentei: ${input.alreadyTried.join(", ")}\n` : ""}\nHTML compactado:\n\`\`\`html\n${compacted}\n\`\`\``,
    maxTokens: 400,
    tool: {
      name: "suggest_recovery",
      description: "Suggest a selector and action to recover a failed E2E step",
      inputSchema: RECOVER_STEP_INPUT_SCHEMA,
    },
  });
  if (inp?.selector && inp.action) {
    return {
      selector: inp.selector,
      action: inp.action,
      value: inp.value,
      reasoning: inp.reasoning,
    };
  }
  return null;
}
