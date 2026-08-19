# /parity:migrate

Start or resume a migration for a site.

## Trigger

Load `skills/migration-orchestrator/SKILL.md` and follow it from the current
phase in `.parity/migration.json` (or from `discovery` if no state exists).

## Arguments (optional)

- `--url <prod-url>` — skip URL discovery
- `--source <dir>` — path to the source repo (skips repo detection)
- `--target <name>` — `tanstack-deco` or `faststore-v4` (skips the question)
- `--target-dir <dir>` — path to the candidate repo (skips repo-setup)
- `--resume` — force resume even if last phase is ambiguous

## First turn

1. Check for `.parity/migration.json` in the current directory or any parent.
2. If found: announce the current phase and ask "Resume from <phase>?"
3. If not found: run discovery (delegate to `scout`, then prompt for target).
4. Write or update `.parity/migration.json`.
5. Advance one phase at a time, reporting progress.
