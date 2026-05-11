import * as cheerio from "cheerio";
import { LLM_MODEL, getLlmClient } from "./client.ts";

export type RecoveryAction = "click" | "fill" | "press";

export interface RecoverySuggestion {
  selector: string;
  action: RecoveryAction;
  value?: string;
  reasoning?: string;
}

const RECOVER_STEP_TOOL = {
  name: "suggest_recovery",
  description: "Suggest a selector and action to recover a failed E2E step",
  input_schema: {
    type: "object" as const,
    properties: {
      selector: { type: "string", description: "CSS or Playwright selector that targets the element" },
      action: { type: "string", enum: ["click", "fill", "press"] },
      value: { type: "string", description: "For 'fill' or 'press', the text/key to use" },
      reasoning: { type: "string" },
    },
    required: ["selector", "action"],
  },
};

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
  const client = getLlmClient();
  if (!client) return null;
  const compacted = compactHtmlForRecovery(input.html);
  try {
    const response = await client.messages.create({
      model: LLM_MODEL,
      max_tokens: 400,
      system: [
        {
          type: "text",
          text:
            "Você ajuda a recuperar passos de teste E2E (Playwright) que falharam. Receba o nome do step, a ação desejada e o HTML atual da página. Sugira UM seletor e ação ('click' | 'fill' | 'press') que provavelmente funciona. Para 'fill', preferir input visível com label relacionada. Para 'click', preferir botão visível com texto/label que case com a intenção. Use Playwright selectors quando apropriado (`button:has-text('X')`, `[role='button']`). Não invente seletores genéricos; baseie no HTML fornecido.",
          cache_control: { type: "ephemeral" },
        },
      ],
      tools: [RECOVER_STEP_TOOL],
      tool_choice: { type: "tool", name: "suggest_recovery" },
      messages: [
        {
          role: "user",
          content: `Step: ${input.stepName}\nAção desejada: ${input.intendedAction}\n${input.alreadyTried?.length ? `Já tentei: ${input.alreadyTried.join(", ")}\n` : ""}\nHTML compactado:\n\`\`\`html\n${compacted}\n\`\`\``,
        },
      ],
    });
    for (const block of response.content) {
      if (block.type === "tool_use" && block.name === "suggest_recovery") {
        const inp = block.input as {
          selector?: string;
          action?: RecoveryAction;
          value?: string;
          reasoning?: string;
        };
        if (inp.selector && inp.action) {
          return {
            selector: inp.selector,
            action: inp.action,
            value: inp.value,
            reasoning: inp.reasoning,
          };
        }
      }
    }
  } catch (err) {
    console.error(`[llm-recover-step] failed: ${(err as Error).message}`);
  }
  return null;
}
