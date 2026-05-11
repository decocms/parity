import type { Issue, Run } from "../types/schema.ts";

const SEVERITY_ORDER: Record<Issue["severity"], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

const SEVERITY_EMOJI: Record<Issue["severity"], string> = {
  critical: "🔴",
  high: "🟠",
  medium: "🟡",
  low: "⚪",
};

export interface BuildPromptOptions {
  /** Only include issues at or above this severity. Default: "low" (all). */
  minSeverity?: Issue["severity"];
  /** Cap number of issues. Default: 20. */
  limit?: number;
}

export function buildLlmPrompt(run: Run, opts: BuildPromptOptions = {}): string {
  const minSev = opts.minSeverity ?? "low";
  const limit = opts.limit ?? 20;

  const baseIssues = run.topIssues.length > 0 ? run.topIssues : run.issues;
  const filtered = baseIssues
    .filter((i) => SEVERITY_ORDER[i.severity] <= SEVERITY_ORDER[minSev])
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
    .slice(0, limit);

  return buildPromptInner(run, filtered, baseIssues.length);
}

function buildPromptInner(run: Run, issues: Issue[], totalIssues: number): string {
  const v = run.verdict;
  const sections: string[] = [];

  sections.push(
    `# Migration Parity Report — ${run.id}

You are reviewing the result of an automated E2E parity test between two versions of a site:

- **prod (source of truth):** ${run.prodUrl} — running the old framework (Deno Fresh + Preact)
- **cand (candidate):** ${run.candUrl} — migrated version on the new stack (TanStack Start + React + Cloudflare Workers)

The test ran flows \`${run.flows.join(", ")}\` in viewports \`${run.viewports.join(", ")}\` using CEP \`${run.cep}\`. Total duration: ${(run.durationMs / 1000).toFixed(1)}s.

## Verdict

- **Status:** ${v.status.toUpperCase()}
- **Parity score:** ${v.score}/100
- **Issues:** ${v.critical} critical · ${v.high} high · ${v.medium} medium · ${v.low} low
- **Checks:** ${v.checksRun} run (${v.checksPassed} pass · ${v.checksFailed} fail · ${v.checksSkipped} skipped)

The cand version must behave as close as possible to prod. Every divergence below is a regression unless explicitly intentional in the migration. Your job is to help me decide which to fix first and how.

---

## Top ${issues.length} of ${totalIssues} issues (ranked by severity)
`,
  );

  if (issues.length === 0) {
    sections.push("\n_No issues at or above the requested severity._\n");
  } else {
    for (const [idx, issue] of issues.entries()) {
      sections.push(renderIssueBlock(idx + 1, issue));
    }
  }

  sections.push(`
---

## What I need from you

For each issue above, in order of severity:

1. **Diagnose** the most likely root cause specific to a Fresh → TanStack Start migration of a Deco storefront. Common patterns include:
   - \`useDevice\` / \`usePlatform\` hydration mismatch (server returns one, client another)
   - Section not registered in \`registerSections()\` in \`src/setup.ts\`
   - Loader returning a different shape (different VTEX/Shopify endpoint mapping in @decocms/apps-start)
   - Cache profile not covering this route type in \`@decocms/start\` (\`routeCacheDefaults\`)
   - VTEX cookies not propagating (\`vtexFetchWithCookies\` issue) — affects cart, shipping
   - Image helper or CDN URL drift, or lost \`preload\` on hero image
   - \`<head>\` meta tags hoist not running server-side
2. **Propose a concrete fix** — file path, what to change, why. If two fixes are plausible, list both.
3. **Flag dependencies** between issues (e.g. "fixing #2 will likely fix #5 too").
4. **Rank execution order** for me: which fix unlocks the most other fixes? Which is cheapest?

Be terse. Skip preamble. If an issue is ambiguous, say what extra information you'd need from me (a HAR file, a specific page screenshot, a code path) and I'll fetch it.

Don't suggest generic best practices — only fixes tied to specific issues above.
`);

  return sections.join("\n");
}

function renderIssueBlock(idx: number, issue: Issue): string {
  const lines: string[] = [];
  const emoji = SEVERITY_EMOJI[issue.severity];
  lines.push(
    `### ${idx}. ${emoji} [${issue.severity.toUpperCase()}] ${issue.summary}`,
    "",
    `- **Category:** \`${issue.category}\`  ·  **Check:** \`${issue.check}\`${issue.page ? `  ·  **Page:** \`${humanKey(issue.page)}\`` : ""}`,
  );
  if (issue.details) {
    lines.push("", "**Details:**", "", "```", issue.details, "```");
  }
  if (issue.reproduction) {
    lines.push("", "**Reproduction:**", "", issue.reproduction);
  }
  if (issue.suggestedFix) {
    lines.push("", "**Suggested fix (preliminary):**", "", issue.suggestedFix);
  }
  if (issue.evidence && issue.evidence.length > 0) {
    const refs = issue.evidence
      .map((e) => `\`${e.path}\`${e.label ? ` (${e.label})` : ""}`)
      .join(", ");
    lines.push("", `**Evidence:** ${refs}`);
  }
  lines.push("", "");
  return lines.join("\n");
}

function humanKey(key: string): string {
  const parts = key.split("::");
  const path = parts[0] ?? key;
  const viewport = parts[1] ?? "";
  const niceName = path === "/" || path === "" ? "Home" : path;
  return viewport ? `${niceName} · ${viewport}` : niceName;
}
