# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.11.16](https://github.com/decocms/parity/compare/v0.11.15...v0.11.16) (2026-06-17)

### Changed

* **All checks now run in parallel.** `runAllChecks` previously walked the ~27 checks sequentially with `for (const check of ALL_CHECKS) await check(ctx)`, taking ~4m26s on bagaggio. Almost every check is a pure CPU aggregation over already-captured `PageCapture[]` data (string diffs, regex matches, console-entry filtering); the 3 network-bound ones (`seo-deep-audit`, `footer-links-health`, `plp-pagination`) are I/O-bound and parallelize cleanly too. Now uses `Promise.all` — the whole checks phase is dominated by the slowest single check. **Expected speedup: ~4m26s → ~30-60s** on bagaggio.
* **Console errors now dedupe across pages.** Previously the same error message ("A chave utilizada não corresponde ao domínio…") that appeared on 4 pages produced 4 separate top-level issues, crowding the report. Now `consoleErrorsBaseline` groups by normalized error key across all page pairs and emits ONE issue per unique error with the affected-pages list inline:
  ```
  [high] [generic] novo erro de console em 4 páginas (/ · /s · /search · /:::desktop): A chave utilizada não corresponde…
  ```
  Direct response to user feedback ("console log não deveria ter um teste pra ele … fazer o dedup e descrever quais páginas tiveram aquele error"). The schema-level Issue shape is unchanged (page = first affected, details = full list).

## [0.11.15](https://github.com/decocms/parity/compare/v0.11.14...v0.11.15) (2026-06-17)

### Changed

* **Viewports now run in parallel during collect.** Building on 0.11.14's parallel-sides change, the outer `for (const viewport of viewports)` loop is now wrapped in `runWithConcurrency` so the default `mobile,desktop` set runs fully concurrent — 4 BrowserContexts simultaneously (mobile/prod + mobile/cand + desktop/prod + desktop/cand). **Expected collect speedup: another ~40% on top of 0.11.14** (~9min → ~5–6min on bagaggio).
* **New `--max-viewport-concurrency <n>` flag (default 2).** Lets memory-constrained machines fall back to serial-viewport behavior, and caps concurrency for runs that add a 3rd viewport (e.g. `--viewports mobile,tablet,desktop`).
* **LLM call concurrency cap.** With 4 sides running, recovery-budget × side count could push 8–12 simultaneous LLM calls — past Anthropic tier-1's 4 RPS. Added a process-global semaphore in `src/llm/client.ts` (3 concurrent slots, queue thereafter) so calls never blow up with 429s — they queue. Default of 3 leaves headroom for the post-collect aggregate call.

## [0.11.14](https://github.com/decocms/parity/compare/v0.11.13...v0.11.14) (2026-06-17)

### Added

