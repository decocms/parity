import chalk from "chalk";
import { callMessage, isLlmAvailable } from "../llm/client.ts";
import { ISSUE_AGGREGATOR_SYSTEM_PROMPT } from "../llm/system-prompt.ts";
import { loadRun } from "../storage/fs.ts";

export async function explainCommand(runId: string, issueId: string, output: string): Promise<number> {
  if (!isLlmAvailable()) {
    console.error(
      chalk.red("Nenhuma API key de LLM encontrada — set ANTHROPIC_API_KEY ou OPENROUTER_API_KEY."),
    );
    return 1;
  }
  const run = loadRun(output, runId);
  const issue =
    run.issues.find((i) => i.id === issueId) || run.topIssues.find((i) => i.id === issueId);
  if (!issue) {
    console.error(chalk.red(`Issue não encontrada: ${issueId}`));
    return 1;
  }

  const checks = run.checks.filter((c) =>
    c.issues.some((i) => i.id === issueId || i.check === issue.check),
  );

  console.log(chalk.dim("Consultando LLM…\n"));
  const text = await callMessage({
    systemPrompt: ISSUE_AGGREGATOR_SYSTEM_PROMPT,
    userText: `Faça um deep-dive técnico sobre esta issue específica de uma migração Deco. Liste causa raiz prováveis e ações concretas em ordem de probabilidade.

Issue:
${JSON.stringify(issue, null, 2)}

Contexto de checks relacionados:
${JSON.stringify(
  checks.map((c) => ({ name: c.name, status: c.status, summary: c.summary })),
  null,
  2,
)}`,
    maxTokens: 1500,
  });
  if (text) console.log(text);
  return text ? 0 : 1;
}
