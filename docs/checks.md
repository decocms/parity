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
| HTML structural diff          | Section / element counts drifting beyond tolerance                     | html |
| Meta / SEO parity             | `<title>`, `<meta description>`, canonical, og:*, twitter:*, JSON-LD   | seo |
| **Visual diff (LLM Vision)**  | Sections missing, wrong hero, broken shelf, layout shifts              | visual |
| Purchase journey              | Home → PLP → PDP → CEP → cart → checkout completes in both             | e2e |
| **PLP pagination**            | Interactive next-page / load-more / infinite-scroll all work in cand; fetch-based `?page=N` fallback for classic paginated PLPs | seo |
| Network summary               | Request count / bytes / cache hit rate                                 | network |
| Web Vitals                    | LCP, FCP, TTFB, INP, CLS — mobile + desktop                            | vitals |
| Image loading health          | Missing alt text, no srcset, broken `<img>`                            | html |
| Lazy section presence         | Deco `/deco/render` and `/_loader/*` routes responding                 | html |
| SEO deep audit                | robots.txt, sitemap, noindex regressions                               | seo |
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
| **Lazy sections eager**       | Detects intentional eager rendering of "lazy" sections                 | html |
| **Cart reveal mode**          | prod/cand cart-reveal markup intent matches                            | e2e |

All results are aggregated (optionally via Claude) and ranked by severity. Each issue includes screenshots, reproduction, and a suggested fix.
