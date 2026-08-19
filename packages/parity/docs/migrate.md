# `parity migrate` — phased, AI-ready migration capture

## Why

`parity extract` snapshots a site's components. `parity migrate` goes further:
it runs a **phased migration capture** over one live storefront and produces a
**target-agnostic, token-lean bundle + prompt** for a migration agent — theme,
classified pages, and per-component detail (suggested Tailwind classes,
interaction hints, and e2e selectors).

Like `extract`, it does **not** compare prod × cand — it looks at one live URL,
and works whether or not the source code exists. Use it to migrate a storefront
to a new framework (e.g. VTEX IO → FastStore) when you want the agent to ground
its work in what the site actually renders.

## Usage

```bash
parity migrate --url https://loja.com \
  [--pages /,category-auto,pdp-auto] \
  [--components header,footer,nav,shelf,minicart] \
  [--target faststore] \
  [--viewport mobile|desktop|tablet] \
  [--format md|json|both] \
  [--out ./parity-migrate] \
  [--refresh] \
  [--no-llm]
```

## Phases

1. **Theme + assets** — one in-page pass elects the primary/secondary/background/
   text colors (most-frequent non-neutral interactive backgrounds win primary)
   and builds the typography/spacing/radii scales + a token map (`theme.json`).
   The same pass captures **brand assets** — logo, favicon, apple-touch-icon,
   OG image, web app manifest, web fonts — and an **icon inventory** (inline
   SVGs, `<use>` symbol ids, icon-font glyphs). Logo/favicon/apple-touch-icon/
   OG image are **downloaded** to `assets/`; the rest are referenced
   (`assets.json`).
2. **Sitemap** — resolves the pages to capture (default: home + a PLP + a PDP
   via `category-auto`/`pdp-auto`) and saves the site's classified sitemap URLs
   for reference. Written to `sitemap.json`.
