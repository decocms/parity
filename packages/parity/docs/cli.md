# CLI reference

| Command | What it does |
| --- | --- |
| `parity run` | Full comparison run between two URLs |
| `parity pr` | CI/CD entry point: PR-preview vs prod, emits Markdown comment |
| `parity audit` | Single-site absolute audit (console + vitals + SEO + images) |
| `parity e2e` | Single-site functional end-to-end: all flows + all checks |
| `parity journey` | CI-friendly: only the purchase journey, with JUnit / GitHub annotations |
| `parity vitals` | Crawl N pages, compare Web Vitals prod vs cand — **via Lighthouse by default** (Slow 4G + 4× CPU, matches PageSpeed) plus its actionable opportunities. `--no-lighthouse` uses the fast unthrottled collector. |
| `parity benchmark` | User Navigation Benchmark: warm before/after story (home → PLP → paginate → PDP → shelf), single shareable HTML |
| `parity cache` | CDN cache analysis, opportunities, request categorization |
| `parity serve` | Local HTTP server with iframe proxy so side-by-side tab works for any site |
| `parity report` | Reopen a saved run's HTML report. With `--section <name>`: extract one tab to stdout |
| `parity compare` | Compare a run against a baseline |
| `parity baseline` | Manage baselines (`set`, `list`, `unset`) |
| `parity list` | List saved runs |
| `parity list modules` | List the 8 selectable check modules (`--only`/`--skip` targets), with `--json` |
| `parity check` | Run a single check (`<name>`) — skips sitemap + LLM aggregation; sub-10s loop |
| `parity console` | Sub-10s capture of console errors/warnings + network failures for one URL |
| `parity html` | Dump page/selector HTML or unified diff prod×cand (prettier + jsdiff) |
| `parity css-trace` | Inspect which CSS rules affect a DOM element; single-URL rule listing or prod×cand computed-style diff |
| `parity section` | Focused prod×cand diff of a section: HTML + screenshot + computed styles |
| `parity fix` | Pixel-perfect bundle: heatmap + CSS source + LLM-ready Markdown prompt |
| `parity extract` | Single-site AI-ready component extraction (no prod×cand) — see `docs/extract.md` |
| `parity plan set-status <name> <status>` | Mark a component `pending`/`done`/`skipped` in `migration-plan.json` (`--dir`, default `.parity/`) — the orchestrator's API instead of hand-editing JSON. See `docs/migrate.md` |
| `parity prompt` | Export issues as a Markdown prompt for any LLM |
| `parity explain` | LLM deep-dive on a specific issue (needs API key) |
| `parity learned` | Inspect the learned-selectors library |

Run any command with `--help` for the full flag list.

## Default behavior on `parity run` (no preset)

- `flows=purchase-journey, viewports=mobile,desktop`
- `vitals-pages=10` — auto-sampled extra sitemap pages; see the noise/scoping note below
- `visual-pages=5` (auto-zeroed when no LLM provider available, unless `--pages`/`--pages-file` was explicitly set — explicit page selection still gets the prod/cand screenshot + pixelmatch heatmap capture even without an LLM verdict)
- `auto-selectors=ON` (if LLM available)
- `learn=ON, cache=ON, visual-diff=ON`
- `warmup=OFF, bypass-cache=OFF, fail-on=critical` (exit code is 1 whenever a
  blocking-severity issue is present — no extra flag needed)

## Flag convention

- `--X` (no `no-` prefix) → enable / opt-in (default OFF unless preset overrides)
- `--no-X` → disable / opt-out (default ON unless preset overrides)

## Other `parity run` flags

