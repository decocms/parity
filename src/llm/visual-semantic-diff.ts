import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
import type { VisualDifference, VisualDifferenceType, VisualRegion } from "../types/schema.ts";
import { callTool } from "./client.ts";

/** Max height to send to Vision. Trades cost for catching below-the-fold diffs (footer, lower shelves). */
const MAX_HEIGHT = 8000;

export type DifferenceType = VisualDifferenceType;
export type Region = VisualRegion;
export type { VisualDifference };

const REPORT_VISUAL_DIFFS_TOOL = {
  name: "report_visual_differences",
  description: "Report semantic visual differences between prod and cand screenshots.",
  input_schema: {
    type: "object" as const,
    properties: {
      differences: {
        type: "array",
        items: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: [
                "missing-component",
                "different-component",
                "extra-component",
                "layout-shift",
                "text-changed",
                "color-style-diff",
                "image-diff",
                "cosmetic",
              ],
            },
            region: {
              type: "string",
              enum: [
                "header",
                "hero",
                "navigation",
                "main",
                "shelf",
                "footer",
                "sidebar",
                "modal",
                "minicart",
                "other",
              ],
            },
            severity: { type: "string", enum: ["critical", "high", "medium", "low"] },
            description: {
              type: "string",
              description: "1-2 sentences describing WHAT is different and WHY it matters",
            },
          },
          required: ["type", "region", "severity", "description"],
        },
      },
    },
    required: ["differences"],
  },
};

const SYSTEM_PROMPT = `
Você é um QA visual especialista em migrações de sites de e-commerce Deco
(Fresh → TanStack Start). Recebe duas screenshots da MESMA página:

1ª imagem = prod (Fresh, fonte da verdade)
2ª imagem = cand (TanStack, candidata recém-migrada)

Sua tarefa: identificar diferenças SEMÂNTICAS que importam pra qualidade do
site migrado. Você responde APENAS via tool_use report_visual_differences.

CONSIDERE COMO DIFERENÇA REAL:
- Section presente em prod mas ausente em cand (ou vice-versa)
- Componente claramente diferente: header com layout outro, hero com banner errado, shelf de produtos com card design diverso
- Conteúdo textual diferente: títulos, CTAs, mensagens de erro
- Imagens diferentes ou faltando (hero, logo, banners de categoria)
- Layout shift significativo (elementos em posição muito diferente)
- Estilo (cor, tipografia) substancialmente diferente que muda a percepção

IGNORE COMO RUÍDO (não reporte):
- Anti-aliasing e diferenças sub-pixel
- Ordem de banners rotativos / carrosséis em estados diferentes
- Tooltips visíveis em apenas um lado
- Cookies banners / pop-ups consent em estados diferentes
- Ads injetados por extensões
- Hora/data dinâmicas (timestamp, countdown)
- Stock counters / preços com pequena variação dinâmica
- Pixel-level rendering quirks

SEVERIDADE:
- critical: feature inteira faltando (header sumiu, carrinho não existe, busca quebrada visualmente)
- high: section importante diferente ou faltando (hero errado, shelf principal vazio, footer cortado)
- medium: diferença significativa em componente secundário (cor de CTA, espaçamento, imagem trocada)
- low: cosmético menor (alinhamento pequeno, ícone com 2px de diferença)

Se NÃO houver diferenças relevantes (só ruído), retorne differences: []. Não invente.
Cap 8 diferenças por análise — só as que mais importam.
`.trim();

/** Load a PNG file and return a base64-encoded buffer cropped to max height. */
function loadCroppedPngBase64(path: string, maxHeight = MAX_HEIGHT): string {
  const png = PNG.sync.read(readFileSync(path));
  if (png.height <= maxHeight) {
    return PNG.sync.write(png).toString("base64");
  }
  const cropped = new PNG({ width: png.width, height: maxHeight });
  for (let y = 0; y < maxHeight; y++) {
    const srcStart = y * png.width * 4;
    const dstStart = y * png.width * 4;
    png.data.copy(cropped.data, dstStart, srcStart, srcStart + png.width * 4);
  }
  return PNG.sync.write(cropped).toString("base64");
}

