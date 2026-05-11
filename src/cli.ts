import { Command } from "commander";
import { baselineList, baselineSet, baselineUnset } from "./commands/baseline.ts";
import { cacheCommand } from "./commands/cache.ts";
import { compareCommand } from "./commands/compare.ts";
import { explainCommand } from "./commands/explain.ts";
import { journeyCommand } from "./commands/journey.ts";
import { learnedStats } from "./commands/learned.ts";
import { vitalsCommand } from "./commands/vitals.ts";
import { listCommand } from "./commands/list.ts";
import { promptCommand } from "./commands/prompt.ts";
import { reportCommand } from "./commands/report.ts";
import { runCommand } from "./commands/run.ts";
import { serveCommand } from "./commands/serve.ts";

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
  .option("--no-auto-selectors", "Disable LLM-based selector discovery (uses defaults instead)")
  .option("--refresh-selectors", "Bypass selector cache and re-run discovery", false)
  .option("--no-learn", "Don't write to learned-selectors.json (read-only mode)")
  .option("--vitals-pages <n>", "Extra pages from sitemap to crawl for Vitals coverage (default 10)", (v) => Number(v), 10)
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
  .command("serve")
  .argument("<runId>", "Run ID to serve")
  .description(
    "Sobe um HTTP server local que serve o report e faz proxy de iframes externos (remove X-Frame-Options/CSP), tornando a aba Side-by-side funcional pra qualquer site.",
  )
  .option("--output <dir>", "Output directory where runs live", "./parity-output")
  .option("--port <n>", "Fixed port (default: auto-pick free port)", (v) => Number(v))
  .option("--no-open", "Don't open the browser automatically")
  .action(async (runId, opts) => {
    process.exit(await serveCommand(runId, opts));
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
  .command("cache")
  .description(
    "Análise de cache focada em cand. Crawla N páginas (mais leve que vitals: sem screenshot, sem vitals, sem scroll), agrupa requests por categoria, lista oportunidades de assets MISS.",
  )
  .requiredOption("--prod <url>", "Production URL (referência opcional)")
  .requiredOption("--cand <url>", "Candidate URL (foco)")
  .option("--urls <list-or-file>", "Comma-separated paths or .txt file (1/line). Overrides sitemap.")
  .option("--pages <n>", "Max pages to crawl from sitemap", (v) => Number(v), 30)
  .option("--viewports <list>", "mobile,desktop", "mobile")
  .option("--concurrency <n>", "Parallel workers (1-8)", (v) => Number(v), 6)
  .option("--cand-only", "Skip prod entirely (faster, no comparison)", false)
  .option("--output <dir>", "Output directory", "./parity-output")
  .option("--open", "Open the HTML report when done", false)
  .action(async (opts) => {
    process.exit(await cacheCommand(opts));
  });

program
  .command("vitals")
  .description(
    "Crawleia múltiplas páginas (via sitemap.xml ou --urls) e compara Web Vitals prod vs cand em cada uma. Output HTML com top piores/melhores expandidos.",
  )
  .requiredOption("--prod <url>", "Production URL (base)")
  .requiredOption("--cand <url>", "Candidate URL (base)")
  .option("--urls <list-or-file>", "Comma-separated paths or .txt file (1/line). Overrides sitemap discovery.")
  .option("--limit <n>", "Max pages discovered from sitemap.xml", (v) => Number(v), 20)
  .option("--viewports <list>", "mobile,desktop", "mobile")
  .option("--concurrency <n>", "Parallel workers (1-8)", (v) => Number(v), 4)
  .option("--output <dir>", "Output directory", "./parity-output")
  .option("--open", "Open the HTML report when done", false)
  .action(async (opts) => {
    process.exit(await vitalsCommand(opts));
  });

program
  .command("journey")
  .description(
    "CI-friendly: roda só o purchase-journey (home → PLP → PDP → frete → carrinho → frete carrinho → checkout) e compara prod vs cand step-by-step",
  )
  .requiredOption("--prod <url>", "Production URL")
  .requiredOption("--cand <url>", "Candidate URL")
  .option("--viewports <list>", "mobile,desktop", "mobile")
  .option("--cep <cep>", "CEP for shipping calc", "01310-100")
  .option("--output <dir>", "Output directory for runs/<id>/", "./parity-output")
  .option("--junit <file>", "Write JUnit XML to this path")
  .option("--github", "Emit GitHub Actions annotations (::error, ::warning) for failures")
  .option("--json", "Emit a one-line JSON status object to stdout (machine-readable)")
  .option("--no-report", "Skip writing report.html / report.json")
  .option("--no-auto-selectors", "Skip LLM-based selector discovery")
  .action(async (opts) => {
    process.exit(await journeyCommand(opts));
  });

program
  .command("prompt")
  .argument("<runId>", "Run ID")
  .description("Generate a Markdown prompt of ranked issues ready to paste into any LLM")
  .option("--output <dir>", "Output directory where runs live", "./parity-output")
  .option("--out <file>", "Write to file instead of stdout")
  .option(
    "--min-severity <sev>",
    "Only include issues at or above this severity (critical|high|medium|low)",
    "low",
  )
  .option("--limit <n>", "Cap the number of issues included", (v) => Number(v), 20)
  .action((runId, opts) => {
    process.exit(
      promptCommand(runId, {
        output: opts.output,
        out: opts.out,
        minSeverity: opts.minSeverity,
        limit: opts.limit,
      }),
    );
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

program
  .command("learned")
  .description("Inspect the learned-selectors library")
  .addCommand(
    new Command("stats")
      .description("Print learned-selectors stats per platform")
      .action(() => {
        process.exit(learnedStats());
      }),
  );

program.parseAsync(process.argv);
