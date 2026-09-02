# miess run — cache & render-location learnings

A post-migration performance run on `deco-sites/miess-01-tanstack` (VTEX,
TanStack/Deco target, already live on a candidate worker). Not a migration: the
site was built and the score was at target. Everything below came from optimizing
it, which is exactly the ground the `performance` phase stands on.

## Outcome

| | before | after |
|---|---|---|
| SPA nav → PDP, blocking GET (MISS) | 9227 ms | **659 ms** |
| cold PDP, HTML | 316 KB | 176 KB |
| shelf loader cache entry (28 products) | 991 KB | **247 KB** |
| PLP loader cache entry | 1.92 MB | 0.92 MB |
| PLP HTML for Googlebot | 6024 KB | **852 KB** |
| PLP `ld+json` | 2 474 206 B | **6 198 B** |
| PDP 404 HTML | 1.24 MB | 299 KB |
| 3 related shelves, cold isolate | 5.78 s | 1.09 s |

10 PRs merged: framework `decocms/blocks` #506, #526, #527, #528, #529, #530;
site `deco-sites/miess-01-tanstack` #189, #192, #193, #194.

## What we learned, by theme

### 1. Render location is invisible to Lighthouse

The single biggest win — 1703 ms off the eager critical path of every PDP — was a
404-fallback shelf being resolved on every request and discarded. It produces no
Lighthouse opportunity, no CLS, no layout shift, nothing in the browser timeline.
It is one undifferentiated TTFB number.

The framework had no deferred-prop primitive, and the site declared `asResolved` /
`isDeferred` as no-ops to compile. The loader already held the correct
`if (!props.page)` guard — there was simply never anything to defer. That
combination reads as a solved problem in review.

→ `skills/knowledge/perf/render-location.md`, triager checks 16-17,
`decocms/blocks#529`.

### 2. Deferral can be silently off exactly where it matters most

A TanStack route loader is blocking, and deferral was disabled for client
navigations. So the config the site set (`foldThreshold`) applied to SSR only, and
every `<Link>` click resolved the whole page: 9227 ms and 4178 KB, worse than a
full reload. → `decocms/blocks#506`.

Corollary: a comment in the code claiming which deferral path is in use is worth
verifying. On this site the comment said "TanStack streaming, not the observer";
the streaming path had been removed from the framework, and the false premise was
load-bearing for a `respectCmsLazy: false` decision.

### 3. Cache entry SIZE, not hit rate

The loader cache was working (`4.35s → 1.25s → 0.42s → 0.19s` on repeat calls).
The problem was a 1.92 MB entry against an 8 MB L1 — four entries, then thrash.

And the trap: trimming in the CONSUMERS shrinks the HTML and not the cached
object. A 9.6× HTML reduction had moved the hit rate by zero for that reason. The
diet has to happen in the loader, before the cache wrapper.
→ `decocms/blocks#526`, `#527`.

### 4. I fixed the wrong cache once — there are two

`resolvedLayoutCache` (CMS prop resolution) and `layoutCache` (section loader
output) are different caches. `isMobile` is produced by the *loader*, so putting
device in the first key fixed nothing; `#528`'s PR body claimed Header/Footer were
now safe to cache and that was false. Caught it by trying to use it: desktop
first, and a mobile visitor got `h-[90px]`. → `#530`.

Method note that generalizes: after landing a framework fix, **use it** before
believing it.

### 5. Bots get a different page, and nobody was looking

Deferral is off for crawlers by design, so bot HTML is a separate axis: 832 KB
human vs 6024 KB Googlebot on the same PLP. Inside that, 2.75 MB was a JSON-LD
node typed `{"@type": "Products"}` — not a schema.org type, so no crawler parses
it. Dead weight for every bot on every PLP. → triager check 19.

### 6. Cold start dominates MISS and mimics a slow page

The user asked why some products took 4 s and others 600 ms. Answer: they don't.
The same URL, six requests, all MISS: `3.45 1.45 0.36 2.16 3.61 0.19` s. The "slow
product" served in 0.19 s on the sixth try, and no property of the product
correlated — the slowest had the smallest description and one SKU.

Ruled out by measurement, in order: session warm-up (the two slowest came last),
payload (131 KB vs 129 KB), the product fetch itself (0.09-0.16 s for all six),
description size, SKU count, additionalProperty count.

→ never diagnose a per-item cost from one sample; hit rate and post-deploy warmup
pay twice because cold start only hurts on MISS.

### 7. Measurement killed four of my own hypotheses

Worth recording because it is the actual working method, not a footnote:

- reusing the framework's existing `buildOfferShelf` for the ladder diet **broke
  the installment string on 36/36 products** (it keeps the cheapest total, which
  on a store with a boleto discount is "Boleto 1x", not "Visa 10x")
- an internal flag leaked into variant options and made the payload **bigger**
  (isVariantOf 38.6 → 49.6 KB) — the option I added was a regression until the
  test caught it
- a docblock I wrote claiming the deferred thunk shares the request memo was
  false; the test I wrote to prove it failed (`expected 2 to be 1`) and I fixed
  the comment, not the test
- "these products are slow" was environment variance

Every one was found by measuring the result rather than reasoning about the diff.

## Landed in the plugin — STATUS

| Learning | Where | Status |
|---|---|---|
| render location, all six patterns | `knowledge/perf/render-location.md` (new) | ✅ |
| entry size, key fragmentation, two layout caches, cold start, negative caching | `knowledge/perf/edge-caching.md` (29 → 123 lines) | ✅ |
| deferred-section N+1, direct-import bypasses cache | `knowledge/perf/n-plus-1.md` | ✅ |
| static detection of the four patterns | `agents/triager.md` checks 16-19 | ✅ |
| a `findings` input with no audit id + how to verify each | `agents/perf-optimizer.md` | ✅ |
| the phase gets a second leg Lighthouse cannot see; benchmark regression loops back here | `skills/migration-orchestrator/SKILL.md` `### performance` | ✅ |

Not carried over: `variant-selection.md` (no measurement of my own this run), and
two site investigations that are still open rather than settled — the PDP
`Product` JSON-LD missing `offers` in production, and a production PDP being 2.7×
larger than its own preview on the same commit.
