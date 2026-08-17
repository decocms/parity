/**
 * FastStore (VTEX) v4 target playbook. A short pointer for the migration agent
 * — CLI commands + doc URLs + structure map, NOT inlined docs (token economy).
 * The agent scaffolds with `@faststore/cli` and fills sections; there is no
 * codegen exporter in the core (see plan).
 *
 * Shipped as a `.ts` string (not `.md`) so `bun build` bundles it into
 * `dist/cli.js` — loose `.md` files aren't copied to `dist`.
 */
export const faststore = `## Target: VTEX FastStore (v4)

Generate the migrated storefront as a FastStore v4 project. Do NOT hand-roll the
scaffold — use the official CLI, then fill in sections from the components below.

### Setup (once)
- Requirements + project setup: https://developers.vtex.com/docs/guides/faststore/getting-started-requirements
- Project structure overview: https://developers.vtex.com/docs/guides/faststore/project-structure-overview
- \`yarn install\` then \`yarn dev\` → dev store at http://localhost:3000

### CLI (@faststore/cli)
- \`faststore dev\` — local dev server (localhost:3000)
- \`faststore build\` — production build
- \`faststore generate\` — regenerate schema + TS types after changes
- \`faststore cms-sync\` — sync the \`cms/\` folder with the Headless CMS

### Styling — IMPORTANT: FastStore does NOT use Tailwind
FastStore v4 styles with **SCSS design tokens + \`data-fs-*\` attributes**, not
utility classes. The Tailwind classes in each component README are a convenience
approximation — treat the **raw computed styles in manifest.json as the source
of truth** for exact values.
- **Theme** → map the extracted theme tokens (primary/secondary/background/text +
  typography/spacing/radii scales, in this snapshot's theme) to FastStore
  **global tokens** in \`src/themes/custom-theme.scss\` (inside the \`.theme\` class).
  Global tokens: https://developers.vtex.com/docs/guides/faststore/global-tokens-overview
  Theming: https://developers.vtex.com/docs/guides/faststore/using-themes-overview
- **Per-component styling** → override via each component's \`data-fs-*\` attribute
  in SCSS (e.g. \`[data-fs-product-shelf]\`), not utility classes.
  Styling a component: https://developers.vtex.com/docs/guides/faststore/using-themes-components

### Icons — Phosphor
FastStore ships Phosphor icons via the \`<Icon>\` component (\`data-fs-icon\`, \`weight\`
prop: thin|light|regular|bold). Map each entry in this snapshot's **icon inventory**
to a Phosphor icon id; add any missing ones as custom icons.
- Iconography: https://developers.vtex.com/docs/guides/faststore/reference-icons
- Adding custom icons: https://developers.vtex.com/docs/guides/faststore/atoms-icon

### Brand assets
- Logo + favicon (and apple-touch-icon / OG image) were downloaded to \`assets/\`
  in this snapshot — drop them into the FastStore project's \`public/\` and wire the
  logo into the Navbar/Header section.

### Where components go
- **Global components** (header/footer/minicart) → FastStore sections rendered
  on every page.
- **Page components** (home/PLP/PDP) → one FastStore section each, registered and
  added to the corresponding page content type under \`cms/\`.
- After adding/editing sections, run \`faststore generate\` then \`faststore cms-sync\`.
- Headless CMS model: https://developers.vtex.com/docs/guides/faststore/headless-cms-overview
- Creating sections: https://developers.vtex.com/docs/guides/faststore/creating-a-new-section-and-content-type

### e2e
Use the suggested selectors (per component, mapped to known commerce keys) to
seed Playwright/Cypress smoke tests on the migrated store.`;
