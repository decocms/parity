---
name: target-faststore-v4
description: Target playbook for VTEX FastStore v4 (@faststore/cli). Load when porting TO faststore-v4 from any source. Covers the 3-point invariant, gates, and hard rules.
---

# Target: VTEX FastStore v4

Source of truth: `docs/ai-playbooks.md` in the target repo (ALWAYS read it first
if present — it overrides everything here). This skill fills the gap when absent.

## The 3-point invariant (porting checklist for EVERY section)

Every section must have ALL THREE or the CMS will silently drop it:

1. **Export** in `src/components/index.tsx`
   ```ts
   export { default as MySection } from "./sections/MySection/MySection";
   // The KEY is the $componentKey — must match exactly
   ```
2. **CMS schema** at `cms/faststore/components/cms_component__<sectionname>.jsonc`
   - `$componentKey` = the export key from step 1 (case-sensitive)
   - `$componentTitle` = human label in the CMS
   - Use `required` for fields that are truly required for a valid render
   - **NO** `default`/`defaultValue` to hide absent content (CMS-first principle)
3. **Whitelist entry** in `cms/faststore/pages/cms_content_type__*.jsonc`
   - Sections array must be **alphabetically sorted by `$ref`**
   - Run `node scripts/sort-cms-whitelists.mjs` to fix; it auto-sorts
   - Pre-push hook validates this — a malformed whitelist blocks the push

## Hard rules (from the electrolux-poc AGENTS.md pattern)

- **Mobile-first CSS**: base = mobile, increments with `>=` breakpoints. No desktop-first.
- **Only `--fs-*` tokens**: never hex/rgb/px in components. Check `docs/tokens.md`.
- **Never `:global()` in `.module.scss`**: override atoms via className prop merge.
- **`.faststore/` is READ-ONLY**: override by copying to `src/` — never edit in-place.
- **i18n for every visible string**: no hardcoded user-facing text.
- **Icons**: Phosphor via the `Icon` atom only. No alternative icon libraries.
- **`color-contrast`**: NEVER decide a color for contrast. Add `// TODO: verify with Design`.
- **Atoms DS-aligned**: `Button`, `Icon`, `IconButton`, `LinkButton` from `src/components/ui/atoms/`.
  Never `ButtonBase`, `IconButtonBase`, `LinkButtonBase` (removed).

## Gates (run before signaling done)

```bash
yarn quality:guard    # blocks commit — checks CLS risks, aria-label, img dimensions
bun run check         # or: yarn lint
yarn stylelint "src/**/*.scss"
node scripts/validate-responsive-mixins.mjs
```

## CLI commands

```bash
faststore dev         # localhost:3000
faststore build       # production build
faststore generate    # regenerate schema + TS types (run after adding sections)
faststore cms-sync    # sync cms/ folder to Headless CMS
```
