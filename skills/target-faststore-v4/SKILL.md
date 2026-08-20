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

**The app runs locally; only real CONTENT needs the account.** `faststore dev`
serves `http://localhost:3000` with zero account access — code renders fine. What
comes from the account is the page/global CONTENT: FastStore fetches it by
documentId at runtime (local `CMS_DATA` only maps slugs→ids; globals/home/landing
re-fetch remotely). So a build is green and the app boots with just code, but real
content requires the VTEX account.

**Modern content path = Content Platform (CP), not Headless CMS.** On FastStore v4
today, **Headless CMS is LEGACY** (`faststore cms-sync` / `yarn cms-sync` — legacy
flows only). The current flow is the **Content Platform**: upload component/page
schemas with the VTEX Content plugin — `vtex content …` (repos often wrap it as
`yarn cms:content` = generate-schema + upload-schema). Without the schema uploaded,
the Admin/CP can't see a component. Check `package.json` scripts + the repo README
before assuming which path a repo uses (grep `cms:content`/`vtex content` = CP;
`cms-sync` = legacy).

**Local content preview: `/api/preview`.** To preview real CP content on localhost
without a full deploy, use the app's preview route against a CP branch:
`http://localhost:3000/api/preview?contentType=home&documentId=<entryId>&versionId=<branchId>&slug=/&locale=<locale>`
(create the branch + edit content in the CP admin panel first; per-page for now).
This is how you validate a candidate locally when the account content exists.

State this at the target decision: **faststore-v4 needs the client's VTEX account
for real content (CP schema upload + a `faststore` custom app on the orderForm);
the app itself runs locally either way. tanstack-deco renders standalone.**

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
faststore dev         # localhost:3000 (runs with no account access)
faststore build       # production build
faststore generate    # regenerate schema + TS types (run after adding sections)

# Content — modern path (Content Platform), often wrapped as a repo script:
vtex content ...      # a.k.a. `yarn cms:content` — generate + upload CP schemas
# /api/preview?contentType=…&documentId=…&versionId=…&slug=/&locale=… — preview a CP branch locally

# Content — LEGACY (Headless CMS), only for legacy flows:
faststore cms-sync    # a.k.a. `yarn cms-sync` — sync cms/ folder to Headless CMS
```
