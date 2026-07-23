import { Command } from "commander";
import { auditCommand } from "./commands/audit.ts";
import { baselineList, baselineSet, baselineUnset } from "./commands/baseline.ts";
import { cacheCommand } from "./commands/cache.ts";
import { checkCommand } from "./commands/check.ts";
import { compareCommand } from "./commands/compare.ts";
import { consoleCommand } from "./commands/console.ts";
import { cssTraceCommand } from "./commands/css-trace.ts";
import { e2eCommand } from "./commands/e2e.ts";
import { explainCommand } from "./commands/explain.ts";
import { fixCommand } from "./commands/fix.ts";
import { htmlCommand } from "./commands/html.ts";
import { journeyCommand } from "./commands/journey.ts";
import { learnedStats, learnedValidate } from "./commands/learned.ts";
import { listCommand, listModulesCommand } from "./commands/list.ts";
import { prCommand } from "./commands/pr.ts";
import { promptCommand } from "./commands/prompt.ts";
import { reportCommand } from "./commands/report.ts";
import { runCommand } from "./commands/run.ts";
import { sectionCommand } from "./commands/section.ts";
import { serveCommand } from "./commands/serve.ts";
import { vitalsCommand } from "./commands/vitals.ts";
import { getPackageVersion } from "./util/version.ts";

const program = new Command();

program
  .name("parity")
  .description("E2E parity validator for Fresh -> TanStack site migrations")
  .version(getPackageVersion());

