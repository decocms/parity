# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.10.1](https://github.com/decocms/parity/compare/v0.10.0...v0.10.1) (2026-05-30)

### Fixed

* **Adaptive `scrollFullPage` — actually reaches the bottom on long pages.** Previous fixed-step loop with a 10s outer race only covered ~15000px before bailing, so 25000-40000px e-commerce homepages were captured with half the content still as skeletons. New loop re-measures `scrollHeight` every tick, waits inline for in-view skeleton placeholders to clear (up to 1.5s per step), and exits once page height has been stable for 3 consecutive checks. On miess home: 15 steps, 8862px reached, **0 skeletons at screenshot time** (was 7+ before). Race timeout bumped 10s → 45s, `capturePage` visual-diff `timeoutMs` 45s → 90s to fit the new scroll budget.

* **Silent `ReferenceError: __name is not defined` inside `page.evaluate`.** Took two debug rounds to isolate — `tsx`/esbuild injects a `__name` helper to preserve `.name` on arrow-function declarations (`const foo = () => ...`), but that helper doesn't exist in the page's browser context. The function threw immediately and `.catch(() => undefined)` swallowed it, making it look like a legitimate timeout. Fix: inlined the helper Promises inside `scrollFullPage`'s `page.evaluate`, and replaced silent `.catch` with one that logs the actual error message.

* **`SKELETON_DOWNGRADE_PCT_DIFF_CEILING = 0.25`.** The skeleton-vs-loaded downgrade was masking structural failures: any diff where the LLM mentioned "skeleton"/"placeholder" was forced to `low`, even when prod had a half-empty page (34%+ pctDiff). Now the downgrade only fires when pctDiff is under 25% — above that, the imbalance is treated as a real regression, not timing noise.

### Changed

* `waitForSkeletonsToResolve` budget reduced 10s → 5s. The new adaptive scroll does inter-step skeleton waits, so the global safety net is a last-resort for off-screen skeletons rather than the primary defense.

* New `pre-screenshot skeletons=N` diagnostic log (via `DEBUG_PARITY=1`) so anyone investigating "is the page actually ready when we capture it?" can answer in one run.

## [0.10.0](https://github.com/decocms/parity/compare/v0.9.0...v0.10.0) (2026-05-29)

### Added

* **skeleton-aware capture pipeline:** `capturePage` now waits up to 6s for skeleton/loader placeholders (`.skeleton`, `[aria-busy]`, `.animate-pulse`, `.shimmer*`, `react-loading-skeleton`, generic `[class*='skeleton' i]`) to resolve before the screenshot fires. Stops the visual-diff LLM from reporting phantom "missing-component" diffs because one side raced ahead. `DomSnapshot.skeletonCount` exposes residual skeletons to downstream consumers.
* **skeleton-vs-loaded downgrade post-process:** when prod and cand differ in skeleton count by ≥5, LLM-reported `missing-component`/`different-component`/`extra-component` diffs whose description mentions skeleton/placeholder/shimmer wording are downgraded to `low` with an explanatory `[downgraded: skeleton-vs-loaded — ...]` suffix. Mirrors the carousel safety net from issue #22.

### Fixed

* **scrollFullPage timing on heavy storefronts:** scroll step delay raised from 220ms → 400ms (gives shelf APIs time to dispatch before viewport moves past), bottom dwell from 400ms → 1500ms (footer + bottom carousels get to finish), plus a new 700ms settle after returning to the top (covers lazy frameworks that re-skeletonize on IntersectionObserver "leave"). This was the root cause of prod screenshots capturing 30-60% skeleton placeholders on Miess `/`, `/super-live`, `/intt-day`.
* **post-scroll networkidle wait:** added a 3s `networkidle` race after `scrollFullPage` in `capturePage`, plus 800ms (was 600ms) settle. Catches the lazy-fetch wave kicked off during the scroll-through before the screenshot fires.
* **visual-diff `settleMs` for the dedicated capture pass:** bumped from 1.8s → 4s and outer `timeoutMs` from 30s → 45s. These screenshots are the source of truth for the LLM verdict — flaky captures translate directly to flaky verdicts.