| Flag | What it does |
| --- | --- |
| `--fail-on <severities>` | Comma-separated severities that flip the exit code to 1 (default: `critical`). Always active — no `--ci` flag needed to enable it. |
| `--vitals-pages <n>` | Extra sitemap-sampled pages crawled for Vitals coverage, on top of `--flows`/`--pages` (default 10) — auto-sampled and can add significant unrelated noise to findings; pass `0` to scope the run to only the pages you explicitly requested |
| `--timeout <minutes>` | Hard wall-clock budget for the whole run; writes a partial report on expiry |
| `--llm-timeout <seconds>` | Per-call budget for the LLM aggregation pass |
| `--llm <provider>` | Force a provider: `anthropic`, `openrouter`, `claude-code`, or `none` (offline) |
| `--llm-model <overrides>` | Per-feature model override string (see `--help` for syntax) |
| `--llm-tier-default <tier>` | Default model tier (`haiku`/`sonnet`/`opus`) when a feature has no explicit override |
| `--llm-model-default <model>` | Default concrete model id, overriding the tier |
| `--llm-premium` | Bump the reasoning-heavy features (`explain`/`issue-aggregation`/`visual-diff`) to opus. Defaults are sonnet-first for cost/latency (opus blew the 60s timeout on most runs); opt into opus for hard fixes (#256) |
| `--refresh-selectors` | Bypass the selector-discovery cache and re-run LLM discovery |
| `--no-learn` | Skip learned-selectors promotion for this run |
| `--no-cache` | Disable the visual-diff verdict cache |
| `--clear-cache` | Wipe the visual-diff verdict cache before running |
| `--no-visual-diff` | Skip the visual-diff capture/analysis pass entirely |
| `--max-viewport-concurrency <n>` | How many viewports run in parallel (default 2) — lower this on resource-constrained machines if a full run stalls |
| `--pages <list>` | Comma-separated paths for deterministic visual-diff coverage instead of sampled sitemap pages. Accepts `prod->cand` pairs — see below. **Scopes the visual-diff + vitals-extra-pages passes only** — see warning below |
| `--pages-file <path>` | Same as `--pages`, read from a text file (one entry per line, `#` comments). Overrides `--pages` when both are set |
| `--accept-prod-quirks` | Demote prod-side cart-empty journey failures (VTEX session quirk) from failed to skipped — see issue #12 |
| `--json <path\|->` | Stream JSONL progress (one line per check/metadata) to a file or stdout (`-`) for agents/scripts |
| `--pt` | Tell the LLM to respond in Brazilian Portuguese |
| `--no-interactive` | Disable the interactive selector/module prompts that auto-fire in a TTY |

### Comparing pages that live at different paths (`prod->cand`)

A partially-migrated site usually has no path parity: the reference PDP on prod
is a product the candidate hasn't ported yet. Both `--pages` and `--pages-file`
accept an arrow to pin the two sides explicitly:

```bash
parity run --prod https://www.electrolux.com.ec --cand http://localhost:3000 \
  --pages "/,/encimeraagaselectroluxgc60m60cm/p->/ar-condicionado-split-inverter-12k-2003379/p"
```

`/` compares `/` on both sides; the second entry navigates prod and cand to
their own path but keeps them in **one** comparison bucket. Without the arrow,
the two captures pair on their (different) pathnames and every check that pairs
pages — visual diff, vitals, http-status, banner aspect ratio — reports two
orphans instead of one comparison.

The pairing key is the prod path, so `report.json` keys stay stable across runs
even if the candidate's path changes again later.

### `--pages`/`--pages-file` scoping gap (issue #178)

`--pages`/`--pages-file` only feed the **visual-diff** and **vitals-extra-pages**
capture passes. The `flows` crawl (`--flows`, default `purchase-journey`) does
**not** read `--pages` — each flow discovers its own target page(s)
independently (a `.parityrc.json` `*UrlHint` like `plpUrlHint`, sitemap/
category-link discovery on the home page, or a hardcoded homepage
click-through). Passing `--pages "/produto/x"` will NOT make
`purchase-journey` visit `/produto/x`.

To scope which page(s) a flow actually visits:

- Pick a lighter/more specific flow with `--flows` (e.g. `--flows plp` or
  `--flows pdp` instead of the full `purchase-journey`), and/or
- Set the matching hint in `.parityrc.json` (e.g. `"plpUrlHint": "/produto/x"`)
  to steer that flow's PLP/PDP discovery.

`parity run` prints a one-line warning when both `--pages`/`--pages-file` and
a flows crawl are active in the same run, as a reminder of this split.

> **Noisy findings? Check `--vitals-pages`.** By default `parity run` auto-samples
> 10 extra pages from the sitemap for Vitals coverage, beyond whatever
> `--flows`/`--pages` you explicitly asked for. Those extra pages are a real
> source of unrelated noise — one run's `high`-severity findings dropped from
> 53 to 13 on an otherwise identical command purely from adding
> `--vitals-pages 0` (issue #178). If you want a run scoped tightly to only
> the pages/flows you named, pass `--vitals-pages 0`.

## Module selection: `--only`, `--skip`, `--why`

`parity run` groups its ~30 checks into 8 **modules** so you can scope a run
to just the part you care about — lighter and faster than a full run.
`parity list modules` prints the current mapping (add `--json` for
structured output); `docs/checks.md` also has a Module column for the
check-name → module direction.

| Module | Covers |
| --- | --- |
| `e2e` | Functional flows: purchase journey, search, cart interactions, login, PDP gallery/breadcrumbs, PLP sorting, SPA navigation, server-fn hover flood |
| `seo` | Meta/SEO parity, deep audit, 404 handling, footer links, pagination, HTTP status |
| `visual` | Visual regression (LLM Vision), banner aspect ratio, cookie/CEP modal CLS |
| `vitals` | Web Vitals (mobile) |
| `cache` | Cache-header coverage |
| `console` | Console error baseline |
| `html` | HTML structural diff, lazy sections, image loading health, picture dims |
| `network` | Network request summary delta |

```bash
# e2e sozinho — just the functional flows, nothing else
parity run --prod https://www.example.com --cand https://example.deco-cx.workers.dev --only e2e

# everything except visual + vitals (skip the slow LLM/sitemap passes)
parity run --prod ... --cand ... --skip visual,vitals

# a module plus one extra single check, at check-level granularity
parity run --prod ... --cand ... --only e2e,check:cache-coverage

# annotate why the run was scoped this way (stored in report.json as `selectionReason`)
parity run --prod ... --cand ... --only e2e --why "smoke test before deploy"
```

Rules:

- `--only` is the base set (default: all 8 modules). `--skip` subtracts from
  whatever base was chosen (all modules, or `--only`'s set if both are given).
- Both flags accept module names and/or `check:<name>` entries, comma-separated.
- No `--only`/`--skip` at all → **unchanged behavior**: all checks run, all
  flows captured, exactly like before module selection existed.
- When a selection narrows which flows are needed, only those flows are
  captured — `--flows`/`--flow` still works standalone and is unioned in.
  Sitemap crawling (`vitals-pages`) and the visual-diff capture pass are
  auto-skipped when no selected module needs them (mirrors the existing
  no-LLM smart-defaults behavior).
- Presets are module-aware too: `--preset ci` implies `--only e2e,html,console`
  unless you pass an explicit `--only`/`--skip`, which always wins.
- Running from a TTY with none of `--only`/`--skip`/`--preset` set shows an
  interactive checkbox-style prompt (all modules pre-checked) so you can
  narrow the run on the spot. Non-TTY callers (CI, scripts) just get a
  one-line heads-up and proceed with everything — this is *never* a hard
  requirement.
- Unknown module/check names in `--only`/`--skip` exit with code 2 and a
  list of valid names.

### Adaptive scoring

The verdict score reflects **only the modules that ran**. Run `--only e2e`
and the score is purely about the e2e checks; add `--only e2e,seo` and the
composite blends both, weighted by how many page-pairs each module actually
analyzed (a module that covered more ground counts for more). `report.json`
carries the full breakdown under `moduleVerdicts` (one entry per module:
`score`, `status`, severity counts, `checksRun`, `pagesAnalyzed`), and the
top-level `verdict.modulesRun` lists which modules contributed. The CLI
summary prints a `modules: e2e 72 · seo 91 → composite 78` line, `parity pr`'s
markdown comment gets a `### Modules` table, and the HTML report's dashboard
shows a small score chip per module. Score trend (`previousRun`) only compares
against a prior run that scored the **same module set** — a `--only e2e` run
is never diffed against a full run's composite.

## Site profile: `--profile` (commerce vs content)

Not every site is a storefront. A content/blog site has no PLP, PDP, cart, or
CEP — running the commerce purchase journey there is either a meaningless 100
or a spurious failure (issues #254/#255).

```bash
# force content scoping (blog / custom site with no storefront)
parity run --prod https://blog.example.com --cand https://cand.example.com --profile content
```

- **`commerce`** — runs everything (purchase journey, PLP/PDP, CEP). The default
  for any recognized storefront platform (VTEX, Shopify, Wake, Nuvemshop, …).
- **`content`** — drops the `e2e` module, scopes flows to the **homepage** (never
  plp/pdp), and skips CEP. Every scope decision is printed, never silent.
- **Auto-detection** — when `--profile` is omitted, the profile is derived from
  the platform detected on the prod home page. A bare framework (`deco`) or an
  unrecognized stack (`custom`) defaults to `content`; a failed fetch falls back
  to `commerce` (unchanged behavior). Explicit `--profile`/`--only`/`--skip`
  always win.

## Visual Diff tab

When `--visual-pages > 0` AND an LLM provider is configured, the report's **Visual Diff** tab shows per page:

- prod screenshot · cand screenshot · pixelmatch heatmap, side-by-side
- list of Deco sections present in prod but missing in cand (auto-detected from `data-section`)
- semantic differences identified by Claude Vision (region, type, severity, description)
- one-click "Export visual prompt" — Markdown ready to paste into Claude / ChatGPT to generate the fix

The visual prompt focuses *only* on visual diffs, references the screenshot paths, and includes migration-specific guidance (register section in `setup.ts`, loader shape drift, useDevice hydration, etc).

## Pixel-perfect fix loop

When `parity run` flags a section but you want the LLM to actually patch it, `parity fix` bundles every signal into one Markdown prompt:

```bash
parity fix \
  --prod https://www.example.com \
  --cand https://example.deco-cx.workers.dev \
  --selector 'header'
```

Writes (under `./parity-output/sections/`):

- `section-<hash>-{prod,cand}.png` — locator screenshots, carousels stabilized
- `section-<hash>-heatmap.png` — pixelmatch with bounding-box analysis
- `section-<hash>-bundle.json` — machine-readable bundle (deltas + sources + bboxes)
- `section-<hash>-prompt.md` — paste-ready Markdown with embedded images, computed-style deltas, CSS source per property, HTML diff, and an opinionated "summarize what you understand first, no code yet" instruction

If `ANTHROPIC_API_KEY` is set, the LLM is invoked automatically and prints a one-paragraph diagnosis to stdout (uses Claude Vision on the screenshots). Pass `--no-llm` to stay offline.

### When the ported component has a different selector (`--cand-selector`)

A ported component rarely keeps the source's selector: VTEX IO class names
become hashed CSS Modules, `data-fs-*` attributes replace utility classes. Pass
the candidate's own selector so the cand side resolves at all:

```bash
parity fix \
  --prod https://www.electrolux.com.ec \
  --cand http://localhost:3000 \
  --selector '.vtex-store-components-3-x-container' \
  --cand-selector '[data-fs-product-shelf]'
```

Both `parity section` and `parity fix` accept it; it defaults to `--selector`.
When the two differ, the generated prompt states both selectors and tells the
LLM to compare rendered output and computed styles rather than class names —
otherwise it reads the expected port divergence as the bug to fix.

## `parity e2e` — single-site functional run

The `audit` command runs absolute checks (vitals, console, network, images, SEO). `parity e2e` runs **all the functional flows** (homepage, plp, pdp, purchase-journey, search, cart-interactions, spa-navigation, optionally login) against a single URL plus all parity checks in single-site mode.

Like `parity run`, `e2e` **detects the platform and auto-discovers selectors via the LLM** (grounded on a real PLP/PDP crawled off the home), live-validates them, and **learns** from each run — so you usually don't need to hand-write `.parityrc.json` selectors. The purchase-journey and cart flows are evaluated on their own terms (a failed or skipped-critical step fails the run) instead of being diffed against a prod baseline.

```bash
parity e2e --url https://www.example.com
parity e2e --url http://localhost:5173/ --flows=purchase-journey   # migrated-build health check
parity e2e --url https://www.example.com --flows=search,cart-interactions
parity e2e --url https://www.example.com --search-terms="camisa,promocao"
parity e2e --url https://www.example.com --refresh-selectors        # re-run discovery, ignore cache
parity e2e --url https://www.example.com --no-auto-selectors        # defaults + .parityrc.json only
parity e2e --url https://www.example.com --no-learn                 # don't write learned-selectors.json

PARITY_LOGIN_EMAIL=test@example.com PARITY_LOGIN_PASSWORD=*** \
  parity e2e --url https://www.example.com --flows=login
```

Selector automation flags (mirror `parity run`): `--no-auto-selectors`, `--refresh-selectors`, `--no-learn`.

Tune the add-to-cart confirmation window with `--add-to-cart-timeout <ms>` (default 3000) when the journey reports a false "add-to-cart sem confirmação" on a site that actually works — e.g. a short-lived success toast or slow TTFB. Persist it per-project as `addToCartConfirmMs` in `.parityrc.json` (issue #143). Applies to `parity run` too.

**Use `parity e2e` when** you want to validate "does this site actually work end-to-end?" — pre-launch, post-deploy, partner sites, or an agent-in-loop validating a migrated build in CI/PR where there's no prod baseline to compare against (issue #141). **Use `parity run` when** you need to detect *regressions* between two versions.

> `parity run` requires both `--prod` and `--cand` (it's a prod↔cand diff). Running it with a single site (`--prod X --cand X`) is wasteful and produces a degenerate self-comparison — omit `--prod` and the CLI will point you at `parity e2e` instead.

## `parity benchmark` — User Navigation Benchmark

A client-facing before/after story for a Fresh→TanStack migration. It simulates a
real returning visitor and times each step of a shopping journey on **both** sites,
emitting a **single self-contained HTML** report (PT/EN toggle, mobile/desktop tabs,
scrollable full-page prints, links to every tested page).

```bash
parity benchmark --prod https://www.farmrio.com.br --cand https://farmrio-tanstack.deco.site
parity benchmark --prod ... --cand ... --plp /novidades --viewports mobile,desktop --open
```

**How it works.** A *scout* validates, in the browser, a category (PLP) and a product
(PDP) that actually work on **both** sites (render products, no error) and pins the
same pages for both. Then, as a returning visitor, each side warms the edge **and the
browser cache** (`--warmup-runs`, default 2) and is measured `--measured-runs` times
(default 3, median). Each navigation is timed by **wall-clock from the click to the
first product image rendering** (not `networkidle`, not the HAR). Steps: home load,
home→PLP (hamburger menu), pagination (per page × per technology), PDP entry, product→
product SPA shelf hop, and — only when the product has a colour variant — variant switch.
Web Vitals come from Lighthouse (cold first visit) per viewport. A full HAR of the
session is saved as `user-navigation-benchmark-<viewport>-<side>.har`.

**Content sites** (blog/custom, no PLP/PDP) auto-switch to a `content` journey
(`--journey content` to force): the scout picks two internal content routes that
load on **both** sites (from the prod home's nav), and each side is measured on
**home-load → click to page A → click to page B** with the same warm-context /
median / Lighthouse scaffolding. This is exactly the click→content timing that a
Speculation-Rules / hover-prefetch setup improves. The commerce journey above is
unchanged.

| Flag | What it does |
| --- | --- |
| `--prod <url>` / `--cand <url>` | Fresh ("before") and TanStack ("after") URLs (required) |
| `--viewports <list>` | `mobile,desktop` (default) — pick one or both |
| `--warmup-runs <n>` | Warmup passes before measuring (default 2) |
| `--measured-runs <n>` | Measured passes per side, reported as the median (default 3) |
| `--paginations <n>` | How many times to scroll/paginate the PLP (default 3) |
| `--plp <path>` | Pin the PLP path (skip auto-discovery), e.g. `/novidades` |
| `--journey <type>` | `commerce` (home→PLP→PDP→variant) or `content` (home→page A→page B, for blog/custom sites with no PLP/PDP). Auto-detected from the platform when omitted (#251) |
| `--no-vitals` | Skip the Lighthouse Web-Vitals pass (faster) |
| `--no-auto-selectors` | Skip LLM selector discovery (defaults + learned only) |
| `--lang <pt\|en>` | Default report language (the toggle switches live) |
| `--open` | Open the HTML report when done |

Broken steps (a route the candidate doesn't have, pagination that didn't advance) are
flagged red and listed in a warning banner instead of being reported as a fake win.
