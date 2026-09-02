---
name: target-faststore-next
description: Target playbook for FastStore Next — Next.js App Router on @faststore/api/sdk/ui (no @faststore/cli/core) + Deco CMS decofiles. Load when porting TO faststore-next from any source, or when a VTEX target's client wants the Deco CMS as their content source instead of the VTEX Headless CMS.
---

# Target: FastStore Next

Source of truth: `CLAUDE.md` in the target repo (ALWAYS read it first if
present — it overrides everything here). This skill fills the gap when absent.

## Two FastStore targets exist by design — pick one at discovery, not mid-migration

`faststore-v4` (`skills/target-faststore-v4/SKILL.md`) and `faststore-next`
(this skill) are **not** a legacy/current pair or competing defaults. Which
one a client gets is a decision made once, at discovery, based on who owns
content:

| | `faststore-v4` | `faststore-next` (this skill) |
|---|---|---|
| Build tool | `@faststore/cli` (`.faststore/` merge layer) | Plain Next.js — no CLI/core |
| Content source | VTEX Headless CMS (`cms/faststore/*.jsonc`) | Deco CMS/Studio (`.deco/blocks/*.json`) |
| Styling | SCSS, `--fs-*` tokens | Tailwind v4 utilities, no SCSS |
| Rendering | `core` fetches CMS content by documentId at runtime — **needs the client's VTEX account to render** | Renders standalone; VTEX/Synerise are data sources, not the CMS |
| Pick when | Client wants the VTEX-native CMS/WebOps editing flow | Client wants Deco Studio as the editing surface (this is Deco's core product) |

If a migration was scaffolded on one and the client later wants the other,
that is a **new migration project**, not a "flip" — the CMS content-authoring
model is a different repo shape, not a config flag. See the ADR in
`decocms/context` for the standing decision record; don't let this get
re-litigated per-migration.

## Bootstrapping the target repo

Scaffold by **copying the code** from **`deco-sites/faststore-next-template`**
(the generic form of `deco-sites/faststore-fila`'s platform layer — same
copy/re-init model as the other two targets). Clone it, copy the tree,
re-init git, set the new remote. It ships: `src/app/` App Router structure,
`src/sdk/gallery/` (PLP pagination + ISR, with its own boundary tests — don't
reinvent this), `src/proxy.ts` (gradual-cutover reverse-proxy pattern, see
below), `src/sdk/deco/` (CMS bootstrap), VTEX GraphQL resolvers in
`src/customizations/src/graphql/vtex/`, **native Synerise resolvers**
(`.../thirdParty/synerise*.ts` + `src/sdk/synerise/` + the CSR-only rendering
rule), observability (OTel), and the WebOps deploy accommodations (see
Hard rules). See `TEMPLATE.md` in that repo for the exact TODO list —
grep for `TODO_` after cloning.

The repo itself (does it exist? create it private?) is `repo-setup` step 0 in
`skills/migration-orchestrator/SKILL.md` — check before copying anything.

Do NOT start from the bare `vtex-sites/starter.store` — it has none of the
above, and re-deriving the PLP pagination/ISR mechanics or the WebOps
accommodations from scratch is exactly the work this template exists to
short-circuit (they took a production incident history to get right).

**Config the store**: recover the source VTEX account (the `*.vtexassets.com`
subdomain in `blocks.json`, or the account id from `window.__RUNTIME__` on a
live vtex-io source) and set `discovery.config.js`'s `api.storeId` — this
value is PUBLIC (client-bundled), not secret. Fill in `storeUrl`/
`checkoutUrl`/`loginUrl`/`accountUrl` from the source's real domains.

**Rendering does NOT need the client's VTEX account for CMS content** — that
is the structural difference from `faststore-v4`. Page/section content comes
from `.deco/blocks/*.json` (Deco CMS), read at build/request time by this
app's own runtime; VTEX and Synerise are commerce/search data sources, not
the CMS. A build is green with just code AND renders correctly with just
code — decofiles are what turn it into a real site (see "Bootstrapping a
site's content" below).

**Gradual cutover via `proxy.ts`**: this target's reverse-proxy pattern lets
the new site go live on the client's domain one route at a time instead of
an all-or-nothing switch — `resolveProxyOrigin(pathname)` returns an origin
for any path not yet migrated, and the request is proxied whole to the
legacy VTEX IO origin. Start with everything proxied except the pages
actually ported; shrink the proxied set as porting completes. This is how
Fila validated in a WebOps staging environment before cutover — reuse the
mechanism, don't design a new one per migration.

## Bootstrapping a site's content (the part the template doesn't ship)

The template ships zero decofiles on purpose — content is per-site. This is
where `parity migrate`'s VTEX IO capture pays off: it already reads
`window.__RUNTIME__` on every captured page and writes `blocks.json` with
each block's **resolved content** (banner images/text/links/shelf config)
plus downloaded content images. Emit that as `.deco/blocks/*.json` shaped to
match this target's section registry (`src/sections/<Path>.tsx` — the file
path IS the Studio block key, see the 3-point-equivalent rule below), not as
`faststore-v4`'s `cms/faststore/*.jsonc` CMS schema shape.

## The porting checklist for EVERY section (this target's equivalent of the 3-point invariant)

Unlike `faststore-v4`'s CMS-schema-file model, a Deco CMS section needs:

1. **The component** in `src/components/sections/<Path>/<Name>.tsx` — a
   typed `Props` export IS the CMS schema (blocks-cli's ts-morph step derives
   it — no separate `.jsonc` to hand-write or keep in sync).
2. **The shim** in `src/sections/<Path>.tsx` — thin re-export:
   `export { default } from "src/components/sections/<Path>/<Name>"`, plus
   convention exports (`sync = true`, `layout = true` on Header/Footer,
   `cache = "listing"`, etc. — see the template's `CLAUDE.md`). The file's
   PATH is the Studio block key — this is the whole registration; there is
   no separate whitelist file to update.
3. **`bun run generate:deco`** — regenerates `.deco/*.gen.*`. Does not watch;
   rerun + restart dev after adding a section or changing a `Props` type.

**Editability gate — check this for every ported section, it's what
`parity`'s visual/functional checks structurally cannot see:** does the
section actually read from its decofile, or did the port hardcode the
captured content into JSX? A section with trivial/empty `Props` or literal
strings > ~25 chars in the component body is a section a merchant can't
edit in Studio — visually identical to prod, but a CMS regression. Check
`src/sections/<Path>.tsx` maps 1:1 to a real component with real `Props`,
not a static re-skin of the capture.

## Hard rules (carried from the Fila production record — see the template's CLAUDE.md for the full, load-bearing versions)

- **Rendering golden rule: CMS data renders SSR; product/search data renders
  CSR.** Product cells never appear in server HTML when Synerise search is in
  use (its requests are shopper-`clientUUID`-dependent and browser-only).
  This is an architecture decision made once, up front — a site that starts
  SSR-ing product data and adds Synerise later needs its rendering split
  reworked, not patched. Decide this before porting the first section, not
  after `parity` flags SSR/CSR deltas as false-positive regressions.
- **No SCSS.** Tailwind v4 utilities only, tokens as concrete values in
  `src/styles/tailwind.css` — do not reintroduce a `--fs-*` bridge (that's
  the other target's model).
- **`discovery.config.js` is public** (client-bundled) — never put secrets
  there. Real secrets go in `.env.local` (gitignored) / the deploy
  platform's env UI.
- **WebOps deploy accommodations are load-bearing, not cleanup targets**:
  build-time tooling (`tsx`, `@decocms/blocks-cli`, `@graphql-codegen/cli`,
  `prettier`, `@types/react`) sits in `dependencies`, not `devDependencies`,
  because WebOps production installs skip devDependencies — moving them
  "for hygiene" breaks the deploy silently (build succeeds locally, fails on
  WebOps). Branch names must not contain a second `/` (WebOps naming
  constraint) — dashes only past the first segment.
- Never edit `node_modules` or generated files (`@generated/`, `.deco/*.gen.*`).

## Gates (run before signaling done)

```bash
bun run generate       # regenerate .deco/*.gen.*, GraphQL schema/codegen
bun run build           # next build --webpack (runs generate first)
bun jest <path> --testPathIgnorePatterns '/node_modules/' 'cypress/'
bun run knip            # unused code/deps — merge gate
```

CI pattern to port from the template: `.github/workflows/quality-checks.yml`
(jest, `next build`, Cypress against the prod build, product-URL guard, knip)
— this is the reusable-workflow candidate; don't hand-write a new one per site.

## CLI commands

```bash
bun dev                 # localhost:3000
bun run dev:worktree    # WORKTREE_SLUG=<slug> → http://<slug>.localhost
bun run build           # prod build
bun run generate:deco   # after adding/changing a section — restart dev after
```

## Deploy

WebOps builds this repo directly from `discovery.config.js` + `package.json`
scripts — there is no Cloudflare Workers Builds app and no deploy workflow
to create (that rule is `tanstack-deco`-specific). Do not add a `deploy.yml`.
Staging validation happens on the WebOps-provisioned preview domain before
DNS cutover; use the `proxy.ts` gradual-cutover pattern (above) for a
route-by-route rollout instead of an all-or-nothing switch.