### Changed

* **`LLM_PROMPT_VERSION` → `v3-skeleton`:** prompt now includes an explicit "skeleton/loading is timing, not regression" rule plus the prod/cand skeleton-count imbalance context. Bump invalidates all v2-keyed cache entries so prior verdicts get re-judged under the new heuristic.

## [0.9.0](https://github.com/decocms/parity/compare/v0.8.1...v0.9.0) (2026-05-29)

### Added

* **e2e command:** new `parity e2e --url=<URL>` for single-site functional validation. Runs all functional flows (homepage, plp, pdp, purchase-journey, search, cart-interactions, optionally login) plus all checks in single-site mode. Use for pre-launch / partner-site verification when there's no prod baseline to compare against.
* **search flow:** new `flowSearch` (6 steps: visit-home → open-search → type-and-autocomplete → submit-results → search-no-results → search-empty-state). Resolves the search term inteligentemente via cascade (rc.search.terms → cache → LLM suggest → PT-BR fallbacks). Generates a deterministic unicode `no-results` term per run to exercise the empty-state UI without false matches.
* **cart-interactions flow:** new `flowCartInteractions` (7 steps: seed-cart → read-baseline → increment-qty → decrement-qty → apply-invalid-coupon → remove-item → verify-empty-state). Seeds via PJ-style navigation (home → PLP → PDP → add → minicart) then exercises each cart interaction with before/after qty+price validation.
* **login flow:** new `flowLogin` (5 steps, gated by `rc.login.enabled` + `PARITY_LOGIN_EMAIL` / `PARITY_LOGIN_PASSWORD` env vars). Validates invalid-credential error + valid-credential redirect + account area access. Credentials never read from `.parityrc.json` (env vars only).
* **10 new checks:** `search-presence`, `search-autocomplete`, `search-results`, `search-no-results`, `cart-interactions-flow`, `not-found-parity`, `cookie-cep-modal-cls`, `pdp-gallery-related`, `footer-links-health`, `login-flow`. All adapt to comparative (`parity run`) vs single-site (`parity e2e`) mode.
* **universal `findElement(page, ctx, { key, intent, budget })` helper:** unifies the override → learned → defaults → LLM-recovery cascade behind one call. Replaces ~80 lines of boilerplate across the new flows and is now the recommended pattern for any new selector-driven step.
* **21 new selector keys:** `searchTrigger`, `searchInput`, `searchSuggestions`, `cartItemRow`, `cartQuantityIncrement`/`Decrement`, `cartRemoveItem`, `cartCouponInput`/`Submit`, `cartTotalPrice`, `pdpGalleryThumbnail`/`Main`, `pdpRelatedShelf`, `loginTrigger`/`EmailInput`/`PasswordInput`/`Submit`/`ErrorMessage`, `accountMenuTrigger`. Defaults cover VTEX/Shopify/Deco patterns; LLM discovery extended to suggest them when missing.
* **`StepCapture` validations:** `searchValidation` (term/mode/resultCount/suggestionCount/hasEmptyState), `cartItemValidation` (action/before/after/succeeded), `loginValidation` (stage/errorMessage).
* **`ParityRc` blocks:** `search.terms` / `search.noResultsTerm`, `login.enabled`, `footer.maxLinks` / `followExternal`, `notFound.testUrl`.
* **preset `full`:** now includes `search,cart-interactions` alongside `purchase-journey`.

### Fixed

