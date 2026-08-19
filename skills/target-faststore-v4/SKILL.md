---
name: target-faststore-v4
description: Target playbook for VTEX FastStore v4 (@faststore/cli). Load when porting TO faststore-v4 from any source. Covers the 3-point invariant, gates, and hard rules.
---

# Target: VTEX FastStore v4

Source of truth: `docs/ai-playbooks.md` in the target repo (ALWAYS read it first
if present — it overrides everything here). This skill fills the gap when absent.

## Bootstrapping the target repo

Scaffold from `vtex-sites/starter.store` (public FastStore v4 template repo):
`gh repo create <owner>/<name> --private --template vtex-sites/starter.store`.

**But the starter is BARE** — it ships only `src/fonts` + `src/themes`. It has NO
`cms/faststore/`, no `src/components/ui/atoms/`, no i18n message runtime, no
`docs/*playbooks`, and no `scripts/sort-cms-whitelists.mjs` / `yarn quality:guard`
gate. This skill's rules assume a MATURE store (like the electrolux-poc). On a fresh
starter you must CREATE the tree as you port:
- `src/components/index.tsx` (with the default `CUSTOM_COMPONENTS` map — see below),
- `cms/faststore/components/` (schemas) + `cms/faststore/pages/` (whitelists),
- `src/i18n/messages/<locale>.json` (read directly with a local `t()` until a real
  provider is wired), and reference `@faststore/ui` for `Icon` + global `--fs-*`
  token scale (`--fs-spacing-*`, `--fs-color-neutral-*`, `--fs-text-*`) — the
  generated `custom-theme.scss` only carries BRAND tokens.

**Config the store**: recover the source VTEX account (the `*.vtexassets.com`
subdomain in `blocks.json`) + locale/currency (from the DOM/`manifest.json`) and
write them into `discovery.config.js` (`api.storeId`,
`session.locale/currency/country`) — the starter ships the demo `newstore`. The build queries the store's PUBLIC catalog, so no client credentials
are needed. Assets the live site renders via config (e.g. a logo with no `<img>`)
can't be recovered from the capture — leave them as required CMS fields.

Prefer a reusable **deco FastStore template** (with the conventions pre-baked) once
one exists — same model as `deco-sites/storefront-tanstack` for TanStack.

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
