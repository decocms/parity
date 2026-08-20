---
name: migration-orchestrator
description: Orchestrates a full site migration end-to-end. Load when the user asks to migrate a site, start a migration, or resume one. This is the main entry point.
---

# Migration Orchestrator

Drives the migration lifecycle from first capture to benchmark sign-off. Every
bash call goes through the `runner` agent — never run commands directly.

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

## Reading a `runner` reply

The `runner` is a subagent — its reply is **prose that ends with a JSON line**,
not a raw JSON payload. Parse it defensively: take the **last** `{…}` block in
the reply and `JSON.parse` it. If there is no parseable object, re-dispatch the
same `cmd` once (the runner is told to return only the object). Never assume the
whole message is JSON.

## Phase machine

```
discovery → reconcile → repo-setup → template-bootstrap → workflows
→ [migrate-script | porting] → cleanup → build-green → fallbacks → triage → fix → parity
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
After: advance to `cleanup`.

### cleanup
Remove template scaffolding that does not belong to this site. The source of
truth is **`.deco/blocks/`** — it contains every `__resolveType` reference that
the CMS actually renders. Anything the CMS doesn't reference and that isn't
imported by something the CMS does reference is dead code.

**Step 1 — build the "needed" set from `.deco/blocks/`:**
```bash
# All sections the CMS actually uses:
grep -rh "__resolveType" .deco/blocks/ 2>/dev/null \
  | grep -o '"site/[^"]*"' \
  | tr -d '"' | sort -u
```
This gives the canonical list, e.g.:
```
site/sections/BannerCaroussel.tsx
site/sections/Header.tsx
...
```

**Step 2 — find sections NOT in the needed set:**
```bash
# Sections that exist in src/ but have no CMS page reference:
for f in src/sections/**/*.tsx src/sections/*.tsx; do
  key="site/${f#src/}"   # src/sections/Foo.tsx → site/sections/Foo.tsx
  if ! grep -qr "\"$key\"" .deco/blocks/ 2>/dev/null; then
    echo "UNUSED SECTION: $f"
  fi
done
```

**Step 3 — find hooks/UI components not imported by any CMS-referenced section:**

Extract the unique set of section filenames from step 1, then check each
`src/components/ui/` and `src/hooks/` file for imports:

```bash
# For each candidate UI component/hook:
find src/components/ui src/hooks -name "*.tsx" -o -name "*.ts" | while read f; do
  bn=$(basename "$f" | sed 's/\.[^.]*$//')
  # Never delete framework primitives
  echo "$bn" | grep -qE "^(Image|Icon|Seo|Video|Picture|Section|Slider|Theme)$" && continue
  
  # Check if any CMS-referenced section imports it
  callers=0
  for section in <unique_section_filenames_from_step1>; do
    grep -q "$bn" "src/sections/$section" 2>/dev/null && callers=$((callers+1))
  done
  [ "$callers" -eq 0 ] && echo "DEAD: $f"
done
```

Never delete: `Image.tsx`, `Icon.tsx`, `Seo.tsx`, `Video.tsx`, `Picture.tsx`,
`Section.tsx`, `Slider.tsx`, `Theme.tsx` — framework primitives wired indirectly.

**Step 4 — delete and commit:**
```bash
git rm <dead files>
git commit -m "chore(cleanup): remove template dead code — not referenced in .deco/blocks"
```

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
conventions. When a porter signals done, set that component's `status: "done"`
in `migration-plan.json` (in place). `source-only` (synthetic) components are
ported from their source `file`, not a live capture.
After all `pending` are `done`: advance to `build-green`.

### build-green
Via `runner`: run the target's build command. If it fails, spawn a `builder`.
Repeat until `runner` reports exit 0. Cap at 3 attempts before escalating to
the user.

### fallbacks (tanstack-deco)
Deferred sections without a `LoadingFallback` render blank until hydration →
CLS + blank no-JS render. Fix them BEFORE parity so the vitals run isn't polluted.

1. **Detect** (static, no browser) — cross-reference section order in
   `.deco/blocks/pages-*.json` against flags in `.deco/sections.gen.ts`. A real
   content section (ignore `webRendering/Lazy.tsx` wrappers) that defers (past
   fold OR CMS-Lazy), is not `neverDefer`/`eager`, and has `hasLoadingFallback:
   false` needs attention. This is the same check as `triager` step 7.
2. **Above the fold** (first ~3 sections on the page): mark `export const
   neverDefer = true` in the section file — no skeleton needed, it renders in SSR.
   NOTE: if the CMS wraps everything in Lazy, `setAsyncRenderingConfig({
   respectCmsLazy: false })` in `src/setup.ts` is required or the flags are ignored.
3. **Below the fold**: spawn `fallbacker` per section. It measures the real
   rendered size via `parity section --computed-styles --json` and writes a
   skeleton of matching dimensions (zero CLS when it defers).
4. After all are handled: `bun run generate`, rebuild, advance to `triage`.

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
