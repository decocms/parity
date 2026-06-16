import type { CheckResult, Issue } from "../types/schema.ts";
import { callTool, isLlmAvailable } from "./client.ts";
import { ISSUE_AGGREGATOR_SYSTEM_PROMPT } from "./system-prompt.ts";

export interface AggregateInput {
  runId: string;
  prodUrl: string;
  candUrl: string;
  viewports: string[];
  flows: string[];
  checks: CheckResult[];
  /**
   * Hard timeout in ms for the LLM call. Default: client default (60s).
   * Falls back to deterministic aggregation if the LLM doesn't return in
   * time. Issue #52.
   */
  timeoutMs?: number;
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
  if (!isLlmAvailable()) return fallbackAggregate(input);

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

  const parsed = await callTool<{ issues?: Partial<Issue>[] }>({
    systemPrompt: ISSUE_AGGREGATOR_SYSTEM_PROMPT,
    userText: `Analise os resultados abaixo e produza issues priorizadas via report_issues.\n\n${userContent}`,
    maxTokens: 4096,
    timeoutMs: input.timeoutMs,
    tool: {
      name: REPORT_ISSUES_TOOL.name,
      description: REPORT_ISSUES_TOOL.description,
      inputSchema: REPORT_ISSUES_TOOL.input_schema as unknown as Record<string, unknown>,
    },
  });
  if (!parsed) return fallbackAggregate(input);
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
