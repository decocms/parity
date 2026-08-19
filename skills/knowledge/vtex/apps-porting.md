<!--
  SOURCE: decocms/blocks .agents/skills/deco-to-tanstack-migration/references/vtex-commerce.md
  Run `bun run scripts/sync-skills.ts` to pull the latest version.
-->

# VTEX Apps Porting — Key Patterns

## Block → Component mapping

| VTEX IO block | Component to create |
|---|---|
| `vtex.store-header@*/header-layout` | Navbar / NavbarCustom |
| `vtex.store-footer@*/footer-layout` | Footer / FooterCustom |
| `vtex.slider-layout@*/slider-layout` | carousel section |
| `vtex.product-summary@*` | ProductCard |
| `vtex.rich-text@*` | RichText / BannerText |
| `vtex.search-result@*/search-result-layout` | ProductGallery |
| `vtex.product-details@*` | ProductDetail |
| `vtex.minicart@*` | CartSidebar |
| `vtex.breadcrumb@*` | Breadcrumb |

## Props from block tree

The `parity migrate` bundle's `component-map.json` has the mapped props. The
`blocks.json` has the raw block tree from `window.__RUNTIME__`. Use `props` to
populate CMS defaults; `component` field gives the React component class name
from the VTEX app.

## Commerce loaders

```ts
// TanStack
import { searchProducts } from "@decocms/apps-vtex/loaders/intelligentSearch/productListingPage.ts";
import { getProduct } from "@decocms/apps-vtex/loaders/product/productPage.ts";

// FastStore: extend FastStore's GraphQL queries in src/graphql/vtex/
```

Full reference (380 lines): `vtex-commerce.md` in blocks .agents/skills/deco-to-tanstack-migration/references/
