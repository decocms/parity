import { Command } from "commander";

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
  .option("--runs <n>", "Repeat each measurement N times (median)", "3")
  .option("--baseline <name>", "Compare against a saved baseline")
  .option("--output <dir>", "Output directory", "./parity-output")
  .option("--ci", "CI mode: stricter exit codes", false)
  .option("--fail-on <severities>", "Comma-separated severities that cause exit 1", "critical")
  .action(async (_opts) => {
    console.log("parity run — not yet implemented (Phase 1+)");
    process.exit(0);
  });

program
  .command("baseline")
  .description("Manage baselines")
  .addCommand(
    new Command("set")
      .argument("<runId>", "Run ID to mark as baseline")
      .requiredOption("--name <name>", "Baseline name")
      .action(async (_runId, _opts) => {
        console.log("parity baseline set — not yet implemented");
      }),
  )
  .addCommand(
    new Command("list").action(async () => {
      console.log("parity baseline list — not yet implemented");
    }),
  )
  .addCommand(
    new Command("unset")
      .argument("<name>", "Baseline name to remove")
      .action(async (_name) => {
        console.log("parity baseline unset — not yet implemented");
      }),
  );

program
  .command("list")
  .description("List saved runs")
  .action(async () => {
    console.log("parity list — not yet implemented");
  });

program
  .command("report")
  .argument("<runId>", "Run ID to open")
  .description("Open the HTML report for a run in the default browser")
  .action(async (_runId) => {
    console.log("parity report — not yet implemented");
  });

program
  .command("compare")
  .argument("<runId>", "Run ID to compare")
  .requiredOption("--against <name>", "Baseline name to compare against")
  .description("Compare a run against a baseline")
  .action(async (_runId, _opts) => {
    console.log("parity compare — not yet implemented");
  });

program
  .command("explain")
  .argument("<runId>", "Run ID")
  .argument("<issueId>", "Issue ID")
  .description("LLM deep-dive on a specific issue")
  .action(async (_runId, _issueId) => {
    console.log("parity explain — not yet implemented");
  });

program.parseAsync(process.argv);
