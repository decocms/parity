/**
 * `parity plan set-status <name> <status>` — the orchestrator's API for
 * marking a component's porting progress in `migration-plan.json`, instead of
 * hand-editing the JSON. A thin wrapper over {@link loadPlan}/{@link savePlan}.
 * Defaults to `.parity/` in the target repo so the plan lives with the
 * `.parity/migration.json` state file and survives a resume.
 */

import chalk from "chalk";
import { studioConfigFromEnv, syncBoardToStudio } from "../board/studio.ts";
import {
  type ComponentStatus,
  type Disposition,
  type PageColumn,
  type PageStatus,
  loadPlan,
  mergePlanDecisions,
  pagePlan,
  planBoard,
  planProgress,
  savePlan,
  setComponentReference,
  setComponentStatus,
  setComponentVerified,
  setPageStatus,
} from "../migrate/plan.ts";

const STATUSES: ComponentStatus[] = ["pending", "partial", "done", "as-is", "upgrade", "skipped"];
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
  // An accepted divergence with no recorded reason is indistinguishable from a forgotten gap.
  if ((status === "upgrade" || status === "as-is") && !component.reference) {
    console.log(
      chalk.yellow(
        `  no reason recorded — run \`parity plan set-reference ${component.name} --note "<why>"${
          status === "upgrade" ? " --url <reference site>" : ""
        }\``,
      ),
    );
  }
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

const DISPOSITION_STYLE: Record<Disposition, (s: string) => string> = {
  build: chalk.red,
  validate: chalk.yellow,
  upgrade: chalk.cyan,
  "as-is": chalk.gray,
  settled: chalk.green,
};

/**
 * `parity plan set-reference` — point a component's comparison at something other than prod, or
 * just record why it diverges. This is what keeps an intentional improvement from being reported
 * as a defect forever: `parity section --prod <url>` accepts any URL, so the reference site
 * becomes the thing the component is checked against.
 */
export function planSetReferenceCommand(
  dir: string,
  name: string,
  opts: { url?: string; selector?: string; note: string },
): number {
  const plan = loadPlan(dir);
  if (!plan) {
    console.error(chalk.red(`No migration-plan.json found in ${dir}`));
    return 1;
  }
  const component = setComponentReference(plan, name, {
    url: opts.url ?? plan.url,
    selector: opts.selector ?? null,
    note: opts.note,
  });
  if (!component) {
    console.error(chalk.red(`No component matching "${name}" in the plan`));
    return 1;
  }
  savePlan(dir, plan);
  console.log(`${chalk.green("✓")} ${component.name} → reference ${component.reference?.url}`);
  return 0;
}

/**
 * `parity plan verify` — record that a component was actually compared, and against what. A
 * `done` row with no verification only means the code exists.
 */
export function planVerifyCommand(
  dir: string,
  name: string,
  verdict: string,
  opts: { note?: string; at?: string },
): number {
  if (verdict !== "pass" && verdict !== "fail") {
    console.error(chalk.red(`Invalid verdict "${verdict}". Use pass or fail.`));
    return 1;
  }
  const plan = loadPlan(dir);
  if (!plan) {
    console.error(chalk.red(`No migration-plan.json found in ${dir}`));
    return 1;
  }
  const component = setComponentVerified(
    plan,
    name,
    verdict,
    opts.at ?? new Date().toISOString(),
    opts.note,
  );
  if (!component) {
    console.error(chalk.red(`No component matching "${name}" in the plan`));
    return 1;
  }
  savePlan(dir, plan);
  const mark = verdict === "pass" ? chalk.green("✓") : chalk.red("✗");
  console.log(`${mark} ${component.name} → ${verdict} (against ${component.verified?.against})`);
  return 0;
}

