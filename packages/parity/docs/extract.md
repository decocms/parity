# `parity extract` — AI-ready component extraction

## Why

Every other `parity` command compares **prod × cand** — two URLs, one a
source of truth, one a migration candidate. `parity extract` is different:
it looks at **one site** and produces a structured, AI-ready snapshot of
its UI components (header, footer, nav, shelves, hero, minicart, ...) —
HTML, computed styles, a screenshot, and asset/link inventories per
component.

Use it when there's **no source code to read at all** — e.g. you're
handed a live storefront URL and asked to migrate it from scratch. Feed
the generated Markdown (or JSON) into an AI coding agent as ground truth
for what each component looks like and is made of, instead of asking the
agent to reverse-engineer everything from a single screenshot.

## Usage

```bash
parity extract --url https://loja.com \
  [--pages /,category-auto,pdp-auto] \
  [--components header,footer,nav,shelf,banner,hero,minicart] \
  [--viewport mobile|desktop] \
  [--format md|json|both] \
  [--out ./parity-extract] \
  [--no-llm]
```

## Flags

| Flag | Default | What it does |
| --- | --- | --- |
| `--url <url>` | _(required)_ | Site to extract from |
| `--pages <list>` | `/` (home only) | Comma-separated pages: literal paths/URLs, and/or `category-auto`/`pdp-auto` to auto-discover a PLP/PDP from the home page (reuses the same heuristics `plp-pagination.ts` uses for purchase-journey discovery) |
| `--components <list>` | all detected | Role allowlist, e.g. `header,footer,nav,shelf,banner,hero,minicart`. Matches exact role or any `<name>-*` role (e.g. `shelf` matches `shelf-related-products`) |
| `--viewport <viewport>` | `mobile` | `mobile` \| `desktop` \| `tablet` |
| `--format <fmt>` | `both` | `md` \| `json` \| `both` |
| `--out <dir>` | `./parity-extract` | Output directory |
| `--no-llm` | LLM on (if configured) | Skip the optional component-relabeling LLM pass. Heuristic detection always runs regardless. |
| `--json` | off | Emit one-line JSON to stdout instead of pretty text |

## Component detection

A heuristic pass **always** runs, no LLM required:

- Semantic tags: `header`, `footer`, `nav`, `[role='banner']`
- Deco-authored sections: `[data-section]`, `[data-deco-section]` (same
  convention `carousel-stabilizer.ts` / `lazy-sections.ts` use) — role
  becomes `section-<slugified-name>`
- Class-name heuristics: `[class*='shelf' i]`, `[class*='carousel' i]`,
  `[class*='minicart' i]`, `[data-minicart]`, `[data-cart-drawer]`
- Geometry: full-width, above-the-fold, non-semantic top-level content is
  guessed as `hero` (first match) or `banner` (subsequent matches)

Overlapping detections are deduped by a containment rule: the biggest box
wins unless a candidate has a strictly higher priority (e.g. `minicart`
survives even nested inside a lower-priority generic container) — see
`dedupeByContainment` in `src/extract/detect-components.ts`.

### Optional LLM refinement (v1: relabeling only)

When `--no-llm` is NOT passed and an LLM provider is configured (same
`ANTHROPIC_API_KEY`/`OPENROUTER_API_KEY` gate every other optional LLM
pass uses), an extra call relabels the heuristic candidates using the
compacted page HTML for context — e.g. turning a generic
`section-flash-sale-banner` into `promo-banner`, or distinguishing a
"related products" shelf from a "recently viewed" one.

This pass is genuinely wired (`src/llm/component-refine.ts`, feature
`component-detection` in the model-tier registry), but it's **v1-scoped
to relabeling only** — it cannot merge, split, or invent components. A
merge/split pass would need the model to reason about geometry, which is
a bigger prompt-engineering lift than this milestone's budget covers.
Documented as a gap for a future iteration.

## Output layout

```
parity-extract/
  loja.com/
    2026-07-23T18-42-11.123Z/
      index.md
      manifest.json
      components/
        header-1/
          component.html
          styles.json
          screenshot.png
          README.md
        footer-2/
          ...
```

- `manifest.json` — the full machine-readable `ExtractBundle` (all
  components, across all resolved pages).
- `index.md` — site overview: URL, timestamp, table of detected
  components with links to each component's README.
- `components/<role>-<index>/README.md` — per-component structure
  outline, a design-tokens table (from computed styles), asset/link
  inventory, embedded screenshot reference, and the component's HTML.

## Relationship to `section`/`fix`

`extract` reuses the single-selector capture primitives factored out of
`parity section`'s `gatherSide` (`src/engine/section-capture.ts`):
`captureSectionArtifacts` (HTML + computed styles + optional CSS source)
and `captureSectionScreenshot` (full-page screenshot cropped to a
selector's bounding box, preserving page-level CSS context). `section`
and `fix` are unchanged — they still run prod×cand diffs — `extract` is
purely additive.
