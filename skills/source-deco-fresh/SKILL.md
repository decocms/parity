---
name: source-deco-fresh
description: Source-side playbook for Deco on Fresh/Deno storefronts. Load when porting FROM deco-fresh to any target. Covers what to expect in the repo and what the deco-migrate script handles automatically.
---

# Source: Deco on Fresh/Deno

## What the code looks like

- **Sections** in `sections/*.tsx` — each is a Preact component + exported `Props`
  interface (the CMS schema). The component IS the section — no separate schema file.
- **Islands** in `islands/` — client-interactive pieces. These need to be React
  components on TanStack, or inlined as client-only if they're small.
- **Loaders** in `loaders/` — server-data functions. Become TanStack route loaders
  or `@decocms/apps` loaders.
- **`deno.json`** has the import map. Every `https://` or `jsr:` import is Deno-only.
- **`fresh.gen.ts`** and `manifest.gen.ts` are GENERATED — never edit them.

## What `deco-migrate` handles automatically

The `@decocms/blocks-cli deco-migrate` script handles:
- Package.json rewrite (Deno → Node, @decocms/*)
- JSX transform (Preact → React)
- Signal rewrites (@preact/signals → @tanstack/store)
- Island elimination (move to React components)
- Import URL rewriting

## What it does NOT handle (manual work)

- **HTMX/useSection partials** → must be rewritten as React components with
  state, or TanStack route transitions.
- **`useDevice` SSR/CSR split** — the Preact version is a signal; the TanStack
  version is `import { useDevice } from "@decocms/start/sdk/device"`.
- **`invoke` calls** — Fresh used a Preact proxy; TanStack uses generated `invoke.gen.ts`.
- **Commerce hooks** — `useCart`, `useUser`: import from `@decocms/apps-vtex/hooks`.

## References (load only what you need)

Load via explicit path — do not load all at once:
- `skills/knowledge/tanstack/hydration-fixes.md` — hydration mismatches
- `skills/knowledge/tanstack/navigation.md` — useNavigate, Link, SPA nav
- `skills/knowledge/tanstack/react-hooks-patterns.md` — signals → React state
- `skills/knowledge/tanstack/jsx-migration.md` — Preact → React JSX patterns