/**
 * `parity plan merge <source>` — bring a freshly captured plan into the canonical one without
 * losing what was decided. The orchestrator copies the plan from the migrate output dir into the
 * target repo; a plain copy would revert every ported/accepted/upgraded/verified row, and since
 * the canonical plan is committed, that revert lands as a diff nobody wrote.
 */
export function planMergeCommand(dir: string, sourceDir: string): number {
  const fresh = loadPlan(sourceDir);
  if (!fresh) {
    console.error(chalk.red(`No migration-plan.json found in ${sourceDir}`));
    return 1;
  }
  const existing = loadPlan(dir);
  const { plan, carried, droppedWithDecisions } = mergePlanDecisions(fresh, existing);
  savePlan(dir, plan);

  if (!existing) {
    console.log(`${chalk.green("✓")} plan written to ${dir} (nothing to merge)`);
    return 0;
  }
  console.log(`${chalk.green("✓")} merged into ${dir} — ${carried.length} decision(s) kept`);
  if (droppedWithDecisions.length) {
    console.log(
      chalk.yellow(
        `  no longer in the capture, decisions lost: ${droppedWithDecisions.join(", ")}`,
      ),
    );
  }
  return 0;
}

/**
 * `parity plan page <path>` — the per-page worksheet. The unit of work a migration actually
 * closes is a page, not a global queue: without this the orchestrator triages the whole repo and
 * files whatever it finds, so no page ever finishes.
 */
export function planPageCommand(
  dir: string,
  path: string,
  opts: { cand?: string; json?: boolean },
): number {
  const plan = loadPlan(dir);
  if (!plan) {
    console.error(chalk.red(`No migration-plan.json found in ${dir}`));
    return 1;
  }
  const page = pagePlan(plan, path, opts.cand);
  if (!page) {
    console.error(chalk.red(`No page matching "${path}" in the plan`));
    console.error(chalk.gray(`  known pages: ${plan.pages.map((p) => p.path).join(", ")}`));
    return 1;
  }

  if (opts.json) {
    console.log(JSON.stringify(page, null, 2));
    return 0;
  }

  console.log(
    chalk.bold(`\n${page.path} ${chalk.gray(`(${page.kind})`)} — ${page.status}`) +
      (page.ready ? chalk.green("  ready") : ""),
  );

  if (page.tasks === null) {
    console.log(
      chalk.yellow(
        "\n  This plan has no page/component edges — it predates them. Re-run `parity migrate` to get per-page work.\n",
      ),
    );
    return 0;
  }

  if (page.tasks.length === 0) {
    console.log(chalk.gray("\n  The capture saw no components on this page.\n"));
    return 0;
  }

  const order: Disposition[] = ["build", "validate", "upgrade", "as-is", "settled"];
  for (const d of order) {
    const rows = page.tasks.filter((t) => t.disposition === d);
    if (!rows.length) continue;
    console.log(`\n${DISPOSITION_STYLE[d](chalk.bold(d))} (${rows.length})`);
    for (const t of rows) {
      console.log(`  ${t.name} ${chalk.gray(`(${t.scope}, ${t.origin}, ${t.status})`)}`);
      if (t.note) console.log(chalk.gray(`    why: ${t.note}`));
      if (t.against?.kind === "reference") {
        console.log(chalk.cyan(`    reference: ${t.against.url}`));
      }
      if (t.command) console.log(chalk.gray(`    $ ${t.command}`));
    }
  }

  if (page.counts.validate > 0 && !opts.cand) {
    console.log(chalk.yellow("\n  Pass --cand <url> to get runnable `parity section` commands."));
  }
  console.log("");
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
      `${chalk.cyan(`${c.byStatus.upgrade} upgrade`)}, ` +
      `${chalk.gray(`${c.byStatus["as-is"]} as-is`)}, ` +
      `${chalk.gray(`${c.byStatus.skipped} skipped`)}`,
  );
  // Reported apart from `settled`: "we tolerated a difference" and "we did it better" are the
  // two lines a stakeholder asks about, and both look like "not equal" to the visual diff.
  if (c.accepted.upgrade.length) {
    console.log(chalk.cyan(`  deliberately ahead of prod: ${c.accepted.upgrade.join(", ")}`));
  }
  if (c.accepted.asIs.length) {
    console.log(chalk.gray(`  divergence accepted: ${c.accepted.asIs.join(", ")}`));
  }
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

