import { relative } from "node:path";
import type { Run, Severity, VisualDiffPage, VisualDifference } from "../types/schema.ts";

const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

const SEVERITY_EMOJI: Record<Severity, string> = {
  critical: "🔴",
  high: "🟠",
  medium: "🟡",
  low: "⚪",
};

export interface BuildVisualPromptOptions {
  /** Only include pages at or above this severity. Default: "low" (all with any diff). */
  minSeverity?: Severity;
  /** Include pages that fully passed (no diffs). Default: false. */
  includePassed?: boolean;
}

function relPath(runDir: string, absPath: string | undefined): string {
  if (!absPath) return "";
  try {
    return relative(runDir, absPath);
  } catch {
    return absPath;
  }
}

function pageMaxSeverity(page: VisualDiffPage): Severity | null {
  if (page.differences.length === 0 && page.sectionsOnlyInProd.length === 0) return null;
  if (page.sectionsOnlyInProd.length > 0) {
    // missing sections are treated as at least "high"
    const maxFromDiffs = page.differences.length > 0 ? minByOrder(page.differences.map((d) => d.severity)) : "high";
    return SEVERITY_ORDER[maxFromDiffs] < SEVERITY_ORDER.high ? maxFromDiffs : "high";
  }
  return minByOrder(page.differences.map((d) => d.severity));
}

function minByOrder(sevs: Severity[]): Severity {
  let best: Severity = "low";
  for (const s of sevs) {
    if (SEVERITY_ORDER[s] < SEVERITY_ORDER[best]) best = s;
  }
  return best;
}

export function buildVisualPrompt(
  run: Run,
  runDir: string,
  opts: BuildVisualPromptOptions = {},
): string {
  const minSev = opts.minSeverity ?? "low";
  const includePassed = opts.includePassed ?? false;
  const summary = run.visualDiff;

  const sections: string[] = [];
  sections.push(buildHeader(run, summary));

  if (!summary || summary.results.length === 0) {
    sections.push(
      "_Nenhuma comparação visual rodou neste run (visual-pages=0 ou erro no capture)._",
    );
    return sections.join("\n");
  }

  const pages = summary.results
    .filter((p) => {
      if (includePassed) return true;
      const sev = pageMaxSeverity(p);
      if (!sev) return false;
      return SEVERITY_ORDER[sev] <= SEVERITY_ORDER[minSev];
    })
    .sort((a, b) => {
      const sa = pageMaxSeverity(a);
      const sb = pageMaxSeverity(b);
      const va = sa ? SEVERITY_ORDER[sa] : 99;
      const vb = sb ? SEVERITY_ORDER[sb] : 99;
      return va - vb;
    });

  if (pages.length === 0) {
    sections.push("_Todas as páginas comparadas passaram (sem diferenças relevantes)._");
    return sections.join("\n");
  }

  sections.push(
    "",
    `## Páginas com diferenças (${pages.length}/${summary.pagesChecked})`,
    "",
  );

  for (const [idx, page] of pages.entries()) {
    sections.push(renderPageBlock(idx + 1, page, runDir));
  }

  sections.push(buildInstructions());
  return sections.join("\n");
}

function buildHeader(
  run: Run,
  summary: Run["visualDiff"],
): string {
  const lines: string[] = [];
  lines.push(
    `# Visual Diff Report — ${run.id}`,
    "",
    "You are reviewing **visual differences** between two versions of an e-commerce site, detected by comparing full-page screenshots:",
    "",
    `- **prod (source of truth, Fresh/Preact):** ${run.prodUrl}`,
    `- **cand (migrated, TanStack/React):** ${run.candUrl}`,
    "",
    "Prod is always correct. Every visual difference in cand is a regression that must be diagnosed and fixed, unless explicitly intentional in the migration.",
    "",
  );
  if (summary) {
    lines.push(
      `## Sumário`,
      "",
      `- **Páginas comparadas:** ${summary.pagesChecked}`,
      `- **Com diferenças:** ${summary.pagesWithDiffs}`,
      `- **OK:** ${summary.pagesPassed}`,
      `- **Falha de análise:** ${summary.pagesFailed}`,
      `- **Chamadas LLM Vision:** ${summary.llmCallsUsed}`,
      "",
    );
  }
  return lines.join("\n");
}

