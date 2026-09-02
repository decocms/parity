# Render Location — server-side work that belongs on the client (or nowhere)

Load when: TTFB is seconds while the HTML is small, SPA navigation is slower than
a full reload, or the page resolves data it never renders.

This is the class of problem Lighthouse cannot see. Every item below shows up as
one undifferentiated TTFB number with no audit id pointing at it — the browser
timeline is innocent, the server did work and threw it away. Read this before
concluding "nothing over the noise floor" in the `performance` phase.

## The diagnostic that separates the two costs

```bash
# Small on the wire + seconds of wait = server-side work, not payload.
curl -s -A "Mozilla/5.0 ... Chrome/120" "$URL/<path>" -o h.html -w 'bytes %{size_download} wait %{time_total}\n'
```

Measured on a real PDP: **29 KB on the wire, 4661 ms of wait.** No amount of
payload trimming touches that number.

To attribute the wait, time every loader instead of guessing. Wrapping the
framework's loader lookup for one run is enough:

```ts
// Temporary, in node_modules — the point is the ranking, not the absolute ms.
const t0 = Date.now();
try { return await loader(props, request); }
finally { console.log(`[PROF] ${Date.now() - t0}ms ${resolveType} ${JSON.stringify(props).slice(0, 120)}`); }
```

That is how the 1703 ms below was found. Guessing from payload size pointed at
the wrong section three times.

## 1. A conditional prop resolved eagerly, every request

The CMS resolver is recursive: it resolves **every** `__resolveType` it finds in
a section's props, including branches the section will not render.

Measured: a PDP's `notFoundSections` — the 404 fallback — carried a shelf whose
`products` was a full-text search. **1703 ms of the eager critical path of every
product page, result discarded.** The same shape applies to tab content, modal
content, and the losing branch of an A/B flag.

Fix: `asResolved(value, true)` in the section's `onBeforeResolveProps`, then
`resolveDeferred(prop)` in the loader on the branch that renders it
(decocms/blocks#529).

**Check the stubs first.** Migrated sites routinely declare these as no-ops to
compile, and then the deferral is decorative:

```ts
// src/types/deco.ts — real code from a migrated site
// `defer` is accepted for API parity with deco-cx's asResolved (deferred props)
// but is a runtime no-op here — we just pass the value through.
export function asResolved<T>(value: T, _defer?: boolean): T { return value }
export function isDeferred(value: unknown): boolean { return false }
```

The site's loader already had the correct `if (!props.page)` guard. There was
simply never anything to defer. A no-op stub plus a correct guard reads like a
solved problem in code review and costs 1.7 s per request in production.

## 2. Deferral silently off on SPA navigation

A TanStack route loader is **blocking** — the router does not commit the
transition until it settles. If the framework disables deferral for client
navigations, every `<Link>` click resolves the whole page.

Measured on a PDP: **9227 ms blocking and 4178 KB** on the `/_serverFn` GET,
against 659 ms and 1131 KB once deferral applied to client nav
(decocms/blocks#506). It was slower than a full reload, and the site's own
`foldThreshold` config silently applied to SSR only.

How to detect without reading framework source: the document response contains
`data-deferred="true"` skeletons, and the `/_serverFn` navigation response for
the same path contains none.

## 3. A multi-section `Deferred` group falls back to eager

`resolveFinalSectionKey` returns `null` for a `Deferred` wrapper holding more
than one inner section, and `shouldDeferSection` returns before the position
test. Three shelves the editor marked ⚡ resolved eagerly, in the `Promise.all`
that holds the first byte.

Symptom: the editor marked a section async and the payload says otherwise. Count
`data-deferred="true"` against the number of ⚡ wrappers in the page block.

## 4. Streaming is not deferral

Resolving deferred sections server-side and streaming them (`<Await>`) keeps the
work on the server and ships every shelf's images at once. The framework removed
that path deliberately in favour of an IntersectionObserver + server-fn hop.
A comment claiming "we use streaming, not the observer" is worth verifying — on
one site it was false, and the false premise was load-bearing for a
`respectCmsLazy: false` decision nobody could justify.

## 5. Every deferred section's `LoadingFallback` mounts at first paint

All of them, before any scroll. A fallback that renders the real component with
reduced props means N full component trees at first paint. Sizing them is
`agents/fallbacker.md`'s job — but a fallback that is *heavy* rather than
*mis-sized* is this file's problem.

## 6. Bot and human are different measurements

Deferral is disabled for crawlers by design (an SEO guarantee), so bot HTML is a
separate axis. Do not carry a human number over to the bot case: on the same
PLP, human HTML was 832 KB and Googlebot's was **6024 KB**.

While you are there, check what the crawler actually receives. One site emitted
`{"@type": "Products", products: [...]}` — a type that does not exist in
schema.org, so no crawler parses it — at **2.75 MB per PLP**. Dead weight for
everyone, and invisible to every browser-side metric. The correct shape for a
listing is `ItemList` of `ListItem` with `url`/`position`; the full `Product`
belongs on the PDP. That one change took the block from 2 474 206 to 6 198 bytes.

## Rules

- **Do not move rendering to the client to win a number.** Above the fold and
  anything a crawler must read stays server-rendered. This file is about work
  that is *discarded*, not about shipping less HTML to humans who need it.
- **Measure, then attribute.** Small wire + long wait ⇒ server-side. Long wire +
  short wait ⇒ payload (`payload-trim.md`).
- **Confirm the same URL twice.** If one path swings from 0.19 s to 3.61 s across
  requests, that is environment (cold isolate), not the page — see the cold-start
  section of `edge-caching.md` before optimizing anything.
