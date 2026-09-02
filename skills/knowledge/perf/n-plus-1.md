# N+1 in Loaders

Load when: SSR over ~3s, terminal shows the same VTEX endpoint called dozens of
times per page, 429s from VTEX, "a troca de página tá demorando".

## The pattern

```ts
// RED FLAG — one API call per product
export const loader = async (props: Props) => {
  const products = await Promise.all(
    props.products.map(async (p) => ({ ...p, spec: await getProductSpecification(p.productId) })),
  );
  return { ...props, products };
};
```

A 24-product shelf = 24 extra round trips before the first byte.

## Fix order

1. **Is the data already there?** Most N+1s fetch what Intelligent Search already
   returned. Check the product object first:
   | Per-item call | Already available as |
   |---|---|
   | `/catalog_system/pvt/products/{id}/Specification` | `product.isVariantOf.additionalProperty` |
   | `/catalog_system/pub/products/variations/{id}` | `product.isVariantOf.hasVariant` |
   Delete the call, read the field.
2. **Is it per-page, not per-product?** Cross-selling / related products is one call
   for the page, not one per item in the shelf.
3. **Can it batch?** MasterData takes `_where=id=1 OR id=2`. One call, N ids.
4. **Genuinely per-item?** (price simulation with CEP is the honest case) — then cache
   it: `skills/knowledge/vtex/fetch-cache.md`, and cap the fan-out. Never
   `Promise.all` over an unbounded list.

## The N+1 that no loop contains

The pattern above is a loop you can grep. Two variants have no loop at all:

**A deferred section resolves in its OWN request.** Per-request memoization does
not reach across requests, so three shelves on one PDP — each fetching the same
product to derive a category facet, then the same faceted search — are six
uncached upstream calls, and they look like one call each from inside any single
loader. Measured cold: `2.878s + 2.863s + 0.040s` before, `1.056s + 0.015s +
0.017s` after routing both calls through the cached registry entries.

**A direct `import` of an app loader bypasses the cache entirely** — and the
observability panel with it, so the calls do not even appear in the hit-rate
numbers you are looking at. Import the registry's cached entry, not the app
function.

Do NOT "fix" this by switching to a different upstream. On one site the tempting
swap (legacy Catalog → Intelligent Search) changes the shape of
`product.category`, which is what the facet is built from — so it silently
changes which products the shelf shows. Add caching to the call you have.

## Grep

```bash
grep -rn "\.map(.*async" src/loaders/ src/components/sections/
grep -rn "await" src/loaders/ | grep -E "for \(|\.map\(|forEach\("
# the loopless variants: an app loader imported straight into a site loader
grep -rn "from \"@decocms/apps-" src/loaders/ src/sections/
```

## Verify

Count the calls, don't eyeball the page — and count them at the framework's loader
lookup, not per file, or the loopless variants above stay invisible (the
instrumentation snippet is in `skills/knowledge/perf/render-location.md`): the dev log for one page load should show one
line per endpoint, not one per product. `parity run` TTFB / `network-summary` confirms
the win end to end.
