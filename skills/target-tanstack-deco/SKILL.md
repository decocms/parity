---
name: target-tanstack-deco
description: Target playbook for TanStack Start + Deco CMS (@decocms/*). Load when porting TO tanstack-deco from any source. Covers section contract, Tailwind, commerce, and what regenerates on build.
---

# Target: TanStack Start + Deco CMS

Source of truth: `decocms/tanstack-storefront` + `decocms/blocks` `.agents/skills/`.
This skill is a SHORT summary; load references for deep detail.

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

- `skills/knowledge/tanstack/hydration-fixes.md`
- `skills/knowledge/tanstack/navigation.md`
- `skills/knowledge/tanstack/search.md`
- `skills/knowledge/vtex/invoke.md`
- `skills/knowledge/vtex/cart.md`
