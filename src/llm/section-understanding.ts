import { readFileSync } from "node:fs";
import { callTool, isLlmAvailable } from "./client.ts";

/**
 * "What did the LLM understand?" diagnostic for the section diff bundle.
 *
 * Given the opinionated Markdown prompt produced by
 * `assembleSectionDiffBundle()` plus the screenshots referenced inside
 * it, this calls Claude (Vision) and asks for ONE paragraph confirming
 * the diagnosis: where the diff is, which property is responsible,
 * which file to edit. We deliberately do NOT ask for a patch — that's
 * a follow-up turn the user runs manually after sanity-checking the
 * summary.
 *
 * Returns the summary text on success, or `null` when no LLM provider
 * is configured / the call failed. Callers should treat `null` as
 * "skip silently", not as an error.
 */

const SUMMARIZE_TOOL = {
  name: "summarize_understanding",
  description:
    "Return a single paragraph describing what you understood from the section diff signals. NO code — only diagnosis.",
  inputSchema: {
    type: "object" as const,
    properties: {
      summary: {
        type: "string",
        description:
          "ONE paragraph (4-6 sentences). Cover: (a) the most visible visual difference, (b) the CSS property most likely responsible, (c) which file/component the user should probably edit. Be concrete — name the property, name the file. NO code blocks. NO patches.",
      },
    },
    required: ["summary"],
  },
};

const SYSTEM_PROMPT = `
You are a senior frontend engineer reviewing a migrated e-commerce page
(Fresh → TanStack Start). The user shows you a Markdown bundle with
production vs candidate signals for ONE section: heatmap, screenshots,
computed-style deltas, and an HTML diff.

Your ONLY job in this turn is to confirm what you understood. Do NOT
write code. Do NOT propose a patch. The user will explicitly ask for
the patch in a follow-up turn after they sanity-check your reading.

Format: ONE paragraph. Be concrete about which property/rule is the
likely culprit and which file/component the user should edit. If the
signals don't agree (e.g. heatmap says diff but computed-styles match),
say so — that's a useful diagnosis too.
`.trim();

export interface UnderstandingInput {
  /** Path to the opinionated markdown file produced by section-bundle. */
  markdownPath: string;
  /** Optional screenshot paths to attach to Vision. */
  prodScreenshotPath?: string;
  candScreenshotPath?: string;
  heatmapPath?: string;
}

export interface UnderstandingResult {
  summary: string;
}

export function isUnderstandingAvailable(): boolean {
  return isLlmAvailable();
}

export async function invokeUnderstandingSummary(
  input: UnderstandingInput,
): Promise<UnderstandingResult | null> {
  if (!isLlmAvailable()) return null;
  let markdown: string;
  try {
    markdown = readFileSync(input.markdownPath, "utf8");
  } catch (err) {
    console.error(
      `[section-understanding] failed to read markdown: ${(err as Error).message}`,
    );
    return null;
  }

  const images: { base64: string; mediaType: "image/png" }[] = [];
  for (const p of [input.prodScreenshotPath, input.candScreenshotPath, input.heatmapPath]) {
    if (!p) continue;
    try {
      const buf = readFileSync(p);
      images.push({ base64: buf.toString("base64"), mediaType: "image/png" });
    } catch (err) {
      console.error(
        `[section-understanding] skipping image ${p}: ${(err as Error).message}`,
      );
    }
  }

  const result = await callTool<{ summary?: string }>({
    feature: "section-understanding",
    systemPrompt: SYSTEM_PROMPT,
    userText: markdown,
    userImages: images,
    maxTokens: 600,
    tool: {
      name: SUMMARIZE_TOOL.name,
      description: SUMMARIZE_TOOL.description,
      inputSchema: SUMMARIZE_TOOL.inputSchema as unknown as Record<string, unknown>,
    },
  });
  if (!result?.summary) return null;
  return { summary: result.summary.trim() };
}
