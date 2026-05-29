# @decocms/parity

E2E parity validator for site migrations. CLI that runs comparative tests between two URLs — `prod` (source of truth) and `cand` (migrated version) — and produces a single HTML report flagging UI, functional, SEO, and Web Vitals regressions.

Built originally for Fresh → TanStack Start migrations of Deco storefronts, but the checks are generic enough for any side-by-side migration.

> **Status:** alpha. APIs and report layout may still change.

## What it checks

| Check                         | What it catches                                                        |
| ----------------------------- | ---------------------------------------------------------------------- |
| HTTP status parity            | Routes that 404 / 500 in cand but worked in prod                       |
| Console errors                | New hydration mismatches, failed fetches, JS exceptions                |
| HTML structural diff          | Section / element counts drifting beyond tolerance                     |
| Meta / SEO parity             | `<title>`, `<meta description>`, canonical, og:\*, twitter:\*, JSON-LD |
| **Visual diff (LLM Vision)**  | Sections missing, wrong hero, broken shelf, layout shifts              |
| Purchase journey              | Home → PLP → PDP → CEP → cart → checkout completes in both             |
| Network summary               | Request count / bytes / cache hit rate                                 |
| Web Vitals                    | LCP, FCP, TTFB, INP, CLS — mobile                                      |
| Image loading health          | Missing alt text, no srcset, broken `<img>`                            |
| Lazy section presence         | Deco `/deco/render` and `/_loader/*` routes responding                 |
| SEO deep audit                | robots.txt, sitemap, noindex regressions                               |
| Cache coverage                | Cache hit rate, opportunities to cache                                 |
| **Search presence**           | Search input reachable from home in both                               |
| **Search autocomplete**       | Typing reveals suggestions; cand keeps parity with prod                |
| **Search results**            | Same keyword returns comparable product counts                         |
| **Search no-results**         | Unicode garbage term shows empty state, doesn't match products         |
| **Cart interactions**         | Increment / decrement / coupon / remove all behave in cand             |
| **404 parity**                | Invalid URL returns 404 (no catch-all 200 in cand)                     |
| **Cookie/CEP modal CLS**      | Modals don't introduce layout shifts >0.1 in cand                      |
| **PDP gallery + related**     | Image gallery + "Related products" shelf still render                  |
| **Footer links health**       | Institutional links (privacy, contact, etc.) aren't broken in cand     |
| **Login flow** _(opt-in)_     | Valid credentials log in; invalid ones show a clear error              |

All results are aggregated (optionally via Claude) and ranked by severity. Each issue includes screenshots, reproduction, and a suggested fix.

## Quickstart

```bash
# Install
npm install -g @decocms/parity
# or run without install
npx @decocms/parity run --prod ... --cand ...

# First-time smoke run (~30s, no LLM needed)
parity run \
  --prod https://oldsite.com \
  --cand https://newsite.example.dev \
  --preset smoke --open

# Full audit with visual diff (set ANTHROPIC_API_KEY for the LLM bits)
ANTHROPIC_API_KEY=sk-... parity run \
  --prod https://oldsite.com \
  --cand https://newsite.example.dev \
  --preset full --open
```

## Presets

`--preset smoke` — homepage only, mobile only, no LLM, no extra crawl. Use to validate the pipeline runs at all (~30s).

`--preset full` — purchase journey, mobile + desktop, 5 visual diff pages, 10 vitals pages, LLM enabled if API key is set. Use for releases.

`--preset ci` — purchase journey on mobile, smaller crawls (3 visual + 5 vitals). Tuned for CI runtime.

Individual flags always override the preset.

## Commands

| Command            | What it does                                                                  |
| ------------------ | ----------------------------------------------------------------------------- |
| `parity run`       | Full comparison run between two URLs                                          |
| `parity audit`     | **Single-site** absolute audit (no prod×cand). Console + Vitals + SEO + Imgs  |
| `parity e2e`       | **Single-site** functional end-to-end: all flows + all checks. ONE URL.       |
| `parity journey`   | CI-friendly: only the purchase journey, with JUnit / GitHub annotations       |
| `parity vitals`    | Crawl N pages, compare Web Vitals prod vs cand                                |
| `parity cache`     | CDN cache analysis, opportunities, request categorization                     |
| `parity serve`     | Local HTTP server with iframe proxy so side-by-side tab works for any site    |
| `parity report`    | Reopen an existing run's HTML report                                          |
| `parity compare`   | Compare a run against a baseline                                              |
| `parity baseline`  | Manage baselines (`set`, `list`, `unset`)                                     |
| `parity list`      | List saved runs                                                               |
| `parity check`     | Run a single check (`<name>`) — skips sitemap + LLM aggregation; sub-10s loop |
| `parity console`   | Sub-10s capture of console errors/warnings + network failures for one URL     |
| `parity html`      | Dump page/selector HTML or unified diff prod×cand (prettier + jsdiff)         |
| `parity section`   | Focused prod×cand diff of a section: HTML + screenshot + computed styles      |
| `parity fix`       | Pixel-perfect bundle: heatmap + CSS source + LLM-ready Markdown prompt        |
| `parity prompt`    | Export issues as a Markdown prompt for any LLM                                |
| `parity explain`   | LLM deep-dive on a specific issue (needs `ANTHROPIC_API_KEY`)                 |
| `parity learned`   | Inspect the learned-selectors library                                         |

Run any command with `--help` for the full flag list.

## Output

