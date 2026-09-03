# Knowledge Index

Reference files for migration agents. Load by EXPLICIT PATH only — never load
the whole directory. Each entry: path | when to load.

## TanStack

| Path | When to load |
|---|---|
| `skills/knowledge/tanstack/hydration-fixes.md` | "Hydration mismatch", `Text content does not match`, SSR errors |
| `skills/knowledge/tanstack/navigation.md` | Broken links, SPA navigation, useNavigate errors |
| `skills/knowledge/tanstack/react-hooks-patterns.md` | Signal → React state migration, useEffect, useState patterns |
| `skills/knowledge/tanstack/jsx-migration.md` | Preact → React JSX, class → className, Fragment, forwardRef |
| `skills/knowledge/tanstack/search.md` | Intelligent Search, autocomplete, useSuggestions, search params |
| `skills/knowledge/tanstack/typescript-fixes.md` | TS errors that don't break build, gen.ts not to edit |
| `skills/knowledge/tanstack/responsive-device.md` | Mobile layout on desktop, header wrong for ~5min, React #418/#419, any use of `useDevice`/`isMobile` to pick markup |

## VTEX

| Path | When to load |
|---|---|
| `skills/knowledge/vtex/apps-porting.md` | Mapping VTEX IO blocks to components |
| `skills/knowledge/vtex/fetch-cache.md` | SWR in-memory cache for VTEX API calls |
| `skills/knowledge/vtex/invoke.md` | Server functions, createServerFn, CORS, invoke.gen.ts |
| `skills/knowledge/vtex/cart.md` | useCart, orderForm, CartSidebar, expectedOrderFormSections |

## Performance

| Path | When to load |
|---|---|
| `skills/knowledge/perf/render-location.md` | Small HTML but seconds of TTFB, SPA nav slower than a reload, data resolved and never rendered |
| `skills/knowledge/perf/head-priority-and-hydration.md` | LCP bad with everything else green, Load Delay dominates, removing a tag from `<head>` or a module from the eager chunk, a page that stopped hydrating |
| `skills/knowledge/perf/payload-trim.md` | Heavy HTML, large JSON in SSR, product payload |
| `skills/knowledge/perf/edge-caching.md` | Cache-Control, staleTime, cache profiles |
| `skills/knowledge/perf/n-plus-1.md` | N+1 API calls in loaders, batching |
| `skills/knowledge/perf/variant-selection.md` | Variant change performance, replaceState |

## Parity

| Path | When to load |
|---|---|
| `skills/knowledge/parity/commands.md` | Choosing/running a parity command (run vs e2e, section, benchmark, vitals, cache, audit) — flags + score reading |

## Source

These files are vendorized from upstream repos. Run `scripts/sync-skills.ts --check`
to see if they've drifted. Source: `decocms/blocks .agents/skills/deco-to-tanstack-migration/references/`.
