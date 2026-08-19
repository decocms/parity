# Payload Trim

Load when: multi-MB HTML, heavy SSR product JSON, slow TTFB.

## Product payload

Never send the full product list to the client in SSR HTML. For PLP/PDP:
- Server: fetch products, pass only `{id, name, price, image}` to the component
- Client: fetch full product on hover/interaction

## Product shelf pruning (TanStack)

```ts
// In the loader, trim before returning:
const slim = products.map(p => ({
  productId: p.productId,
  productName: p.productName,
  items: p.items.slice(0, 1).map(item => ({
    sellers: item.sellers.slice(0, 1),
    images: item.images.slice(0, 1),
  })),
}));
```

## SSR JSON in `<script>` tags

A `dangerouslySetInnerHTML` or `inlineScript` that embeds user-specific data
(CEP, cart, user) in the SSR response MUST be removed — it causes edge cache
contamination (one user's data served to another).
