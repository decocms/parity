---
name: parity-validation
description: How to run parity correctly for each case in a migration. Load when running parity run / section / benchmark or interpreting the score.
---

# Parity Validation

## Command selection (delegate to `parity-specialist`)

Always ask `parity-specialist` for the exact command. Never guess flags —
the `prod->cand` pair syntax and `--cand-selector` only exist since v0.22.

## Reading the score

```
parity-output/runs/<latest-runId>/report.json
→ verdict.score          // 0–100, higher = closer to prod
→ verdict.status         // "pass" | "warn" | "fail"
→ topIssues              // LLM-ranked array, first 5 are actionable
→ visualDiff.parityOk    // boolean — binary signal for visual equality
```

Score interpretation during migration:
- < 60: significant gaps, multiple high/critical issues
- 60–79: major sections ported, some visual/content drift
- 80–94: mostly matching, fine-grained issues
- 95–97: target threshold — benchmark is next
- ≥ 97: ready for benchmark sign-off

## When a parity run produces issues about parity itself

A bug in parity (hanging browser, wrong selector, broken screenshot) is NOT a
site issue. File it on `decocms/parity` repo (not the migration target):
`gh issue create --repo decocms/parity --title "..." --body "..."`

## `--pages-file` format for cross-path pairs

```
# One entry per line; blank lines and # comments ignored
/                         # same path both sides
/encimera-gc60/p->/ar-condicionado-12k/p   # different PDPs
```

Write the file to `.parity/pages.txt` in the target repo.

## Single-section loop (a porter validating their component)

```bash
parity section \
  --prod https://prod.example.com \
  --cand http://localhost:3000 \
  --selector '.vtex-store-components-3-x-container' \
  --cand-selector '[data-fs-product-shelf]' \
  --prompt
```

The `--prompt` flag emits a `*-bundle.json` + `*-prompt.md` the fixer can
read directly to understand the delta.