* **cache-coverage false positives:** assets with `cache-control: public, max-age=N≥60s` are no longer flagged as "MISS opportunities" just because `fromCache=false` (which is always the case on a cold Playwright session). New `cacheable` decision state recognizes properly-configured cache headers. On Miess this dropped flagged opportunities from 323 → 0 — the assets had 1-year `max-age` headers and weren't actually misconfigured.
* **http-status-parity in single-site mode:** the check no longer flags every captured page as "missing in prod" when `parity e2e` runs with an empty prod slot by convention. Returns `skipped` when prod is empty and cand has content.
* **audit-seo noindex exceptions:** `/search`, `/buscapagina` (VTEX legacy), `/s` (VTEX Intelligent Search), `/account`, `/checkout`, `/cart`, `/login`, `/404` and friends no longer trigger `noindex` high-severity issues — those routes SHOULD be noindex by SEO best practice.
* **search-no-results severity scaling:** unicode term returning 1-10 products is now `medium` "fuzzy fallback" rather than `critical` "matches everything"; only >10 products without empty state remains critical. Matches real VTEX Intelligent Search behavior on stores like Miess.
* **search empty-state detection:** waits for SPA hydration (`networkidle` + 800ms) before checking; combines `innerText` + captured HTML + proximity heuristic so VTEX Intelligent Search empty states are reliably detected.
* **cache-coverage wording in single-site mode:** says `"no site"` instead of `"em cand"` when running without a prod baseline.
* **e2e flow `runId` propagation:** `FlowContext.runId` is now plumbed from `e2e.ts` / `run.ts` so the deterministic no-results unicode term uses the actual run id (was previously taking the literal string `"screenshots"` from `outDir.split("/").pop()`).

### Fixed