```
./parity-output/runs/<runId>/
├── report.html       # standalone, open in any browser
├── report.json       # structured output for CI / tooling
├── screenshots/      # per-page, per-viewport, per-side; includes pixelmatch heatmaps
├── har/              # Playwright HARs (one per viewport/side)
├── traces/           # Playwright traces — drag into trace.playwright.dev
└── console/          # console messages captured per page
```

Plus `./parity-baselines/<name>.json` for git-trackable baseline manifests.

## Visual Diff tab

When `--visual-pages > 0` and an LLM key is set, the report's **Visual Diff** tab shows, per page:

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
- `section-<hash>-prompt.md` — **paste-ready** Markdown with embedded images, computed-style deltas, CSS source per property, HTML diff, and an opinionated "summarize what you understand first, no code yet" instruction

If `ANTHROPIC_API_KEY` is set, the LLM is invoked automatically and prints a one-paragraph diagnosis to stdout (uses Claude Vision on the screenshots). Pass `--no-llm` to stay offline.

The same flags are available individually on `parity section`: `--heatmap`, `--css-source`, `--prompt`, `--llm-summary`. Use those when you only need one signal; `parity fix` is the "do everything" shortcut.

## `parity e2e` — single-site functional run

The `audit` command runs absolute checks (vitals, console, network, images, SEO) — useful but doesn't exercise interactions. `parity e2e` runs **all the functional flows** (homepage, plp, pdp, purchase-journey, search, cart-interactions, optionally login) against a single URL plus all parity checks in single-site mode.

```bash
# Quick e2e for a single site (no comparison, ~3-5min)
parity e2e --url https://www.example.com

# Pick specific flows
parity e2e --url https://www.example.com --flows=search,cart-interactions

# Override LLM-discovered search term
parity e2e --url https://www.example.com --search-terms="camisa,promocao"

# With login (credentials via env or flags)
PARITY_LOGIN_EMAIL=test@example.com PARITY_LOGIN_PASSWORD=*** \
  parity e2e --url https://www.example.com --flows=login
```

**Use `parity e2e` when** you want to validate "does this site actually work end-to-end?" — pre-launch, post-deploy, partner sites. **Use `parity run` when** you need to detect *regressions* between two versions (prod vs migration candidate).

## Configuration (optional)

`.parityrc.json` at the project root — selector overrides and run defaults:

```json
{
  "cep": "01310-100",
  "selectors": {
    "categoryLink": "header a[href*='/c/']",
    "productCard": "[data-product-card] a",
    "buyButton": "button:has-text('Comprar')",
    "minicartTrigger": "[data-minicart-trigger]",
    "cepInputPdp": "input[name='shipping-zipcode']",
    "cepInputCart": "input[name='cart-zipcode']",
    "checkoutButton": "a:has-text('Finalizar compra')",
    "searchInput": "input[type='search']",
    "cartCouponInput": "input[name*='coupon']"
  },
  "search": {
    "terms": ["camisa", "promocao"]
  },
  "footer": {
    "maxLinks": 20,
    "followExternal": false
  },
  "notFound": {
    "testUrl": "/this-page-definitely-does-not-exist"
  },
  "login": { "enabled": true }
}
```

> **Credentials are NEVER read from `.parityrc.json`.** Set `PARITY_LOGIN_EMAIL` and `PARITY_LOGIN_PASSWORD` as environment variables (`.parityrc.json` is for non-secret config only).

`.parityignore` — noise suppression:

```json
{
  "ignoreSelectorsVisual": [".banner-rotativo", "#trustvox-trustbar"],
  "ignoreRequestPatterns": ["*.gif?t=*", "**/pixel*"],
  "ignoreConsolePatterns": ["ERR_BLOCKED_BY_CLIENT"]
}
```

Both files are gitignored by default — they're per-user, not per-repo.

## LLM (optional)

Set **one** environment variable to unlock LLM-driven features:

- `ANTHROPIC_API_KEY` — direct Anthropic API (Claude Sonnet 4.6 with prompt caching). Preferred.
- `OPENROUTER_API_KEY` — OpenRouter (default model `anthropic/claude-sonnet-4.5`; override with `PARITY_OPENROUTER_MODEL`).

What LLM enables:

- **Issue aggregation** — flat raw issues become ranked, deduplicated top issues
- **Selector discovery** — infers `categoryLink` / `productCard` / `buyButton` etc. from HTML
- **Step recovery** — when a flow step fails, suggest a working selector
- **Visual semantic diff** — Claude Vision interprets pixel diffs as missing sections / wrong layout / etc.
- **PLP picker / PDP matcher** — cross-site disambiguation
- **`parity explain <issue>`** — root-cause analysis on demand

Without any key, the CLI still runs and outputs raw check results — only the smart bits are skipped. Deterministic fallbacks always apply.

**Cost** — A `--preset full` run with visual diff uses ~6-12 Claude calls (each with 2 screenshots). Roughly $0.05–$0.20 per run on Sonnet 4.6 with prompt caching.

## CI usage

```yaml
- name: Parity check
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
  run: |
    npx @decocms/parity journey \
      --prod ${{ vars.PROD_URL }} \
      --cand ${{ env.PR_PREVIEW_URL }} \
      --junit parity.junit.xml \
      --github
```

`parity journey` emits GitHub Actions `::error` and `::warning` annotations for each failed step and writes JUnit XML.

## Development

```bash
git clone git@github.com:decocms/parity.git
cd parity
bun install
bunx playwright install chromium
bun run dev run --prod ... --cand ...
```

Tests: `bun run test` (vitest). Typecheck: `bun run check`. Build: `bun run build`.

## License

MIT
