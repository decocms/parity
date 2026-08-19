# Next steps — work for larger agents after the plugin MVP

This file tracks what needs a full-context agent (Opus or Sonnet with room to
think) to do properly. Things that were deliberately left minimal or as stubs
in the initial PR, and that will break or disappoint in a real migration run.

---

## 1. Skills audit — round 2

**Why:** The audit in `SKILLS-AUDIT.md` was done from the index level (names +
descriptions). No agent actually READ the kept skills end-to-end and checked for
contradictions, gaps, or stale references.

**What to do:**
- Read every file under `skills/` and cross-check against the phase machine in
  `skills/migration-orchestrator/SKILL.md`.
- Each skill should: (a) point to exactly one "source of truth" when a topic is
  covered elsewhere, (b) not repeat what the orchestrator already says, and (c)
  have no stale upstream references (functions/files that no longer exist in the
  vendorized source repos).
- `skills/knowledge/tanstack/hydration-fixes.md` and `navigation.md` are stubs —
  pull the full files from `decocms/blocks` and evaluate whether they're still
  accurate against the current `@decocms/start` version.
- Check `scripts/sync-skills.ts` entries: run `--check` against live upstream,
  update anything that drifted.

---

## 2. Agent definitions — model choices and tool sets

**Why:** Model assignments in `agents/*.md` were reasonable guesses, not
benchmarks. The wrong model on a hot path (runner too heavy, porter too light)
burns tokens or produces bad output.

**What to do:**
- Run a dry-run migration on a small real site (e.g. a simple deco-fresh site
  with 5–10 sections) and trace which agents bottleneck.
- `runner`: haiku is correct for bash dispatch — validate the JSON contract
  actually works (Claude Code subagents return text, not structured JSON; the
  orchestrator must parse `{"ok":...}` from prose output).
- `porter`: Sonnet may be too heavy for trivial atoms (Button, Icon) and too
  light for complex sections (ProductDetail). Consider a tiered approach:
  component complexity score → model choice.
- `parity-specialist`: the "write a `pages.txt` file then read the report"
  two-step assumes file I/O that may not work cleanly in a subagent context.
  Validate or simplify to a direct command string return.
- Add `reviewer` agent (defined in the plan but not written in `agents/`).

---

## 3. Orchestrator flow — gaps found in the phase machine

**Why:** `skills/migration-orchestrator/SKILL.md` was written top-down from
the plan. Several phases have open questions that need design decisions before
a real run.

**Open items:**

