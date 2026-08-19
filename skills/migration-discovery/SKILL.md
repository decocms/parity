---
name: migration-discovery
description: How to discover prod URL, source stack, and target repo conventions in a migration. Load when running the discovery or reconcile phase.
---

# Migration Discovery

## Source detection (delegate to `scout`)

Ask `scout` with `task: "detect-source"`. Evidence priority:
1. `deno.json` + `fresh.gen.ts` + `@deco/deco` import → `deco-fresh`
2. `manifest.json` with `vendor` field + `store` builder → `vtex-io`
3. `package.json` with `@faststore/cli` dep → already `faststore-v4` (a target, not a source)
4. Fallback → `live-only`

## Prod URL discovery (delegate to `scout`)

Ask `scout` with `task: "find-prod-url"`. Check in order:
1. `discovery.config.js` → `prod` preset `storeUrl`
2. `package.json` → `homepage`
3. `README.md` → first `https://` URL that looks like a store (has `.com`, `.ec`, etc.)
4. Ask the user if still unknown.

## Conventions discovery (delegate to `scout`)

Ask `scout` with `task: "find-conventions"`. Must read:
- `AGENTS.md` (primary — the rules an AI agent must follow)
- `CLAUDE.md` (secondary — Claude-specific guidance)
- `docs/ai-playbooks.md` (playbook source of truth if present)
- `.github/skills/*/SKILL.md` (project-shared skills)

Extract from these:
- **rules**: lines that say "never", "always", "must", "obey", "required" (first 10)
- **gates**: scripts that block commits/PRs (`pre-commit`, `pre-push`, `quality:guard`)

## Reconcile — what's already done

For FastStore v4 target:
```bash
# Components already ported (exist in index.tsx)
grep "^import\|^export" src/components/index.tsx

# CMS schemas present
ls cms/faststore/components/

# Check whitelist completeness (FastStore invariant)
node scripts/sort-cms-whitelists.mjs --check 2>&1 | tail -10
```

For TanStack target:
```bash
ls src/components/sections/
```

Cross-reference against `components` in `migration-plan.json`. Mark `status: "done"`
for every component whose name (case-insensitive) appears in both lists.

## Importing existing backlog

If the target has `docs/todo-radar.md`, read it and extract open `[ ]` items.
For each, check `gh issue list --label parity-migrate` for the same title
before creating. Import only items that are NOT already issues.
