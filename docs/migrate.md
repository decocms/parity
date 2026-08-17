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
| `--viewport <viewport>` | `mobile` | `mobile` \| `desktop` \| `tablet` |
| `--format <fmt>` | `both` | `md` \| `json` \| `both` |
| `--out <dir>` | `./parity-migrate` | Output directory (stable per host) |
| `--refresh` | off | Re-run all phases even if cached |
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
    index.md            # LEAN tier: theme + assets + component map + notes
    MIGRATION_PROMPT.md # LEAN tier: agent instructions (+ target playbook)
    custom-theme.scss   # --target faststore: brand tokens → --fs-* (starter)
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

## Relationship to `extract`

`migrate` reuses `extract`'s capture primitives (`detectComponents`,
`extractComponent`, `section-capture`) and adds the theme phase, the Tailwind
IR, interaction/e2e capture, page classification, resume, and the target
playbook. `extract` stays the lower-level, single-snapshot command.
