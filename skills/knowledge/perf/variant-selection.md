# Variant Selection

Load when: clicking a size/color on the PDP takes >500ms, or a HAR shows two
`loadCmsPage` calls for one variant click (one with `?skuId`, one without).

## Two kinds of "variant", two mechanics

| Case | Data needed | Approach |
|---|---|---|
| Same product, different SKU (90x0.8 → 90x0.95) | Already loaded in `isVariantOf.hasVariant` | `history.replaceState` — **zero fetch** |
| Different product (visual variation) | New product | `navigate()` — exactly one fetch, with a loading state |

The PDP loader does not take `skuId`; every SKU arrives in the first load. The
`?skuId` in the URL is for bookmarking/sharing only — so re-fetching the page to
change it is pure waste.

## Fix 1 — same-product: replaceState

```tsx
const [currentUrl, setCurrentUrl] = useState(() => relative(product.url));

const onVariant = useCallback((e: React.MouseEvent, link: string) => {
  e.preventDefault();
  setCurrentUrl(link);
  window.history.replaceState(null, "", link);
}, []);

<a href={link} onClick={(e) => onVariant(e, link)}>
  <Avatar variant={link === currentUrl ? "active" : "default"} />
</a>
```

Plain `<a>` with `preventDefault`, not `<Link>` — a `<Link>` invokes the router,
which is the fetch we are removing.

## Fix 2 — the double-fetch

`<Link to="…?skuId=160" preload="intent">` fires twice: hover prefetches the URL
minus the filtered search param, then the click fetches it with the param. **Drop
`preload="intent"` from variant links.** Prefetch is for links to pages you don't
have; a variant is a page you already loaded.

## Verify

Export a HAR, count `/_serverFn/` entries containing `loadCmsPage` for one variant
click: same-product must be 0, cross-product exactly 1.
