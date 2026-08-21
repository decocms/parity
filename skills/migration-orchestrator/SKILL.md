---
name: migration-orchestrator
description: Orchestrates a full site migration end-to-end. Load when the user asks to migrate a site, start a migration, or resume one. This is the main entry point.
---

# Migration Orchestrator

Drives the migration lifecycle from first capture to benchmark sign-off.

## Language — READ THIS FIRST

**All output must be in English.** This applies to every artifact produced during
a migration: commit messages, PR titles and bodies, GitHub issue titles and
descriptions, code comments, and any prose written to files. The only exception
is user-facing guidance delivered interactively in the chat — match the user's
language there. When dispatching to subagents, instruct them to write in English.

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
parity plan set-status <name> <pending|partial|done|as-is|upgrade|skipped> --dir <target.dir>/.parity
parity plan verify     <name> <pass|fail> [--note "<what you saw>"] --dir <target.dir>/.parity
parity plan page       <path> --cand <cand url> --json              --dir <target.dir>/.parity
```

Name matching is case- and separator-insensitive (`product-shelf` == `ProductShelf`).

**"Not equal to prod" is three different things.** Treating them as one is how a
run turns into a queue of findings nobody wants:

| status | Meaning | Reference |
|---|---|---|
| (report it) | the target is worse or broken — a real defect | prod |
| `as-is` | different, accepted, not worth the work | still prod |
| `upgrade` | the target is deliberately **ahead** — usually a better component brought in from another site | **not prod** |

`skipped` still means "not going to do it".

An `upgrade` needs a reference, or parity keeps measuring it against the wrong
thing forever:

```
parity plan set-reference <name> --url <site it came from> --selector "<sel>" --note "<why>" --dir <target.dir>/.parity
```

`--note` is required. Only the **user** decides `as-is` / `upgrade` — see "The
page loop".

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

  fix, when budget.stackPrs → stack-review → done   (nothing merged; user lands the stack)
```

**Decision at porting fork:**
- Source is `deco-fresh` → `migrate-script` (runs `deco-migrate`)
- Source is `vtex-io` or `live-only` → `porting` (one `porter` per component)

## Stage — what the run is allowed to care about

A migration is not one undifferentiated pile of work. `state.stage` scopes what
`triage` reports and what gets imported from the target's backlog, so the run
works on the CURRENT goal instead of everything at once. Ask the user which
stage they are in when resuming an existing migration; default `components`.

| stage | goal | triage reports ONLY | explicitly deferred |
|---|---|---|---|
| `components` | build the missing sections | build failures, runtime errors, missing/partial components, FastStore 3-point invariant breaks | CSS tokens, i18n, CLS, perf, bundle, analytics/GTM, SEO, a11y contrast |
| `pages` | close pages **one at a time** (see "The page loop") | above, plus pages `pending`/`code` (route missing, or content unpublished), whitelist gaps blocking a page — scoped to `state.currentPage` | same as above, plus anything belonging to another page |
| `polish` | parity/quality pass | everything: CSS tokens, i18n, CLS/LoadingFallback, perf/bundle, analytics, SEO, a11y | — |

**Why this exists.** A mature target's repo and backlog are full of polish work.
Run an unscoped survey on it and you get a queue of bundle-size, Lighthouse,
GTM/analytics and color-contrast issues — real, but not what the user is doing
right now — while "component X is not built" and "page Y has no content" never
surface at all. Deferred items are NOT filed as issues: they stay in the backlog
file until the stage reaches them. Say what was deferred; never silently drop it.

## The page loop — `stage: pages`

While the stage is `pages`, the unit of work is **one page**, not a global queue.
Set `state.currentPage` and work it to closure before moving on.

**Why.** With a global queue you get five issues from five different places and
no page ever finishes. The stage tells you what KIND of work counts; it never
tells you WHERE. A page that closes is something you can show someone.

**Order — globals first.** Global components (header, footer, nav) are NOT page
members in the capture, so they never show up in a page worksheet. Settle every
component with `scope: global` before walking pages, then go by `kind`:
`home` → `plp` → `pdp` → the rest. Skip this and a global fix reopens pages you
already closed.

**The cycle**, per page, replacing the global `triage → fix` while the stage is
`pages`:

1. Read the worksheet, via `runner`:
   `parity plan page <path> --dir <target.dir>/.parity --cand <cand url> --json`
