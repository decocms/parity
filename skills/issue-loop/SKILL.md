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
