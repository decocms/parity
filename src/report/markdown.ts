import type { Run } from "../types/schema.ts";

/**
 * Markdown summary for PR comments / Slack. Concise — title + verdict + top 5 issues.
 */
export function renderMarkdownSummary(run: Run): string {
  const v = run.verdict;
  const statusEmoji = v.status === "pass" ? "✅" : v.status === "warn" ? "⚠️" : "❌";

  const top = run.topIssues
    .slice(0, 5)
    .map((i) => `- **[${i.severity.toUpperCase()}]** ${i.summary}${i.page ? ` _(${i.page})_` : ""}`)
    .join("\n");

  return `## ${statusEmoji} parity report · score ${v.score}/100

**${v.checksRun} checks** (${v.checksPassed} pass · ${v.checksFailed} fail · ${v.checksSkipped} skipped) — ${(run.durationMs / 1000).toFixed(1)}s

**Issues:** ${v.critical} critical · ${v.high} high · ${v.medium} medium · ${v.low} low

- prod: ${run.prodUrl}
- cand: ${run.candUrl}
- flows: ${run.flows.join(", ")} · viewports: ${run.viewports.join(", ")}

${top ? `### Top issues\n\n${top}` : "_Nenhuma issue prioritária._"}
`;
}
