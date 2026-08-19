<!--
  SOURCE: decocms/blocks .agents/skills/deco-to-tanstack-migration/references/navigation.md
  Run `bun run scripts/sync-skills.ts` to pull the latest version.
-->

# Navigation — Key Patterns

## Link component

```tsx
// TanStack: use Link from @tanstack/react-router (or the site's ui/Link)
import { Link } from "~/components/ui/Link";
// NOT: import { Link } from "$fresh/runtime.ts"
```

## Programmatic navigation

```tsx
import { useNavigate } from "@tanstack/react-router";
const navigate = useNavigate();
navigate({ to: "/checkout" });
```

## SPA navigation between routes

TanStack Start uses file-based routing in `src/routes/`. The CMS-driven catch-all
is typically `src/routes/$.tsx`. Page transitions use the router's built-in
prefetch — no manual `window.location` changes.

## Search params

```tsx
import { useSearch } from "@tanstack/react-router";
const { page, sort } = useSearch({ strict: false });
```

Full reference (666 lines): load from blocks via sync-skills.ts or gh api.
