# Checks reference

Every check `parity` runs, what it catches, and when it fires.

The **Module** column is the `--only`/`--skip` scoping key for `parity run` —
see [Module selection](./cli.md#module-selection---only---skip---why) in the
CLI reference, or run `parity list modules` for the same mapping from the
check-name side.

| Check                         | What it catches                                                        | Module |
| ----------------------------- | ---------------------------------------------------------------------- | ------ |
| HTTP status parity            | Routes that 404 / 500 in cand but worked in prod                       | seo |
| Console errors                | New hydration mismatches, failed fetches, JS exceptions                | console |
| HTML structural diff          | Section / structural-tag counts drifting beyond tolerance (image-count deltas are demoted to low+inconclusive with a unique-src count, since deferred-vs-SSR render strategies and carousel clones make raw `<img>` counts unreliable — #252) | html |
| Meta / SEO parity             | `<title>`, `<meta description>`, canonical, og:*, twitter:*, JSON-LD   | seo |
| **Visual diff (LLM Vision)**  | Sections missing, wrong hero, broken shelf, layout shifts              | visual |
| Purchase journey              | Home → PLP → PDP → CEP → cart → checkout completes in both             | e2e |
| **PLP pagination**            | Interactive next-page / load-more / infinite-scroll all work in cand; fetch-based `?page=N` fallback for classic paginated PLPs | seo |
| Network summary               | Request count / bytes / cache hit rate                                 | network |
| Web Vitals                    | LCP, FCP, TTFB, INP, CLS — mobile + desktop                            | vitals |
| Image loading health          | Missing alt text, no srcset, broken `<img>`                            | html |
| Lazy section presence         | Deco `/deco/render` and `/_loader/*` routes responding; downgrades to low+intentional-eager when cand renders everything inline by design | html |
| **Banner aspect ratio**       | Hero/banner images keep the same aspect ratio prod vs cand (CLS/crop regressions) | visual |
| SEO deep audit                | robots.txt, sitemap, noindex regressions — plus absolute gaps surfaced even when both sides share them: `seo:sitemap-absent` (neither serves `/sitemap.xml`), `seo:robots-no-sitemap-directive` (robots.txt has no `Sitemap:`), `seo:llms-txt-absent` (no `/llms.txt` for AI crawlers). The migration is the moment to fix these. | seo |
| **Lighthouse category scores** | `parity vitals` (Lighthouse mode): flags any category (performance/accessibility/best-practices/seo) where cand scores below prod — enforces parity-or-better, not just performance | a11y/perf/seo |
| **Navegação agêntica** _(#264)_ | Composite for AI-agent navigability: agent-accessibility tree audits (`button-name`, `link-name`, `label`, `image-alt`, `aria-*`) + `/llms.txt` quality (llmstxt.org shape). Passed/total tally in the Vitals tab | a11y/seo |
| Cache coverage                | Cache hit rate, opportunities to cache                                 | cache |
| **Search presence**           | Search input reachable from home in both                               | e2e |
| **Search autocomplete**       | Typing reveals suggestions; cand keeps parity with prod                | e2e |
| **Search results**            | Same keyword returns comparable product counts                         | e2e |
| **Search no-results**         | Unicode garbage term shows empty state, doesn't match products         | e2e |
| **Cart interactions**         | Multi-item add / increment / decrement / set-qty-input / cart persistence across reload / coupon (invalid + optional valid) / VTEX seller-null probe / remove all behave in cand | e2e |
| **404 parity**                | Invalid URL returns 404 (no catch-all 200 in cand)                     | seo |
| **Cookie/CEP modal CLS**      | Modals don't introduce layout shifts >0.1 in cand                      | visual |
| **PDP gallery + related**     | Image gallery + "Related products" shelf still render                  | e2e |
| **PDP breadcrumbs**           | Breadcrumb trail (markup or JSON-LD `BreadcrumbList`) still renders on PDP | e2e |
| **PLP sorting**                | A sort query param (`?sort=`/`?orderBy=`) actually reorders products in cand like it does in prod | e2e |
| **Footer links health**       | Institutional links (privacy, contact, etc.) aren't broken in cand     | seo |
| **Login flow** _(opt-in)_     | Valid credentials log in; invalid ones show a clear error              | e2e |
| **Picture missing dims**      | Static CLS detector — `<picture>` without explicit width/height        | html |
| **Cart reveal mode**          | prod/cand cart-reveal markup intent matches                            | e2e |
| **SPA navigation** _(M2.5, issue #54)_ | F5-load a category, click to another route (client-side, not `page.goto`), then verify the SPA-navigated render didn't drop CMS sections vs a plain F5 of the same destination; also flags hydration-classified console errors during the nav itself | e2e |
| **Server-fn hover flood** _(M2.5, issue #54)_ | Hovering ~8 product cards shouldn't fire more than a configurable budget (default 10) of `_serverFn`/preload-shaped requests — catches TanStack `preload="intent"` flooding the worker | e2e |
| **Favicon parity** _(issue #240)_ | Missing `<link rel=icon\|manifest\|apple-touch-icon>` vs prod, and a SHA-256 mismatch of the primary favicon (catches a favicon from a different site) | seo |
| **Font parity** _(issue #241)_ | prod loads web fonts and cand loads none → silent fallback to a system font (e.g. `Lato` declared but no `@font-face`) that a screenshot diff misses | html |
| **SSR / no-JS** _(issue #244)_ | Plain `fetch` (no JS) returns the SSR HTML; a near-empty body → content is client-only and the page is blank without JS (high CLS, broken SEO/a11y) | html |
| **Nav-links health** _(issue #247)_ | Dead same-page anchors (`#foo` with no matching `id`/`name`) and broken header/nav routes; prod-ok + cand-broken = high regression | seo |

All results are aggregated (optionally via Claude) and ranked by severity. Each issue includes screenshots, reproduction, and a suggested fix.
