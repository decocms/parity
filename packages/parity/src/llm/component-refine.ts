import type { Page } from "playwright";
import type { DetectedComponent } from "../types/extract.ts";
import { callTool, isLlmAvailable } from "./client.ts";
import { compactHtmlForSelectors } from "./html-compact.ts";

/**
 * Optional LLM refinement pass for `detectComponents` (M5 `parity extract`).
 *
 * v1 scope: RELABELING only. Given the heuristic candidates (role guess +
 * selector + bounding box) and a compacted view of the page HTML, ask the
 * model to propose a better `role` name per selector (e.g. turn a generic
 * "section-flash-sale-banner" into "promo-banner", or "shelf" into
 * "shelf-related-products" when the surrounding HTML makes the distinction
 * obvious). Selectors and bounding boxes are NOT touched — the model can't
 * invent components that weren't geometrically detected, and can't merge
 * or split boxes. That's a documented v1 limitation (see docs/extract.md):
 * a real merge/split pass would need the model to reason about geometry,
 * which is a bigger prompt-engineering lift than the M5 time budget covers.
 *
 * Returns `null` on ANY failure (no provider configured, call error,
 * malformed response) — callers must treat that as "keep the heuristic
 * list unchanged", never as a hard failure. `detectComponents` already
 * gates the call behind `opts.llm && isComponentDetectionLlmAvailable()`,
 * so `page` is only used here to no-op-safely re-derive nothing extra.
 */

const RELABEL_TOOL = {
  name: "relabel_components",
  description:
    "Return a refined `role` label for each candidate component selector. Do NOT invent new selectors or drop/add entries — one role per input selector, same order.",
  inputSchema: {
    type: "object" as const,
    properties: {
      labels: {
        type: "array",
        description: "One entry per input candidate, in the same order.",
        items: {
          type: "object",
          properties: {
            selector: { type: "string" },
            role: {
              type: "string",
              description:
                "Refined kebab-case role name, e.g. 'header', 'footer', 'hero-banner', 'shelf-related-products', 'minicart'.",
            },
          },
          required: ["selector", "role"],
        },
      },
    },
    required: ["labels"],
  },
};

const SYSTEM_PROMPT = `
You are helping build an AI-ready component inventory for a from-scratch
e-commerce storefront migration (no source code access). You're given a
list of components a heuristic pass already detected on a page (semantic
tags, data attributes, geometry) with a rough role guess, plus a compacted
view of the page HTML.

Your ONLY job: propose a clearer, more specific "role" label per
component, using the surrounding HTML for context (e.g. distinguish a
"related products" shelf from a "recently viewed" shelf, or a cookie
banner from a hero banner). Keep names short, kebab-case, no punctuation
besides hyphens. Return exactly one label per input selector, in the same
order — never add, remove, merge, or split entries.
`.trim();

export function isComponentRefineLlmAvailable(): boolean {
  return isLlmAvailable();
}

export async function refineComponentsWithLlm(
  page: Page,
  candidates: DetectedComponent[],
): Promise<DetectedComponent[] | null> {
  if (candidates.length === 0) return null;
  if (!isLlmAvailable()) return null;

  let html: string;
  try {
    html = await page.content();
  } catch {
    return null;
  }
  const compacted = compactHtmlForSelectors(html, 20_000);

  const userText = [
    "## Candidates",
    "",
    "```json",
    JSON.stringify(
      candidates.map((c) => ({ selector: c.selector, role: c.role })),
      null,
      2,
    ),
    "```",
    "",
    "## Compacted page HTML",
    "",
    "```html",
    compacted,
    "```",
  ].join("\n");

  const result = await callTool<{ labels?: { selector: string; role: string }[] }>({
    feature: "component-detection",
    systemPrompt: SYSTEM_PROMPT,
    userText,
    maxTokens: 1500,
    tool: {
      name: RELABEL_TOOL.name,
      description: RELABEL_TOOL.description,
      inputSchema: RELABEL_TOOL.inputSchema as unknown as Record<string, unknown>,
    },
  });

  if (!result?.labels || !Array.isArray(result.labels)) return null;
  const bySelector = new Map(result.labels.map((l) => [l.selector, l.role]));
  // Defensive: only apply labels for selectors we actually sent — never
  // let a malformed/hallucinated response introduce a component that
  // wasn't geometrically detected.
  return candidates.map((c) => ({
    ...c,
    role: bySelector.get(c.selector) ?? c.role,
  }));
}
