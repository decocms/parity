import { LLM_MODEL, getLlmClient } from "./client.ts";

export interface CategoryLinkCandidate {
  text: string;
  href: string;
}

const PATH_BLOCKLIST = [
  "/atendimento",
  "/lojas",
  "/empresa",
  "/sobre",
  "/blog",
  "/vale-presente",
  "/contato",
  "/ajuda",
  "/trabalhe-conosco",
  "/imprensa",
  "/institucional",
  "/privacidade",
  "/termos",
  "/quem-somos",
  "/loja-fisica",
  "/franquia",
];

/**
 * Pick the most likely "real product category" link from a list of header candidates.
 * Deterministic blocklist first; LLM only when ambiguous.
 */
export async function pickCategoryLink(
  candidates: CategoryLinkCandidate[],
): Promise<CategoryLinkCandidate | null> {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0]!;

  // Deterministic pass — drop obviously non-category links
  const filtered = candidates.filter((c) => !isBlocked(c.href));
  if (filtered.length === 0) return candidates[0] ?? null;
  if (filtered.length === 1) return filtered[0]!;

  // Heuristic — prefer URLs with /c/, /category/, /collections/
  const strong = filtered.filter((c) => /\/c\/|\/category\/|\/collections\//.test(c.href));
  if (strong.length === 1) return strong[0]!;
  if (strong.length > 0 && strong.length < filtered.length) {
    // We have strong candidates — try LLM among those
    return (await llmPick(strong)) ?? strong[0]!;
  }

  // LLM among all filtered
  return (await llmPick(filtered)) ?? filtered[0]!;
}

function isBlocked(href: string): boolean {
  try {
    const path = new URL(href, "http://placeholder.invalid").pathname.toLowerCase();
    return PATH_BLOCKLIST.some((b) => path.startsWith(b));
  } catch {
    return false;
  }
}

const PICK_PLP_TOOL = {
  name: "pick_category",
  description: "Pick the index of the best category link",
  input_schema: {
    type: "object" as const,
    properties: {
      index: { type: "number", description: "Index in the input list (0-based)" },
      reasoning: { type: "string", description: "1 sentence rationale" },
    },
    required: ["index"],
  },
};

async function llmPick(
  candidates: CategoryLinkCandidate[],
): Promise<CategoryLinkCandidate | null> {
  const client = getLlmClient();
  if (!client) return null;
  try {
    const response = await client.messages.create({
      model: LLM_MODEL,
      max_tokens: 200,
      system: [
        {
          type: "text",
          text:
            "Você escolhe links de categoria reais em sites de e-commerce. Categoria real = página que lista produtos à venda. Evite: institucional, atendimento, blog, vale-presente, lojas físicas. Prefira URLs com /c/, /category/, /collections/ ou claramente vinculadas a tipos de produto.",
          cache_control: { type: "ephemeral" },
        },
      ],
      tools: [PICK_PLP_TOOL],
      tool_choice: { type: "tool", name: "pick_category" },
      messages: [
        {
          role: "user",
          content: `Candidatos:\n${candidates.map((c, i) => `${i}. "${c.text}" → ${c.href}`).join("\n")}`,
        },
      ],
    });
    for (const block of response.content) {
      if (block.type === "tool_use" && block.name === "pick_category") {
        const idx = (block.input as { index?: number }).index;
        if (typeof idx === "number" && idx >= 0 && idx < candidates.length) {
          return candidates[idx]!;
        }
      }
    }
  } catch (err) {
    console.error(`[llm-pick-plp] failed: ${(err as Error).message}`);
  }
  return null;
}
