/**
 * `parity plan set-status <name> <status>` — the orchestrator's API for
 * marking a component's porting progress in `migration-plan.json`, instead of
 * hand-editing the JSON. A thin wrapper over {@link loadPlan}/{@link savePlan}.
 * Defaults to `.parity/` in the target repo so the plan lives with the
 * `.parity/migration.json` state file and survives a resume.
 */

import chalk from "chalk";
import { type ComponentStatus, loadPlan, savePlan, setComponentStatus } from "../migrate/plan.ts";

const STATUSES: ComponentStatus[] = ["pending", "done", "skipped"];

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
