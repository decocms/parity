/**
 * `parity plan set-status <name> <status>` — the orchestrator's API for
 * marking a component's porting progress in `migration-plan.json`, instead of
 * hand-editing the JSON. A thin wrapper over {@link loadPlan}/{@link savePlan}.
 * Defaults to `.parity/` in the target repo so the plan lives with the
 * `.parity/migration.json` state file and survives a resume.
 */

import chalk from "chalk";
import {
  type ComponentStatus,
  type PageStatus,
  loadPlan,
  planProgress,
  savePlan,
  setComponentStatus,
  setPageStatus,
} from "../migrate/plan.ts";

const STATUSES: ComponentStatus[] = ["pending", "partial", "done", "skipped"];
const PAGE_STATUSES: PageStatus[] = ["pending", "code", "done", "skipped"];

export function planSetStatusCommand(dir: string, name: string, status: string): number {
  if (!STATUSES.includes(status as ComponentStatus)) {
    console.error(chalk.red(`Invalid status "${status}". Use one of: ${STATUSES.join(", ")}`));
    return 1;
  }
  const plan = loadPlan(dir);
  if (!plan) {
    console.error(chalk.red(`No migration-plan.json found in ${dir}`));
    return 1;
  }
  const component = setComponentStatus(plan, name, status as ComponentStatus);
  if (!component) {
    console.error(chalk.red(`No component matching "${name}" in the plan`));
    return 1;
  }
  savePlan(dir, plan);
  console.log(`${chalk.green("✓")} ${component.name} → ${status}`);
  return 0;
}

export function planSetPageStatusCommand(dir: string, path: string, status: string): number {
  if (!PAGE_STATUSES.includes(status as PageStatus)) {
    console.error(chalk.red(`Invalid status "${status}". Use one of: ${PAGE_STATUSES.join(", ")}`));
    return 1;
  }
  const plan = loadPlan(dir);
  if (!plan) {
    console.error(chalk.red(`No migration-plan.json found in ${dir}`));
    return 1;
  }
  const page = setPageStatus(plan, path, status as PageStatus);
  if (!page) {
    console.error(chalk.red(`No page matching "${path}" in the plan`));
    return 1;
  }
  savePlan(dir, plan);
  console.log(`${chalk.green("✓")} ${page.path} → ${status}`);
  return 0;
}

/**
 * `parity plan status` — the migration inventory. Answers, in one place: which
 * components need no further work, which remain, and which pages have code but
 * no published content. The orchestrator reads this before triaging so it works
 * on what is actually missing instead of linting whatever the repo contains.
 */
export function planStatusCommand(dir: string, asJson: boolean): number {
  const plan = loadPlan(dir);
  if (!plan) {
    console.error(chalk.red(`No migration-plan.json found in ${dir}`));
    console.error(
      chalk.yellow(
        "Run `parity migrate --url <prod>` first — without a plan there is no inventory.",
      ),
    );
    return 1;
  }
  const p = planProgress(plan);

  if (asJson) {
    console.log(JSON.stringify({ url: plan.url, target: plan.target.name, ...p }, null, 2));
    return 0;
  }

  const c = p.components;
  console.log(
    chalk.bold(`\nMigration plan — ${plan.url}${plan.target.name ? ` → ${plan.target.name}` : ""}`),
  );
  console.log(
    `\n${chalk.bold("Components")} (${c.total}): ` +
      `${chalk.green(`${c.byStatus.done} done`)}, ` +
      `${chalk.yellow(`${c.byStatus.partial} partial`)}, ` +
      `${chalk.red(`${c.byStatus.pending} pending`)}, ` +
      `${chalk.gray(`${c.byStatus.skipped} skipped`)}`,
  );
  if (c.settled.length) {
    console.log(chalk.gray(`  no work needed: ${c.settled.join(", ")}`));
  }
  for (const r of c.remaining) {
    const tag = r.status === "partial" ? chalk.yellow("partial") : chalk.red("pending");
    console.log(`  ${tag}  ${r.name} ${chalk.gray(`(${r.scope}, ${r.origin})`)}`);
  }

  const pg = p.pages;
  console.log(
    `\n${chalk.bold("Pages")} (${pg.total}): ` +
      `${chalk.green(`${pg.byStatus.done} done`)}, ` +
      `${chalk.yellow(`${pg.byStatus.code} code-only`)}, ` +
      `${chalk.red(`${pg.byStatus.pending} pending`)}, ` +
      `${chalk.gray(`${pg.byStatus.skipped} skipped`)}`,
  );
  if (pg.awaitingContent.length) {
    console.log(chalk.yellow(`  awaiting CMS content: ${pg.awaitingContent.join(", ")}`));
  }
  for (const r of pg.remaining.filter((r) => r.status === "pending")) {
    console.log(`  ${chalk.red("pending")}  ${r.path} ${chalk.gray(`(${r.kind})`)}`);
  }
  console.log("");
  return 0;
}
