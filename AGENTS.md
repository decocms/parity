# AGENTS.md

Guidance for AI coding agents (Claude Code, Cursor, Aider, etc.) using `parity` to validate or fix a site migration.

## When to run parity

Use `parity run` (or `parity journey` in CI) when the user:

- finished migrating a section / page / route and wants to verify nothing regressed
- mentions "is this still working in cand?" / "compare prod and cand"
- wants a baseline before starting a refactor
- asks for a visual diff or "what's missing in the migration"
- needs a structured artifact (`report.json`) to drive other automation

Do **not** run parity for:

- linting / type errors — that's `tsc`
- single-component unit tests — use vitest
- performance profiling of just one page — use Lighthouse or Chrome DevTools directly

## Picking the command

| User intent                                  | Command                                         |
| -------------------------------------------- | ----------------------------------------------- |
| "is everything still working?"               | `parity run --preset smoke` then `--preset full` if smoke is clean |
| "compare these two URLs in CI"               | `parity journey --prod ... --cand ... --junit ... --github`        |
| "find sections missing in the migration"     | `parity run --visual-pages 5` then read `report.json` `.visualDiff` |
| "did web vitals regress?"                    | `parity vitals --prod ... --cand ... --limit 20`                   |
| "is the new site missing cache?"             | `parity cache --cand ... --pages 30`                               |
| "I want an LLM prompt with all the issues"   | `parity prompt <runId>` (writes Markdown to stdout)                |
| "explain this specific issue"                | `parity explain <runId> <issueId>` (needs `ANTHROPIC_API_KEY`)     |

## Reading the JSON output

`./parity-output/runs/<runId>/report.json` is the source of truth. Key fields:

```ts
{
  verdict: { status: "pass"|"warn"|"fail", score: 0..100, critical, high, medium, low },
  topIssues: Issue[],       // LLM-ranked, deduplicated; usually 5-10 items
  issues: Issue[],          // all raw issues from every check
  checks: CheckResult[],    // one per check; .data has structured details
  visualDiff: {
    pagesChecked, pagesWithDiffs, pagesPassed,
    results: VisualDiffPage[]   // per page: prod/cand screenshots, sections, LLM diffs
  },
  flowCaptures: FlowCapture[]   // per-flow page captures with vitals + network
}
```

To programmatically decide if a migration is ready:

```ts
const run = JSON.parse(fs.readFileSync(`${runDir}/report.json`));
if (run.verdict.critical === 0 && run.verdict.high === 0) {
  // ship it
}
```

## Driving fixes from the output

The most useful flow for an AI agent is:

1. Run `parity run --preset full` → wait → read `report.json`
2. For each `topIssue` with severity ≥ high, open the file(s) referenced in `suggestedFix`
3. For visual diffs: read `visualDiff.results[].sectionsOnlyInProd` — these are Deco sections present in prod's DOM but missing in cand. Most likely cause: not registered in `src/setup.ts → registerSections()`.
4. For console errors: read `issues[].evidence[]` for HAR paths; the failed request is usually the root cause.
5. Re-run `parity journey` (cheaper) after each fix to confirm.

**Important:** prod is the source of truth. Never modify prod-side code to make tests pass — always fix cand.

## When LLM features are unavailable

If neither `ANTHROPIC_API_KEY` nor `OPENROUTER_API_KEY` is set:

- `topIssues` will fall back to deterministic severity-sorted merge (still useful)
- `visualDiff.results[].differences` will be empty (only pixelmatch heatmap survives)
- `sectionsOnlyInProd` is still populated (uses DOM, not vision)
- Selector discovery is skipped; defaults from `.parityrc.json` or platform heuristics kick in

The CLI never fails just because the LLM is unavailable. Issues will still be reported, just less polished.

## Cost-conscious usage

A `--preset full` run with visual diff ≈ 6-12 Claude calls × ~$0.01-0.02 each. Cheap, but in tight loops:

- Use `--preset smoke` first (no LLM, ~30s) to validate the URLs respond
- Use `--no-visual-diff` if you only care about functional checks
- Use `parity journey` (no aggregation step) for the tightest CI loop

Hard caps already in place:

- 12 max Claude Vision calls per `run` (visual diff)
- 8 max selector recovery calls per run
- 120s timeout per Vision call, 60s per text call

## Gotchas

- **First run is slower** — Playwright downloads Chromium (~150MB). After that, ~30s for smoke, ~5min for full.
- **Sites with X-Frame-Options block the side-by-side iframe tab.** Use `parity serve <runId>` which proxies through.
- **Cookies are isolated per run** — no shared session between prod and cand. If a flow needs auth, you'll need to handle that in `.parityrc.json` or extend the flow.
- **Visual diff catches missing sections** mostly via DOM (`data-section`); if the migrated site doesn't emit that attribute, the LLM still sees the screenshots but loses the section-name context.
- **`parity run` doesn't apply schema changes from old runs** — if you change `src/types/schema.ts`, old `report.json` files won't parse. Delete `parity-output/` or re-run.

## Files agents should and should not write

- ✅ `.parityrc.json` (selectors, CEP) — gitignored, per-user
- ✅ `.parityignore` (noise filters) — gitignored
- ✅ Code changes in `src/` of the candidate site
- ❌ Don't commit `learned-selectors.json` (gitignored) — it contains host names
- ❌ Don't commit `parity-output/` — gitignored, can be GB-sized
- ❌ Don't modify `parity-baselines/<name>.json` by hand — use `parity baseline set`
