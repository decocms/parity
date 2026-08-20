---
name: migration-orchestrator
description: Orchestrates a full site migration end-to-end. Load when the user asks to migrate a site, start a migration, or resume one. This is the main entry point.
---

# Migration Orchestrator

Drives the migration lifecycle from first capture to benchmark sign-off.

## Dispatching — READ THIS FIRST

You are the orchestrator. You do **not** do the work yourself — you dispatch it
to specialist subagents and sequence their results. "Delegate to X", "spawn X",
and "via X" below all mean exactly one thing:

> **Invoke the Task tool with `subagent_type: "<agent>"`** and a prompt carrying
> everything that agent needs (task name, paths, the relevant `conventions`,
> the plan entry). Then read its reply and continue.

The agents are: `scout`, `porter`, `builder`, `spa-strategist`, `triager`,
`fixer`, `reviewer`, `parity-specialist`, `perf-optimizer`, `fallbacker`, and
`runner`. Never inline a specialist's job (do not triage, port, or fix in your
own context) — that defeats the whole design and burns your context window.

**Every shell command goes through the `runner` subagent** — `parity`, `gh`,
`git`, `bun`, `yarn`, `npx`, everything. Never call the Bash tool yourself. A
`PreToolUse` hook enforces this during an active migration: if you try to run
bash on the main thread it is denied with a reminder to dispatch to `runner`.
To run a command, invoke the Task tool with `subagent_type: "runner"` and pass
the command as its `cmd`.

## State file location

State lives in `.parity/migration.json` **in the TARGET repo**, not wherever the
command was invoked (the user often runs `/parity:migrate` from the parity repo
itself). Resolve it once, at the start of every turn:

1. If `state.target.dir` is already set, use `<target.dir>/.parity/migration.json`.
2. Otherwise walk **up** from `cwd` looking for a `package.json` whose `name` (or
   git remote) matches `state.target.repo`; the `.parity/` dir sits beside it.
3. If neither resolves (first run, no target yet), keep state in memory and write
   it only after `repo-setup` establishes `target.dir`. Never scatter a
   `.parity/` into the parity repo or an unrelated cwd.

## Plan file — the single source of truth for components

The component list and each component's porting `status` live in ONE place:
`<target.dir>/.parity/migration-plan.json`, produced by `parity migrate`. The
state file does **not** duplicate it. Once `target.dir` exists (`repo-setup`),
copy the plan there and treat that path as canonical for the rest of the run
(it survives a resume — see `/parity:resume`).

Never hand-edit the JSON. Flip a component's status through the CLI, via `runner`:

```
parity plan set-status <name> <pending|done|skipped> --dir <target.dir>/.parity
```

Name matching is case- and separator-insensitive (`product-shelf` == `ProductShelf`).

## Reading a `runner` reply

The `runner` is a subagent — its reply is **prose that ends with a JSON line**,
not a raw JSON payload. Parse it defensively: take the **last** `{…}` block in
the reply and `JSON.parse` it. If there is no parseable object, re-dispatch the
same `cmd` once (the runner is told to return only the object). Never assume the
whole message is JSON.

## Phase machine

```
discovery → reconcile → repo-setup → template-bootstrap → workflows
→ [migrate-script | porting] → build-green → nav-strategy → triage → fix → parity
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
  // components + their porting status live in <target.dir>/.parity/migration-plan.json,
  // NOT here. Flip status via `parity plan set-status` (see "Plan file" above).
  "budget": { "fixRounds": 6, "used": 0 },
  "parity": { "lastScore": null, "target": 97, "reportPath": null }
}
```

## Phase-by-phase instructions

### discovery
Delegate to `scout` with `task: "full-discovery"`. Merge result into state.
Ask the user: "What is the output target? (tanstack-deco / faststore-v4)" — and state
the tradeoff: **`tanstack-deco` renders standalone from props/loaders (a blind live-only
migration is viewable end-to-end); `faststore-v4` is coupled to the client's VTEX account
— it builds from code, but RENDERING needs content synced to the account's headless CMS
(`faststore cms-sync`, account write access) + the `faststore` custom app.** For a
no-account/live-only migration, faststore-v4 yields buildable code but not a running site.
Set `source.prodUrl` if not found automatically.

