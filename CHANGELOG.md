# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.11.5](https://github.com/decocms/parity/compare/v0.11.4...v0.11.5) (2026-06-17)

### Fixed

* **Variant clicks now wait for navigation.** Deco TanStack PDPs render size/color pickers as `<a href="<product>/p?skuId=N">` links — clicking navigates to a different SKU URL. The previous `click + waitForTimeout(400)` ran add-to-cart against the pre-nav page where the variant was still "unselected". New `clickAndMaybeWait` helper races the click with `page.waitForNavigation` so the flow runs against the post-navigation page when it happens, and falls through when it doesn't (button-radio case).
* **`validateAddToCart` now uses `cartOpenedIndicator` selectors.** The new selector key from 0.11.4 (`[aria-label='Fechar notificação']` / `[aria-label='Fechar carrinho']` + generic role fallbacks) is now actually wired into the post-click drawer-open probe, so Deco TanStack notifications correctly mark add-to-cart as `ok` via the `drawer-open` signal.

### Added

* **Landing-page detection before LLM recovery on missing buy button.** When step 6 (add-to-cart) can't find a buy button, the runner now checks whether the page even looks like a PDP (schema:Product JSON-LD, `<form>` with button, price text, variant inputs). If fewer than 2 PDP signals fire, the step is skipped with `PDP appears to be a landing page (...)` instead of burning LLM recovery budget on a page that has nothing to recover. Reasons are surfaced in the skip note so the user immediately knows why.

### Verification (live against bagaggio)

| Version | Steps reached on cand |
| --- | --- |
| 0.11.2 and earlier | 3/9 (stops at enter-pdp) |
| 0.11.3 | 4/9 (stops at select-variant) |
| 0.11.4 | 6/9 (stops at add-to-cart) |
| **0.11.5** | **9/9** (reaches go-checkout) |

## [0.11.4](https://github.com/decocms/parity/compare/v0.11.3...v0.11.4) (2026-06-17)

### Added

* **`cartOpenedIndicator` selector key.** Used by the upcoming post-add-to-cart validator — list of selectors that, when matched and visible after clicking buy, confirm the cart actually opened (notification toast, drawer, etc). Default candidates include `[aria-label='Fechar notificação']` / `[aria-label='Fechar carrinho']` patterns from Deco TanStack plus generic role/`[role='dialog']` fallbacks.

### Fixed

* **Deco TanStack selectors covered before the LLM is even called.** Defaults extended for the bagaggio-class storefront — patterns observed live against `bagaggio-tanstack.deco-cx.workers.dev`:
  - **buyButton:** lowercase `comprar` variants + `button[type='button']:has-text('comprar')` (the CSS renders uppercase via `text-transform`; the markup is lowercase).
  - **minicartTrigger:** `[aria-label='Sacola']` + lowercase aria substring.
  - **cepInputPdp:** `input[name='postalCode']`, `#postalCodeInput`, `input[inputMode='numeric'][maxLength='8']`.
  - **sizeSwatch:** `[aria-label*='Tamanho '][aria-label*='Disponível']` — the " - Disponível" suffix means in-stock; sold-out variants don't carry it.
* **HTML compaction passed to the LLM is now actually useful.** Both `compactHtmlForSelectors` and `compactHtmlForRecovery` now:
  - Strip the Tailwind utility-class soup (`class="w-full h-12 flex items-center bg-primary ..."` becomes `class=""`) so the LLM sees semantic anchors (`data-*`, `aria-*`, `role`, semantic class names) instead of drowning in token noise.
  - Strip URL-encoded JSON in `data-event` / `data-track` / `data-analytics` attrs (Deco sites carry multi-kb analytics blobs there).
  - Drop inline `style=""`.
  - Add `data-product-list` and `[aria-label]` to the kept-element whitelist so the Deco TanStack patterns survive the compaction.
* **LLM prompts know about Deco TanStack now.** `discover-selectors` and `recover-step` system prompts both document the bagaggio-class patterns explicitly (product card via `aria-label='view product'`, lowercase CTA text, `[aria-label='Sacola']` minicart, `[aria-label='Tamanho X - Disponível']` size swatches, `name='postalCode'` CEP input) so when defaults miss the LLM has structured guidance instead of having to re-discover the pattern each time.

### Verification (live against bagaggio)