* **Always-visible elapsed counter.** A 1-second ticker rewrites the spinner with `⏱ 04:32 · <current label>` from the moment "Launching browser…" appears until the report writes. No more "is it stuck?" minutes of silence — the user knows exactly how long the run has been going at any moment. Cleared in `finally` so it can't survive past `runCommand`.
* **Per-flow timing in the bottom summary.** New `flows breakdown` block lists each flow's `max` time (the parallel-wall-clock contribution) plus per-side detail:
  ```
  flows breakdown (sides run in parallel within viewport)
    purchase-journey  max 1m32s · mobile/prod 52s · mobile/cand 58s · desk/prod 89s · desk/cand 90s
    search            max 1m48s · …
  ```
  Driven by the existing `FlowCapture.totalDurationMs` (already populated by `finalize` — just wasn't surfaced).

### Changed

* **Prod + cand now run in parallel within each viewport.** `parity run`'s collect loop was 100% sequential: `for viewport { for side { for flow {…} } }`. The two sides for a given viewport are already independent (separate BrowserContexts, separate HAR/trace paths), so the same `Promise.all([prod, cand])` pattern that `parity journey` has used for months now applies to `parity run` too. Extracted a `runOneSide(viewport, side)` helper, replaced the inner side loop with `Promise.all`, and deferred `promoteStepsFromFlow` (which mutates the shared `learned` object) until after `Promise.all` resolves so there's no race on selector promotion. **Expected speedup: ~50% on collect phase** (25m → ~17m total on bagaggio). Viewports still serialize for now — PR #2 will parallelize those too.

## [0.11.13](https://github.com/decocms/parity/compare/v0.11.12...v0.11.13) (2026-06-17)

### Fixed

* **`parity run` no longer crashes when a flow's `newPage()` errors.** A single rejected inner-flow promise (most commonly `browserContext.newPage: Target page, context or browser has been closed` raised from `flowSearch` when a prior flow corrupted the context) was bubbling through `Promise.race` in `runFlow` and aborting the entire run, throwing away 25+ minutes of work. The `.catch(() => undefined)` on the inner promise only silenced the unhandled-rejection warning — it didn't stop `Promise.race` from seeing the rejection. Wrapped the inner switch in a try/catch that returns a `flow-error` `FlowCapture` instead of throwing, so the surviving viewports/sides finish and the report still renders.

### Added

* **Live per-step progress in `parity run`.** Previously the terminal went silent for tens of minutes after "Launching browser…" with no feedback until the run ended or crashed — devs were stuck guessing whether the tool was making progress. Now the spinner updates on every step (`[mobile/prod] purchase-journey 5/9 add-to-cart…`) and prints a permanent per-flow summary line as each side finishes:
  ```
  ✓ [mobile/prod]  purchase-journey 9/9                       58.2s
  ✓ [mobile/cand]  purchase-journey 9/9                       62.4s
  ✗ [desk/prod]    purchase-journey 6/9 stopped at open-minicart  118s
  ▴ [desk/cand]    purchase-journey 3/9 ended at enter-pdp        45s
  ```
  Glyphs: `✓` reached target, `✗` explicit failure at a step, `▴` early exit (e.g. PDP not found so journey never started checkout). Wires the existing `onStep` callback from `runFlow` (already used by `parity journey`) into `run.ts`.

## [0.11.12](https://github.com/decocms/parity/compare/v0.11.11...v0.11.12) (2026-06-17)

### Fixed

* **Zero warnings on `npm install -g @decocms/parity`.** Verified end-to-end: a clean global install produces no `ERESOLVE` peer-dep warning and no `deprecated` notices. From 161 packages down to 137.
* **Migrated to zod 4** to eliminate the `ERESOLVE overriding peer dependency` warning. `@anthropic-ai/claude-agent-sdk@0.3.x` peer-deps `zod@^4.0.0` and we were pinned to `zod@^3.24.1`. Both sibling deps (`@anthropic-ai/sdk@^0.100.1` and `@modelcontextprotocol/sdk`) already accept `^3.25.0 || ^4.0.0`, so zod 4 was the safe direction. Migration touched two files (`src/types/schema.ts`, `src/learned/repo.ts`): `z.record(value)` → `z.record(z.string(), value)` (zod 4 requires explicit key type), and `z.record(enum, value)` → `z.partialRecord(enum, value)` (zod 4 made enum-keyed records require all enum members by default). All 701 tests still pass.
* **Bundled cheerio inline to drop the deprecated `whatwg-encoding@3.1.1` warning.** `npm overrides` only applies to the consumer's root project, so even with `overrides: { "encoding-sniffer": "^1.0.0" }` end users still saw `npm warn deprecated whatwg-encoding@3.1.1`. The fix: switched the build from `--packages=external` (everything external) to an explicit `--external` list that excludes cheerio. cheerio + its transitives (`parse5`, `htmlparser2`, `domutils`, `domhandler`, `encoding-sniffer`, etc.) are now bundled inline in `dist/cli.js`, and cheerio moved from `dependencies` to `devDependencies`. Net cost: `dist/cli.js` grew from 0.76 MB → 2.16 MB. Net benefit: end users no longer install cheerio or any of its transitives, eliminating the deprecation warning at its source. Live-validated.

## [0.11.11](https://github.com/decocms/parity/compare/v0.11.10...v0.11.11) (2026-06-17)

### Fixed

* **Runtime auto-install was incomplete in 0.11.10.** The 0.11.10 install path ran `npx --yes playwright install chromium` and reported success, but Playwright 1.49+ launches `chromium-headless-shell` for `headless: true` — that's a *separate* binary download. The retry still failed with `Executable doesn't exist at .../chrome-headless-shell` and the user saw the friendly fallback message even though we tried to fix it. Live-reproduced against bagaggio.
* **Now installs both `chromium` AND `chromium-headless-shell`** so `parity run` works headless without manual intervention.
* **Uses the bundled Playwright CLI, not `npx --yes playwright`.** `npx --yes` may fetch a *different* Playwright version into its cache, and the binaries it downloads may not match the version `parity` actually launches — so even a successful install can leave the retry failing. We now resolve `playwright/cli.js` via `createRequire` against the local `node_modules` and spawn `node <local-cli> install chromium chromium-headless-shell` — guaranteed version-matched. Falls back to `npx` only if the local resolution fails.
* **Validated locally end-to-end**: cleared `~/Library/Caches/ms-playwright`, ran `parity audit`, both binaries downloaded (`chromium-1217` + `chromium_headless_shell-1217`), audit completed successfully — no manual `npx playwright install` needed.

## [0.11.10](https://github.com/decocms/parity/compare/v0.11.9...v0.11.10) (2026-06-17)

### Fixed

* **Runtime auto-install of Chromium when `postinstall` didn't run.** The 0.11.7 `postinstall` hook works when npm runs it — but plenty of installs skip lifecycle scripts (`npm config set ignore-scripts true`, `npm 11+` global-install default, monorepos with `--ignore-scripts`). Users saw a friendly "run `npx playwright install chromium`" message but still had to run a second command before `parity` worked. Now `launchBrowser` catches the missing-browser error and runs `npx --yes playwright install chromium` inline (with stdio inherited so the download progress is visible), then retries the launch once. The original "you must run X" path is preserved via `PARITY_SKIP_PLAYWRIGHT_INSTALL=1` for CI / Docker / monorepos that want explicit control. Net effect: a fresh `npm i -g @decocms/parity && parity run …` works in one command even when lifecycle scripts are disabled.

## [0.11.9](https://github.com/decocms/parity/compare/v0.11.8...v0.11.9) (2026-06-17)

### Fixed

* **Re-publish to refresh `@latest` and let the Publish workflow create the GitHub release.** All the 0.11.x manual `gh release create` calls collided with the CI Publish job's `gh release create --generate-notes` step (it gets `HTTP 422: Release.tag_name already exists` and exits non-zero), which made the workflow look red even though npm publish succeeded each time. This bump has no code changes — it triggers a clean end-to-end publish so the workflow can prove green and `@latest` carries the same artifact as 0.11.8 with a fresh install signature. From now on no manual release creation — the workflow does it.

## [0.11.8](https://github.com/decocms/parity/compare/v0.11.7...v0.11.8) (2026-06-17)

### Fixed

* **CI on `main` was broken across the 0.11.x patch series.** Three issues converged: (a) the new `postinstall` script in 0.11.7 used CommonJS `require()` but the package is `"type": "module"`, so every fresh `bun install --frozen-lockfile` (including the CI install step) threw `ReferenceError: require is not defined`. (b) Several lint errors carried over from PRs that used `--admin` to bypass CI (template-literal-as-string, assign-in-while-conditions in the new `plp-pagination` check, `delete attrs[name]` flagged by `noDelete`). (c) The earlier `0.11.4` HTML-compaction code in `discover-selectors`/`recover-step` triggered the same `noDelete` rule.
* **`postinstall.js` renamed to `postinstall.cjs`** so it runs as CommonJS regardless of the package's `"type"`. `package.json` `files` list and the `postinstall` script invocation updated accordingly.
* **Lint clean across the repo.** `bun run lint` returns zero errors. Loop patterns rewritten from `while ((m = re.exec(s)))` to `for (;;)` + early-break (biome's `noAssignInExpressions`). Two intentional `delete` calls on cheerio attribs get a scoped `biome-ignore` with the rationale (cheerio serializes `undefined`-valued attrs as empty strings; only `delete` actually removes them).

## [0.11.7](https://github.com/decocms/parity/compare/v0.11.6...v0.11.7) (2026-06-17)

### Fixed

* **First-run UX after `npm install -g`.** Two papercuts:
  1. **Playwright Chromium wasn't auto-installed.** A fresh global install left users with `browserType.launch: Executable doesn't exist at ...` plus a stack trace on the first `parity run`. Now there's a `postinstall` script that runs `npx playwright install chromium` automatically (one-time, ~140 MB). Skippable via `PARITY_SKIP_PLAYWRIGHT_INSTALL=1` for CI / Docker / monorepos that manage browsers separately. Failures during postinstall (offline, corp proxy) are downgraded to a warning so the global install itself still completes.
  2. **`launchBrowser` now catches the missing-browser error** and prints a single clear instruction (`npx playwright install chromium`) instead of Playwright's ASCII banner + stack trace. Original error is preserved on `.cause` for debugging.

### Known cosmetic warning

The `@anthropic-ai/claude-agent-sdk` peer-dep on `zod@^4.0.0` clashes with parity's `zod@^3.x`. The warning is harmless — npm nests the two versions and everything works. A migration to zod 4 is tracked separately (lots of schema API differences).

## [0.11.6](https://github.com/decocms/parity/compare/v0.11.5...v0.11.6) (2026-06-17)

### Added

* **New `plp-pagination` check.** Tests that `?page=2` and `?page=3` of every captured PLP return 200 AND show different products than page 1. Catches the classic migration regression: the new site silently ignores `?page=N` and returns the first page on every request (or caps pagination). Live tested against bagaggio TanStack — surfaces a real critical bug (`page=2` shows the same 10 products as `page=1`, 100% overlap). Falls back to scraping the home page for a category link when running standalone (`parity check plp-pagination`).
* **Cross-side count divergence detection.** When prod and cand both serve a paginated PLP but cand's `?page=2` product count differs from prod's by more than 30%, flag as medium-severity (likely sort-order or index pruning regression).

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
