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

## Priority order for a follow-up PR

1. Tests (4a + 4b) — they're pure unit tests, fast to add, catch real bugs.
2. Agent fixes (2) — the JSON contract issue with `runner` is a silent failure risk.
3. Orchestrator gaps 3b + 3c — parallelism and PR merge gate, needed for any real run.
4. Real dry-run (5) — reveals everything else.
5. Everything else in any order.
