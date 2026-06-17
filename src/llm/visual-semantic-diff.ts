import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
import type { VisualDifference, VisualDifferenceType, VisualRegion } from "../types/schema.ts";
import { callTool } from "./client.ts";

/** Max height to send to Vision. Trades cost for catching below-the-fold diffs (footer, lower shelves). */
const MAX_HEIGHT = 8000;

/**
 * Cache invalidation key. Bump whenever the prompt or tool schema changes —
 * cached verdicts under a different version are ignored so stale judgments
 * don't outlive prompt iterations.
 */
export const LLM_PROMPT_VERSION = "v3-skeleton";

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
(Fresh → TanStack Start). Recebe DUAS ou TRÊS imagens:

1ª imagem = prod (Fresh, fonte da verdade)
2ª imagem = cand (TanStack, candidata recém-migrada)
3ª imagem (quando presente) = heatmap pixelmatch:
  - Pixels VERMELHOS indicam onde prod e cand divergem pixel-a-pixel.
  - Use o heatmap como MAPA pra orientar onde olhar — mas julgue SEMANTICAMENTE
    olhando 1ª e 2ª. Vermelho num carrossel rotacionando é ruído; vermelho
    cobrindo metade da página geralmente é página renderizando rota errada.

Sua tarefa: identificar diferenças SEMÂNTICAS que importam pra qualidade do
site migrado. Você responde APENAS via tool_use report_visual_differences.

CONSIDERE COMO DIFERENÇA REAL:
- Section presente em prod mas ausente em cand (ou vice-versa)
- Componente claramente diferente: header com layout outro, hero com banner errado, shelf de produtos com card design diverso
- Conteúdo textual diferente: títulos, CTAs, mensagens de erro
- Imagens diferentes ou faltando (hero, logo, banners de categoria)
- Layout shift significativo (elementos em posição muito diferente)
- Estilo (cor, tipografia) substancialmente diferente que muda a percepção
- **Página rota-errada**: se um lado mostra uma página (ex: login, /account, PDP)
  e o outro lado mostra conteúdo TOTALMENTE diferente (ex: home, PLP, 404),
  reporte como \`missing-component\` com severity \`critical\`. O candidato
  provavelmente está renderizando a rota errada — isso é o pior bug possível
  pra uma migração.

IGNORE COMO RUÍDO (não reporte):
- Anti-aliasing e diferenças sub-pixel
- Ordem de banners rotativos / carrosséis em estados diferentes
- Tooltips visíveis em apenas um lado
- Ads injetados por extensões
- Hora/data dinâmicas (timestamp, countdown)
- Stock counters / preços com pequena variação dinâmica
- Pixel-level rendering quirks

REGRA DE SKELETON / LOADING (timing — não regressão):
- Skeletons / shimmers / placeholders cinzas com padrão de "card vazio" indicam
  que o lado em questão ainda estava buscando dados quando a screenshot foi
  tirada. Se UM lado mostra skeletons e o OUTRO lado mostra o componente real
  carregado pra o MESMO slot (mesma região, mesmo tipo de componente), isso é
  timing-noise, NÃO regressão.
- Nesses casos a severidade deve ser \`low\` no máximo. Nunca \`critical\` ou
  \`high\`. Indique no \`description\` algo como "skeleton-vs-loaded — pode ser
  timing" pra o leitor humano não perder tempo.
- Exceção: se um lado mostra a região INTEIRA em skeleton infinito (sem
  componente nem placeholder) enquanto o outro tem o conteúdo completo, isso
  pode ser um bug real de fetch — aí severity \`medium\`.

REGRA DE MODAL/POPUP (importante — não confundir com rota-errada):
- Modal/popup visível em SÓ um lado é ruído APENAS se o conteúdo de fundo dos
  dois lados é o mesmo (ex: cookie banner em prod, sem cookie banner em cand,
  mas ambos mostram a home).
- Se um lado mostra modal/conteúdo X e o outro mostra conteúdo Y completamente
  diferente (ex: prod tem modal de login sobre fundo de login, cand mostra a
  home), reporte como \`missing-component\` \`critical\` — é o caso rota-errada.

SEVERIDADE:
- critical: feature inteira faltando (header sumiu, carrinho não existe, busca quebrada visualmente), página renderizando rota errada
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
  /**
   * Optional pixelmatch heatmap PNG. When provided, sent as the 3rd image so
   * the LLM has a literal red-overlay map of where pixels diverge. Helps catch
   * cases where prod and cand look superficially similar (same chrome) but the
   * main content area is rendering an entirely different route.
   */
  heatmapPath?: string;
  /**
   * Raw pctDiff from pixelmatch (0–1). Passed in the user text so the LLM can
   * weight its judgment: a 60%+ pctDiff with no obvious carousel/dynamic-content
   * explanation strongly suggests the candidate is rendering the wrong route.
   */
  pctDiff?: number;
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
  /**
   * Skeleton/loader elements still present in each side's final HTML. When
   * one side has noticeably more skeletons than the other, the LLM should
   * downgrade any "missing-component" diffs in that region — they likely
   * reflect a render race, not a real regression.
   */
  prodSkeletonCount?: number;
  candSkeletonCount?: number;
}

function buildContextBlock(input: VisualDiffInput): string {
  const lines: string[] = [];
  if (typeof input.pctDiff === "number") {
    const pct = (input.pctDiff * 100).toFixed(2);
    lines.push(
      "",
      `**pctDiff bruto do pixelmatch: ${pct}%.** Acima de 30% sem explicação clara (carrossel girando, banner promo alternando, imagens dinâmicas, fontes carregando) é forte indício de página renderizando conteúdo errado — investigue com mais cuidado.`,
    );
  }
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
  const prodSkel = input.prodSkeletonCount ?? 0;
  const candSkel = input.candSkeletonCount ?? 0;
  // Imbalance threshold: a few skeleton elements is normal (e.g. SVG
  // shimmer in a logo); a difference of 5+ between sides strongly suggests
  // one finished its data fetch and the other didn't.
  if (Math.abs(prodSkel - candSkel) >= 5) {
    const heavier = prodSkel > candSkel ? "prod" : "cand";
    const lighter = prodSkel > candSkel ? "cand" : "prod";
    lines.push(
      "",
      `**Desbalanço de skeleton/loaders detectado no DOM**: ${heavier} ainda tem ${Math.max(prodSkel, candSkel)} elementos skeleton enquanto ${lighter} tem ${Math.min(prodSkel, candSkel)}. Isso indica que ${heavier} não terminou o data fetch quando a screenshot foi tirada. Diferenças onde ${heavier} mostra placeholder cinza e ${lighter} mostra o componente carregado são TIMING NOISE — reporte com severity \`low\` no máximo e mencione "skeleton-vs-loaded" no description.`,
    );
  }
  if (input.prodSections && input.prodSections.length > 0) {
    lines.push(
      "",
      `Total sections em prod: ${input.prodSections.length}; em cand: ${input.candSections?.length ?? 0}.`,
    );
  }
  return lines.join("\n");
}

