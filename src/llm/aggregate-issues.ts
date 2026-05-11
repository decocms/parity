import type { CheckResult, Issue } from "../types/schema.ts";
import { LLM_MODEL, getLlmClient } from "./client.ts";
import { ISSUE_AGGREGATOR_SYSTEM_PROMPT } from "./system-prompt.ts";

export interface AggregateInput {
  runId: string;
  prodUrl: string;
  candUrl: string;
  viewports: string[];
  flows: string[];
  checks: CheckResult[];
}

const REPORT_ISSUES_TOOL = {
  name: "report_issues",
  description: "Report a prioritized list of aggregated issues from the parity run.",
  input_schema: {
    type: "object" as const,
    properties: {
      issues: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            severity: { type: "string", enum: ["critical", "high", "medium", "low"] },
            category: {
              type: "string",
              enum: ["functional", "visual", "performance", "seo", "console", "network"],
            },
            page: { type: "string" },
            check: { type: "string" },
            summary: { type: "string" },
            details: { type: "string" },
            reproduction: { type: "string" },
            suggestedFix: { type: "string" },
          },
          required: ["id", "severity", "category", "check", "summary"],
        },
      },
    },
    required: ["issues"],
  },
};

/**
 * Aggregate raw check results into prioritized issues via LLM.
 * Falls back to a deterministic merge of raw issues if no API key is set.
 */
export async function aggregateIssues(input: AggregateInput): Promise<Issue[]> {
  const client = getLlmClient();
  if (!client) return fallbackAggregate(input);

  const failedChecks = input.checks.filter((c) => c.status === "fail" || c.status === "warn");
  if (failedChecks.length === 0) return [];

  const rawIssues = input.checks.flatMap((c) => c.issues);
  const userContent = JSON.stringify(
    {
      run: {
        id: input.runId,
        prod: input.prodUrl,
        cand: input.candUrl,
        viewports: input.viewports,
        flows: input.flows,
      },
      checks_summary: failedChecks.map((c) => ({
        name: c.name,
        status: c.status,
        severity: c.severity,
        summary: c.summary,
        issueCount: c.issues.length,
        data: c.data,
      })),
      raw_issues: rawIssues.map((i) => ({
        id: i.id,
        severity: i.severity,
        category: i.category,
        page: i.page,
        check: i.check,
        summary: i.summary,
        details: i.details,
      })),
    },
    null,
    2,
  );

  try {
    const response = await client.messages.create({
      model: LLM_MODEL,
      max_tokens: 4096,
      system: [
        {
          type: "text",
          text: ISSUE_AGGREGATOR_SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" },
        },
      ],
      tools: [REPORT_ISSUES_TOOL],
      tool_choice: { type: "tool", name: "report_issues" },
      messages: [
        {
          role: "user",
          content: `Analise os resultados abaixo e produza issues priorizadas via report_issues.\n\n${userContent}`,
        },
      ],
    });

    for (const block of response.content) {
      if (block.type === "tool_use" && block.name === "report_issues") {
        const parsed = block.input as { issues?: Partial<Issue>[] };
        return (parsed.issues ?? [])
          .filter((i) => i.id && i.severity && i.category && i.check && i.summary)
          .map(
            (i) =>
              ({
                id: i.id!,
                severity: i.severity!,
                category: i.category!,
                page: i.page,
                check: i.check!,
                summary: i.summary!,
                details: i.details,
                reproduction: i.reproduction,
                suggestedFix: i.suggestedFix,
                evidence: [],
              }) as Issue,
          );
      }
    }
  } catch (err) {
    console.error(`[llm] aggregation failed: ${(err as Error).message}`);
  }
  return fallbackAggregate(input);
}

function fallbackAggregate(input: AggregateInput): Issue[] {
  // Deterministic fallback: take raw issues, dedup by id, sort by severity, cap at 10.
  const seen = new Map<string, Issue>();
  for (const c of input.checks) {
    for (const i of c.issues) {
      if (!seen.has(i.id)) seen.set(i.id, i);
    }
  }
  const order: Record<Issue["severity"], number> = { critical: 0, high: 1, medium: 2, low: 3 };
  return [...seen.values()].sort((a, b) => order[a.severity] - order[b.severity]).slice(0, 10);
}
