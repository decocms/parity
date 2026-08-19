# /parity:validate

Run parity (prod × cand) on demand and report the score.

Load `skills/parity-validation/SKILL.md` to pick the right command for the
current migration state. Route execution through `runner`. Report the score,
top 3 issues, and whether the `parity.target` was reached.

Arguments:
- `--pages <list>` — same syntax as `parity run --pages` (supports `prod->cand`)
- `--selector <sel>` + `--cand-selector <sel>` — single-section comparison
- `--benchmark` — run `parity benchmark` instead of `parity run`
