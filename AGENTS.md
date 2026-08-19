# AGENTS.md

This repo is **two things in one monorepo**:

1. **The `parity` CLI** — `packages/parity/` — validation + migration capture.
   Its own guidance is in `packages/parity/AGENTS.md`; deeper docs in
   `packages/parity/docs/`. Work on the CLI happens **inside that package**.
2. **The Claude Code plugin** (`parity`) — the repo root — which orchestrates a
   full site migration *using* the CLI. Plugin files live at the root:
   - `.claude-plugin/` — `plugin.json` + `marketplace.json` manifests.
   - `skills/` — the orchestrator (`migration-orchestrator/SKILL.md` is the entry
     point / phase machine), per-phase skills, source/target skills, and
     `knowledge/` references loaded by explicit path.
   - `agents/` — the subagents the orchestrator dispatches (scout, runner, porter,
     builder, triager, fixer, reviewer, parity-specialist). One `*.md` each.
   - `commands/` — the slash commands (`/parity:migrate`, `:status`, `:validate`,
     `:resume`).
   - `hooks/` — session hooks.

## Working here

- **Install / build / test / lint** run across the workspace via bun filters:
  `bun install`, then `bun run build | check | test | lint | fmt` (each delegates
  with `--filter='./packages/*'`). To run just the CLI: `bun run --filter=./packages/parity <script>`.
- **The plugin layer has no build step** — agents/skills/commands are Markdown +
  YAML front-matter, read by Claude Code directly. Validate them by reading, not
  compiling.
- **Vendorized knowledge** under `skills/knowledge/**` is pulled from upstream
  (`decocms/blocks`) by `scripts/sync-skills.ts`. Check drift with
  `bun run sync-skills:check`; the two large files (`hydration-fixes.md`,
  `navigation.md`) are stubs managed manually.
- **`NEXT.md`** tracks the known gaps / follow-up work for the plugin.

## Which side am I changing?

- Touching capture, checks, reports, the `parity` command surface → `packages/parity/`
  (obey `packages/parity/AGENTS.md`; a `feat` PR that changes the CLI surface must
  update `packages/parity/docs/`).
- Touching how a migration is *orchestrated* (phases, agent roles, prompts) →
  the root `skills/` + `agents/` + `commands/`.
