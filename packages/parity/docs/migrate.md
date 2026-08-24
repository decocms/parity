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

## Stack detection

Phase 1 classifies **what the site is built with** — the verdict that drives a
migration's path — and logs it (`stack: deco-fresh + htmx, commerce: vtex`). It's
stored in `assets.json` and on the bundle (`bundle.stack`):

- `frontend`: `deco-fresh` | `vtex-io` | `faststore` | `salesforce-commerce` | `unknown`
  — a deco frontend on a **custom domain** is detected from markup, not the URL.
- `htmx`: deco-fresh only — `true` when the HTMX plugin is in use (`hx-*` attrs /
  `htmx.org`), the signal that a port needs an extra `hx-*` → React refactor pass.
- `commerce`: the backend the ported components keep calling (`vtex` can sit
  behind a `deco-fresh` frontend).

Markers are calibrated against real stores; see `src/migrate/sources/classify.ts`.

The HTML report header surfaces this verdict (`deco-fresh + htmx · commerce: vtex`)
plus the paired source (`--source` repo or `live capture (no repo)`) instead of the
bare platform. Full-page screenshots render in a scrollable phone/desktop frame,
and logo detection rejects full-width banners/forms (picks the top, logo-shaped
image), preferring the downloaded `<img>` over a rendered-element screenshot.

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

### Starter theme per target

Every target declares its own starter theme in `src/migrate/targets/index.ts`, and `migrate` writes
whichever the `--target` resolves to:

| target | file | shape |
| --- | --- | --- |
| `faststore` / `faststore-v4` | `custom-theme.scss` | SCSS `--fs-*` tokens — `@faststore/cli` mandates that contract |
| `faststore-next` | `theme.css` | Tailwind v4 `@theme` block |
| `tanstack` / `tanstack-deco` | `theme.css` | Tailwind v4 `@theme` block |

