# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

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
