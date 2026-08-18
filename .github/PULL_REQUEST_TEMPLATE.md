## What

<!-- One or two sentences on what this PR does and why. -->

## Docs

<!--
The docs-check CI blocks `feat` PRs that change the CLI/check surface
(src/cli.ts, src/commands/**, src/checks/**) without touching docs/**.
Tick one — or add the `skip-docs` label to bypass.
-->

- [ ] Docs updated (`docs/**` and the Parity section on [deco-sites/docs](https://github.com/deco-sites/docs))
- [ ] Docs not needed (no user-facing command/check surface change)

## Checklist

- [ ] `bun run check` (tsc) + `bun run lint` (biome) pass
- [ ] Tests added/updated and `bun run test` passes
