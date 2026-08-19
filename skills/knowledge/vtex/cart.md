# Cart Patterns

## TanStack + @decocms/apps-vtex

```ts
import { useCart } from "@decocms/apps-vtex/hooks/useCart.ts";
const { cart, addItem, removeItem, updateItem } = useCart();
// cart is the VTEX orderForm; addItem takes an SKU id + quantity
```

## CartSidebar (FastStore v4)

Override by copying `.faststore/src/components/cart/CartSidebar.tsx` to
`src/components/cart/CartSidebar.tsx`, then modify. Never edit the `.faststore/` copy.
Reference visual: `loja.electrolux.com.br` CartSidebar.

## expectedOrderFormSections

```ts
// When cart sections are missing, specify them:
const SECTIONS = ["items", "totalizers", "customData", "clientProfileData", "shippingData"];
```

## On-demand cart (no getOrCreateCart on page load)

Do NOT call `getOrCreateCart` on every F5 / SSR. Call it lazily when the user
first interacts with the cart (open minicart, add item). An empty cart is
rendered without an API call using in-memory state.