### 3a. `reconcile` phase — matching logic
The current description says "mark matching components as done" using
case-insensitive name matching. This will false-positive on name collisions
(e.g. a VTEX IO `product-summary` block vs a FastStore `ProductSummary`
section that's actually a different component). Define a stricter matching
policy: role + scope + approximate visual footprint from the capture.

### 3b. `porting` parallelism
The skill says "parallel where safe, sequential when global scope dependency".
It doesn't define the dependency graph. Globals (Navbar, Footer) must complete
before pages that reference them. Write the actual ordering algorithm or
simplify to: all globals first (sequential), then all page components
(parallel, capped at 4).

### 3c. `fix` phase — PR merge gate
Fixers create PRs but the orchestrator doesn't wait for CI or merge them before
the next parity run. In a real project with branch protection the PRs sit open
and the dev server stays unpatched. Add a step: after each fixer creates a PR,
check if auto-merge is enabled; if not, pause and ask the user to merge.

### 3d. `template-bootstrap` for FastStore
The skill says "user must provide the repo (created via VTEX Onboarding)". This
is correct but needs a cleaner UX: the orchestrator should detect if the target
dir already exists and skip the question; if not, give the user the exact
Onboarding URL and wait. Currently it would just stall.

### 3e. State file location
`.parity/migration.json` is created in "the TARGET repo". When the user runs
`/parity:migrate` from a different directory (e.g. the parity repo itself), the
file goes in the wrong place. The orchestrator should walk up from `cwd` looking
for a `package.json` that matches `target.repo`, or ask explicitly.

---

## 4. Tests

**Why:** There are zero tests for the plugin layer (agents, skills, orchestrator).
The parity CLI has 1131 tests; the plugin has none.

**What to add:**

### 4a. Unit tests for `migration-plan.ts`
`buildMigrationPlan` is new logic. Test:
- Source-only components are tagged `source-only` when not in the live bundle.
- Live-only components are tagged `live-only` when not in the source.
- Name matching survives case and separator differences.
- An empty source inventory (live-only mode) still produces a valid plan.

### 4b. Unit tests for `sources/`
- `decoFresh.detect()` returns true on a dir with `deno.json` + `@deco/deco` + `fresh.gen.ts`.
- `decoFresh.detect()` returns false on a dir without `fresh.gen.ts`.
- `vtexIo.detect()` returns true on a dir with `manifest.json` + `store` builder.
- `decoFresh.inventory()` finds all `.tsx` files under `sections/` and none elsewhere.
- `vtexIo.inventory()` parses a `.jsonc` block file correctly (strips `// comments`).

### 4c. Integration test for the `run.ts` pair syntax (already partially done)
Extend `tests/commands/run-page-pairs.test.ts` to cover:
- A `--pages-file` with mixed simple and arrow entries produces the right `PagePathPair[]`.
- `resolveExplicitPages` with both `pagesFile` and `pagesList` set: file wins.

### 4d. Integration smoke test for `parity migrate --source`
Add a test that creates a temp dir with a minimal `deno.json` + `fresh.gen.ts` +
`sections/Hero.tsx`, runs `detectSource`, and checks that the inventory returns
`Hero` with `role: "section"`. No network call needed.

---

## 5. Real migration dry-run

Before the plugin is usable, run it on an actual site:

**Suggested target:** a deco-fresh site with 5–10 sections → TanStack.
1. `parity migrate --url <prod> --source <repo-dir> --target tanstack-deco`
2. Verify `migration-plan.json` lists all sections with correct `origin`.
3. Run `/parity:migrate` from the target dir; step through discovery + reconcile
   manually and confirm state is written correctly.
4. Let the orchestrator run `migrate-script` (deco-migrate) and check the output.
5. Run `parity run --prod <prod> --cand http://localhost:5173` and verify the
   `prod->cand` path pairs work on a real PDP pair.

Document any failures as issues in `decocms/parity` with label `plugin-dryrun`.

---

## 6. FastStore v4 — template bootstrap automation

The current `target-faststore-v4/SKILL.md` says "user must provide the repo via
VTEX Onboarding". Investigate whether the starter repo can be cloned and
configured programmatically:
- `gh repo clone vtex-sites/starter.store <name>` as a starting point.
- Inject `discovery.config.js` with the store ID / workspace from the migration
  state.
- Or: provide a documented checklist for the user to do manually, with exact
  CLI commands and expected outputs at each step.

---

## 7. `perf/n-plus-1.md` and `perf/variant-selection.md`

These two knowledge files were listed in `knowledge/INDEX.md` but not written
(they're in the index as forward references). Write them:
- `n-plus-1.md`: from `decocms/skills deco-loader-n-plus-1-detector` + the
  batching patterns from `@decocms/apps-vtex`.
- `variant-selection.md`: from `decocms/skills deco-variant-selection-perf` +
  the `replaceState` pattern.

---

## 8. Source playbook never wired into MIGRATION_PROMPT.md

**Why it matters:** Each source (`deco-fresh`, `vtex-io`, `live-only`) has a
`.playbook` string defined in `src/migrate/sources/*.ts` (e.g. "Fresh/Deno
sections are Preact + signals; don't copy `$fresh/` imports"). This is exactly
the context a migration agent needs at the top of the prompt. But
`buildMigrationPrompt` in `src/migrate/prompt.ts` only appends the TARGET
playbook (`--target faststore` → appends `faststore-v4.ts` string). The source
playbook is never passed in.

**Fix:** In `src/commands/migrate.ts`, after resolving `source`, pass
`source.playbook` to `buildMigrationPrompt`. In `prompt.ts`, accept an optional
`sourcePlaybook` param and prepend it before the target section. Also: the
`sourceInventory.notes` are logged to the terminal but never included in the
prompt — append them too.

---

## 9. `PlanComponent.status` not updateable by the orchestrator

**Why it matters:** `migration-plan.json` is written once by `parity migrate`
with all components as `origin: "both" | "source-only" | "live-only"` but NO
`status` field. The orchestrator skill says it marks components `status: "done"`
after porting, but there's no field for it in the schema (`src/migrate/plan.ts`).
The reconcile phase's "mark matching components done" instruction is unimplementable
without this field.

**Fix:** Add `status: "pending" | "done" | "skipped"` to `PlanComponent` in
`src/migrate/plan.ts`. Default all to `"pending"` at creation time. The
orchestrator updates the file in-place as components are ported. Add a helper
`loadPlan(dir)` / `savePlan(dir, plan)` that reads/writes `migration-plan.json`.

---

## 10. `reviewer` agent not written

**Why it matters:** The plan table included a `reviewer` agent (Sonnet, read-only,
gates auto-merge before the benchmark phase). The orchestrator skill references it
in the `fix` phase ("gate of review before merge"). The agent file `agents/reviewer.md`
doesn't exist.

**Fix:** Write `agents/reviewer.md`. It receives a PR number + branch diff, checks
for: (a) no new `:global()` in `.module.scss`, (b) no hardcoded hex/px in FastStore
CSS, (c) no edits to `.faststore/` or `*.gen.ts`, (d) all gates listed in
`conventions.gates` have a passing status in the PR checks. Returns
`{"approved": bool, "blockers": [...]}`.

---

## 11. `commands/resume.md` not written

**Why it matters:** The plan listed four commands: migrate, status, validate,
resume. `resume.md` was never created, so `/parity:resume` doesn't exist.

**Fix:** Write `commands/resume.md`. It reads `.parity/migration.json`, finds the
last completed phase, and re-enters the orchestrator from the NEXT phase. Useful
when a session is interrupted mid-run (the most common case, as migrations take
many turns).

---

## 12. Root `AGENTS.md` / `CLAUDE.md` missing

**Why it matters:** Claude Code reads `AGENTS.md` / `CLAUDE.md` at the repo root
to orient itself. After the monorepo move the root has none — so any agent working
in this repo starts cold, not knowing the `packages/parity` structure or the
plugin layout. The `packages/parity/AGENTS.md` only covers the CLI.

**Fix:** Write a root `AGENTS.md` (≤ 60 lines) covering: where the parity CLI
lives (`packages/parity/`), where the plugin lives (root-level `skills/`,
`agents/`, `commands/`, `.claude-plugin/`), that `bun run check/test` delegates
via `--filter`, and that `scripts/sync-skills.ts --check` validates vendorized
knowledge files.

---

## 13. `decocms/tanstack-storefront` is private — bootstrap needs a plan B

**Why it matters:** `target-tanstack-deco/SKILL.md` says scaffold from
`decocms/tanstack-storefront`. That repo exists but is **private** (`visibility:
PRIVATE`, last pushed 2026-02-27). An external user running the plugin won't
have access. The orchestrator's `template-bootstrap` phase would silently fail
at `gh repo clone`.

**Fix options (pick one before shipping the plugin publicly):**
- Make the template public.
- Point to `decocms/blocks examples/tanstack-smoke` as a minimal starting point.
- Document an alternative: `bun create tanstack` + manual wiring of `@decocms/*`
  packages (there may be a published create template — check).
- Gate the TanStack target on the user confirming they have template access.

---

## 14. `sourceInventory.components` not merged into `MigrationBundle`

**Why it matters:** The plan says "with `--source`, the inventory comes from CODE
and complements the scrape". In the implementation, `sourceInventory` goes into
`migration-plan.json` but the `MigrationBundle` (and thus the markdown/HTML
exporters) still only contain live-captured components. An agent reading
`bundle.json` / `MIGRATION_PROMPT.md` doesn't see source-only components (those
that exist in code but weren't in the DOM snapshot).

**Fix:** After building the plan, merge `source-only` components into the bundle's
`components` array with a synthetic `MigratedComponent` (empty HTML/styles/tailwind,
role from `SourceComponent.role`, scope from `SourceComponent.scope`). Tag them
with a `synthetic: true` flag so exporters can render them differently (e.g. "from
source code, not captured live").

---

## 15. `sync-skills` not in root workspace scripts

**Why it matters:** `sync-skills` and `sync-skills:check` were added to
`packages/parity/package.json` but not to the root `package.json`'s scripts. From
the repo root, `bun run sync-skills:check` doesn't work — you have to `cd
packages/parity` first, which is easy to forget.

**Fix:** Add to root `package.json`:
```json
"sync-skills": "bun run scripts/sync-skills.ts",
"sync-skills:check": "bun run scripts/sync-skills.ts --check"
```

---

## Priority order for a follow-up PR

1. **9 + 14** (plan status field + component merge) — unimplementable orchestrator flow without these.
2. **8** (source playbook wiring) — one-line fix, high value.
3. **10 + 11** (reviewer agent + resume command) — completes the agent table and command surface.
4. **12** (root AGENTS.md) — orientation for any agent working in the repo.
5. **13** (template bootstrap plan B) — blocks public release of the plugin.
6. **Tests 4a–4d** — catch regressions in the new code.
7. **15** (sync-skills at root) — convenience, low risk.
8. **Agent benchmark dry-run (5)** — validates everything end-to-end.
9. **Everything else** in any order.
