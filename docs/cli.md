# CLI reference

| Command | What it does |
| --- | --- |
| `parity run` | Full comparison run between two URLs |
| `parity pr` | CI/CD entry point: PR-preview vs prod, emits Markdown comment |
| `parity audit` | Single-site absolute audit (console + vitals + SEO + images) |
| `parity e2e` | Single-site functional end-to-end: all flows + all checks |
| `parity journey` | CI-friendly: only the purchase journey, with JUnit / GitHub annotations |
| `parity vitals` | Crawl N pages, compare Web Vitals prod vs cand |
| `parity cache` | CDN cache analysis, opportunities, request categorization |
| `parity serve` | Local HTTP server with iframe proxy so side-by-side tab works for any site |
| `parity report` | Reopen a saved run's HTML report. With `--section <name>`: extract one tab to stdout |
| `parity compare` | Compare a run against a baseline |
| `parity baseline` | Manage baselines (`set`, `list`, `unset`) |
| `parity list` | List saved runs |
| `parity check` | Run a single check (`<name>`) — skips sitemap + LLM aggregation; sub-10s loop |
| `parity console` | Sub-10s capture of console errors/warnings + network failures for one URL |
| `parity html` | Dump page/selector HTML or unified diff prod×cand (prettier + jsdiff) |
| `parity section` | Focused prod×cand diff of a section: HTML + screenshot + computed styles |
| `parity fix` | Pixel-perfect bundle: heatmap + CSS source + LLM-ready Markdown prompt |
| `parity prompt` | Export issues as a Markdown prompt for any LLM |
| `parity explain` | LLM deep-dive on a specific issue (needs API key) |
| `parity learned` | Inspect the learned-selectors library |

Run any command with `--help` for the full flag list.

## Default behavior on `parity run` (no preset)

- `flows=purchase-journey, viewports=mobile,desktop`
- `vitals-pages=10`
- `visual-pages=5` (auto-zeroed when no LLM provider available)
- `auto-selectors=ON` (if LLM available)
- `learn=ON, cache=ON, visual-diff=ON`
- `warmup=OFF, bypass-cache=OFF, ci=OFF`

## Flag convention

- `--X` (no `no-` prefix) → enable / opt-in (default OFF unless preset overrides)
- `--no-X` → disable / opt-out (default ON unless preset overrides)

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

## `parity e2e` — single-site functional run

The `audit` command runs absolute checks (vitals, console, network, images, SEO). `parity e2e` runs **all the functional flows** (homepage, plp, pdp, purchase-journey, search, cart-interactions, optionally login) against a single URL plus all parity checks in single-site mode.

```bash
parity e2e --url https://www.example.com
parity e2e --url https://www.example.com --flows=search,cart-interactions
parity e2e --url https://www.example.com --search-terms="camisa,promocao"

PARITY_LOGIN_EMAIL=test@example.com PARITY_LOGIN_PASSWORD=*** \
  parity e2e --url https://www.example.com --flows=login
```

**Use `parity e2e` when** you want to validate "does this site actually work end-to-end?" — pre-launch, post-deploy, partner sites. **Use `parity run` when** you need to detect *regressions* between two versions.
