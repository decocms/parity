---
name: target-faststore-v4
description: Target playbook for VTEX FastStore v4 (@faststore/cli). Load when porting TO faststore-v4 from any source. Covers the 3-point invariant, gates, and hard rules.
---

# Target: VTEX FastStore v4

Source of truth: `docs/ai-playbooks.md` in the target repo (ALWAYS read it first
if present — it overrides everything here). This skill fills the gap when absent.

## Bootstrapping the target repo

Scaffold by **copying the code** from **`deco-sites/storefront-faststore`** (the deco
FastStore v4 template — same model as `deco-sites/storefront-tanstack`). Clone it, copy
the tree, re-init git, set the new remote. It ships the reusable infra a port needs:
`src/components/ui/atoms` + `ui/organisms`, `src/sdk`, `src/hooks`, a real `src/i18n`
runtime (`useTranslation`), worked `src/components/sections/` patterns, `cms/faststore/`
schemas + whitelists, `scripts/` (sort-cms-whitelists, guards), `docs/` playbooks, and
`.github/` gates — so ports **compose over shared organisms/atoms instead of reinventing**.

Do NOT use the bare `vtex-sites/starter.store` unless the template is unavailable — it
has none of the above (only `src/fonts` + `src/themes`), so ports come out monolithic
and can't close the 3-point invariant cleanly (there's no `cms/` tree to write into).

**Config the store**: recover the source VTEX account (the `*.vtexassets.com` subdomain
in `blocks.json`) + locale/currency (from the DOM/`manifest.json`) and set them via env
(`VTEX_STORE_ID`, `VTEX_WORKSPACE`, `CONTENT_SOURCE_PROJECT`) / `discovery.config.js`.
Replace the template's example brand theme (`src/themes/`) + assets with the store's.

**Rendering needs the account CMS.** FastStore fetches page/global content from the
store's headless CMS by documentId at runtime (local `CMS_DATA` only maps slugs→ids;
globals/home/landing re-fetch remotely). So a build is green with just code, but a
running site needs the captured content SYNCED into the account CMS (`faststore
cms-sync`, needs account write access) + the `faststore` custom app on the orderForm.
State this at the target decision: **faststore-v4 needs the client's VTEX account to
render; tanstack-deco renders standalone.**

**Gitignore build output**: `faststore build` copies `.faststore/{public,.next,
lighthouserc.js}` into the repo root. The starter's `.gitignore` misses `public/`
— add `/public/` (and confirm `/.next/`, `/.faststore`) so generated assets don't
leak into every migration commit.

## Cart / Minicart is a UI OVERRIDE, not a CMS section

The cart drawer is NOT a page section — do NOT add it to `CUSTOM_COMPONENTS` or give
it a CMS schema/whitelist. FastStore ships `.faststore/src/components/cart/CartSidebar/
CartSidebar.tsx` (built on `@faststore/ui` `CartSidebar`/`CartSidebarList`/
`CartSidebarFooter` + `useCart`/`useUI`/`useCheckoutButton`). Override it by copying
to `src/components/cart/CartSidebar/` and feeding live `useCart` data — reuse the
captured visual/structure for styling only. A standalone presentational Minicart is
fine as an interim, but wire it through the CartSidebar override, not a section.

## The 3-point invariant (porting checklist for EVERY section)

Every section must have ALL THREE or the CMS will silently drop it:

1. **Register** in `src/components/index.tsx` — TWO things, both required:
   ```ts
   import MySection from "./sections/MySection/MySection";
   export { default as MySection } from "./sections/MySection/MySection"; // optional named export

   // REQUIRED: the DEFAULT export is the CUSTOM_COMPONENTS map. FastStore's
   // generated `.faststore/src/customizations/src/components` does a DEFAULT
   // import of it. A file with ONLY named exports fails the build:
   //   "Module '…/src/components/index' has no default export".
   const CUSTOM_COMPONENTS = { MySection /* key MUST equal the $componentKey */ };
   export default CUSTOM_COMPONENTS;
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
  ⚠️ FastStore's `icons.svg` sprite spells the delete glyph **`Thrash`** (their typo),
  not `Trash` — use `Thrash` or the icon renders blank.
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
