# parity plugin — session start

The **parity** plugin is active. It orchestrates site migrations end-to-end.

## Commands available

| Command | When to invoke |
|---|---|
| `/parity:migrate` | Start or resume a migration for a site |
| `/parity:status` | Show the current phase and score of an active migration |
| `/parity:validate` | Run parity (prod × cand) on demand and report the score |
| `/parity:resume` | Resume from the last saved `.parity/migration.json` |

## Critical rule: bash is always routed through the `runner` agent

No shell commands run directly from the orchestrator. Every `parity`, `gh`,
`git`, `bun`, or `yarn` call goes through the `runner` agent (Haiku, read-only
tools for analysis phases, full tools for build phases). This keeps the
orchestrator context lean and Haiku token costs low for the repetitive parts.

If you see yourself about to run a bash command, delegate it to `runner` instead.

## State file

Migration state lives in `.parity/migration.json` in the TARGET repo being
migrated — not in this repo. Phases: discovery → reconcile → repo-setup →
template-bootstrap → workflows → (migrate-script | porting) → build-green →
triage → fix → parity → benchmark → done.
