# parity plugin — session start

The **parity** plugin is active. It orchestrates site migrations end-to-end.

## Commands available

| Command | When to invoke |
|---|---|
| `/parity:migrate` | Start or resume a migration for a site |
| `/parity:status` | Show the current phase and score of an active migration |
| `/parity:validate` | Run parity (prod × cand) on demand and report the score |
| `/parity:resume` | Resume from the last saved `.parity/migration.json` |
| `/parity:report` | Build a stakeholder report — deck or executive one-pager |

## Critical rule: dispatch — never work inline

The orchestrator sequences specialist subagents; it does not do their jobs. To
delegate, **invoke the Task tool with `subagent_type: "<agent>"`** (e.g.
`scout`, `porter`, `triager`, `fixer`, `reviewer`, `runner`). Phrases like
"spawn a porter" or "via the runner" in the skills mean exactly that Task call.

**Every shell command goes through the `runner` subagent** — `parity`, `gh`,
`git`, `bun`, `yarn`, `npx`. Never call the Bash tool from the orchestrator.
This keeps the orchestrator context lean and Haiku token costs low for the
repetitive parts. A `PreToolUse` hook enforces it during an active migration:
main-thread bash is denied with a reminder to dispatch to `runner` instead
(subagents and non-migration sessions are unaffected).

## State file

Migration state lives in `.parity/migration.json` in the TARGET repo being
migrated — not in this repo. Phases: discovery → reconcile → repo-setup →
template-bootstrap → workflows → (migrate-script | porting) → build-green →
nav-strategy → triage → fix → parity → performance → benchmark → done.