function renderPageBlock(idx: number, page: VisualDiffPage, runDir: string): string {
  const lines: string[] = [];
  const maxSev = pageMaxSeverity(page);
  const emoji = maxSev ? SEVERITY_EMOJI[maxSev] : "✅";
  const sevLabel = maxSev ? maxSev.toUpperCase() : "OK";
  const diffsCount = page.differences.length;
  const missingSecs = page.sectionsOnlyInProd.length;

  lines.push(
    "---",
    "",
    `### ${idx}. ${emoji} ${page.pageLabel} [${sevLabel} · ${diffsCount} diff(s)${missingSecs ? ` · ${missingSecs} section(s) ausente(s)` : ""}]`,
    "",
    `- **Path:** \`${page.pagePath}\``,
    `- **Viewport:** \`${page.viewport}\``,
    `- **Pixel diff:** ${(page.pctDiff * 100).toFixed(2)}%`,
    `- **prod URL:** ${page.prodUrl}`,
    `- **cand URL:** ${page.candUrl}`,
    "",
    "**Screenshots:**",
    `- prod: \`${relPath(runDir, page.prodScreenshotPath)}\``,
    `- cand: \`${relPath(runDir, page.candScreenshotPath)}\``,
  );
  if (page.heatmapPath) {
    lines.push(`- heatmap (pixelmatch): \`${relPath(runDir, page.heatmapPath)}\``);
  }

  if (page.sectionsOnlyInProd.length > 0) {
    lines.push(
      "",
      "**Sections detectadas no DOM de prod e AUSENTES em cand (provavelmente faltam migrar):**",
      ...page.sectionsOnlyInProd.map((s) => `- \`${s}\``),
    );
  }

  if (page.sectionsOnlyInCand.length > 0) {
    lines.push(
      "",
      "**Sections só em cand (sections novas/extras, suspeitas):**",
      ...page.sectionsOnlyInCand.map((s) => `- \`${s}\``),
    );
  }

  if (page.differences.length > 0) {
    lines.push("", "**Diferenças visuais identificadas pelo LLM Vision:**", "");
    for (const [i, d] of page.differences.entries()) {
      lines.push(`${i + 1}. ${SEVERITY_EMOJI[d.severity]} [${d.region} · ${d.type} · ${d.severity}] ${d.description}`);
    }
  }

  if (page.llmError) {
    lines.push("", `> ⚠️ LLM Vision retornou erro: ${page.llmError}`);
  }

  lines.push("");
  return lines.join("\n");
}

function buildInstructions(): string {
  return `
---

## What I need from you

For each page above, in order of severity:

1. **Diagnose** the most likely root cause specific to a Fresh → TanStack Start migration of a Deco storefront. Common patterns:
   - **Section ausente em cand** → não registrada em \`registerSections()\` em \`src/setup.ts\`, ou o CMS resolve a key mas não acha o componente
   - **Section com layout diferente** → loader retorna shape diferente (\`@decocms/apps-start\` vs \`deco-cx/apps\`), props recebidas via JSDoc mudaram, ou \`useDevice()\` hidrata diferente
   - **Imagem ausente / sem srcset** → image helper drift (perdeu \`preload\`, perdeu \`Picture\` ou usa \`<img>\` direto), CDN URL mudou
   - **Texto/CTA diferente** → CMS draft vs published, ou copy hardcoded em código novo
   - **Cor/estilo diferente** → CSS tokens não foram portados, Tailwind config drift, ou seletor mais específico em cand sobrescrevendo
   - **Hero/banner errado** → loader VTEX/Shopify retornando dados diferentes, cookies (geo, cohort) não propagando, ou cache stale
   - **Layout shift / hidratação** → \`useDevice\` divergente entre SSR e client, ou \`<Suspense>\` sem fallback adequado

2. **Propose concrete fix** — arquivo + mudança específica + por que. Se duas alternativas plausíveis, lista as duas.

3. **Group** páginas que provavelmente compartilham a mesma causa raiz (ex.: shelf quebrada em home E PLP → loader compartilhado, fix consolidado).

4. **Rank** execution order:
   - Qual fix desbloqueia mais páginas (impacto)?
   - Qual é mais barato implementar?
   - Qual depende de migração ainda não feita (precisa portar primeiro)?

Sem preâmbulo. Se faltar contexto (código fonte de uma section, HAR, output de loader), peça com path específico e eu busco.

Importante: **só sugira mudanças em cand**. Prod é fonte da verdade — nunca pedimos pra alterar prod.
`;
}
