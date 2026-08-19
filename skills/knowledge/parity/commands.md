# Parity command reference (for the migration loop)

Grounded in `packages/parity/docs/cli.md` + docs.deco.cx/v2/en/parity/performance.
The `parity-specialist` picks ONE of these per turn; the `runner` executes it.

## The fork that matters: `run` vs `e2e`

- **Have prod AND a candidate?** → `parity run` — a prod↔cand **regression diff**.
  This is the default in the migration loop (prod is the source of truth).
- **Only the migrated build, no prod baseline to diff?** → `parity e2e --url` —
  single-site functional validation (flows + checks, absolute criteria). Use it
  for a quick "does the candidate actually work?" health check.
- Never fake single-site with `parity run --prod X --cand X` — it self-diffs and
  wastes a run. `run` now rejects a missing `--prod`.

## `parity run` — the main loop command

```
parity run --prod <prodUrl> --cand <candUrl> --visual-pages 5
parity run --prod <prodUrl> --cand <candUrl> --pages-file <path>   # cross-path pairs
```

- `--pages-file` — one `prod->cand` pair per line (see parity-validation SKILL);
  needed when a PDP/PLP lives at a different path on cand.
- `--visual-pages N` — how many pages get the visual diff (LLM). Default auto.
- `--only <modules>` / `--skip <modules>` — scope the ~30 checks by module
  (`e2e`, `visual`, `vitals`, …); `--why "<reason>"` records the scope.
- `--preset smoke` for a fast pass, then `--preset full` when smoke is clean.
- Score: `parity-output/runs/<id>/report.json` → `verdict.score` / `verdict.status`.

## `parity section` — one component (porter self-check)

```
parity section --prod <prod+path> --cand <cand+path> --selector '<sel>' --prompt
parity section ... --selector '<prodSel>' --cand-selector '<candSel>' --prompt
```

Focused HTML + screenshot + computed-style diff of a single section. `--prompt`
emits a `*-bundle.json` + `*-prompt.md` the `fixer` reads directly. Use
`--cand-selector` when the ported component's selector differs.

## `parity benchmark` — navigation-timing sign-off

```
parity benchmark --prod <prodUrl> --cand <candUrl>
parity benchmark --prod ... --cand ... --plp /novidades --viewports mobile,desktop --open
```

Warm before/after story (home → PLP → paginate → PDP → shelf), click→first
product-image timing, single shareable HTML. The final gate once the score is
near target. Flags: `--plp <path>` pins the category, `--warmup-runs` (2),
`--measured-runs` (3), `--no-vitals` skips Lighthouse.

## `parity vitals` — Web Vitals across many pages

```
parity vitals --prod <prodUrl> --cand <candUrl> --limit 10
```

LCP/FCP/TTFB/INP/CLS across N sampled pages. `--runs` (median), `--concurrency`
(4), `--viewports`. Use to localize a vitals regression the run flagged.

## `parity cache` — CDN cache opportunities (cand-side)

```
parity cache --cand <candUrl> --pages 30
parity cache --cand <candUrl> --cand-only
```

Fast crawl grouping requests by caching opportunity — catches a migrated build
shipping uncached assets. `--cand-only` skips the prod comparison.

## `parity audit` — single-site absolute checks

```
parity audit --url <url>
```

Console + vitals + SEO + images on ONE url, no comparison. Lighter than `e2e`
(no functional flows) — a quick pre-launch/absolute sanity check.

## Reading the result

`parity-output/runs/<latest>/report.json`:
- `verdict.score` (0–100), `verdict.status` (`pass|warn|fail`)
- `topIssues` (LLM-ranked; first 5 actionable), `visualDiff.parityOk` (bool)

Score bands: <60 significant gaps · 60–79 drift · 80–94 fine-grained · 95–97
target · ≥97 benchmark sign-off.