The declaration lives in the registry rather than in the command on purpose: theme generation used
to be hardcoded to the v4 target, so `--target faststore-next` and `--target tanstack-deco` produced
**no theme at all, silently** (#309). A target may legitimately have none — but then it says so in
the registry instead of a caller forgetting it, and a test asserts every registered target declares
one.

Both Tailwind targets share one builder; only the header comment differs, because what the agent
should do with the file differs. The Deco one says *reconcile* — a Deco site already declares tokens
in `tailwind.css` and possibly in a CMS-editable Theme block, and three parallel token sets is worse
than none.

Omitting `--target` still writes no theme: without a target there is no way to know which shape to
emit.

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
- `status` — `pending` \| `partial` \| `done` \| `as-is` \| `upgrade` \|
  `skipped`, all `pending` at creation; the orchestrator flips it via
  `parity plan set-status <name> <status> [--dir]` (default `.parity/`; case- and
  separator-insensitive name match) rather than hand-editing the JSON. `partial`
  is for a half-wired target: on FastStore a section needs component + CMS schema
  + whitelist entry, so a schema with no `index.tsx` registration (or the reverse)
  is neither pending nor done — reporting it as `pending` sends a porter to redo
  finished work. The plan lives at `<target>/.parity/migration-plan.json` — the
  single source of truth for components, so it survives a resume.
- `file` — repo-relative source path when the code defines the component.
- `selector` — the captured CSS selector, so a per-component validation command
  can be built without re-reading the capture.
- `reference` — `{ url, selector, note }` when this component is **not** measured
  against prod. See "Deliberate divergence" below.
- `verified` — `{ at, verdict, against, note? }`, the last recorded comparison. A
  `done` row with no `verified` only means the code exists.

### Deliberate divergence — `as-is` vs `upgrade`

Both mean "stop opening work for this", for opposite reasons, and the difference
is the whole point:

| status | What it says | Reference |
| --- | --- | --- |
| `as-is` | different from prod, accepted, not worth the work | still prod |
| `upgrade` | the target is deliberately **ahead** — a better component brought in from elsewhere | **not prod** |

`skipped` keeps its old meaning: not going to do it.

An `upgrade` is not a label nuance, it is a change of reference. Point the
component somewhere else and say why:

```bash
parity plan set-reference <name> --url https://other-site.example \
  --selector ".hero-v2" --note "brought over from the other storefront"
```

`--note` is required. An `upgrade` with no written reason is indistinguishable
from a forgotten gap six months later.

This works because `parity section --prod <url>` takes any URL — nothing forces
it to be the production site — so the component gets compared against where it
actually came from. Do **not** reach for `.parityignore`'s
`ignoreSelectorsVisual` for this: that blinds the diff to the selector, so a real
regression in the improved component also stops being seen.

Record the outcome of a comparison with:

```bash
parity plan verify <name> pass|fail [--note "<what was seen>"]
```

`against` is derived from the row (`reference` when one is set, otherwise
`prod`), so a caller cannot record a pass against the wrong thing.

Each `pages[]` row also carries a `status`, flipped via
`parity plan set-page-status <path> <status>`:

- `pending` — no route/sections for it yet.
- `code` — route + sections exist but the CMS has no published content, so the
  page renders empty. **On FastStore this is the most common real state** —
  code-complete is not page-complete.
- `done` — code AND content live. `skipped` — intentionally out of scope.

Each `pages[]` row also carries `components[]` — the component names the capture
saw on that page. This is what turns a flat component list into per-page work;
without it there is no answer to "what is left on the PDP?". Plans written before
these edges existed have no `components` key, which reads as *unknown*, not
*none*.

### `parity plan page <path>` — the per-page worksheet

```bash
parity plan page /some-product/p --dir <target>/.parity --cand http://localhost:3000
parity plan page /some-product/p --dir <target>/.parity --json
```

Every component the capture saw on that page, grouped by what to do about it:

| disposition | Derived from | Task |
| --- | --- | --- |
| `build` | `pending` / `partial` | port it |
| `validate` | `done`, or `upgrade` **with** a reference, and never verified | run the printed `parity section` command |
| `upgrade` | `upgrade` with **no** reference | human review — there is nothing to compare against |
| `as-is` | `as-is` | none; listed so nobody re-raises it |
| `settled` | verified, or `skipped` | none |

Dispositions are **derived, never stored**: a second task store drifts from the
plan on the first round and then neither is trustworthy. `--cand` is a flag
rather than a plan field because the plan describes the capture, not whichever
environment happens to be running.

`ready: true` means nothing is left to build or validate on that page — the
signal for `parity plan set-page-status <path> done`.

Note that **global components (header, footer, nav) are not page members** in the
capture, so they never appear in a page worksheet. Order globals first by
`scope`, before walking pages, or a global fix reopens pages already closed.

### `parity plan board` — the per-page kanban

```bash
parity plan board --dir <target>/.parity
parity plan board --dir <target>/.parity --json
```

Every sampled page in a lane, plus what blocks it. Lanes are **derived** from the
page's components (never stored), so a page cannot read as done while a component
it needs is still missing:

| lane | Derived from |
| --- | --- |
| `triage` | no page/component edges, or the capture saw no components — scope unconfirmed, which is **not** "nothing to do" |
| `backlog` | components to build, none started |
| `building` | components to build, some already moved |
| `review` | nothing left to build or validate (`ready`), page not closed yet |
| `done` / `skipped` | the page's explicit status |

Two lists sit outside the lanes:

- **`shell`** — global components still to build. They block every page at once,
  so they are reported once instead of repeated on each card.
- **`no page`** — components the code defines that no sampled page uses. Common on
  `deco-fresh`, whose source inventory walks `sections/*.tsx` with no page
  association. Listed rather than hidden: real work with no lane.

The board covers the pages the capture **sampled**, not every URL on the site.

### What to commit

**Commit `migration-plan.json`. Ignore everything else parity writes.**

The plan is the only parity artifact that holds information no rerun can reproduce: what was
ported, which divergence was accepted, which component is deliberately ahead of prod and the
written reason why, what was verified against what. That is review material — "we marked the
footer `upgrade` because it came from the other storefront" belongs in a diff, not in someone's
memory. It is also small: a real 20-component / 10-page plan is **8 KB**.

Everything else is either machine-local run state or a regenerable capture, and two of them are
multi-megabyte:

```gitignore
# parity — commit .parity/migration-plan.json, ignore the rest
.parity/*
!.parity/migration-plan.json
.parity-cache/
parity-output/
learned-selectors.json
```

| Artifact | Size (real run) | Commit? |
| --- | --- | --- |
| `migration-plan.json` | 8 KB | **yes** — decisions + progress |
| `migration.json` (orchestrator state) | small | no — phase/round/budget, machine-local, conflicts on every run |
| `manifest.json` | 7.1 MB | no — regenerable capture |
| `capture.json` | 7.0 MB | no — regenerable capture |
| `report.html` | 4.0 MB | no — regenerable, screenshots inlined |
| `learned-selectors.json`, `.parity-cache/` | — | no — caches |

### Re-capturing does not revert decisions

`buildMigrationPlan` writes every row `pending`, because the capture is all it knows. Running
`parity migrate` again therefore **would** wipe every recorded decision — and with the plan
committed, that wipe lands as a diff nobody wrote.

`migrate` now merges instead: the fresh capture owns the row *set*, the previous plan owns the
*decisions*. It prints how many were carried, and warns by name when a component that had a
decision is no longer in the capture — a decision disappearing should never be silent.

Copying the plan between directories has the same hazard, so use the merge instead of `cp`:

```bash
parity plan merge <migrate output dir> --dir <target>/.parity
```

### `parity plan status` — the inventory

```bash
parity plan status --dir <target>/.parity      # human-readable
parity plan status --dir <target>/.parity --json
```

Prints what is settled (components needing no further work), what remains
(`pending` + `partial`, with scope/origin), and which pages are awaiting CMS
content. `as-is` and `upgrade` are reported on their own lines rather than folded
into "settled": "we tolerated a difference" and "we did it better" are the two
lines a stakeholder asks about, and both look identical to a visual diff. **Read this before triaging.** Without a plan there is no record of what
is missing, so a survey silently reports zero missing components and degenerates
into a lint pass over whatever the repo happens to contain — filing polish issues
(CSS tokens, bundle size, analytics) while unbuilt components and unpublished
pages go unreported.

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
