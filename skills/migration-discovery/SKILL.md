---
name: migration-discovery
description: How to discover prod URL, source stack, and target repo conventions in a migration. Load when running the discovery or reconcile phase.
---

# Migration Discovery

"Delegate to `scout`" below means: **invoke the Task tool with
`subagent_type: "scout"`** and the given `task`. Run any shell (the reconcile
snippets) through the `runner` subagent, never the Bash tool directly.

## Source detection (delegate to `scout`)

Ask `scout` with `task: "detect-source"`. Evidence priority:
1. `deno.json` + `fresh.gen.ts` + `@deco/deco` import → `deco-fresh`
2. `manifest.json` with `vendor` field + `store` builder → `vtex-io`
3. `package.json` with `@faststore/cli` dep → already `faststore-v4` (a target, not a source)
4. Fallback → `live-only`

## Prod URL discovery (delegate to `scout`)

The parity `prod` URL must be the **legacy site being replaced** (e.g. the VTEX
IO storefront) — NOT the target's own staging. When the target repo is already a
`faststore-v4`/`tanstack-deco` scaffold, its `storeUrl` points at its OWN preview
(`*.vtex.app`, `*.myvtex.com`, `*.deco.site`, a Workers `*.workers.dev`). Using
that as `prod` compares the candidate against itself → a meaningless high score.

Ask `scout` with `task: "find-prod-url"`. Check in order:
1. `discovery.config.js` → `prod` preset `storeUrl` — **but reject it if the host
   is the target's own staging** (`*.vtex.app` / `*.myvtex.com` / `*.deco.site` /
   `*.workers.dev`); that is the candidate, not the legacy source.
2. `package.json` → `homepage`
3. `.env.example` / `.env` → a legacy-gateway var (`VTEX_IO_BASE_URL`,
   `LEGACY_URL`, `SOURCE_URL`) — often the only place the real live domain lives,
   commented out.
4. `README.md` → first `https://` URL that looks like the live store (has a real
   brand TLD: `.com`, `.com.ec`, `.com.br`, …), not a staging host.
5. Ask the user: "What is the URL of the legacy live site being migrated?"

Also flag **config smells** while here: if `discovery.config.js` locale/currency/
country (e.g. `pt-BR`/`BRL`/`BRA`) disagree with the live host's TLD/market
(e.g. `.com.ec` → Ecuador), report it — it's a real target bug worth an issue.

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

Cross-reference against the rows in `<target.dir>/.parity/migration-plan.json`.
For every component whose name appears in both lists, mark it done via the CLI
(never hand-edit): `parity plan set-status <name> done --dir <target.dir>/.parity`
(matching is case- and separator-insensitive).

## Importing existing backlog

If the target has `docs/todo-radar.md`, read it and extract open `[ ]` items.
For each, check `gh issue list --label parity-migrate` for the same title
before creating. Import only items that are NOT already issues.
