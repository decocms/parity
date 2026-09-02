---
name: target-tanstack-deco
description: Target playbook for TanStack Start + Deco CMS (@decocms/*). Load when porting TO tanstack-deco from any source. Covers section contract, Tailwind, commerce, and what regenerates on build.
---

# Target: TanStack Start + Deco CMS

Source of truth: **`deco-sites/storefront-tanstack`** (public) + `decocms/blocks`
`.agents/skills/`. This skill is a SHORT summary; load references for deep detail.

## Scaffolding — COPY the template, don't fork it

Bootstrap a new candidate by **copying the code** from `deco-sites/storefront-tanstack`
into the target repo (clone it, copy the tree, re-init git / point it at the new
remote). Do **not** use `gh repo create --template` — the template keeps
improving, and each new migration should pick up those improvements by copying
its current `main`, not forking a point-in-time snapshot.

The repo itself (does it exist? create it private?) is `repo-setup` step 0 in
`skills/migration-orchestrator/SKILL.md` — check before copying anything.

## Section contract (3 things must be in sync)

1. **Component file**: `src/components/sections/<Name>.tsx`
   - Default-export the React component.
   - Named-export `schema` (Zod schema — replaces Fresh's JSDoc annotations).
2. **Index export**: `src/components/index.tsx` — add one entry.
3. **Loader** (when needed): `src/loaders/<name>.ts` — export a function that
   returns the loader's return type.

After adding a section: `bun run predev` regenerates manifests.

## Styling

Tailwind utilities + CSS Modules for overrides. **NOT** SCSS tokens like FastStore.
Captured Tailwind classes from the bundle are the starting point.

**Responsive is CSS, never a JS device branch** — `md:hidden` / `hidden md:flex`,
`<picture>` + `<source media>` for two image sources. A `useDevice`/`isMobile`
branch poisons the edge cache and mismatches on hydration; see
`skills/knowledge/tanstack/responsive-device.md` for the reasoning and the one
legitimate exception.

## Commerce

```ts
import { useCart } from "@decocms/apps-vtex/hooks/useCart.ts";
import { useProduct } from "@decocms/apps-vtex/hooks/useProduct.ts";
// loaders from @decocms/apps-vtex/loaders/
```

## What regenerates (NEVER edit these)

- `src/components/manifest.gen.ts`
- `src/invoke.gen.ts`
- `src/meta.gen.ts`

## References (load only what you need)

- `skills/knowledge/tanstack/responsive-device.md` — device/responsive, CLS, cache
- `skills/knowledge/tanstack/jsx-migration.md` — Preact → React JSX
- `skills/knowledge/tanstack/react-hooks-patterns.md` — signals → React state
- `skills/knowledge/perf/payload-trim.md` — heavy SSR payload
- `skills/knowledge/perf/n-plus-1.md` — API call per item in a loader
- `skills/knowledge/tanstack/hydration-fixes.md`
- `skills/knowledge/tanstack/navigation.md`
- `skills/knowledge/tanstack/search.md`
- `skills/knowledge/vtex/invoke.md`
- `skills/knowledge/vtex/cart.md`
