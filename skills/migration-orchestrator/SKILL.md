---
name: migration-orchestrator
description: Orchestrates a full site migration end-to-end. Load when the user asks to migrate a site, start a migration, or resume one. This is the main entry point.
---

# Migration Orchestrator

Drives the migration lifecycle from first capture to benchmark sign-off. State
lives in `.parity/migration.json` in the TARGET repo. Every bash call goes
through the `runner` agent — never run commands directly.

## Phase machine

```
discovery → reconcile → repo-setup → template-bootstrap → workflows
→ [migrate-script | porting] → build-green → triage → fix → parity
→ [loop back to triage if score < target] → benchmark → done
```

**Decision at porting fork:**
- Source is `deco-fresh` → `migrate-script` (runs `deco-migrate`)
- Source is `vtex-io` or `live-only` → `porting` (one `porter` per component)

## State schema (`.parity/migration.json`)

```jsonc
{
  "phase": "discovery",           // current phase
  "round": 0,                     // triage→fix→parity iteration count
  "source": {
    "kind": "vtex-io",            // deco-fresh | vtex-io | live-only
    "repo": null,                 // local path to source repo, if any
    "prodUrl": "https://..."
  },
  "target": {
    "name": "faststore-v4",       // tanstack-deco | faststore-v4
    "repo": "owner/repo",         // GitHub repo of the candidate
    "dir": "/path/to/candidate"   // local clone path
  },
  "conventions": {                // populated by scout find-conventions
    "files": [],
    "rules": [],
    "gates": []
  },
  "pagePairs": [],                // [{prod, cand, kind}] for cross-path pairing
  "components": [],               // [{name, status, file}] from migration-plan.json
  "budget": { "fixRounds": 6, "used": 0 },
  "parity": { "lastScore": null, "target": 97, "reportPath": null }
}
```

## Phase-by-phase instructions

### discovery
Delegate to `scout` with `task: "full-discovery"`. Merge result into state.
Ask the user: "What is the output target? (tanstack-deco / faststore-v4)"
Set `source.prodUrl` if not found automatically.

### reconcile
1. If `source.repo` exists: run `parity migrate --source <dir> --url <prodUrl>`
   via `runner` to get `migration-plan.json`.
2. If no source: run `parity migrate --url <prodUrl>`.
3. Read `migration-plan.json` → populate `components` with `status: "pending"`.
4. If target already has work done (FastStore: read `src/components/index.tsx`;
   TanStack: read `src/components/index.tsx`), mark matching components as `"done"`.
5. If target has a backlog file (`docs/todo-radar.md`), read it and import
   open items as issues via `gh issue create` with label `parity-migrate` ONLY
   if no issue with the same title already exists.
6. `pendingComponents` = components where `status === "pending"`.

### repo-setup / template-bootstrap
- **TanStack**: scaffold by **copying the code** from `deco-sites/storefront-tanstack`
  (public) into the new repo — `git clone` it, copy the tree, re-init git and set
  the new remote. NOT `gh repo create --template`: copying its current `main` means
  each migration inherits the template's latest improvements.
  (Skip this entirely when the source is `deco-fresh` — `deco-migrate` scaffolds
  the target from the original repo in the `migrate-script` phase.)
- **FastStore v4**: user must provide the repo (created via VTEX Onboarding).
  Ask for the repo path / URL. Clone it locally.
Load skill `skills/target-faststore-v4/SKILL.md` or `skills/target-tanstack-deco/SKILL.md`.

### workflows
The target repo should be **born with CI/CD**. Where it comes from depends on the path:

- **deco-fresh → TanStack**: `deco-migrate` (the `migrate-script` phase) already
  scaffolds the CI workflows — `ci`, `parity`, `perf`, `playwright`, `react-doctor`,
  `lockfile-check`, `main-push-guard` (rendered from
  `decocms/blocks` `packages/blocks-cli/scripts/migrate/templates/*-yml.ts`). Here the
  `workflows` phase only **verifies** `.github/workflows/` has them and doesn't
  re-create.
- **template scaffold (vtex-io / live-only → TanStack)**: the copied
  `deco-sites/storefront-tanstack` carries its deploy setup (`deploy.yml` on push to
  `main` + Cloudflare **Workers Builds** GitHub App for per-PR previews; see its
  `.github/workflows/README.md`). Confirm the required secrets
  (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`) are set. If the richer CI
  (parity/perf/playwright) is wanted, pull those yml from the same blocks-cli
  migrate templates.
- **FastStore v4**: use the FastStore release workflow pattern.

Never leave the repo without a deploy workflow — a migration that can't ship isn't done.

### migrate-script (deco-fresh only)
Via `runner`: `bun run predev && npx -p @decocms/blocks-cli deco-migrate --verbose 2>&1 | tail -100`
After: advance to `build-green`.

### porting (vtex-io / live-only)
For each `pending` component in `components` (parallel where safe, sequential
when the component has a `global` scope dependency):
1. Spawn a `porter` with the component name + migration-plan entry + target conventions.
2. Porter signals done → update `status: "done"`.
3. When all globals done, start page components.
After all done: advance to `build-green`.

### build-green
Via `runner`: run the target's build command. If it fails, spawn a `builder`.
Repeat until `runner` reports exit 0. Cap at 3 attempts before escalating to
the user.

### triage
Spawn `triager`. It surveys the migrated repo and returns issue drafts.
Create GitHub issues via `gh issue create --label parity-migrate` (skip if
title already exists — check with `gh issue list --label parity-migrate`).
Advance to `fix`.

### fix
For each open `parity-migrate` issue (up to 5 per round):
- Spawn `fixer` with the issue body.
- Fixer creates a commit + PR.
After each fixer, run `runner` with the build command to catch regressions.
Increment `round`. Advance to `parity`.

### parity
Load skill `skills/parity-validation/SKILL.md`.
`parity-specialist` picks the right command, `runner` executes it.
Extract `score` from report JSON (`parity-output/runs/<id>/report.json`).
Update `parity.lastScore`.
- If `score >= parity.target` → advance to `benchmark`.
- If `round < budget.fixRounds` → go back to `triage`.
- Else → ask the user whether to raise the round budget or accept the score.

### benchmark
Via `runner`: `parity benchmark --prod <prodUrl> --cand <candUrl> 2>&1 | tail -60`
Report the result to the user. If there are regressions, loop back to `triage`.
Otherwise → `done`.

## Token discipline

Never load more than ONE skill reference per turn. The orchestrator passes the
path of any extra reference in the agent prompt, not in its own context.

## Conventions discipline

When dispatching a `porter` or `fixer` to the TARGET repo, ALWAYS include the
`conventions.rules` and `conventions.gates` from state. The porter/fixer must
obey the target repo's rules (e.g. mobile-first, no `:global()`, only `--fs-*`
tokens for FastStore) — do not impose parity's own conventions on top.