const COLUMN_ORDER: PageColumn[] = ["triage", "backlog", "building", "review", "done"];

const COLUMN_STYLE: Record<PageColumn, (s: string) => string> = {
  triage: chalk.magenta,
  backlog: chalk.red,
  building: chalk.yellow,
  review: chalk.cyan,
  done: chalk.green,
  skipped: chalk.gray,
};

/**
 * `parity plan board` — the migration as a per-page kanban. Lanes are DERIVED from each page's
 * components (see `pageColumn`), so the board cannot claim a page is done while a component it
 * needs is still missing. Read-only.
 */
export async function planBoardCommand(
  dir: string,
  opts: { cand?: string; json?: boolean; board?: string },
): Promise<number> {
  const plan = loadPlan(dir);
  if (!plan) {
    console.error(chalk.red(`No migration-plan.json found in ${dir}`));
    console.error(chalk.yellow("Run `parity migrate --url <prod>` first — no plan, no board."));
    return 1;
  }

  const board = planBoard(plan, opts.cand);
  if (opts.json) {
    console.log(JSON.stringify(board, null, 2));
    return 0;
  }

  console.log(chalk.bold(`\nBoard — ${board.url}`));
  console.log(
    chalk.gray(
      `${board.sampled} sampled page(s) — the capture's sample, not every URL on the site.`,
    ),
  );

  if (board.shell.length) {
    console.log(
      `\n${chalk.bold("shell")} ${chalk.gray("(global — blocks every page)")}: ${chalk.yellow(
        board.shell.join(", "),
      )}`,
    );
  }

  for (const column of COLUMN_ORDER) {
    const cards = board.columns[column];
    if (!cards.length) continue;
    console.log(`\n${COLUMN_STYLE[column](chalk.bold(column))} (${cards.length})`);
    for (const card of cards) {
      console.log(`  ${card.path} ${chalk.gray(`(${card.kind})`)}`);
      if (card.blockers.length) {
        console.log(chalk.gray(`    blocked by: ${card.blockers.join(", ")}`));
      }
    }
  }

  const skipped = board.columns.skipped;
  if (skipped.length) {
    console.log(
      `\n${chalk.gray(`skipped (${skipped.length}): ${skipped.map((c) => c.path).join(", ")}`)}`,
    );
  }

  if (board.unassigned.length) {
    console.log(
      `\n${chalk.bold("no page")} ${chalk.gray(
        "(in the code, not seen on any sampled page)",
      )}\n  ${chalk.gray(board.unassigned.join(", "))}`,
    );
  }
  console.log("");

  // The Studio push is reporting, never a gate: a board nobody can reach must not fail a
  // migration, so every failure degrades to the terminal render above and still exits 0.
  if (opts.board === "studio") {
    const cfg = studioConfigFromEnv();
    if (!cfg) {
      console.log(
        chalk.yellow(
          "Studio board skipped — set PARITY_STUDIO_URL and PARITY_STUDIO_TOKEN. Showing the terminal board instead.\n",
        ),
      );
      return 0;
    }
    try {
      const synced = await syncBoardToStudio(board, cfg);
      console.log(
        chalk.green(
          `Studio board synced — ${synced.created} created, ${synced.updated} updated, ${synced.skipped} skipped.\n`,
        ),
      );
    } catch (err) {
      console.log(
        chalk.yellow(
          `Studio board unavailable (${err instanceof Error ? err.message : String(err)}). Showing the terminal board instead.\n`,
        ),
      );
    }
  }
  return 0;
}