3. **Components** — per page, detects components (reusing `extract`'s detector),
   collapses structurally-identical repeats (a row of shelves → one + `×N`)
   **before** the expensive capture, then for each: rendered HTML, computed
   styles, screenshot, **deterministic Tailwind classes**, light interaction
   hints (declared `:hover`/`:focus` + transitions) and **suggested e2e
   selectors**. Global roles (header/footer/nav/minicart) are captured once.
   Written to `capture.json`.

## Resume

The output dir is **stable per host** (no timestamp), so a re-run skips any
phase whose artifact already exists. Pass `--refresh` to redo every phase.

## Flags

| Flag | Default | What it does |
| --- | --- | --- |
| `--url <url>` | _(required)_ | Site to migrate from |
| `--pages <list>` | `/,category-auto,pdp-auto` | Literal paths/URLs and/or `category-auto`/`pdp-auto` |
| `--components <list>` | all detected | Role allowlist (exact role or `<name>-*`) |
| `--target <name>` | none | Appends a target playbook to the prompt (e.g. `faststore`) |
| `--source <dir>` | none | Path to the source repo. Reads the component inventory from CODE and prepends the source playbook to the prompt |
| `--source-kind <kind>` | auto-detect | Force the source: `deco-fresh` \| `vtex-io` \| `live-only` |
| `--viewport <viewport>` | `mobile` | `mobile` \| `desktop` \| `tablet` |
| `--format <fmt>` | `both` | `md` \| `json` \| `both` |
| `--out <dir>` | `./parity-migrate` | Output directory (stable per host) |
| `--sample <spec>` | `plp=2,pdp=2,other=3,search=1` | Extra pages sampled from the sitemap by kind (`other` = institutional; institutional pages are preferred). Capped at 15 total pages. |
| `--refresh` | off | Re-run all phases even if cached |
| `--open` | off | Open the generated `index.html` visual report in the browser |
| `--no-llm` | LLM on (if configured) | Skip the optional component-relabel pass |
| `--json` | off | Emit one-line JSON to stdout |

## Output layout

```
parity-migrate/
  loja.com/
    theme.json          # Phase 1 (theme tokens + scales + breakpoints + motion)
    assets.json         # Phase 1 (platform + brand assets + icons + screenshots)
    assets/             # Phase 1 (downloaded logo, favicon, og-image, …)
    screenshots/        # Phase 1 (full-page site screenshot per viewport)
    sitemap.json        # Phase 2
    capture.json        # Phase 3 (resume checkpoint)
    manifest.json       # FULL tier: complete MigrationBundle (raw HTML + CSS)
    index.html          # human visual report (references screenshots/ + assets/)
    report.html         # SAME report, fully self-contained (images inlined) — shareable single file; `--open` opens this
    assets/fonts/       # downloaded web-font files (.woff2/.woff)
    index.md            # LEAN tier: theme + assets + component map + notes
    MIGRATION_PROMPT.md # LEAN tier: agent instructions (+ source & target playbooks)
    migration-plan.json # machine contract: source/target + reconciled components
    custom-theme.scss   # --target faststore: brand tokens → --fs-* (starter)
    blocks.json         # VTEX IO only: raw block tree from window.__RUNTIME__
    component-map.json  # VTEX IO only: block → FastStore component (+ custom-component)
    components/
      header-3/
        README.md       # LEAN: Tailwind, interactions, e2e selectors, compacted HTML
        component.html  # raw HTML
        styles.json     # raw computed styles
        screenshot.png
```

## Token economy

The artifact an agent reads (`index.md` + `components/*/README.md` +
`MIGRATION_PROMPT.md`) is deliberately lean; the full raw data lives only in
`manifest.json` and is never meant to be fed to an LLM.

- **Tailwind instead of raw CSS** in the lean tier.
- **Repeated siblings collapsed** to one representative + `×N` marker.
- **Repeated components collapsed** before capture (role + structural signature).
- **Utility classes purged**, base64 data-URIs / scripts / styles stripped.
- **Theme by reference** — tokens defined once; components use `bg-primary`.
- **Per-component files** — the agent migrates one component at a time.
- Truncation/collapse is surfaced in `index.md`'s "Compaction notes" — never
  silent.

## Targets

`--target <name>` appends a short **playbook** (CLI commands + doc links +
structure map) to `MIGRATION_PROMPT.md`. `faststore` ships today. There is no
framework codegen in the core — the agent scaffolds with the target's CLI and
fills sections. Add a target by adding a string to `src/migrate/targets/`.

**Note on Tailwind vs the target.** The Tailwind classes in each component are a
target-agnostic convenience IR. Some targets don't use Tailwind — e.g. FastStore
v4 styles with **SCSS design tokens + `data-fs-*` attributes** and **Phosphor
icons**. For those, the extracted **theme tokens** map to the target's design
tokens and the **raw computed styles** (in `manifest.json`) are the exact-value
source of truth; the `faststore` playbook spells this out.

## Source & the migration plan

`--source <dir>` points at the original repo (the input mirror of `--target`).
The source is sniffed on disk — `deco-fresh` (a `deno.json` importing `@deco/deco`
+ `fresh.gen.ts`), `vtex-io` (a `manifest.json` with a `store` builder /
`vtex.store*` dep), or `live-only` (the fallback when `--source` is omitted or
nothing matches). Override with `--source-kind`. When a source repo is present,
the component inventory comes from **code** (exhaustive, exact names) instead of
DOM heuristics, and the source's **playbook** (framework gotchas) is prepended to
`MIGRATION_PROMPT.md` ahead of the target playbook.

`migration-plan.json` is the machine contract every orchestration phase reads
(instead of re-parsing `manifest.json`). It carries the source/target decision,
the page list, and one row per component reconciling code against the live
capture:

- `origin` — `both` (in code and seen live), `source-only` (in code, not
  observed live), or `live-only` (seen live, no source file).
- `status` — `pending` \| `done` \| `skipped`, all `pending` at creation; an
  orchestrator flips it in-place as it ports.
- `file` — repo-relative source path when the code defines the component.

`source-only` components also join the lean artifact as **synthetic** entries
(empty capture, flagged in the component's README and prompt row) so an agent
reading only the capture still sees them and ports them from the source code.

## VTEX IO stores (block tree)

When the site is a VTEX IO storefront, `migrate` reads the store's **real
declarative block tree** from `window.__RUNTIME__` (the render-runtime
serialized into the page) **on every captured page** (home + PLP + PDP +
institutional), merging them by treePath — so the whole store's content is
captured, not just the home page. It writes:

- `blocks.json` — every block instance (treePath, block id, resolved component,
  parent) from the runtime, **including each block's `props` — the CMS content
  the merchant registered** (banner images, texts, links, shelf config, …). This
  captures the storefront's actual content, not just its structure. Image
  references in props are **resolved to absolute URLs** (VTEX stores use
  site-relative pointers like `/arquivos/ids/…` and `/img/…`).
- `content-assets.json` + `assets/content/` — the content images from block
  props, **downloaded** locally with a `url → local file` map (so the migration
  ships the store's actual content imagery).
- `component-map.json` — each unique block id → a FastStore component with a
  confidence hint (e.g. `product-summary→ProductCard`, `flex-layout.row→
  FlexLayout`, `rich-text→RichText`). Unknown/`custom.*` blocks get
  `strategy: "custom-component"` (build from the captured DOM/CSS/assets).

Layout slots (`$before_*`/`$around_*`) are dropped. The map is deterministic and
additive — DOM capture still runs and remains the target-agnostic fallback.

## Relationship to `extract`

`migrate` reuses `extract`'s capture primitives (`detectComponents`,
`extractComponent`, `section-capture`) and adds the theme phase, the Tailwind
IR, interaction/e2e capture, page classification, resume, and the target
playbook. `extract` stays the lower-level, single-snapshot command.
