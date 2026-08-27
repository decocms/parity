# parity

Monorepo for deco's site-migration tooling: the `parity` CLI that measures a
migration, and the Claude Code plugin that runs one.

| Path | What it is |
| --- | --- |
| [`packages/parity`](./packages/parity) | **`@decocms/parity`** — the CLI. Validation (`run`, `e2e`, `compare`, `section`, `vitals`, `benchmark`) and migration capture (`migrate`, `extract`). Published to npm. |

## The two halves

**Validation** answers "is the candidate the same as production?" — `parity run`
compares two URLs and reports UI, functional, SEO, visual and Web Vitals deltas
with an LLM-ranked HTML report and a 0–100 score.

**Migration** answers "what do I have to build?" — `parity migrate` captures a
live storefront (theme, pages, components) into a target-agnostic bundle an
agent can build from, whether or not the source code still exists.

The plugin closes the loop between them: capture → build → measure → file issues
→ fix → measure again, until the score converges.

## Install in Claude Code

```bash
# 1. register the marketplace (one-time)
claude plugin marketplace add decocms/parity
# 2. install the plugin from it
claude plugin install parity@parity
```

Confirm it installed:

```bash
claude plugin list            # "parity" should appear
claude plugin details parity  # command/agent/skill inventory + token cost
# inside a Claude Code session, /help lists the /parity:* commands below
```

Once installed, five slash commands drive a migration:

| Command | What it does |
| --- | --- |
| `/parity:migrate` | Start or resume a migration for a site |
| `/parity:status` | Show the current phase and score of an active migration |
| `/parity:validate` | Run parity (prod × candidate) on demand and report the score |
| `/parity:resume` | Resume from the last saved `.parity/migration.json` |
| `/parity:report` | Build a stakeholder report — deck or executive one-pager |

## Getting started

```bash
bun install          # installs every workspace
bun run check        # typecheck all packages
bun run test         # test all packages
```

Per-package scripts run from the package directory:

```bash
cd packages/parity && bun run build
```

For CLI usage, see [`packages/parity/README.md`](./packages/parity/README.md).

## Layout notes

- The repo root is a **private** workspace with no version — it never publishes.
  `@decocms/parity` is versioned and published from `packages/parity`.
- `overrides` and `trustedDependencies` live in the root `package.json` because
  bun only reads them from the install root.

## License

MIT
