---
name: issue-loop
description: How to create, dedup, and close parity-migrate GitHub issues. Load when creating issues from triage or parity report output.
---

# Issue Loop

## Creating issues (dedup first)

```bash
# Check if title already exists before creating
EXISTING=$(gh issue list --repo <owner/repo> --label parity-migrate --json title \
  --jq '.[].title' | grep -F "<title>" | head -1)
if [ -z "$EXISTING" ]; then
  gh issue create --repo <owner/repo> \
    --title "<title>" \
    --body "<body>" \
    --label parity-migrate
fi
```

The `parity-migrate` label is the dedup boundary. Same title = same issue.
Never create a duplicate — it creates noise and confuses the fixer.

## Title convention

```
[<page path>] <component>: <problem>
```

Because dedup is by **title**, the page has to be in it. `ProductShelf: does not
match prod` collides across every page that has a shelf: the first one files, the
rest are silently swallowed as duplicates, and those pages can never be closed.
`[/p] ProductShelf: …` and `[/] ProductShelf: …` are two issues, which is
correct — they are two pieces of work.

Omit the prefix only for findings that genuinely have no page (repo-wide config,
build setup).

## Never file these

Read the component's `status` in `.parity/migration-plan.json` first:

- `as-is` — the divergence is accepted. Not a bug, not even `low`.
- `upgrade` — the target is deliberately ahead of prod. A "does not match prod"
  issue here is wrong by construction; prod is not its reference. If it has a
  `reference` and diverges from *that*, file it normally.
- `skipped` — out of scope.

Filing one of these re-opens a decision the user already made, every round.

## Issue body template

```markdown
## Context
<what page/component, when observed>

## Error / observation
<file:line, selector, or URL>

## Fix hint
<smallest actionable change>
```

Body ≤ 1200 chars. Longer context → link to the parity report instead.

## Importing from parity report

```bash
# Read topIssues from the latest report
cat parity-output/runs/$(ls parity-output/runs | sort | tail -1)/report.json \
  | jq '.topIssues[:5][]' \
  | jq -r '"**" + .summary + "**\n\n" + (.detail // "")'
```

## Closing issues

The `fixer` closes via `gh pr create` body (`Closes #N`). After the PR merges,
the issue closes automatically. Never close manually unless the issue is no
longer valid.

## Listing open issues for a round

```bash
gh issue list --repo <owner/repo> --label parity-migrate --state open \
  --json number,title,body --limit 10
```