* **ci:** publish workflow alignment with `decocms/deco-start` to unblock first-time OIDC publish (Node 22, job-level `id-token: write` permission). Includes the 0.5.0 changes that were stuck behind a non-OIDC publisher transition. ([PR #16](https://github.com/decocms/parity/pull/16))

## [0.5.0](https://github.com/decocms/parity/compare/v0.4.0...v0.5.0) (2026-05-27)

### Added

* **journey:** predictive variant selection (new step 4 `select-variant`) — picks a tamanho / cor / sabor before clicking COMPRAR on stores that gate add-to-cart on a SKU choice (Miess, lingerie sites, lubricant brands with SABOR/COR tables). Heuristic-first with LLM fallback when `Selecione um produto` is detected. ([PR #13](https://github.com/decocms/parity/pull/13))
* **journey:** real `add-to-cart` validation — polls for success-toast (`produto adicionado`), minicart count increase, drawer open, or URL navigation. Eliminates the false ✓ class of bugs that masked broken checkouts.
* **journey:** generic `attemptStepAction(click | fill | press)` driver — tries selectors-then-LLM, returns what worked + `recoveredByLlm` marker for promotion. Used in the new steps.
* **journey:** new selector keys: `sizeSwatch`, `colorSwatch`, `variantRow`, `quantityIncrement`, `quantityInput`, `minicartCount`.
* **journey:** `parity journey` now persists learned-selectors across runs (was only `parity run` before). CLI logs `learned-selectors atualizado: X promovido(s), Y reforçado(s)`.
* **llm:** OpenRouter `callTool` retries once on transient failure (5xx / 429 / network abort / unrepairable JSON parse), doubling `max_tokens` on the retry so mid-object truncation completes. Respects the overall `timeoutMs` budget.
* **llm:** `discoverSelectorsFromUrl` prompt sharpened — `checkout_button` is optional + explicit "NEVER same as `minicart_trigger`"; CEP descriptions clarify "ADDRESS postal code, NOT coupon / newsletter / email". Sanity check drops `checkoutButton` when it collides with `minicartTrigger` (the cart-icon-as-checkout-button confusion).
* **ci:** swap `release-please` for a `publish-on-version-change` workflow modeled after `decocms/studio`. No PAT, no org-level pull-request permission, no PR creation step — bump `package.json` version and the workflow publishes + tags + releases. ([PR #14](https://github.com/decocms/parity/pull/14))

### Fixed

* **learned/promote:** deprecated-counter no longer overcounts. Snapshots state before `recordFailure` so already-deprecated entries failing again don't inflate the metric.
* **commands/journey:** `--no-auto-selectors` only disables LLM startup discovery, not learned-selectors persistence (the two are independent features).
* **commands/journey:** `saveLearned` wrapped in try/catch so a disk-full / permission-denied write surfaces as a warning instead of aborting the whole journey.

## [0.4.0](https://github.com/decocms/parity/compare/v0.3.0...v0.4.0) (2026-05-27)


### Added

* **journey:** extract product title on PDP and validate the same product appears in cart drawer (step 6) and on checkout page (step 8). 30+ selectors cover VTEX legacy, checkout6, FastStore, Wake. ([PR #11](https://github.com/decocms/parity/pull/11))
* **journey:** viewport-aware minicart open strategy — desktop tries hover first (popup-style minicarts on VTEX prod), mobile tries `tap()` first (real touch event bypasses overlay handlers that swallow synthetic clicks). Adds `force: true` click + goto-href fallback when interactive strategies fail.
* **journey:** `dismissOverlays` actively closes cookie banners, add-to-cart toasts and `[role=alertdialog]` before interacting with the minicart trigger.
* **journey:** `waitForCartHydration` waits for the orderForm XHR + first cart-item selector before validation runs after `page.goto('/checkout/#/cart')`.
* **journey:** step 8 advance-checkout mode — when URL is already on a checkout subpage, prepends 15 next-step selectors (`#cart-to-orderform`, `a.orange-btn`, `:has-text('Continuar para pagamento')`, etc.) and waits for URL change instead of a `/checkout` match.
* **journey:** empty-cart banner detection populates `step.cartValidation.reason` to distinguish "cart genuinely empty (session not persisting)" from "selectors don't match markup".
* **journey:** `DEBUG_PARITY=1` env var enables structured per-step + per-substep dlog output to stderr.
* **schema:** `StepCapture.cartValidation` (expectedTitle, found, method, observedTitles, reason) and `cartOpenMethod` (click | click-navigate | hover | already-open | failed) for report traceability.


### Fixed

* **journey:** `collectCandidateLinks` 15s budget + per-op `withCap` race — prevents indefinite hang when the page V8 main thread is wedged by memory leaks (CDP messages queue past `locator.count()` declared timeout).
* **journey:** page-close cap of 5s in the flow timeout cleanup — closes never block the next flow indefinitely on a wedged page.
* **journey:** flow-timeout step renamed from `visit-home` to `flow-timeout` so the summary shows honestly which step the deadline aborted.
* **journey:** isReachedCheckout regex accepts 13 checkout-flow URL markers (VTEX `/checkout`, Shopify `/checkouts`, Wake `/pedido`, Magento `/onepage`, Nuvemshop `/finalizar`, custom `/secure`, `/pagamento`, etc.) — no longer too strict to VTEX-only patterns.
* **journey:** `validateCartContainsTitle` scope-qualifies the `[data-product-name]` selector to cart/drawer/checkout/minicart context — prevents false positives where the PDP `<h1>` matched the cart-context selector.
* **journey:** `validateCartContainsTitle` retries after 2s on empty observation — catches in-flight cart-items XHR finishing slightly late.
* **journey:** `waitForCartHydration` uses Promise.race (not Promise.all) so the faster of orderForm-XHR / cart-item-selector signals wins, avoiding 8s stalls when one probe never matches.
* **llm:** `tryRepairJson` recovers from truncated/fenced tool-call arguments returned by some OpenRouter-backed models.
* **llm:** recovery prompt accepts `a[href*=checkout]` when qualified by text or scope (e.g. `:has-text('Finalizar')`, `[role=dialog] …`). Previous version was too strict and the LLM returned null even when the right element was findable.

## [0.3.0](https://github.com/decocms/parity/compare/v0.2.0...v0.3.0) (2026-05-26)


### Added

* **journey:** retry `go-checkout` via LLM recovery when the default selector clicks the wrong element and the URL never reaches `/checkout` ([5826d30](https://github.com/decocms/parity/commit/5826d309c6a910f8cf8017667cdcdcebd65f65d9))
* **journey:** LLM recovery on `cep-pdp` + `cep-cart` when defaults miss the CEP input ([624b0f5](https://github.com/decocms/parity/commit/624b0f5acbe1c50fce2bea69faa6906e29d36e64))
* **journey:** per-flow hard deadline so a single hung flow can't freeze the whole crawl ([e2d4a68](https://github.com/decocms/parity/commit/e2d4a681a5d4f0a9627251eceb1e733d12bdc68d))


### Fixed

* **journey:** abort in-flight Playwright ops when the deadline fires, instead of letting them mutate the next flow's shared BrowserContext ([a21aa78](https://github.com/decocms/parity/commit/a21aa78a4431e7a2cff9aac26ac34c4ca2fa768c))
* **journey:** seal the timeout FlowCapture synchronously so Promise.race can't pick up the inner rejection caused by closing pages ([d2a0f1e](https://github.com/decocms/parity/commit/d2a0f1e7a08bf95a28a951bace322c5baf062bea))
* **journey:** await timeout cleanup before runFlow returns so the next flow on the same context isn't racing in-flight close()s ([a2fd6c2](https://github.com/decocms/parity/commit/a2fd6c2e7e7a9eb493d2cb75d08f3d5cc7cc3f91))

## [0.2.0](https://github.com/decocms/parity/compare/v0.1.1...v0.2.0) (2026-05-26)


### Added

* **css-trace:** inspect CSS rules affecting a DOM element ([1e323fa](https://github.com/decocms/parity/commit/1e323fa17564045d5f55bfbc5cbf2fcdb0112877))


### Fixed

* **capture:** hard outer deadline so capturePage cannot exceed budget+10s ([966b9a5](https://github.com/decocms/parity/commit/966b9a59851536262b88510da6175a215c90d0b2))
* **capture:** hard outer deadline so capturePage cannot exceed budget+10s ([ea61116](https://github.com/decocms/parity/commit/ea61116c81fb1ec86e86ddb24216214380a81c81))
* **lint:** replace 3 template literals without interpolation with strings ([c60f19c](https://github.com/decocms/parity/commit/c60f19c4a56c8441ead829fca0998ee36a671872))

## [Unreleased]

## [0.1.1] — 2026-05-22

### Fixed

- `cache-coverage`: classify `decoims.com` (deco image proxy) and `assets.decocache.com` (deco edge cache) as first-party so they remain eligible for cache-opportunity reporting instead of being silently skipped as third-party. ([#5](https://github.com/decocms/parity/pull/5))
- `purchase-journey-flow`: never silently return `pass` when zero comparable steps were evaluated. The check now returns `skipped` when the flow wasn't requested, and `fail` (critical) when the flow was requested but neither side produced a capture or when capture arrays came back empty. Previously a fully broken cand home would still get a green verdict on the purchase-journey check. ([#6](https://github.com/decocms/parity/pull/6))

## [0.1.0] — 2026-05-12

First public release.

### Added

- `parity run` — full comparison between two URLs with 12 built-in checks
- `parity journey` — CI-friendly purchase journey runner with JUnit + GitHub annotations
- `parity vitals` — multi-page Web Vitals comparison
- `parity cache` — CDN cache analysis with opportunities
- `parity serve` — local HTTP proxy server so side-by-side iframes work for any site
- `parity baseline` / `parity compare` — track regressions over time
- `parity prompt` — export prioritized issues as LLM-ready Markdown
- `parity explain` — LLM root-cause analysis on a specific issue
- **Visual Diff tab** in the HTML report — galleries of prod / cand / pixelmatch heatmap with per-page Claude Vision analysis, missing-section detection from DOM, and dedicated export prompt
- **CLI presets** (`--preset smoke|full|ci`) bundling common flag combinations
- **Pre-flight check** — pings both URLs before the heavy capture phase, fails fast on dead URLs
- **Hard timeouts everywhere**: 120s per LLM Vision call, 60s per text call, 60s per page capture, 5s per response body read, 5s for the response flush. No more infinite hangs on streaming endpoints.
- Learned-selectors library with platform detection (VTEX, Shopify, Nuvemshop, Wake, Deco)
- LLM-driven selector discovery and step recovery
- Cross-site PDP matching via Claude (fingerprint comparison)

### Security

- `learned-selectors.json` is now gitignored and `.npmignored`. It may contain host names of sites you've tested.
- `.parityrc.json` and `.parityignore` are gitignored — they're per-user config that may reference private URLs.
