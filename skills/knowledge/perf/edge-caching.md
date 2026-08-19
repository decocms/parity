# Edge Caching

Load when: cache MISS on everything, no Cache-Control in prod headers.

## TanStack (@decocms/start)

```ts
// In the route's loader:
export const Route = createFileRoute("/")({
  loader: () => fetchPageData(),
  staleTime: 60_000,    // ms before TanStack Query refetches
  gcTime: 300_000,
});

// Worker entry: set Cache-Control via cacheHeaders helper
import { cacheHeaders } from "@decocms/start/cache";
return new Response(html, { headers: cacheHeaders({ maxAge: 60, staleWhileRevalidate: 300 }) });
```

## FastStore v4

FastStore handles caching via Next.js ISR / Cloudflare Workers natively.
Set `revalidate` in `next.config.js` for page-level TTL.

## What must NEVER be cached

- Any response that reads a cookie for user-specific data (CEP, cart, user)
- Checkout routes
- Admin / account routes
