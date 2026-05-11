import chalk from "chalk";
import { getLlmClient, isLlmAvailable, LLM_MODEL } from "../llm/client.ts";
import { ISSUE_AGGREGATOR_SYSTEM_PROMPT } from "../llm/system-prompt.ts";
import { loadRun } from "../storage/fs.ts";

export async function explainCommand(runId: string, issueId: string, output: string): Promise<number> {
  if (!isLlmAvailable()) {
    console.error(chalk.red("ANTHROPIC_API_KEY ausente — explain requer LLM."));
    return 1;
  }
  const run = loadRun(output, runId);
  const issue = run.issues.find((i) => i.id === issueId) || run.topIssues.find((i) => i.id === issueId);
  if (!issue) {
    console.error(chalk.red(`Issue não encontrada: ${issueId}`));
    return 1;
  }

  const checks = run.checks.filter((c) =>
    c.issues.some((i) => i.id === issueId || i.check === issue.check),
  );

  const client = getLlmClient();
  if (!client) return 1;

  console.log(chalk.dim("Consultando LLM…\n"));
  const response = await client.messages.create({
    model: LLM_MODEL,
    max_tokens: 1500,
    system: [{ type: "text", text: ISSUE_AGGREGATOR_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: [
      {
        role: "user",
        content: `Faça um deep-dive técnico sobre esta issue específica de uma migração Deco. Liste causa raiz prováveis e ações concretas em ordem de probabilidade.

Issue:
${JSON.stringify(issue, null, 2)}

Contexto de checks relacionados:
${JSON.stringify(checks.map((c) => ({ name: c.name, status: c.status, summary: c.summary })), null, 2)}`,
      },
    ],
  });

  for (const block of response.content) {
    if (block.type === "text") {
      console.log(block.text);
    }
  }
  return 0;
}
