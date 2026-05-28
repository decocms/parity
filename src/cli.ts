import { Command } from "commander";
import { baselineList, baselineSet, baselineUnset } from "./commands/baseline.ts";
import { auditCommand } from "./commands/audit.ts";
import { cacheCommand } from "./commands/cache.ts";
import { checkCommand } from "./commands/check.ts";
import { compareCommand } from "./commands/compare.ts";
import { consoleCommand } from "./commands/console.ts";
import { htmlCommand } from "./commands/html.ts";
import { cssTraceCommand } from "./commands/css-trace.ts";
import { explainCommand } from "./commands/explain.ts";
import { journeyCommand } from "./commands/journey.ts";
import { learnedStats } from "./commands/learned.ts";
import { vitalsCommand } from "./commands/vitals.ts";
import { listCommand } from "./commands/list.ts";
import { promptCommand } from "./commands/prompt.ts";
import { reportCommand } from "./commands/report.ts";
import { runCommand } from "./commands/run.ts";
import { sectionCommand } from "./commands/section.ts";
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
    "--preset <name>",
    "Bundle of defaults: smoke (fast, ~30s, no LLM) | full (deep audit) | ci (CI-tuned)",
  )
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
  .option("--visual-pages <n>", "Pages to compare visually via LLM (home + sampled PLPs/PDPs from sitemap, default 5)", (v) => Number(v), 5)
  .option("--no-visual-diff", "Skip the visual diff capture pass entirely")
  .option(
    "--bypass-cache",
    "Bypass CDN/edge caches: append a cache-busting query param and send Cache-Control: no-cache on every request. Use right after a deploy to avoid false failures from stale CF edge content.",
    false,
  )
  .option(
    "--warmup",
    "Before measurement, hit each target URL once (per viewport) with a cache-buster so the Worker serves a fresh response. Recommended after deploys.",
    false,
  )
  .option(
    "--accept-prod-quirks",
    "Demote prod-side cart-empty journey failures (VTEX session quirk) from failed to skipped. The cart-reveal-mode-divergence check still emits critical if prod/cand markup intents differ, so this flag never masks a real regression. See issue #12.",
    false,
  )
  .action(async (opts) => {
    const code = await runCommand(opts);
    process.exit(code);
  });