export interface VisualDiffInput {
  prodPath: string;
  candPath: string;
  pageContext?: string;
  viewport?: string;
  /** Deco sections detected in prod HTML (data-section attribute). */
  prodSections?: string[];
  /** Deco sections detected in cand HTML. */
  candSections?: string[];
  /** Sections present only in prod (missing in cand) — flagged as priority context. */
  sectionsOnlyInProd?: string[];
  /**
   * Both sides expose a carousel/slider in their section list. When true, the
   * LLM should ignore hero-region content differences that look like
   * "different active slide" — they're timing noise (issue #22).
   */
  bothHaveCarousel?: boolean;
}

function buildContextBlock(input: VisualDiffInput): string {
  const lines: string[] = [];
  if (input.sectionsOnlyInProd && input.sectionsOnlyInProd.length > 0) {
    lines.push(
      "",
      "**Sections detectadas no DOM de prod mas AUSENTES em cand** (provavelmente faltando migrar):",
      ...input.sectionsOnlyInProd.map((s) => `- ${s}`),
      "",
      "Verifique visualmente se essas sections aparecem na 2ª imagem. Se ausentes, reporte como missing-component com severity high ou critical.",
    );
  }
  if (input.bothHaveCarousel) {
    lines.push(
      "",
      "**Ambos os lados expõem um carousel/slider no DOM.** Diferenças no conteúdo do hero (banner diferente, texto diferente, imagem diferente) provavelmente são apenas slides diferentes do mesmo carousel capturados em momentos distintos. NÃO reporte essas diferenças como critical/high. Se o carousel inteiro sumir, ou o layout do hero quebrar, isso sim reporte normalmente.",
    );
  }
  if (input.prodSections && input.prodSections.length > 0) {
    lines.push("", `Total sections em prod: ${input.prodSections.length}; em cand: ${input.candSections?.length ?? 0}.`);
  }
  return lines.join("\n");
}

export async function visualSemanticDiff(
  input: VisualDiffInput,
): Promise<VisualDifference[] | null> {
  let prodB64: string;
  let candB64: string;
  try {
    prodB64 = loadCroppedPngBase64(input.prodPath);
    candB64 = loadCroppedPngBase64(input.candPath);
  } catch (err) {
    console.error(`[llm-visual-diff] failed to load PNGs: ${(err as Error).message}`);
    return null;
  }

  const context = `${input.pageContext ?? "a página"}${input.viewport ? ` (${input.viewport})` : ""}`;
  const contextBlock = buildContextBlock(input);
  const userText = `Compare as duas screenshots de ${context}. 1ª = prod (Fresh, fonte da verdade), 2ª = cand (TanStack, migrada).${contextBlock}`;
  const result = await callTool<{ differences?: Partial<VisualDifference>[] }>({
    systemPrompt: SYSTEM_PROMPT,
    userText,
    userImages: [
      { base64: prodB64, mediaType: "image/png" },
      { base64: candB64, mediaType: "image/png" },
    ],
    maxTokens: 2000,
    tool: {
      name: REPORT_VISUAL_DIFFS_TOOL.name,
      description: REPORT_VISUAL_DIFFS_TOOL.description,
      inputSchema: REPORT_VISUAL_DIFFS_TOOL.input_schema as unknown as Record<string, unknown>,
    },
  });
  if (!result) return null;
  return (result.differences ?? [])
    .filter((d) => d.type && d.region && d.severity && d.description)
    .map(
      (d) =>
        ({
          type: d.type!,
          region: d.region!,
          severity: d.severity!,
          description: d.description!,
        }) as VisualDifference,
    );
}
