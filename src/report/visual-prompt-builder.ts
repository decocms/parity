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
      "_No visual comparison ran in this run (visual-pages=0 or capture error)._",
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
    sections.push("_All compared pages passed (no relevant differences)._");
    return sections.join("\n");
  }

  sections.push(
    "",
    `## Pages with differences (${pages.length}/${summary.pagesChecked})`,
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
      "## Summary",
      "",
      `- **Pages compared:** ${summary.pagesChecked}`,
      `- **With differences:** ${summary.pagesWithDiffs}`,
      `- **OK:** ${summary.pagesPassed}`,
      `- **Analysis failures:** ${summary.pagesFailed}`,
      `- **LLM Vision calls:** ${summary.llmCallsUsed}`,
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
    `### ${idx}. ${emoji} ${page.pageLabel} [${sevLabel} · ${diffsCount} diff(s)${missingSecs ? ` · ${missingSecs} missing section(s)` : ""}]`,
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
      "**Sections found in prod DOM but MISSING in cand (probably not yet migrated):**",
      ...page.sectionsOnlyInProd.map((s) => `- \`${s}\``),
    );
  }

  if (page.sectionsOnlyInCand.length > 0) {
    lines.push(
      "",
      "**Sections only in cand (new/extra sections, suspicious):**",
      ...page.sectionsOnlyInCand.map((s) => `- \`${s}\``),
    );
  }

  if (page.differences.length > 0) {
    lines.push("", "**Visual differences identified by LLM Vision:**", "");
    for (const [i, d] of page.differences.entries()) {
      lines.push(`${i + 1}. ${SEVERITY_EMOJI[d.severity]} [${d.region} · ${d.type} · ${d.severity}] ${d.description}`);
    }
  }

  if (page.llmError) {
    lines.push("", `> ⚠️ LLM Vision returned an error: ${page.llmError}`);
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
   - **Section missing in cand** → not registered in \`registerSections()\` in \`src/setup.ts\`, or the CMS resolves the key but can't find the component
   - **Section with different layout** → loader returns a different shape (\`@decocms/apps-start\` vs \`deco-cx/apps\`), props received via JSDoc changed, or \`useDevice()\` hydrates differently
   - **Missing image / no srcset** → image helper drift (lost \`preload\`, lost \`Picture\` or uses bare \`<img>\`), CDN URL changed
   - **Different text/CTA** → CMS draft vs published, or copy hardcoded in new code
   - **Different color/style** → CSS tokens not ported, Tailwind config drift, or a more specific selector in cand overriding
   - **Wrong hero/banner** → VTEX/Shopify loader returning different data, cookies (geo, cohort) not propagating, or stale cache
   - **Layout shift / hydration** → \`useDevice\` divergent between SSR and client, or \`<Suspense>\` without proper fallback

2. **Propose a concrete fix** — file + specific change + why. If two plausible alternatives, list both.

3. **Group** pages that likely share the same root cause (e.g. broken shelf on home AND PLP → shared loader, consolidated fix).

4. **Rank** execution order:
   - Which fix unblocks the most pages (impact)?
   - Which is cheapest to implement?
   - Which depends on a migration that isn't done yet (must port first)?

No preamble. If you need extra context (a section's source code, HAR, loader output), ask for it with a specific path and I'll fetch it.

Important: **only suggest changes in cand**. Prod is the source of truth — never ask to modify prod.
`;
}