Before this PR: journey stopped at step 3 (`enter-pdp` — fixed in 0.11.3) and again at step 4 (`select-variant`).
After this PR: journey completes steps 1-5 (`visit-home`, `navigate-plp`, `enter-pdp`, `select-variant`, `shipping-calc-pdp`). Step 6 (`add-to-cart`) now surfaces a real bug — "Selecione um tamanho" is still visible after the variant click, meaning the variant selector matched a tab/expand element instead of the actual radio. Follow-up tracked separately.

## [0.11.3](https://github.com/decocms/parity/compare/v0.11.2...v0.11.3) (2026-06-17)

### Fixed

* **`productCard` defaults now match Deco TanStack PLPs (#102).** Live testing against `bagaggio-tanstack.deco-cx.workers.dev` showed every purchase-journey aborting at step 3 (`enter-pdp` → "no product card found, recovery exhausted"). Root cause: the Deco TanStack PLP uses `<a aria-label="view product" href="/<product>/p">` (no `/p/` subpath, no `[data-product-card]` attr) — none of the seven baked-in candidates matched. Added five new defaults covering the Deco TanStack pattern: `[data-product-list] a[aria-label='view product']`, `[data-product-list] a[href$='/p']`, `[data-product-list] a[href*='/p?']`, `a[aria-label='view product']`, plus path-suffix variants. Journey on bagaggio now reaches step 6 (add-to-cart) where it surfaces a real bug — variant selection — instead of bailing at step 3.

### Changed

* **Default tier for selector-related features back to Sonnet.** PR #66 defaulted selector-discovery / step-recovery / plp-matching / pdp-matching to Haiku 4.5 for cost savings. Live testing showed Sonnet is the safer default for structural-reasoning calls — Haiku-discovered selectors didn't always match on real sites and Haiku-recovery couldn't find alternatives. `search-terms` (pure classification) stays on Haiku. Users who want the previous cheap behavior can opt in with `--llm-tier-default haiku`.

## [0.11.2](https://github.com/decocms/parity/compare/v0.11.1...v0.11.2) (2026-06-17)

### Added

* **Per-flow step timeline in the check detail panel.** When a check is backed by a flow (`purchase-journey-flow`, `cart-interactions-flow`, `search-*`, `login-flow`), the detail page now renders a prod vs cand step-by-step table with status pill, duration, used selector, screenshot link, and skip-reason note per step. Lets you see exactly where the runner stopped instead of just "3/3 ok".

### Changed

* **Journey tile no longer claims "completed in both" when steps were skipped (#100).** The dashboard tile now reads `${ok}/${maxSteps}` (against the actual recorded step count, not just matched steps) and surfaces skipped steps explicitly: `${n} step(s) skipped (recovery exhausted)`. Tile state goes `warn` when a journey aborted early instead of staying `pass`. Found via live testing against bagaggio where step 3 (enter-pdp) silently skipped on both sides and the tile still showed green.
* **`scripts/regen-report.ts`** — small dev utility for re-rendering `report.html` from a saved `report.json` without re-running the browser. Useful when iterating on the renderer.

## [0.11.1](https://github.com/decocms/parity/compare/v0.11.0...v0.11.1) (2026-06-17)

### Fixed

* **Claude Agent SDK provider — every call failed with `error_max_turns` (#98).** Live testing against `lojabagaggio.deco.site` vs `bagaggio-tanstack.deco-cx.workers.dev` showed `[llm-claude-sdk] call failed: error_max_turns` on every selector-discovery, step-recovery, and aggregation call when running with `--llm claude-code`. Root cause: `maxTurns: 1` in `baseSdkOptions` — Claude Code's harness counts the response emission as turn 2 even when `allowedTools: []` prevents any tool from firing. Removed `maxTurns`; the empty tool whitelist alone guarantees a single round-trip. The SDK provider now actually produces output.

## [0.11.0](https://github.com/decocms/parity/compare/v0.10.1...v0.11.0) (2026-06-17)

### Added

* **Claude Agent SDK as a third LLM provider (#66).** Reuses the local `claude` CLI auth via [`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk). Auto-detected when no env key is set — devs with `claude` already logged in don't need to configure anything. Goes through the user's Claude plan instead of API billing.
* **Per-feature model routing.** Selector discovery / step recovery / classification → Haiku 4.5 (cheap), visual diff / aggregation → Sonnet 4.6, explain → Opus 4.7. Overridable via `--llm-model <feat>=<model>,...`, `--llm-tier-default <tier>`, or `--llm-model-default <model>`. Cuts ~70% of the LLM cost on a `--preset full` run.
* **`parity pr` CI/CD command (#79).** Compares a PR preview URL against prod and emits a Markdown comment ready to paste into a GitHub PR. With `--github`, writes to `$GITHUB_STEP_SUMMARY`. Thin wrapper around `parity run` with CI-tuned defaults (preset=ci, mobile-only, purchase-journey).
* **`parity report --section <name>` (#74).** Extracts one tab from a saved run as HTML or, with `--json`, as a tailored JSON projection (verdict, top-issues, checks, network, etc.). Lets agents pull the SEO/Network/Vitals slice without parsing the whole report or loading the full Run.
* **Per-page Network waterfall (#78).** SVG bar chart on the Network tab, positioned by `requestStart`, color-coded by resource type, faded for cached. `NetworkEntry` schema gets optional `startMs`/`endMs` (back-compat).
* **Clickable dashboard tiles → per-check detail panels (#76).** Tiles route to `#detail/<checkName>` showing status, duration, summary, issues, raw `data` payload, and a copy-pasteable reproduction command.
* **Side-by-side Home/PLP/PDP/Cart/Checkout buttons (#77).** SBS panel classifies captured paths by role and emits one button per role. URLs captured on one side only get a dashed border + warning chip.
* **`--pt` flag for LLM output language (#67).** Available on `parity run`, `audit`, `e2e`, `journey`, `fix`, `explain`. Affects only LLM-generated content — static report stays in English.
* **Tab descriptions / inline help (#73).** Every tab opens with a one-line description so new readers (and agents) immediately know what the tab covers.
* **Interactive selector prompt foundation (#72).** When parity hits a missing selector AND no LLM provider is available AND running in a TTY, the new prompt module guides the dev through writing a `.parityrc.json` override. Wiring into the runner is a follow-up.

### Changed

* **Report HTML now in English by default (#67).** Every user-facing PT-BR string in the report, audit HTML, and visual-diff prompt is translated. New regression test scans the output for PT-BR diacritics and a deny-list of common tokens.
* **`#diff` tab hidden when no baseline (#68).** The empty-state "Run executed without baseline" message that looked like a bug on every normal run is gone — the tab simply doesn't render unless `--baseline <name>` is loaded.
* **LLM-only tabs hidden when no LLM ran (#75).** Visual Diff and LLM Prompt tabs are omitted entirely from the nav + DOM when no LLM output exists. Single header banner explains why.
* **Side-by-side iframe forces mobile viewport via proxy (#70).** When `parity serve` is active, the proxy injects `<meta name="viewport" content="width=375">`, sets a mobile UA, and adds `Sec-CH-UA-Mobile: ?1` so cand renders in real mobile.
* **Smart `--visual-pages` default (#71).** Auto-zeroes when no LLM provider is available — the capture without analysis was just wasted seconds. Opt in with `--visual-pages N` if you want the raw screenshots anyway.
* **README rewrites around the agents-in-loop thesis (#80).** Three use cases (assisted migration, CI/CD PR review, continuous smoke) up front. New `docs/cli.md`, `docs/checks.md`, `docs/config.md`.
* **Report mobile-friendly + a11y focus rings + tabular numerics (#81).** Below 880px the sidebar becomes a horizontal chip strip; numeric values in tiles stay aligned across columns.

### Fixed

* **SDK provider image handling.** First implementation embedded base64 data URLs as text in the prompt — vision features (visual-diff, section-understanding) silently produced garbage. Now switches to the async-iterable `SDKUserMessage` form with proper `image` content blocks when `userImages` is set.
* **Timer leak in SDK provider abort handle.** `setTimeout` was created but never cleared. New `makeAbortHandle` returns a `clear()` callback that callers invoke in `finally`.
* **JSON repair reuse in SDK provider.** Bare `JSON.parse` was dropping fenced/wrapped output the OpenRouter provider would have salvaged. Now reuses the exported `tryRepairJson`.
* **`setForcedProvider` validates credentials before activating.** Returns a user-facing error string instead of failing with a 401 mid-run.
* **`disallowedTools: ["*"]` removed.** Was treated as a literal tool name, not a glob — misleading dead code.
* **Repo-wide lint sweep.** 9 biome errors carried over from in-flight PRs (template-literal-as-string, optional-chain, assign-in-expression) now fixed. `bun run lint` is clean.

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
