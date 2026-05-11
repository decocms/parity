import { Command } from "commander";
import { baselineList, baselineSet, baselineUnset } from "./commands/baseline.ts";
import { compareCommand } from "./commands/compare.ts";
import { explainCommand } from "./commands/explain.ts";
import { listCommand } from "./commands/list.ts";
import { reportCommand } from "./commands/report.ts";
import { runCommand } from "./commands/run.ts";

const program = new Command();

program
  .name("parity")
  .description("E2E parity validator for Fresh -> TanStack site migrations")
  .version("0.0.0");

program
  .command("run")
  .description("Compare two URLs and produce a parity report")
  .requiredOption("--prod <url>", "Production URL (source of truth, e.g. Fresh site)")
  .requiredOption("--cand <url>", "Candidate URL (migrated site, e.g. TanStack)")
  .option(
    "--flows <list>",
    "Comma-separated flows: homepage,plp,pdp,purchase-journey",
    "purchase-journey",
  )
  .option("--viewports <list>", "Comma-separated viewports: mobile,desktop", "mobile,desktop")
  .option("--cep <cep>", "CEP for shipping calculation", "01310-100")
  .option("--runs <n>", "Repeat each measurement N times (median)", "1")
  .option("--baseline <name>", "Compare against a saved baseline")
  .option("--output <dir>", "Output directory", "./parity-output")
  .option("--ci", "CI mode: stricter exit codes", false)
  .option("--fail-on <severities>", "Comma-separated severities that cause exit 1", "critical")
  .option("--open", "Open the HTML report after the run completes", false)
  .action(async (opts) => {
    const code = await runCommand(opts);
    process.exit(code);
  });

program
  .command("baseline")
  .description("Manage baselines")
  .addCommand(
    new Command("set")
      .argument("<runId>", "Run ID to mark as baseline")
      .requiredOption("--name <name>", "Baseline name")
      .option("--output <dir>", "Output directory", "./parity-output")
      .action(async (runId, opts) => {
        process.exit(await baselineSet(runId, opts));
      }),
  )
  .addCommand(
    new Command("list").action(() => {
      process.exit(baselineList());
    }),
  )
  .addCommand(
    new Command("unset").argument("<name>", "Baseline name to remove").action((name) => {
      process.exit(baselineUnset(name));
    }),
  );

program
  .command("list")
  .description("List saved runs")
  .option("--output <dir>", "Output directory", "./parity-output")
  .action((opts) => {
    process.exit(listCommand(opts.output));
  });

program
  .command("report")
  .argument("<runId>", "Run ID to open")
  .description("Open the HTML report for a run in the default browser")
  .option("--output <dir>", "Output directory", "./parity-output")
  .action(async (runId, opts) => {
    process.exit(await reportCommand(runId, opts.output));
  });

program
  .command("compare")
  .argument("<runId>", "Run ID to compare")
  .requiredOption("--against <name>", "Baseline name to compare against")
  .option("--output <dir>", "Output directory", "./parity-output")
  .description("Compare a run against a baseline")
  .action((runId, opts) => {
    process.exit(compareCommand(runId, opts.against, opts.output));
  });

program
  .command("explain")
  .argument("<runId>", "Run ID")
  .argument("<issueId>", "Issue ID")
  .option("--output <dir>", "Output directory", "./parity-output")
  .description("LLM deep-dive on a specific issue (requires ANTHROPIC_API_KEY)")
  .action(async (runId, issueId, opts) => {
    process.exit(await explainCommand(runId, issueId, opts.output));
  });

program.parseAsync(process.argv);
