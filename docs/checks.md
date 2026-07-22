# Checks reference

Every check `parity` runs, what it catches, and when it fires.

| Check                         | What it catches                                                        |
| ----------------------------- | ---------------------------------------------------------------------- |
| HTTP status parity            | Routes that 404 / 500 in cand but worked in prod                       |
| Console errors                | New hydration mismatches, failed fetches, JS exceptions                |
| HTML structural diff          | Section / element counts drifting beyond tolerance                     |
| Meta / SEO parity             | `<title>`, `<meta description>`, canonical, og:*, twitter:*, JSON-LD   |
| **Visual diff (LLM Vision)**  | Sections missing, wrong hero, broken shelf, layout shifts              |
| Purchase journey              | Home → PLP → PDP → CEP → cart → checkout completes in both             |
| Network summary               | Request count / bytes / cache hit rate                                 |
| Web Vitals                    | LCP, FCP, TTFB, INP, CLS — mobile + desktop                            |
| Image loading health          | Missing alt text, no srcset, broken `<img>`                            |
| Lazy section presence         | Deco `/deco/render` and `/_loader/*` routes responding                 |
| SEO deep audit                | robots.txt, sitemap, noindex regressions                               |
| Cache coverage                | Cache hit rate, opportunities to cache                                 |
| **Search presence**           | Search input reachable from home in both                               |
| **Search autocomplete**       | Typing reveals suggestions; cand keeps parity with prod                |
| **Search results**            | Same keyword returns comparable product counts                         |
| **Search no-results**         | Unicode garbage term shows empty state, doesn't match products         |
| **Cart interactions**         | Multi-item add / increment / decrement / coupon (invalid + optional valid) / VTEX seller-null probe / remove all behave in cand |
| **404 parity**                | Invalid URL returns 404 (no catch-all 200 in cand)                     |
| **Cookie/CEP modal CLS**      | Modals don't introduce layout shifts >0.1 in cand                      |
| **PDP gallery + related**     | Image gallery + "Related products" shelf still render                  |
| **Footer links health**       | Institutional links (privacy, contact, etc.) aren't broken in cand     |
| **Login flow** _(opt-in)_     | Valid credentials log in; invalid ones show a clear error              |
| **Picture missing dims**      | Static CLS detector — `<picture>` without explicit width/height        |
| **Lazy sections eager**       | Detects intentional eager rendering of "lazy" sections                 |
| **Cart reveal mode**          | prod/cand cart-reveal markup intent matches                            |

All results are aggregated (optionally via Claude) and ranked by severity. Each issue includes screenshots, reproduction, and a suggested fix.
