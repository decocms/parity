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

## Entry SIZE is the constraint, not hit rate

Measure the size of what you cache before tuning TTLs. A loader whose entry is
1.92 MB against an 8 MB L1 fits ~4 entries — browsing facets evicts everything,
so the hit rate looks like a cache problem and is a size problem.

The hit rate on that site was already fine: four identical calls returned in
`4.35s → 1.25s → 0.42s → 0.19s`. Nothing was broken. The entry was just too big
to keep company.

```bash
# Size a loader's cached entry directly, bypassing the page.
curl -s -X POST "$URL/deco/invoke/<loader-key>" -H 'content-type: application/json' \
  -d '<the props the CMS block passes>' -o entry.json -w '%{size_download}\n'
```

## The downstream-trim trap

Trimming a product payload in the CONSUMERS shrinks the HTML and does **not**
shrink the cached object — what the cache stores is the raw upstream result. A
9.6× HTML reduction moved the hit rate by zero on one site for exactly this
reason.

Trim at the origin, in the loader, before the cache wrapper sees it. Measured
after moving the same trim upstream: PLP entry 1.92 → 0.92 MB, shelf entry
1047 → 264 KB. Both without changing a rendered byte (`R$` occurrences in the
HTML identical before and after — that is the cheap regression check).

## Key fragmentation — there are TWO keys

An unknown query param is injected as a top-level loader prop, so it lands in the
loader cache key as well as the edge key. Every ad click (`gad_source`, `gbraid`,
`_gl`) becomes a MISS on both layers.

A tracking-param denylist must be applied to the edge key **and** the loader key.
Normalizing only the edge leaves the origin unprotected, which is the layer that
actually costs money.

## The same block with different props resolves twice

Per-request memoization keys on `JSON.stringify(node)`. The same named block
referenced bare by the SEO section and with overrides by the grid is two distinct
keys — two full upstream executions in one request. Compare the nodes byte for
byte, not by name.

## Layout caching: there are TWO caches, and they cache different things

- the CMS **prop resolution** cache, and
- the section **loader output** cache.

Per-request values like `isMobile` are produced by the *loader*, so segmenting
only the prop cache fixes nothing. I made exactly that mistake (decocms/blocks
#528 fixed the wrong one; #530 fixed the real one). Failure mode: whoever arrives
first decides the variant for everyone for the whole TTL — a mobile header served
to desktop visitors.

Verify with a marker only one branch renders, alternating user agents:

```
desktop 1st → DESKTOP | mobile 2nd → MOBILE | desktop 3rd → DESKTOP
```

If the second request echoes the first's variant, the key is missing an axis.

Device in the key is correct — and note it also **doubles the entries** for every
page. That is the price of correctness, and the reason making sections
device-agnostic (CSS branches, see triager check 14) pays twice: correctness plus
half the cache.

## Cold start dominates MISS, and it looks like a slow page

Before attributing a slow page to the page, request the SAME url several times
with a unique buster. Measured, all MISS:

```
same product, 6 requests:  3.45s  1.45s  0.36s  2.16s  3.61s  0.19s
```

The 4.4 s "slow product" served in 0.19 s on the sixth try. No property of the
product correlated — the slowest had the *smallest* description and one SKU.
Suspect isolate boot cost (one site parses a 3.3 MB generated blocks file on
every cold start).

Consequence for priorities: cold start only hurts on MISS, so hit rate and
post-deploy warmup pay twice. And never diagnose a per-item cost from a single
request.

## Cache empty results too

A result that comes back empty with no TTL is a permanent MISS: the origin is hit
on every request forever to produce nothing. Give it a short negative TTL with no
stale window — short enough that a category which emptied by accident recovers,
present enough that the origin is protected.
