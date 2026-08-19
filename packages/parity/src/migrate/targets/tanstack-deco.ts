/**
 * TanStack Start + Deco CMS target playbook. The migration agent scaffolds from
 * `decocms/tanstack-storefront` and fills in sections using the components below.
 */
export const tanstackDeco = `## Target: TanStack Start + Deco CMS

Generate the migrated storefront as a TanStack Start / Cloudflare Workers site using
the @decocms/* packages. Scaffold from the official template before porting sections.

### Setup (once)
- Clone: \`gh repo clone decocms/tanstack-storefront <name>\`
- Install: \`bun install\`
- Dev: \`bun run dev\` → http://localhost:5173

### CLI (@faststore/cli is NOT used here — this is TanStack)
- \`bun run dev\`         local dev server (Vite + Cloudflare Workers)
- \`bun run build\`       production build
- \`bun run predev\`      regenerate types + invoke stubs (run after adding sections)

### Sections — the CMS unit (mirror of Fresh's sections/)
Each component from the capture → a section in \`src/components/sections/<Name>.tsx\`.
Three things must stay in sync (TypeScript enforces this at build time):
1. Export in \`src/components/index.tsx\` (the key IS the CMS block type).
2. \`export const schema\` on the component (Zod — replaces Fresh's JSDoc annotations).
3. A loader in \`src/loaders/\` when the section needs server data.

### Styling
TanStack Deco uses **Tailwind** (utility classes) and CSS Modules for overrides,
NOT SCSS design-token variables (that's FastStore v4). The captured Tailwind classes
per component are the starting point; cross-check against the prod screenshots.

### Commerce (VTEX)
\`@decocms/apps-vtex\` provides loaders and hooks. Import from there instead of
writing raw GraphQL/REST. Key hooks: \`useCart\`, \`useUser\`, \`useProduct\`.

### After porting each section
\`bun run predev\` — regenerates \`src/components/manifest.gen.ts\` and
\`src/invoke.gen.ts\`. A missing entry here is a 404 in the Deco admin.`;
