# @decocms/parity

> **Infrastructure for agents in loop to close migrations, PRs, and incidents without a dev on the critical path.**

`parity` is a CLI that runs deep comparative tests between two URLs — `prod` (source of truth) and `cand` (migrated version, PR preview, or staging) — and produces:

- A standalone **HTML report** for humans to scan in 30 seconds
- A normalized **JSON projection** (`parity report --section <name> --json`) that agents can consume without parsing HTML
- A **JSONL stream** (`--json`) that streams each check result as it completes
- A **PR comment** (`parity pr --prod ... --preview ...`) ready to drop into a CI/CD pipeline

It checks UI, functional, SEO, performance, console, network, and cache regressions. Built originally for Fresh → TanStack Start migrations of Deco storefronts, but the checks are generic enough for any side-by-side migration.

> **Status:** alpha. APIs and report layout may still change.

## Why parity exists

Migrations, PR reviews, and incident triage all share the same workflow: take two versions of a site, find what's different, fix it. Doing this by hand is slow and error-prone; spinning up an LLM agent to do it requires a tool the agent can drive. `parity` is that tool.

Three use cases drive the design:

1. **Assisted migration** (Fresh → TanStack, Shopify → Hydrogen, etc.) — an agent runs `parity run` on the migrated branch every commit, picks the top issue, fixes it, runs again. The HTML report + visual-diff prompt are both designed to be paste-ready into Claude / ChatGPT.
2. **CI/CD PR review** — `parity pr --prod ... --preview ...` outputs a Markdown comment with verdict, top issues, and a link back to the full report. Drop it into a workflow with `gh pr comment -F` or `actions/github-script`.
3. **Continuous smoke** — `parity run --preset smoke` finishes in ~30s and runs no LLM. Cheap enough to ping after every deploy.

## Quickstart

```bash
# Install
npm install -g @decocms/parity
# or run without install
npx @decocms/parity run --prod ... --cand ...

# First-time smoke run (~30s, no LLM needed)
parity run --prod https://oldsite.com --cand https://newsite.example.dev --preset smoke --open

# Full audit with visual diff
ANTHROPIC_API_KEY=sk-... parity run \
  --prod https://oldsite.com \
  --cand https://newsite.example.dev \
  --preset full --open

# CI/CD PR comment
parity pr --prod https://oldsite.com --preview https://pr-123-preview.example.dev --github
```

## Agent contract

For agents driving `parity` in a loop, the stable surface is:

| Need | Command | Output |
| --- | --- | --- |
| Run a full comparison | `parity run --prod X --cand Y --json runs.jsonl` | JSON-Lines, one line per check |
| Extract one tab from a saved run | `parity report <runId> --section <name>` | HTML slice |
| Extract one tab as structured JSON | `parity report <runId> --section <name> --json` | JSON projection |
| Drive a CI/CD pipeline | `parity pr --prod X --preview Y --github` | Markdown comment + `$GITHUB_STEP_SUMMARY` |
| Drill into one issue | `parity explain <runId> <issueId>` | LLM deep-dive (needs key) |
| Build a paste-ready prompt | `parity prompt <runId>` | Markdown ready for Claude/ChatGPT |
| Generate visual-fix bundle | `parity fix --prod X --cand Y --selector S` | Markdown + screenshots + computed-styles diff |

See [`docs/cli.md`](./docs/cli.md) for every command, [`docs/checks.md`](./docs/checks.md) for every check.

## LLM providers

Three providers, auto-detected in this order — **none required** if you have the `claude` CLI logged in locally:

1. `ANTHROPIC_API_KEY` — direct Anthropic API (fastest, billed to your API account)
2. `OPENROUTER_API_KEY` — OpenRouter
3. **Local `claude` CLI** — uses [`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk); goes through your existing Claude plan. No env vars needed

Force with `--llm <anthropic|openrouter|claude-code|none|auto>`. Override per-feature with `--llm-model visual-diff=claude-opus-4-7,explain=claude-opus-4-7`, or flatten everything to one tier with `--llm-tier-default <haiku|sonnet|opus>`. Default tiers: **Sonnet** for selector discovery / recovery / matching / vision / aggregation (the structural-reasoning calls), **Haiku** for short copy-list classification (`search-terms`), **Opus** for `explain`. Cost-conscious? Try `--llm-tier-default haiku` and bump features back to Sonnet selectively if you hit selector misses.

Without any provider, the CLI still runs and outputs raw check results — only the LLM-tagged tabs (Visual Diff, LLM Prompt) hide themselves and a banner explains why.

## Output

```
./parity-output/runs/<runId>/
├── report.html       # standalone, open in any browser
├── report.json       # structured output for agents / CI / tooling
├── screenshots/      # per-page, per-viewport, per-side; includes pixelmatch heatmaps
├── har/              # Playwright HARs (one per viewport/side)
├── traces/           # Playwright traces — drag into trace.playwright.dev
└── console/          # console messages captured per page
```

## Presets

- `--preset smoke` — homepage only, mobile only, no LLM, no extra crawl. ~30s. Use for "did the pipeline even run?".
- `--preset full` — purchase journey, mobile + desktop, 5 visual diff pages, 10 vitals pages. Use for releases.
- `--preset ci` — purchase journey on mobile, smaller crawls (3 visual + 5 vitals). Tuned for CI runtime.

Individual flags always override the preset. See `parity run --help` for the full default behavior breakdown.

## CI usage (GitHub Actions)

```yaml
- name: Parity check
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
  run: |
    npx @decocms/parity pr \
      --prod ${{ vars.PROD_URL }} \
      --preview ${{ env.PR_PREVIEW_URL }} \
      --github
```

The `--github` flag writes the Markdown to `$GITHUB_STEP_SUMMARY` so it shows up under the workflow summary. To also post as a PR comment:

```yaml
    npx @decocms/parity pr ... --out parity-comment.md
- uses: actions/github-script@v7
  with:
    script: |
      const fs = require('fs');
      const body = fs.readFileSync('parity-comment.md', 'utf8');
      github.rest.issues.createComment({
        ...context.repo,
        issue_number: context.issue.number,
        body,
      });
```

## Configuration (optional)

`.parityrc.json` at the project root — selector overrides and run defaults. See [`docs/config.md`](./docs/config.md) for the full schema.

```json
{
  "cep": "01310-100",
  "selectors": {
    "categoryLink": "header a[href*='/c/']",
    "productCard": "[data-product-card] a",
    "buyButton": "button:has-text('Comprar')"
  },
  "search": { "terms": ["camisa", "promocao"] }
}
```

`.parityignore` — noise suppression. See `docs/config.md`.

> **Credentials are NEVER read from `.parityrc.json`.** Set `PARITY_LOGIN_EMAIL` and `PARITY_LOGIN_PASSWORD` as environment variables.

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