### reconcile
1. If `source.repo` exists: run `parity migrate --source <dir> --url <prodUrl>`
   via `runner` to get `migration-plan.json`.
2. If no source: run `parity migrate --url <prodUrl>`.
3. `parity migrate` writes `migration-plan.json` (all rows `status: "pending"`)
   under its `--out` dir (`./parity-migrate/<host>/`). Once `target.dir` exists,
   copy it to the canonical `<target.dir>/.parity/migration-plan.json`.
4. If target already has work done (read `src/components/index.tsx`), mark each
   matching component done: `parity plan set-status <name> done --dir <target.dir>/.parity`.
5. If target has a backlog file (`docs/todo-radar.md`), read it and import
   open items as issues via `gh issue create` with label `parity-migrate` ONLY
   if no issue with the same title already exists.
6. `pendingComponents` = plan rows still `status: "pending"`.

### repo-setup / template-bootstrap
- **TanStack**: scaffold by **copying the code** from `deco-sites/storefront-tanstack`
  (public) into the new repo — `git clone` it, copy the tree, re-init git and set
  the new remote. NOT `gh repo create --template`: copying its current `main` means
  each migration inherits the template's latest improvements.
  (Skip this entirely when the source is `deco-fresh` — `deco-migrate` scaffolds
  the target from the original repo in the `migrate-script` phase.)
- **FastStore v4**: scaffold by **copying the code** from `deco-sites/storefront-faststore`
  (the deco FastStore template — ships ui atoms/organisms, sdk, hooks, i18n runtime,
  section patterns, cms schemas, scripts, gates, so ports compose over real infra). Clone,
  copy the tree, re-init git, set the new remote. Then set the store via env
  (`VTEX_STORE_ID`, `VTEX_WORKSPACE`, `CONTENT_SOURCE_PROJECT`) — the source VTEX account is
  the `*.vtexassets.com` subdomain in `blocks.json`; locale/currency from the DOM. Replace
  the template's example brand theme + assets. Fall back to bare `vtex-sites/starter.store`
  only if the template is unavailable (ports come out monolithic). See
  `target-faststore-v4/SKILL.md`.
Load skill `skills/target-faststore-v4/SKILL.md` or `skills/target-tanstack-deco/SKILL.md`.

### workflows
The target repo should be **born with CI/CD**. Where it comes from depends on the path:

- **deco-fresh → TanStack**: `deco-migrate` (the `migrate-script` phase) already
  scaffolds the CI workflows — `ci`, `parity`, `perf`, `playwright`, `react-doctor`,
  `lockfile-check`, `main-push-guard` (rendered from
  `decocms/blocks` `packages/blocks-cli/scripts/migrate/templates/*-yml.ts`). Here the
  `workflows` phase only **verifies** `.github/workflows/` has them and doesn't
  re-create.
