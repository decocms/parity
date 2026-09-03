# `<head>` priority, the eager bundle, and changing them without breaking hydration

Load when: LCP is bad and everything else is green; Load Delay dominates the LCP
breakdown; you are about to remove a tag from the `<head>` or a module from the eager
chunk; a transform "worked" but the page stopped being interactive.

All numbers below are from before/after measurements on a migrated TanStack Start
storefront.

## Why the obvious LCP fixes do nothing

Three things get tried first, and all three are measured dead ends on their own:

| Attempt | Result |
|---|---|
| Hoist the image preload to the top of `<head>` | Nothing. Browsers schedule by **priority**, not document order. `modulepreload` is High and outranks an image preload even with `fetchpriority="high"` declared earlier. Load Delay stayed 5239 ms. |
| Send the preload as a `Link:` response header | Zero. The headers do not arrive before the body in this setup. |
| Strip the `modulepreload` tags from the served HTML | Hydration mismatch — **13 of 4300 nodes** survived. |

What actually moves LCP is taking bytes out of the High-priority batch competing with
the image. Measured on one page: `vendor-router` 259 675 B br + `vendor-react`
60 967 + `app.css` 57 019 + others ≈ **390 KB** contending with a 91 166 B LCP image.
On Lighthouse's simulated mobile link (~200 KB/s) that is ~2 s — the same order of
magnitude as the Load Delay being blamed on the image.

## The rule: change the render source, in every environment

**Never mutate what the framework rendered.** React reconciles against the markup it
expects; give it something else and it discards the tree.

`modulepreload` tags in TanStack Start are not "in the HTML" — they come from a
`useRouterState` selector reading `router.ssr.manifest.routes[id].preloads`.
Neutralizing that read makes server and client render the same tree, so there is no
tag to mismatch on, by construction.

Which environment to patch is not a style choice:

| Situation | Patch | Why |
|---|---|---|
| Module only reachable from the client bundle; SSR output must stay identical | **client only** | SSR already renders `null`; touching the server render would be the change |
| The tag is rendered on both sides from the same source | **client and server** | Patch one and the two trees disagree by construction |

Example of the first: a draft-preview badge was statically imported by a layout that
renders unconditionally, so **32 874 B** rode in every published-store visitor's shared
chunk — **29 490 B** of it a logo inlined as a data-URI PNG. A dynamic `import()`
applied in the client environment only cut the chunk 295 087 → 270 215 B gzip (−8.4%),
SSR untouched. Safe *because* the component already returned `null` on both sides.

Example of the second: the `modulepreload` fix, applied to client **and** ssr. Result:
332 KB br left the High-priority batch; locally (5 runs, median) LCP 14 647 → 8 724 ms,
FCP 11 697 → 5 571 ms, TBT 54 → 26 ms. TBT *improved* — the "buy LCP, pay in
hydration" trade never got charged.

**Make the build enforce it.** A build-time transform that silently no-ops when
upstream changes is a future regression that reports nothing. Assert in a
`buildEnd`-style hook that the pattern matched in every expected environment, and fail
the build otherwise.

## The failure mode that reports nothing

The cleanest-looking version of that same fix removed `preloads` from the build's
virtual manifest — the origin of the list. **The page stopped hydrating, silently:**

1. the manifest builder **prunes** any route left with no `preloads` and no `assets`;
2. in a production build the root route only has `preloads`, so it disappears;
3. the asset-URL transform is guarded by `if (rootRoute)` — with no root route, the
   client entry `<script type="module">import("/assets/main-*.js")</script>` is never
   emitted.

Observed: a 572 KB document, 27 sections, a perfect `<head>`, zero `modulepreload`,
zero console errors, zero build warnings — and static markup forever.

**So the check is:** grep the SERVED HTML for the client entry script. Assert the
presence of what must survive, not just the absence of what you removed.

## Verifying a change in this class

1. Confirm the transform applied in **every** environment (fail the build if not).
2. Presence assertions on served HTML: client entry script present, targeted tag
   absent. Both, every time.
3. A hydration-survival metric **with a control run on the base branch** — load each
   representative route, count nodes that survived hydration, record `console.error`
   and `pageerror` counts. From a passing change: control 99.4% / 100.0% / 99.9% →
   after 99.7% / 100.0% / 99.9%, zero errors on both sides. Without the control you
   cannot tell 99.7% from a regression.
4. Smoke-test anything driven by an inline script. A regenerated subtree orphans the
   controller inside it, which reads as "the carousel/drawer is dead" rather than as a
   hydration error.

## Measurement traps specific to this work

- **An uncompressed local preview is for deltas only, never absolutes.** A local FCP
  of 11.7 s was the dev server shipping 573 KB of HTML instead of 62 KB and 364 KB of
  CSS instead of 57 KB.
- **A local build of `main` is not the deployed build of `main`.** Committed codegen
  in a pre-fix state produced a 1 215 kB chunk against the deploy's 908 kB — **307 kB
  of difference that did not exist**. Run the repo's codegen steps in the control, and
  confirm the local build reproduces the deployed asset hashes before comparing.
- **A preview server can serve HTML from a persisted worker cache.** Rebuild plus
  restart did not invalidate it; a control run served HTML from the previous build,
  pointing at a `main-*.js` that no longer existed.
- **Warm up segmented caches before measuring.** When the render cache buckets by
  device segment inferred from User-Agent, a first hit with a mismatched UA measures a
  cold, wrong-segment render — this produced two phantom "TTFB regressions".
- **Percent-encoding a JSON payload into an HTML attribute is not waste.** Removing
  `encodeURIComponent` to "save bytes" cost 8.0% more: React escapes `"` as `&quot;`
  (6 B) against `%22` (3 B), and JSON is mostly quotes — 113 200 B vs 104 802 B across
  the same 524 payloads.

## A prop that compiles and is discarded

A props type carrying `[key: string]: unknown` accepts anything at every call site
while the destructure quietly drops the value — nine call sites passed `alt` into a
component that threw it away, and all of them type-checked. When a prop appears to
have no effect, read the destructure before the caller.