program
  .command("audit")
  .description(
    "Single-site absolute audit. Runs console + vitals + network + images + SEO checks on ONE URL (no prod×cand comparison) and outputs a focused HTML report. Use for pre-launch or post-deploy 'what's broken right now' verification.",
  )
  .requiredOption("--url <url>", "Base URL (e.g. https://miess-tanstack.deco-cx.workers.dev)")
  .option("--viewport <viewport>", "mobile | desktop | tablet", "mobile")
  .option("--pages <list>", "Comma-separated paths to audit (default: /)", "/")
  .option("--output <dir>", "Output directory", "./parity-output")
  .option("--open", "Open the HTML report after the run completes", false)
  .option("--json", "Emit one-line JSON instead of pretty text", false)
  .option(
    "--fail-on <severities>",
    "Comma-separated severities that cause exit 1 (default: critical,high)",
    "critical,high",
  )
  .action(async (opts) => {
    process.exit(await auditCommand(opts));
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
  .option(
    "--accept-prod-quirks",
    "Demote prod-side cart-empty journey failures (VTEX session quirk) from failed to skipped. The cart-reveal-mode-divergence check still emits critical if prod/cand markup intents differ, so this flag never masks a real regression. See issue #12.",
    false,
  )
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
  .command("css-trace")
  .description(
    "Inspect which CSS rules (from which stylesheets) are affecting a DOM element. Single URL mode lists every matched rule; --prod + --cand mode diffs computed styles between Fresh and TanStack sides.",
  )
  .option("--url <url>", "Single URL to inspect (mutually exclusive with --prod/--cand)")
  .option("--prod <url>", "Production URL (for comparison mode)")
  .option("--cand <url>", "Candidate URL (for comparison mode)")
  .requiredOption("--selector <sel>", "CSS selector for the target element (e.g. 'html', '[data-aside]', '.drawer-side')")
  .option(
    "--filter <props>",
    "Comma-separated property names to focus on (e.g. 'scrollbar-gutter,position,width')",
  )
  .option("--viewport <viewport>", "mobile, tablet, or desktop", "desktop")
  .option("--settle <ms>", "Wait this many ms after `load` for hydration", (v) => Number(v), 1500)
  .option("--json", "Output JSON instead of pretty text", false)
  .action(async (opts) => {
    process.exit(
      await cssTraceCommand({
        url: opts.url,
        prod: opts.prod,
        cand: opts.cand,
        selector: opts.selector,
        filter: opts.filter,
        viewport: opts.viewport,
        settleMs: opts.settle,
        json: opts.json,
      }),
    );
  });

program
  .command("console")
  .description(
    "Single-page console capture. Boots Playwright on --url, waits for the page to settle, then prints any console errors/warnings + network failures. No LLM, no checks — designed for sub-10s debug loops (issue #31).",
  )
  .requiredOption("--url <url>", "URL to load")
  .option("--viewport <viewport>", "mobile | desktop | tablet", "mobile")
  .option(
    "--wait <ms>",
    "Extra ms to wait after networkidle so client-side errors land",
    "2000",
  )
  .option(
    "--filter <types>",
    "Comma-separated subset of error,warning,log,info,debug (default: error,warning)",
  )
  .option("--json", "Emit one-line JSON instead of human-readable text", false)
  .action(async (opts) => {
    process.exit(await consoleCommand(opts));
  });

program
  .command("html")
  .description(
    "Dump page HTML or diff prod vs cand HTML for a section. No LLM, no checks — sub-10s debug loop (issue #31).",
  )
  .option("--url <url>", "Single-side mode: dump HTML of this URL")
  .option("--prod <url>", "Diff mode: prod URL (use together with --cand --diff)")
  .option("--cand <url>", "Diff mode: cand URL (use together with --prod --diff)")
  .option("--selector <sel>", "Narrow output to a CSS selector (outer HTML of first match)")
  .option("--pretty", "Format HTML with prettier", false)
  .option("--diff", "Diff mode (required with --prod/--cand). Prints unified diff", false)
  .option("--viewport <viewport>", "mobile | desktop | tablet", "mobile")
  .option(
    "--wait <ms>",
    "Extra ms after networkidle so SSR/hydration settles",
    (v) => Number(v),
    2000,
  )
  .option("--json", "Emit one-line JSON instead of pretty text", false)
  .action(async (opts) => {
    process.exit(await htmlCommand(opts));
  });

program
  .command("check")
  .argument("<name>", "check name (kebab-case, e.g. console-errors-baseline)")
  .description(
    "Run a single check against a prod×cand pair on one page. Skips sitemap discovery, the other 13 checks, and the LLM aggregation. Sub-10s loop for verifying a single fix (issue #31).",
  )
  .requiredOption("--prod <url>", "Production URL (base)")
  .requiredOption("--cand <url>", "Candidate URL (base)")
  .option("--viewports <list>", "Comma-separated mobile,desktop,tablet", "mobile")
  .option("--page <path>", "Pathname to capture (e.g. /bota-tudao-2025)", "/")
  .option("--json", "Emit one-line JSON instead of pretty text", false)
  .action(async (name, opts) => {
    process.exit(
      await checkCommand({
        name,
        prod: opts.prod,
        cand: opts.cand,
        viewports: opts.viewports,
        page: opts.page,
        json: opts.json,
      }),
    );
  });

program
  .command("section")
  .description(
    "Focused prod×cand comparison of one section: HTML diff + screenshot + computed-styles diff. No flags = all 3 facets. Designed for the 'in DOM but invisible' debug loop (issue #31).",
  )
  .requiredOption("--prod <url>", "Production URL (base, e.g. https://www.example.com)")
  .requiredOption("--cand <url>", "Candidate URL (base, e.g. https://example.deco-cx.workers.dev)")
  .requiredOption("--selector <sel>", "CSS selector for the section to compare")
  .option("--output-html", "Include the HTML diff facet (default: on if no facet flag passed)", false)
  .option("--screenshot", "Include the screenshot facet (locator screenshot per side)", false)
  .option("--computed-styles", "Include the computed-styles diff facet", false)
  .option("--viewport <viewport>", "mobile | desktop | tablet", "mobile")
  .option("--wait <ms>", "Extra ms after networkidle so hydration settles", "2000")
  .option("--out-dir <dir>", "Where to write the screenshots", "./parity-output/sections")
  .option("--json", "Emit one-line JSON instead of pretty text", false)
  .action(async (opts) => {
    process.exit(
      await sectionCommand({
        prod: opts.prod,
        cand: opts.cand,
        selector: opts.selector,
        outputHtml: opts.outputHtml,
        screenshot: opts.screenshot,
        computedStyles: opts.computedStyles,
        viewport: opts.viewport,
        wait: opts.wait,
        outDir: opts.outDir,
        json: opts.json,
      }),
    );
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