2. `build` rows → one `porter` each (same fork as `porting`). Flip each with
   `parity plan set-status <name> done` when it lands.
3. `validate` rows → run the `command` the worksheet already built for you (it is
   a ready `parity section` invocation, pointed at the row's reference), then
   record the outcome: `parity plan verify <name> pass|fail --note "<what you saw>"`.
4. A `fail` becomes an issue. Title MUST carry the page (see `issue-loop`) — dedup
   is by title, so two pages sharing a component would collide otherwise.
5. `as-is` and `upgrade` rows → **no issue, ever**. They are decided. Report them
   in the round summary so the user sees they were considered, not skipped.
6. Page closes when the worksheet returns `ready: true`. Then set the page status:
   `done` if content is live, `code` if the route works but the CMS has nothing
   published.
7. Next page.

**Cap.** Same 5-issues-per-round ceiling as `fix`. What does not fit stays on the
worksheet, which is derived from the plan and regenerates — it is not a queue that
can go stale.

**Never mark `as-is` or `upgrade` yourself.** Both mean "stop opening work for
this", and only the user gets to say that. When a component looks deliberately
different or deliberately better, **propose it and wait**:

> `product-shelf` on `/` does not match prod. It looks like a deliberate
> replacement rather than a defect. Should I mark it `upgrade` (and against which
> reference site?), `as-is`, or file it as a defect?

An agent that files these on its own is exactly how a real gap disappears from
view.

**PR mode** (set at `discovery`, `budget.stackPrs`):
- **merge** (default) — independent PRs off `main`, merged one at a time; the
  `fix → parity` loop re-scores after each round.
- **stack** — fixes chained (each PR based on the previous), nothing merged; the
  top PR's preview shows every fix together. `fix → stack-review → done`. Choose
  this when the user asks to stack fixes / get one preview with all fixes / not
  auto-merge.

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
  "stage": "components",          // components | pages | polish — scopes what triage reports
  "currentPage": null,            // stage `pages` only: the ONE page being closed right now
  "budget": { "fixRounds": 6, "used": 0, "stackPrs": false },
  "stack": [],                    // stack mode only: [{issue, pr, branch, base}] bottom→top
  "parity": { "lastScore": null, "target": 97, "reportPath": null }
}
```

## Phase-by-phase instructions

### discovery
Delegate to `scout` with `task: "full-discovery"`. Merge result into state.
Ask the user: "What is the output target? (tanstack-deco / faststore-v4)" — and state
the tradeoff: **`tanstack-deco` renders standalone from props/loaders (a blind live-only
migration is viewable end-to-end); `faststore-v4` builds AND runs locally from code
(`faststore dev`), but real page CONTENT is coupled to the client's VTEX account —
uploaded via the Content Platform (`vtex content` / `yarn cms:content`; Headless CMS
`cms-sync` is legacy) + a `faststore` custom app on the orderForm. Preview real
content locally via `/api/preview` against a CP branch.** For a no-account/live-only
migration, faststore-v4 yields buildable, locally-runnable code but no real content.
See `skills/target-faststore-v4/SKILL.md`. Set `source.prodUrl` if not found automatically.

**PR mode.** If the user asked to stack fixes, review one combined preview, or
not auto-merge, set `budget.stackPrs: true` (see `fix` / `stack-review`).
Otherwise leave it `false` (merge mode). When unsure and the user mentioned
"preview with all fixes" or "don't merge", pick stack.

### reconcile
**First: is the target already a scaffolded storefront?** When `scout` classified
the repo the user pointed at as `faststore-v4` or `tanstack-deco` (i.e. it is
already a TARGET, not a source — `@faststore/cli` in `package.json`, or a
populated `src/components/index.tsx`), then the SOURCE is the legacy live site,
not this repo. Enter **reconcile-only mode**: set `target.dir`/`target.repo` to
this existing repo and **skip `repo-setup` + `template-bootstrap` entirely**
(re-scaffolding would clobber real work). Go reconcile → workflows (verify only)
→ porting (pending rows only) → build-green → … as usual. A mature target most
often has NO pending real work — the value is the `parity → triage → fix` loop,
not porting. Say so to the user.

1. If `source.repo` exists: run `parity migrate --source <dir> --url <prodUrl>`
   via `runner` to get `migration-plan.json`.
2. If no source: run `parity migrate --url <prodUrl>`.
3. `parity migrate` writes `migration-plan.json` (all rows `status: "pending"`)
   under its `--out` dir (`./parity-migrate/<host>/`). Once `target.dir` exists,
   copy it to the canonical `<target.dir>/.parity/migration-plan.json`.
   **HARD GATE — verify the file exists at that path before going further**
   (`ls <target.dir>/.parity/migration-plan.json` via `runner`). The plan is the
   spine of the whole run: it is the ONLY record of what exists vs what is
   missing. With no plan, `triage` has nothing to compare against, silently
   reports zero missing components, and the run degenerates into a CSS/perf lint
   pass — burning fixer cycles on polish while the actual gap (unbuilt
   components, unpublished pages) goes unreported. If the copy failed, fix it
   here; never advance to `porting`/`triage` without it.
4. If target already has work done (read `src/components/index.tsx`), mark each
   matching component done: `parity plan set-status <name> done --dir <target.dir>/.parity`.
   **Match by CONCEPT, not just string.** A live-only plan names components from
   the DOM (`product-hero`, `navigation-mega-menu`, `product-slider`), which
   rarely string-match the target's clean section names (`HeroSwiper`, `Navbar`,
   `ProductGallery`). `parity plan set-status`'s case/separator-insensitive match
   catches `product-shelf`↔`ProductShelf` but NOT `product-hero`↔`HeroSwiper`.
   So read the target's sections and map each plan row to its semantic equivalent
   yourself before flipping status — otherwise a mature target reads as ~2 done /
   25 pending and you dispatch porters to re-do finished work. Rows with no target
   equivalent stay `pending`; rows that are pure DOM plumbing → `skipped`.
5. **Classify each page.** For every `pages[]` row, decide readiness and record
   it: `parity plan set-page-status <path> <pending|code|done|skipped> --dir
   <target.dir>/.parity`.
   - `pending` — no route/sections for it yet.
   - `code` — route + sections exist in the repo but the CMS has no published
     content, so it renders empty. **On FastStore this is the most common real
     state and the usual blocker** — code-complete is not page-complete.
   - `done` — code AND content live.
   Evidence: routes/templates in the repo for code; the CMS/CP entries (or a
   fetch of the candidate page) for content. When you cannot verify content
   access, mark `code` and say so — never guess `done`.
6. **Backlog import is stage-gated.** If the target has a backlog file
   (`docs/todo-radar.md`), read it — but import ONLY items matching the current
   `stage` (below), and always skip items already open as issues (same title).
   A mature target's backlog is mostly polish (bundle size, Lighthouse, CLS,
   analytics/GTM, color-contrast). Importing all of it during the `components`
   stage floods the queue with work you explicitly deferred and starves the
   actual gap. Items that do not match the stage stay in the file — do not
   import them "for later".
7. **Report the inventory before doing any work.** Run
   `parity plan status --dir <target.dir>/.parity` via `runner` and show the user:
   components settled (no work needed) vs remaining, pages done vs awaiting CMS
   content. This is the answer to "what's left?" — surface it, then pick the
   stage with the user if it is not already set.
8. `pendingComponents` = plan rows still `pending`/`partial`.

### repo-setup / template-bootstrap
**Skip this whole phase in reconcile-only mode** (the target the user pointed at
is already a scaffolded `faststore-v4`/`tanstack-deco` repo — see `reconcile`).
Also skip when the source is `deco-fresh` (`deco-migrate` scaffolds instead).
Only scaffold when creating a brand-new target repo from a source/live capture.

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
- **FastStore Next**: scaffold by **copying the code** from
  `deco-sites/faststore-next-template` (Next.js App Router on `@faststore/api`/
  `sdk`/`ui`, no `@faststore/cli`/`core` — Deco CMS decofiles as the content
  source). Clone, copy the tree, re-init git, set the new remote. Then set
  `discovery.config.js`'s `api.storeId` (public, client-bundled — not a
  secret) to the source VTEX account. See `target-faststore-next/SKILL.md`
  for the full bootstrap, including the ADR on when this target applies vs
  `faststore-v4` — **don't guess between the two**, it's a discovery-time
  decision, not a migration-time one.
Load skill `skills/target-faststore-v4/SKILL.md`, `skills/target-faststore-next/SKILL.md`,
or `skills/target-tanstack-deco/SKILL.md`.

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
- **FastStore Next**: no deploy workflow either, but for a different reason
  than `tanstack-deco` — WebOps builds straight from `discovery.config.js` +
  `package.json` scripts (`next build`), no CLI, no GitHub App. Do NOT add a
  `deploy.yml`. Two accommodations WebOps needs that look wrong to a generic
  Node reviewer but are load-bearing — do not "fix" them: (1) build-time
  tooling (`tsx`, `@decocms/blocks-cli`, `@graphql-codegen/cli`, `prettier`,
  `@types/react`) sits in `dependencies`, not `devDependencies`, because
  WebOps production installs skip devDependencies; (2) branch names must not
  contain a second `/` (dependabot.yml's `separator: "-"` exists for this).
  Staging validation happens on the WebOps-provisioned preview domain;
  `src/proxy.ts`'s reverse-proxy pattern (see `target-faststore-next/SKILL.md`)
  supports a route-by-route cutover instead of an all-or-nothing DNS switch.

⚠️ The "never create a deploy workflow / delete if present" rule is EXCLUSIVE to
`tanstack-deco`. FastStore v4 uses the CLI and has its own process; FastStore
Next uses WebOps and has its own (see above) — neither needs a workflow file,
but for unrelated reasons, so don't merge the two rationales.

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
**Precondition:** `<target.dir>/.parity/migration-plan.json` must exist (the
`reconcile` gate). Without it the triager cannot know what is missing and will
only report lint-level findings.

Spawn `triager` with `stage` (see "Stage" above) and the plan path, so it reports
only what this stage is about. It surveys the migrated repo and returns issue
drafts. Create GitHub issues via `gh issue create --label parity-migrate` (skip
if title already exists — check with `gh issue list --label parity-migrate`).

When `stage: pages`, also pass `page` (`state.currentPage`) and that page's
component list from the worksheet. Anything outside the page goes to the
triager's `deferred` list — same mechanism the stage filter already uses. Do not
let a survey of one page file work for another; that is how the queue goes global
again.

Order the queue by the stage's goal: missing/partial components and unpublished
pages first, never polish while `stage !== "polish"`. If the triager returns
nothing for the stage, say so and ask whether to advance the stage rather than
inventing work. Advance to `fix`.

### fix
Two modes, chosen by `budget.stackPrs` (see "PR mode" below). Default is **merge
mode**. In both, the review gate is identical — only the base branch and the
merge step differ.

**Merge mode (`budget.stackPrs: false`, default).** Independent PRs off `main`,
merged one at a time. For each open `parity-migrate` issue (up to 5 per round):
1. Spawn `fixer` with the issue body and `base_branch: <target default branch>`
   → it creates a commit + PR off `main`.
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

**Stack mode (`budget.stackPrs: true`).** Nothing is merged — each fix PR is
based on the PREVIOUS fix's branch, so the **top of the stack accumulates every
fix and its preview deploy shows all fixes together**. Process issues
**sequentially** (a stack is a chain; no parallel batch). Maintain
`state.stack = [{issue, pr, branch, base}]`.
1. `base` for the first issue = the target's default branch; for issue *k* = the
   `branch` returned by issue *k-1*'s fixer.
2. Spawn `fixer` with the issue body and `base_branch: <base>` → commit + PR
   **based on `<base>`** (the fixer passes `--base`). Append `{issue, pr, branch,
   base}` to `state.stack`.
3. Build check + **review gate** exactly as merge mode (reviewer sees only the
   incremental diff against `<base>` — the right unit to review).
4. **No merge gate.** Leave the PR open. Do NOT merge, do NOT delete branches.
5. Do NOT restore HEAD to `main` between issues — the next fixer branches off the
   previous fix branch to continue the chain.

After the last issue, go to **stack-review** (below) instead of `parity`. Never
interleave stack mode with the merge-gated `parity` loop — with nothing merged,
a re-score would measure unpatched code.

### stack-review  *(stack mode only)*
The top branch (`state.stack[last].branch`) is the cumulative candidate. Report
to the user:
- The ordered stack (issue → PR → branch), bottom to top.
- The **top PR's preview URL** — that deploy contains ALL the fixes together
  (Cloudflare Workers Builds / the platform's per-PR preview). This is the "one
  preview with everything" the stack exists for.
- How to land it: **merge bottom-up** (PR #1 into `main` first, then retarget/
  merge #2, …). Do NOT `--delete-branch` mid-stack — deleting a base branch
  closes its child PR. Delete branches only after the whole stack is merged.

Then stop and hand off — landing the stack is the user's call.

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
