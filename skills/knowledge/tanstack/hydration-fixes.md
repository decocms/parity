<!--
  SOURCE: decocms/blocks .agents/skills/deco-to-tanstack-migration/references/hydration-fixes.md
  Run `bun run scripts/sync-skills.ts` to pull the latest version.
  Summary below is a condensed stub; load the full file when investigating a specific error.
-->

# Hydration Fixes — Key Patterns

## Most common causes

1. **Client-only globals in server render** (`window`, `document`, `globalThis.location`)
   - Fix: `typeof window !== "undefined"` guard, or move to `useEffect`
   - FastStore: `typeof window === 'undefined'` is standard in SSR checks

2. **Prop/text content mismatch** (`Hydration failed because initial UI does not match`)
   - Root cause: server renders different HTML than client re-renders
   - Fix: ensure SSR and client use identical data (no `Date.now()`, no `Math.random()`)

3. **`useDevice` mismatch** — server returns one breakpoint, client another
   - `@decocms/start/sdk/device` does NOT fix this: it reads `RequestContext`
     (server-only), so the client re-render falls back to the default
   - Fix: don't branch markup on device at all — `skills/knowledge/tanstack/responsive-device.md`

4. **Static arrays/objects in module scope** that reference DOM
   - Fix: move inside the component function or to `useMemo`

5. **Missing Suspense boundary** for async sections
   - Fix: wrap with `<Suspense fallback={<Skeleton />}>`

For the full 765-line reference with specific error patterns and fixes:
`gh api repos/decocms/blocks/contents/.agents/skills/deco-to-tanstack-migration/references/hydration-fixes.md`
