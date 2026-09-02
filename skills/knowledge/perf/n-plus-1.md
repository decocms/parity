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

## Grep

```bash
grep -rn "\.map(.*async" src/loaders/ src/components/sections/
grep -rn "await" src/loaders/ | grep -E "for \(|\.map\(|forEach\("
```

## Verify

Count the calls, don't eyeball the page: the dev log for one page load should show one
line per endpoint, not one per product. `parity run` TTFB / `network-summary` confirms
the win end to end.
