---
name: source-vtex-io
description: Source-side playbook for VTEX IO Store Framework. Load when porting FROM vtex-io to any target. Covers what to expect in the repo and how to interpret block trees.
---

# Source: VTEX IO Store Framework

## What the code looks like

- **No per-component React source** — the store is DECLARATIVE. Blocks like
  `vtex.store-components@3.x:product-summary` are implemented by VTEX apps
  (npm packages), not in this repo.
- **`store/blocks/**/*.{json,jsonc}`** — block tree: each top-level key is a block
  id (`store.home`, `flex-layout.row#deals`). The value is `{blocks: [...], props: {...}}`.
- **`manifest.json`** — lists all VTEX app dependencies. These resolve the block
  components.
- **`styles/configs/*.json`** — CSS tokens (the VTEX equivalent of design tokens).

## Interpreting block trees for porting

| VTEX IO block | FastStore equivalent | TanStack equivalent |
|---|---|---|
| `vtex.store-header@2.x:header-layout` | `NavbarCustom` section | `Navbar` section |
| `vtex.store-footer@2.x:footer-layout` | `FooterCustom` section | `Footer` section |
| `vtex.slider-layout@0.x:slider-layout` | `HeroSwiper` | carousel component |
| `vtex.product-summary@2.x:product-summary` | `ProductCard` | `ProductCard` |
| `vtex.rich-text@0.x:rich-text` | `BannerText` section | `RichText` section |
| `vtex.search-result@3.x:search-result-layout` | `ProductGallery` | `ProductGallery` |
| `vtex.product-details@1.x:product-details` | `ProductDetailCustom` | `ProductDetail` |

## Using the live capture

The `parity migrate --url <prod>` capture extracts `window.__RUNTIME__` (the
block tree with real content) from the live site — far more reliable than the
static JSON files for knowing the actual content. Prefer the bundle's
`blocks.json` + `component-map.json` over the static `store/blocks/`.

## References

Load via explicit path:
- `skills/knowledge/vtex/apps-porting.md` — how VTEX app blocks map to components
- `skills/knowledge/vtex/fetch-cache.md` — SWR cache for VTEX API calls