program
  .command("run")
  .description(
    [
      "Compare two URLs and produce a parity report.",
      "",
      "Flag convention (Issue #71):",
      "  --X        → enable / opt-in (default OFF unless preset overrides)",
      "  --no-X     → disable / opt-out (default ON unless preset overrides)",
      "",
      "Default behavior (no preset):",
      "  flows=purchase-journey, viewports=mobile,desktop, vitals-pages=10,",
      "  visual-pages=5 (auto-zeroed when no LLM provider available),",
      "  auto-selectors=ON (if LLM), learn=ON, cache=ON, visual-diff=ON,",
      "  warmup=OFF, bypass-cache=OFF, ci=OFF.",
    ].join("\n"),
  )
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
  .option(
    "--vitals-pages <n>",
    "Extra pages from sitemap to crawl for Vitals coverage (default 10)",
    (v) => Number(v),
    10,
  )
  .option(
    "--max-viewport-concurrency <n>",
    "How many viewports run concurrently during collect (default 2: mobile+desktop together). Set to 1 if you hit OOM with many viewports.",
    (v) => Number(v),
    2,
  )
  .option(
    "--visual-pages <n>",
    "Pages to compare visually via LLM (home + sampled PLPs/PDPs from sitemap, default 5)",
    (v) => Number(v),
    5,
  )
  .option(
    "--pages <list>",
    'Comma-separated paths to compare visually (overrides sitemap discovery). E.g. "/,/account,/p/some-product". Use this when you want deterministic coverage instead of sampled.',
  )
  .option(
    "--pages-file <path>",
    "Read paths to compare visually from a text file (one path per line). Lines starting with # are ignored. Overrides --pages when both are present.",
  )
  .option("--no-visual-diff", "Skip the visual diff capture pass entirely")
  .option(
    "--no-cache",
    "Disable the cross-run visual-diff cache (forces a fresh LLM judgment on every page).",
  )
  .option(
    "--clear-cache",
    "Wipe the visual-diff verdict cache (parity-output/cache/verdicts.json) before the run.",
    false,
  )
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
  .option(
    "--llm-timeout <seconds>",
    "Hard timeout for the LLM aggregation call (seconds). The run completes in offline mode if the LLM hangs past this. Default: 60.",
    (v) => Number(v),
    60,
  )
  .option(
    "--timeout <minutes>",
    "Hard wall-clock cap for the whole run (minutes). On expiry, parity writes a partial report and exits 130. Default: 30. Issue #56.",
    (v) => Number(v),
    30,
  )
  .option(
    "--flow <name>",
    "Alias for --flows when running a single flow (e.g. --flow cart). Issue #53.",
  )
  .option(
    "--json <path|->",
    "Emit JSON-Lines (one line per check) to the given file path, or '-' for stdout. Schema versioned via leading metadata line. Issue #53.",
  )
  .option(
    "--pt",
    "Tell the LLM to respond in Brazilian Portuguese. Only affects LLM-generated content (issues, explain, prompts) — the static HTML report stays in English. Issue #67.",
  )
  .option(
    "--llm <provider>",
    "Force LLM provider: anthropic | openrouter | claude-code | none. Default: auto-detect (anthropic key → openrouter key → local claude CLI → none). Issue #66.",
  )
  .option(
    "--llm-model <overrides>",
    "Per-feature model override, e.g. visual-diff=claude-opus-4-7,explain=claude-opus-4-7. Features: selector-discovery, step-recovery, search-terms, plp-matching, pdp-matching, section-understanding, visual-diff, issue-aggregation, explain. Issue #66.",
  )
  .option(
    "--llm-tier-default <tier>",
    "Override the default tier (haiku | sonnet | opus) for every feature that doesn't have a per-feature override. Issue #66.",
  )
  .option(
    "--llm-model-default <model>",
    "Force every LLM call to use this exact model ID, ignoring per-feature defaults. Issue #66.",
  )
  .option(
    "--no-interactive",
    "Disable the interactive selector prompt that auto-fires in a TTY without an LLM provider. Use in scripts and CI where stdin is technically a TTY but you don't want to pause. Issue #72.",
  )
  .option(
    "--only <modules>",
    "Scope the run to these modules and/or single checks (comma-separated). Module names: e2e, seo, visual, vitals, cache, console, html, network. Single-check granularity via `check:<name>`, e.g. `--only e2e,check:cache-coverage`. Run `parity list modules` for the full check/flow mapping. Default: all modules. M3 module selection.",
  )
  .option(
    "--skip <modules>",
    "Subtract these modules and/or single checks (comma-separated, same syntax as --only) from whatever base set was chosen (all modules, or --only's set if both are given). M3 module selection.",
  )
  .option(
    "--why <text>",
    "Free-text reason for this run's scope, stored in report.json as `selectionReason`. Purely informational. M3 module selection.",
  )
  .action(async (opts) => {
    // --flow is just sugar for --flows with a single value
    if (opts.flow) {
      opts.flows = opts.flow;
    }
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
  .option("--pt", "Tell the LLM to respond in Brazilian Portuguese. Issue #67.")
  .action(async (opts) => {
    if (opts.pt) {
      const { setLlmLanguage } = await import("./llm/client.ts");
      setLlmLanguage("pt");
    }
    process.exit(await auditCommand(opts));
  });

program
  .command("e2e")
  .description(
    "Single-site functional end-to-end. Runs all functional flows (homepage, plp, pdp, purchase-journey, search, cart-interactions, optionally login) against ONE URL, then runs all checks in single-site mode. Use for 'does this site actually work?' verification — broader than `audit` (which only does vitals/console/network/images/seo).",
  )
  .requiredOption("--url <url>", "Base URL of the site to test")
  .option(
    "--flows <list>",
    "Comma-separated flows. Default: homepage,plp,pdp,purchase-journey,search,cart-interactions (login is opt-in)",
    "",
  )
  .option("--viewports <list>", "Comma-separated viewports", "mobile,desktop")
  .option("--cep <cep>", "CEP for shipping calculation", "01310-100")
  .option(
    "--search-terms <list>",
    "Comma-separated search terms to use (override LLM auto-discovery)",
  )
  .option("--login-email <email>", "Login email (also PARITY_LOGIN_EMAIL env var)")
  .option("--login-password <pwd>", "Login password (also PARITY_LOGIN_PASSWORD env var)")
  .option("--output <dir>", "Output directory", "./parity-output")
  .option("--open", "Open the HTML report after the run completes", false)
  .option("--json", "Emit one-line JSON instead of pretty text", false)
  .option(
    "--fail-on <severities>",
    "Comma-separated severities that cause exit 1 (default: critical,high)",
    "critical,high",
  )
  .option("--pt", "Tell the LLM to respond in Brazilian Portuguese. Issue #67.")
  .action(async (opts) => {
    if (opts.pt) {
      const { setLlmLanguage } = await import("./llm/client.ts");
      setLlmLanguage("pt");
    }
    process.exit(await e2eCommand(opts));
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
  })
  .addCommand(
    new Command("modules")
      .description(
        "List the 8 selectable check modules (M3 module selection) with their descriptions, checks, and flows — see --only/--skip on `parity run`.",
      )
      .option("--json", "Emit structured JSON instead of human-readable text", false)
      .action((opts) => {
        process.exit(listModulesCommand(Boolean(opts.json)));
      }),
  );

program
  .command("serve")
  .argument("<runId>", "Run ID to serve")
  .description(
    "Spawns a local HTTP server that serves the report and proxies external iframes (strips X-Frame-Options/CSP), making the Side-by-side tab functional for any site.",
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
  .description(
    "Open the HTML report for a run in the default browser. With --section, extract a single tab to stdout instead — useful for agents that need just the SEO/Network/Vitals slice without parsing the whole report. Issue #74.",
  )
  .option("--output <dir>", "Output directory", "./parity-output")
  .option(
    "--section <name>",
    "Extract one tab to stdout instead of opening the report. Valid names: summary, visualdiff, seo, sidebyside, issues, vitals, cache, checks, prompt, pages, console, network, diff.",
  )
  .option(
    "--json",
    "Pair with --section to emit a normalized JSON projection of the section (from report.json) instead of the raw HTML slice.",
  )
  .action(async (runId, opts) => {
    process.exit(
      await reportCommand(runId, {
        output: opts.output,
        section: opts.section,
        json: opts.json,
      }),
    );
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
  .command("pr")
  .description(
    "CI/CD entry point: compare a PR preview URL against prod and emit a Markdown comment ready to paste into a PR (or write to $GITHUB_STEP_SUMMARY with --github). Internally a thin wrapper around `parity run` with sane PR defaults (preset=ci, mobile-only, purchase-journey). Issue #79.",
  )
  .requiredOption("--prod <url>", "Production URL (source of truth)")
  .requiredOption("--preview <url>", "PR preview URL to compare against prod")
  .option("--github", "Also write the Markdown to $GITHUB_STEP_SUMMARY", false)
  .option("--out <path>", "Write the Markdown comment to this file instead of stdout")
  .option("--preset <name>", "Preset bundle: smoke | ci | full", "ci")
  .option("--output <dir>", "Output directory for runs/<id>/", "./parity-output")
  .action(async (opts) => {
    process.exit(
      await prCommand({
        prod: opts.prod,
        preview: opts.preview,
        github: opts.github,
        out: opts.out,
        preset: opts.preset,
        output: opts.output,
      }),
    );
  });

program
  .command("cache")
  .description(
    "Cache analysis focused on cand. Crawls N pages (lighter than `vitals`: no screenshots, no vitals, no scroll), groups requests by category, lists MISS-asset opportunities.",
  )
  .requiredOption("--prod <url>", "Production URL (optional reference)")
  .requiredOption("--cand <url>", "Candidate URL (foco)")
  .option(
    "--urls <list-or-file>",
    "Comma-separated paths or .txt file (1/line). Overrides sitemap.",
  )
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
    "Crawls multiple pages (via sitemap.xml or --urls) and compares Web Vitals prod vs cand on each. HTML output with the top worst/best expanded.",
  )
  .requiredOption("--prod <url>", "Production URL (base)")
  .requiredOption("--cand <url>", "Candidate URL (base)")
  .option(
    "--urls <list-or-file>",
    "Comma-separated paths or .txt file (1/line). Overrides sitemap discovery.",
  )
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
    "CI-friendly: runs only the purchase journey (home → PLP → PDP → shipping → cart → cart shipping → checkout) and compares prod vs cand step by step.",
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
  .option("--pt", "Tell the LLM to respond in Brazilian Portuguese. Issue #67.")
  .action(async (opts) => {
    if (opts.pt) {
      const { setLlmLanguage } = await import("./llm/client.ts");
      setLlmLanguage("pt");
    }
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
  .option("--pt", "Tell the LLM to respond in Brazilian Portuguese. Issue #67.")
  .description("LLM deep-dive on a specific issue (requires ANTHROPIC_API_KEY)")
  .action(async (runId, issueId, opts) => {
    if (opts.pt) {
      const { setLlmLanguage } = await import("./llm/client.ts");
      setLlmLanguage("pt");
    }
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
  .requiredOption(
    "--selector <sel>",
    "CSS selector for the target element (e.g. 'html', '[data-aside]', '.drawer-side')",
  )
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
  .option("--wait <ms>", "Extra ms to wait after networkidle so client-side errors land", "2000")
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
  .option(
    "--output-html",
    "Include the HTML diff facet (default: on if no facet flag passed)",
    false,
  )
  .option("--screenshot", "Include the screenshot facet (locator screenshot per side)", false)
  .option("--computed-styles", "Include the computed-styles diff facet", false)
  .option(
    "--heatmap",
    "Run pixelmatch on the two screenshots and analyze diff regions (bounding box + hotspots). Implies --screenshot.",
    false,
  )
  .option(
    "--css-source",
    "For each divergent computed-style property, resolve which CSS rule (stylesheet + selector) produced it via CDP. Useful when the LLM needs to know which file to edit.",
    false,
  )
  .option(
    "--prompt",
    "Emit an LLM-ready bundle: <prefix>-bundle.json (machine-readable) + <prefix>-prompt.md (opinionated Markdown with embedded images). Implies all signals.",
    false,
  )
  .option(
    "--llm-summary",
    "After building the bundle, invoke Claude (needs ANTHROPIC_API_KEY) and print a 1-paragraph 'what I understood' summary. Does NOT generate a patch. Implies --prompt.",
    false,
  )
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
        heatmap: opts.heatmap,
        cssSource: opts.cssSource,
        prompt: opts.prompt,
        llmSummary: opts.llmSummary,
        viewport: opts.viewport,
        wait: opts.wait,
        outDir: opts.outDir,
        json: opts.json,
      }),
    );
  });

program
  .command("fix")
  .description(
    "Pixel-perfect debug shortcut: run `parity section` with ALL signals on (HTML + screenshot + computed-styles + heatmap + CSS source) and emit an LLM-ready Markdown bundle. When ANTHROPIC_API_KEY is set, also prints a 1-paragraph summary of what Claude understood from the signals — does NOT generate a patch (you ask for that in a follow-up turn).",
  )
  .requiredOption("--prod <url>", "Production URL (source of truth)")
  .requiredOption("--cand <url>", "Candidate URL (migrated)")
  .requiredOption("--selector <sel>", "CSS selector for the section to fix")
  .option("--viewport <viewport>", "mobile | desktop | tablet", "mobile")
  .option("--wait <ms>", "Extra ms after networkidle so hydration settles", "2000")
  .option("--out-dir <dir>", "Where to write the bundle + screenshots", "./parity-output/sections")
  .option("--json", "Emit one-line JSON instead of pretty text", false)
  .option(
    "--no-llm",
    "Skip the LLM call (still writes the markdown bundle). Use when offline or to avoid API costs.",
  )
  .option("--pt", "Tell the LLM to respond in Brazilian Portuguese. Issue #67.")
  .action(async (opts) => {
    if (opts.pt) {
      const { setLlmLanguage } = await import("./llm/client.ts");
      setLlmLanguage("pt");
    }
    process.exit(
      await fixCommand({
        prod: opts.prod,
        cand: opts.cand,
        selector: opts.selector,
        viewport: opts.viewport,
        wait: opts.wait,
        outDir: opts.outDir,
        json: opts.json,
        noLlm: !opts.llm,
      }),
    );
  });

program
  .command("learned")
  .description("Inspect the learned-selectors library")
  .addCommand(
    new Command("stats").description("Print learned-selectors stats per platform").action(() => {
      process.exit(learnedStats());
    }),
  )
  .addCommand(
    new Command("validate")
      .description(
        "Debug: run selector discovery + live-validation against a single URL and print a table (not part of `parity run`)",
      )
      .requiredOption("--url <url>", "URL to fetch + discover + validate")
      .action(async (opts: { url: string }) => {
        process.exit(await learnedValidate(opts.url));
      }),
  );

program.parseAsync(process.argv);