- **template scaffold (vtex-io / live-only → TanStack)**:
  ⚠️ **NEVER create a deploy workflow for `tanstack-deco`.** Deploys are handled
  exclusively by the **Cloudflare Workers Builds GitHub App** — no workflow files
  needed. If a `deploy.yml` (or similar) exists in `.github/workflows/`, **delete
  it** before the first PR via runner:
  ```
  rm .github/workflows/deploy.yml
  git commit -am "remove: deploy workflow (CF Workers Builds handles this)"
  git push
  ```
  The app detects pushes to `main` and posts per-PR preview links via the
  `cloudflare-workers-and-pages` bot.

  **Verify the app is active:**
  1. Via runner: open the first PR.
  2. Wait ~3 minutes.
  3. Via runner: `gh pr view <pr> --json comments --jq '.comments[].author.login' | grep cloudflare`
  4. **Bot commented** → CF Workers Builds is active. Verify secrets via
     `gh secret list` (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`). Phase done.
  5. **Bot did not comment after 3 min** → app not installed. Guide the user:

     > Cloudflare Workers Builds is not connected to this repository.
     > To enable automatic deploys (PR preview links + push-to-main deploy):
     >
     > 1. Go to https://dash.cloudflare.com → **Workers & Pages**
     > 2. Click **Create application** → **Connect to Git**
     > 3. Select the repository `<owner/repo>`
     > 4. Set build settings (framework: None, build command: empty, output dir: empty)
     > 5. Click **Save and Deploy**
     >
     > Confirm when done to continue the migration.

  6. After user confirms: run `gh secret list` to verify `CLOUDFLARE_API_TOKEN` and
     `CLOUDFLARE_ACCOUNT_ID`. If missing, ask the user to add them.

  If richer CI (parity/perf/playwright) is wanted, import those yml from the
  blocks-cli migrate templates separately.

- **FastStore v4**: use the FastStore release workflow pattern.

⚠️ The "never create a deploy workflow / delete if present" rule is EXCLUSIVE to
`tanstack-deco`. FastStore v4 uses the CLI and has its own process.

### migrate-script (deco-fresh only)
Via `runner` (run in SOURCE repo dir — deco-migrate transforms it in-place):
```
npx -p @decocms/blocks-cli deco-migrate --verbose 2>&1 | tail -100
```
Then run `bun run generate` to ensure all generated files (`.deco/sections.gen.ts`,
`.deco/meta.gen.json`) are up-to-date before typecheck:
```
bun run generate 2>&1 | tail -20
```
Note: deco-fresh sites have no `package.json` — skip `bun run predev`. The
Bootstrap phase of `deco-migrate` creates `package.json` and runs install.
After: advance to `build-green`.

### porting (vtex-io / live-only)
Order is fixed by scope — globals are shared, so page components can reference
them:

1. **Globals first, sequentially.** For each `pending` component with
   `scope: "global"` (header, footer, minicart), spawn ONE `porter` at a time.
   Sequential because they define the shared shell + tokens the pages build on,
   and a parallel porter editing the same theme/layout files would collide.
2. **Then page components, in parallel, capped at 4 concurrent.** Once every
   global is `done`, spawn porters for the `scope: "page"` components in batches
   of ≤4 (page components are independent — different files, no shared globals to
   race on).

Each porter gets the component name + its `migration-plan.json` entry + target
conventions. When a porter signals done, mark it via `runner`:
`parity plan set-status <name> done --dir <target.dir>/.parity`. `source-only`
(synthetic) components are ported from their source `file`, not a live capture.
After all `pending` are `done`: advance to `build-green`.

### build-green
Via `runner`: run the target's build command. If it fails, spawn a `builder`.
Repeat until `runner` reports exit 0. Cap at 3 attempts before escalating to
the user.

### nav-strategy
Migrated sites arrive with plain `<a href>` everywhere → every navigation is a
full reload, never an SPA transition. Spawn `spa-strategist` with `target_dir`,
`platform`, and the discovered routes. It returns a per-route plan
(`{routes:[{path, mode:"spa"|"reload", reason}]}`). Hand the `spa` routes to a
`porter`/`fixer` to convert `<a>`→`<Link>` (leave externals, `#anchor`, and
downloads as `<a>`). Skip this phase entirely if the site has a single route.

Also watch for **soft-404s**: a catch-all `$.tsx` that returns HTTP 200 with a
404 page for a nonexistent route is a separate bug — note it for `triage` so a
`fixer` sets the correct status.

### triage
Spawn `triager`. It surveys the migrated repo and returns issue drafts.
Create GitHub issues via `gh issue create --label parity-migrate` (skip if
title already exists — check with `gh issue list --label parity-migrate`).
Advance to `fix`.

### fix
For each open `parity-migrate` issue (up to 5 per round):
1. Spawn `fixer` with the issue body → it creates a commit + PR.
2. Run `runner` with the build command to catch regressions.
3. **Review gate.** Spawn `reviewer` with the PR number + conventions. If
   `approved: false`, re-spawn the `fixer` with the `blockers` and repeat (max 2
   review cycles per issue, then escalate the issue to the user).
4. **Merge gate.** Only a reviewer-approved PR merges:
   - `gh pr merge <pr> --squash --auto` when auto-merge is enabled.
   - If branch protection blocks auto-merge, **pause and ask the user to merge**
     — do NOT continue to `parity` against an unmerged fix (the dev server would
     still be running the unpatched code).
5. After the merge, pull the target so the running dev server picks up the fix.

Increment `round`. Advance to `parity` only once this round's fixes are merged.

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