export async function visualSemanticDiff(
  input: VisualDiffInput,
): Promise<VisualDifference[] | null> {
  let prodB64: string;
  let candB64: string;
  let heatmapB64: string | undefined;
  try {
    prodB64 = loadCroppedPngBase64(input.prodPath);
    candB64 = loadCroppedPngBase64(input.candPath);
    if (input.heatmapPath) {
      try {
        heatmapB64 = loadCroppedPngBase64(input.heatmapPath);
      } catch (err) {
        // Heatmap is optional — if it fails to load, drop it and proceed with 2 images.
        console.error(`[llm-visual-diff] heatmap skipped: ${(err as Error).message}`);
      }
    }
  } catch (err) {
    console.error(`[llm-visual-diff] failed to load PNGs: ${(err as Error).message}`);
    return null;
  }

  const context = `${input.pageContext ?? "a página"}${input.viewport ? ` (${input.viewport})` : ""}`;
  const contextBlock = buildContextBlock(input);
  const heatmapHint = heatmapB64
    ? " A 3ª imagem é o heatmap pixelmatch (vermelho = pixels que divergem)."
    : "";
  const userText = `Compare as duas screenshots de ${context}. 1ª = prod (Fresh, fonte da verdade), 2ª = cand (TanStack, migrada).${heatmapHint}${contextBlock}`;
  const userImages: Array<{ base64: string; mediaType: "image/png" }> = [
    { base64: prodB64, mediaType: "image/png" },
    { base64: candB64, mediaType: "image/png" },
  ];
  if (heatmapB64) {
    userImages.push({ base64: heatmapB64, mediaType: "image/png" });
  }
  const result = await callTool<{ differences?: Partial<VisualDifference>[] }>({
    feature: "visual-diff",
    systemPrompt: SYSTEM_PROMPT,
    userText,
    userImages,
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
