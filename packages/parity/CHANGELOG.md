# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.28.0] — 2026-08-24

The Studio board stops being a one-way report: the client can now see the fixes
that landed and talk back on a card, and what they say enters the flow.

### Added

* **`parity plan notes` — the client's input channel.** Reads the comments the
  client leaves on a page's card (`TASK_BOARD_COMMENT_LIST`), so *"this product
  card should match the Brazil site, not Ecuador"* becomes a proposed
  `set-reference` + `set-status upgrade` — exactly what those exist for. `--post`
  writes a confirmation back on the card so the client sees their note became a
  decision; our comments are prefixed and skipped on the next read, so a
  confirmation never returns as fresh input. Notes are **proposals**: `as-is` and
  `upgrade` still need the user, since only they get to say "stop working on this".
* **Fix cards (`parity plan board --fixes <file>`).** Mirrors the fixes a client
  would recognise as their own cards, with the PR URL in the description and
  `closed` rendering as `done` — "we fixed X" without them reading GitHub. Scoped
  on purpose: lint, bundle and infra findings bury the board that is supposed to
  show progress.
* **`--repo <owner/name>`** stored on each card, so the board knows where the work
  lives.

### Changed

* **Cards are anchored by id, not title.** The card id is stored on the page
  (`PlanPage.boardItemId`) and carried across a re-capture by `mergePlanDecisions`.
  Without it, renaming a card orphaned the client's comments and the next sync
  built a second board. Titles are now the plain page path — the previous
  `[host] /path` prefix existed only because the item was thought to have no repo
  field; it does.
* **Orchestrator: a `client-notes` step** at the start of each page cycle when the
  board goes to the Studio — read notes, propose the plan change, ask, apply,
  confirm on the card. A note that cannot be acted on is answered, never left
  silently unread: the client is watching that card to know they were heard.
  (`migration-orchestrator`)

## [0.27.0] — 2026-08-21

### Added

* **`parity plan board` — the migration as a per-page kanban.** Every sampled page
  sits in a lane (`triage` | `backlog` | `building` | `review` | `done` | `skipped`)
  with the components blocking it. Lanes are **derived** from `pagePlan`, never
  stored, so a page cannot read as done while a component it needs is missing —
  the failure mode of the hand-typed page status. Two lists sit outside the lanes:
  `shell` (global components, reported once because they block every page instead
  of repeated per card) and `no page` (components the code defines that no sampled
  page uses — common on `deco-fresh`, whose source inventory walks `sections/*.tsx`
  with no page association; listed rather than hidden). `--json` for the
  orchestrator. Plans predating page/component edges degrade to `triage` rather
  than claiming false readiness.
* **`--board studio` — mirror the board into the deco Studio task board.** One card
  per page in the client's org, so progress is visible without a terminal. Lanes map
  onto the board's five fixed columns; `skipped` gets no card. Talks to the Studio's
  `/mcp/self` endpoint with plain JSON-RPC over `fetch` (the MCP SDK would be a
  dependency for one POST). The token decides the org — the task board tools take no
  org parameter. Re-running does not duplicate: the sync lists first and matches on
  title, then updates. **It never fails a run** — unset or unreachable Studio prints
  the terminal board and exits 0.

### Changed

* **Orchestrator + plugin integration.** `reconcile` now shows the board next to the
  inventory and uses it to pick what to work on (the page furthest along that is not
  done — finishing a page beats starting three); the per-page cycle refreshes the
  board when a page closes and holds to one page at a time. `discovery` asks where
  the board goes (`terminal`/`studio`) and **always** asks which stage the run is in
  rather than silently defaulting, which is how a team building components ended up
  with a queue of bundle-size and analytics issues. It also asks for `target.dir`
  when it cannot resolve one. New `--stage` and `--board` arguments on
  `/parity:migrate`. (`migration-orchestrator`, `commands/migrate`)

## [0.26.0] — 2026-08-21

Fixes the failure mode found running the plugin on a mature FastStore target
(electrolux-poc): the run filed 13 issues and opened 5 stacked PRs — i18n,
`:global()`, `rgba()` tokens, GA4 analytics, JSON-LD — and **zero** about the
work actually in progress (missing components, pages without content). Root
cause: `.parity/migration-plan.json` was never persisted, so the triager had
nothing to compare against, reported no missing components, and the orchestrator
degenerated into a CSS/perf linter over whatever the repo contained — while
reconcile imported the target's whole polish backlog as issues.

### Added

* **`parity plan status`** — the migration inventory. Prints components settled
  (no work needed) vs remaining, and pages done vs **awaiting CMS content**,
  with `--json` for the orchestrator. This is the "what's actually left?" view
  that was missing.
* **Page readiness tracking.** `pages[]` rows now carry a `status`
  (`pending` \| `code` \| `done` \| `skipped`) flipped by **`parity plan
  set-page-status <path> <status>`**. `code` means the route/sections exist but
  the CMS has no published content — on FastStore the most common real state,
  and previously not modeled at all (code-complete was indistinguishable from
  page-complete). Plans written before this read as `pending`.
* **`partial` component status.** A half-wired section (CMS schema with no
  `index.tsx` registration, or the reverse) is neither pending nor done;
  reporting it as `pending` sent a porter to redo finished work.
* **Stage scoping (`state.stage`: `components` \| `pages` \| `polish`).** Scopes
  what `triage` reports and what gets imported from the target's backlog, so a
  run works on the current goal. In `components`/`pages`, CSS tokens, i18n, CLS,
  perf/bundle, analytics/GTM, SEO and a11y contrast are **deferred, not filed**
  (listed as deferred so nothing is silently dropped). (`migration-orchestrator`,
  `triager`)

### Changed

* **Reconcile hard-gates on the plan.** The orchestrator must verify
  `<target.dir>/.parity/migration-plan.json` exists before `porting`/`triage`,
  classify every page's readiness, and report `parity plan status` to the user
  before doing any work. Backlog import is now stage-filtered instead of
  wholesale. (`migration-orchestrator`)
* **`triager` is stage- and platform-scoped.** Runs only the checks the stage
  allows, returns a `deferred` list for the rest, refuses to survey when the plan
  is absent (returns one critical issue instead of lint findings), and skips the
  deco-fresh-only checks (`.deco/blocks/`, `.deco/sections.gen.ts`) on
  `faststore-v4` where those paths do not exist. Missing-section detection now
  matches by concept and distinguishes `partial` from missing. (`triager`)

## [0.25.1] — 2026-08-20

### Fixed

* **FastStore v4 target skill: Content Platform, not legacy Headless CMS.** The
  `target-faststore-v4` skill (and the orchestrator's discovery blurb) only knew
  the legacy `faststore cms-sync` → Headless CMS flow. On FastStore v4 today
  Headless CMS is LEGACY; the current content path is the **Content Platform**
  (`vtex content` / `yarn cms:content` to upload schemas), and real content
  previews locally via **`/api/preview`** against a CP branch. Corrected both
  files to lead with CP (legacy path kept, labeled), and clarified that
  `faststore dev` runs locally with **no** account access — only real CONTENT
  needs the account, not the app. Fixes misleading "faststore needs cms-sync to
  render" guidance. (Skill/knowledge only; `porter`/`triager` inherit it via
  `target_skill_path` — no agent change.)

## [0.25.0] — 2026-08-20

### Added

* **Stacked-PR fix mode (`budget.stackPrs`).** The `fix` phase can now chain fix
  PRs instead of merging them: each fix branches off the PREVIOUS fix's branch
  (`fixer` takes a `base_branch` and opens the PR with `gh pr create --base`), so
  the **top of the stack accumulates every fix and its per-PR preview deploy
  shows all fixes together** — one combined preview to review before landing
  anything. Nothing is merged; a new `stack-review` terminal reports the ordered
  stack + the top PR's preview URL and hands off (merge bottom-up, delete
  branches last). Default stays **merge mode** (independent PRs off `main`, one
  at a time, with the `fix → parity` re-score loop). Set at `discovery` when the
  user asks to stack fixes / see one preview with all fixes / not auto-merge.
  Orchestration-only change — no CLI behavior change (version kept in lockstep).

## [0.24.0] — 2026-08-20

### Added

* **Live-capture sanitization (`sanitizeDetectedComponents`).** `parity migrate`
  against a live-only site (no source repo — e.g. a VTEX IO storefront) used to
  emit DOM plumbing as migratable components: `main-wrapper`, `portal-root`,
  `overlay-container`, `modal-overlay`/`modal-dialog`, plus a separate row for
  every spelling of the same shell (`header` + `site-header`; `navigation-menu` +
  `main-navigation` + `navigation-mega-menu`; `footer` + `site-footer` +
  `footer-content`). A post-detect pass now (1) drops roles built entirely from
  structural-wrapper tokens and (2) canonicalizes global synonyms to one
  `header`/`nav`/`footer` each — so `isGlobalRole` scopes them correctly and the
  plan stops listing ~11 phantom/duplicate components. Content in a wrapper
  (`newsletter-modal`, `product-hero`) is preserved; only all-structural roles
  are dropped. Runs for both the heuristic and the LLM-refine path.

### Changed

* **Orchestrator: reconcile-only mode when the target already exists.** When
  `scout` classifies the repo the user points at as an already-scaffolded
  `faststore-v4`/`tanstack-deco` target, `repo-setup`/`template-bootstrap` are
  now explicitly skipped (re-scaffolding would clobber real work) and the source
  is the legacy live site. (`skills/migration-orchestrator`)
* **Discovery: never use the target's own staging as the parity `prod`.**
  `find-prod-url` now rejects `*.vtex.app`/`*.myvtex.com`/`*.deco.site`/
  `*.workers.dev` hosts (that's the candidate, not the legacy source), scans
  `.env(.example)` for a legacy-gateway URL, and flags locale/currency/country
  config that disagrees with the live host's market. Reconcile guidance now
  says to match plan rows to target sections by CONCEPT, not just string, so a
  mature target isn't misread as ~2 done / 25 pending. (`skills/migration-discovery`)

## [Unreleased]

### Added

* **Deco page-discovery fallback.** When a site ships no `/sitemap.xml` (404) — common on deco storefronts — `resolveSitemapUrls` falls back to the deco pages loader (`/live/invoke/website/loaders/pages.ts`) to discover CMS-configured content pages instead of collapsing to just the home page. Page-discovery callers (vitals/run/cache/benchmark) get it automatically; the SEO audit opts out (`decoFallback: false`) so it still sees — and reports — the true sitemap state. (#264)
* **SEO absolute-gap insights** in `seo-deep-audit`, surfaced even when prod and cand share the gap (a migration is the moment to fix): `seo:sitemap-absent` (neither side serves `/sitemap.xml`), `seo:robots-no-sitemap-directive` (robots.txt declares no `Sitemap:`), `seo:llms-txt-absent` (no `/llms.txt` manifest for AI crawlers). SPA `index.html` fallbacks served for these routes are correctly treated as absent, not present. (#264)

### Changed

* **`parity vitals` now measures via Lighthouse by default** (Slow 4G + 4× CPU throttle), so its numbers match PageSpeed instead of the optimistic warm Playwright collector — the root cause of "run says 100 but PageSpeed fails". Runs in two ordered phases: a fast parallel Playwright pass (HTML/cache/network structure) then a low-concurrency Lighthouse pass (Lighthouse *measures* CPU, so parallel runs contend and inflate results). `--no-lighthouse` restores the fast unthrottled collector for iteration; `--lighthouse-concurrency <n>` tunes the cap (default cores/2, capped 2). (#264)
* **Lighthouse category scores.** `parity vitals` (Lighthouse mode) now runs `accessibility`, `best-practices` and `seo` alongside `performance` (same run, cheap static audits) and surfaces all four as 0–100 PageSpeed-style chips (prod vs cand) in the Vitals tab + `report.json` `lhScores` + `vitals.json` `scores`. Previously it captured performance only. (#264)
* **`lighthouse-scores` check — parity-or-better on every category.** Flags when a cand Lighthouse category score drops below prod (beyond 3-point jitter), not just performance — e.g. accessibility 90→76. Enforces the migration goal of equal-or-better across performance/accessibility/best-practices/seo. New `a11y` issue category. (#264)
* **Vitals report polish.** Category scores now render as PageSpeed-style SVG ring gauges (cand as the gauge, `prod N · ▲/▼Δ` beneath so "equal or better" reads at a glance), matching the benchmark report's visual language. (#264)
* **`agentic-nav` check + "Navegação agêntica" report panel.** A composite mirroring PageSpeed's in-development category: (1) agent accessibility — Lighthouse accessibility-tree audits an AI agent relies on (`button-name`, `link-name`, `label`, `image-alt`, `aria-*`), with failing elements listed; (2) llms.txt quality — a well-formed `/llms.txt` per llmstxt.org (H1 + sections/links; SPA HTML fallbacks rejected). Renders a passed/total tally + per-pillar detail in the Vitals tab. (#264)
* **Lighthouse opportunities are now preserved and surfaced.** The actionable audits Lighthouse already computes (render-blocking, unused JS, oversized images, lazy LCP…) are deduped across cand pages, persisted on each `PageCapture.lhOpportunities` + in `vitals.json`, and rendered in the report's Vitals tab (biggest savings first) — reaching both the user and the `perf-optimizer` agent. TBT is now carried on `WebVitals` and shown when present. (#264)

## [0.22.0] — 2026-08-19

### Added

* **`parity benchmark` — User Navigation Benchmark.** A client-facing before/after story for a Fresh→TanStack migration: a scout validates a PLP + PDP that work on **both** sites, each side warms the edge + browser cache (returning-visitor model), then a real journey (home → hamburger menu → PLP → paginate → PDP → product→product SPA shelf hop → optional colour-variant switch) is measured N× (median), timed by wall-clock from the click to the first product image rendering. Emits **one self-contained HTML report** (PT/EN, mobile/desktop tabs, per-page/per-technology pagination, scrollable full-page prints, an `(i)` methodology panel, and an error banner for broken steps) plus Lighthouse Web Vitals and a full HAR per side. (#219)
* **Reusable Lighthouse runner** (`src/engine/lighthouse.ts`) — real mobile/desktop devtools throttling with NO_FCP retry, extracted from the FARM Rio vitals spike. (#219)

## [0.21.0] — 2026-08-17

### Added

* **`parity migrate` now covers the whole store, not just the home page.** It samples extra pages per kind from the classified sitemap (`--sample`, default `plp=2,pdp=2,other=3,search=1`, capped at 15) — including **institutional** pages (`other`, which prefers real about/contact/policy URLs over deep categories) — and reads the **VTEX block tree + content on every captured page**, merged by treePath. On Electrolux this took the captured content from home-only to home + PLP + PDP + institutional (`store.home`/`store.product`/`store.search`). (#214)
* **Report organized per page.** `index.md` / `index.html` / `report.html` show a "Global components" section (captured once) plus one section per captured page — a single report separated by page. (#214)

### Fixed

* **Exact-duplicate VTEX blocks are collapsed** (a `product-summary` per product, repeated layout wrappers) into one representative with a `repeated` count, keeping distinct-content blocks — `blocks.json` went from 5242 to 883 on Electrolux without losing content. (#215)
* **`category-auto` no longer lands on an institutional page** (institutional keywords filtered from the PLP pick). (#214)

## [0.20.0] — 2026-08-17

### Added

* **`parity migrate` now captures the VTEX CMS content + all its images.** Each block's `props` (the merchant's registered content — banner images, texts, links, shelf config) is kept in `blocks.json`; content-image references (site-relative `/arquivos/ids/…`, `/img/…`) are resolved to absolute URLs, and the images — from block props **and** the Apollo `__STATE__` (product/catalog imagery) — are downloaded to `assets/content/` with a `content-assets.json` url→file map (up to 150/run). (#209, #211)
* **Quality pass:** robust logo capture (screenshots the element, so sprite `<use>` logos aren't blank), web-font download from `@font-face` (`assets/fonts/`), scroll-before-screenshot (lazy footers render), and a self-contained **`report.html`** (every image inlined) to share as a single link. (#209)

### Fixed

* **Header/footer are now detected on sites without semantic tags** (e.g. VTEX IO, which renders both as plain `<div>`s) via a geometry/anchor fallback that only fires when no `<header>`/`<footer>` matched. Shared by `extract` + `migrate`. (#212)
* **Theme election cleanups:** primary skips translucent overlays and considers opaque colors across all usages; breakpoints kept by frequency (real tiers, not 100+ media-query one-offs); background falls back to the most frequent opaque color; implausible motion durations dropped. (#209)
* Ignore `parity-migrate/` / `parity-extract/` output dirs so scraped store data can't be committed. (#210)

## [0.19.0] — 2026-08-17

### Added

* **`parity migrate` HTML visual report + `--open`.** A self-contained `index.html` (theme color swatches + tokens, per-viewport screenshots, brand assets, component table, VTEX IO → FastStore block map) written alongside `index.md`; `--open` launches it in the browser (same `open` package `parity run`/`audit` use). (#207)

### Fixed

* **`migrate` theme primary election skips translucent overlays.** Primary/secondary are now elected from the most frequent non-neutral, **opaque** color across all usages (text/border/bg + interactive) instead of interactive backgrounds only — a translucent hover overlay could otherwise win (e.g. Electrolux came out `rgba(123,138,156,0.24)` instead of the brand navy). (#206)

## [0.18.0] — 2026-08-17

### Added

* **`parity migrate` — phased, target-agnostic migration capture (new command).** Single-site (no prod×cand) pipeline that produces a token-lean, agent-ready bundle + prompt for migrating a live storefront to a new stack. Three resumable phases: **theme + assets** (color/typography/spacing/radii token election, breakpoints from `@media`, motion tokens, plus brand assets — logo/favicon/apple-touch/OG/manifest/fonts — downloaded **through the browser** to bypass Akamai/CF bot 403s, and an icon inventory); **sitemap** (browser-routed page discovery + classification); **components** (reusing `extract`'s detector, structural dedupe, deterministic **Tailwind IR** + raw-CSS fallback, light interaction hints via CSSOM, and suggested e2e selectors). Token economy is first-class (lean tier vs full `manifest.json`, `×N` collapse, per-component files). (#194)
* **`--target faststore` playbook + `custom-theme.scss`.** Appends a FastStore v4 playbook (CLI commands, doc links, section/CMS structure, Phosphor icons) and emits a deterministic `custom-theme.scss` mapping brand tokens → `--fs-*` global tokens. FastStore v4 styles with SCSS design tokens + `data-fs-*` (not Tailwind). (#196)
* **Multi-viewport theme + per-viewport site screenshots** (`--viewports mobile,desktop`). (#197)
* **VTEX IO block-tree source + deterministic FastStore mapper.** For VTEX IO stores, reads the real declarative block tree from `window.__RUNTIME__` → `blocks.json` + `component-map.json` (`product-summary→ProductCard`, custom blocks → `custom-component`). Verified live on storetheme.vtex.com. (#198)
* **Platform-aware PDP discovery** for `migrate` — Salesforce Commerce `.html`/`Product-Show` product pages, with an action-endpoint rejection guard (Wishlist-Add/Cart-Add never treated as a PDP). (#200)
* **`salesforce-commerce` (Demandware) platform detection**, checked before the loose `fs-`/`vtex-` class heuristics (fixes Sephora BR mis-detected as `vtex`). (#199)

### Fixed

* **403 hardening: `migrate` Phase 2 discovery routes through the browser** instead of a bare node fetch that bot-protected stores 403 (was silently degrading to home-only). (#195)
* **`--fail-on` now gates the exit code on its own (issue #178).** The blocking-issue exit-1 check was gated behind `--ci`, which had no other effect in the codebase — a run with double-digit criticals exited 0 unless the caller also remembered `--ci`, even though `--fail-on` (default `critical`) was already parsed and ready. The check now always runs; `--ci` has been removed as dead weight (`parity audit` never had it and always gated on `--fail-on` alone, which is the pattern `parity run` now follows too).
* **`--pages`/`--pages-file` scoping documented, and no longer silently disable visual-diff in no-LLM environments (issue #178).** These flags only ever scoped the visual-diff/vitals-extra-pages passes, never the `flows` crawl — now documented in `--help`/`docs/cli.md`, and `parity run` prints a one-line warning when both an explicit page list and a flows crawl are active. Separately, `applySmartDefaults` (issue #71) used to force `noVisualDiff = true` whenever no LLM provider was configured, even when `--pages`/`--pages-file` was explicitly set — making the flag silently inert. Explicit page selection now still gets the prod/cand screenshot + pixelmatch heatmap capture without an LLM verdict.
* **`banner-aspect-ratio` no longer double-counts carousel boundary clones (issue #178).** Images marked `aria-hidden="true"` or `data-slider-clone` (or nested inside such a wrapper) — the decorative clones a hydration-safe infinite carousel renders at its boundaries — are now excluded from the banner census in `src/diff/dom.ts`, which previously produced false "candidate has N extra banners" findings.
* **`lazy-section-presence` no longer reports a spurious "missing: render" on every page of a TanStack Start site (issue #178).** The last-path-segment fallback in `extractSectionIds` (used when a lazy-render network entry has no `x-deco-section` header) now ignores known infra/admin route names (`render`, `meta`, `invoke`) that carry no real section-identifying information as a bare fallback id.
* **Visual-diff LLM prompt now hedges on small-text/count reads (issue #178).** Numeric counts and small text read off a (possibly downscaled) full-page screenshot were occasionally misread by the vision model and reported as confident high-severity regressions. The prompt now caps such claims at `low` severity and requires an explicit hedge in the description; `LLM_PROMPT_VERSION` bumped to invalidate cached verdicts from the old prompt.
* **`--vitals-pages` noise/scoping trade-off surfaced in `--help`/`docs/cli.md` (issue #178).** `--vitals-pages 0` can dramatically cut unrelated auto-sampled noise (one run went from 53 to 13 `high` findings) but was previously discoverable only by reading source — now called out in both the flag's help text and a `docs/cli.md` callout.

## [0.17.3](https://github.com/decocms/parity/compare/v0.17.2...v0.17.3) (2026-07-28)

### Fixed

* **`open-minicart` fallback click when already-open drawer is empty (issue #159).** Sites that use a react-query on-demand cart (query `enabled` only when a cart-intent signal is `true`) never hydrate the drawer when it opens via an add-to-cart toast side-effect — the intent signal is only set on an explicit cart-icon click, so the panel renders empty and `validateCartContainsTitle` finds 0 items. When `cartOpenMethod === "already-open"` and validation returns `found=false`, parity now looks up the `minicartTrigger` and clicks it explicitly (mirroring what the user does), waits for cart hydration, then re-validates. The fallback is skipped entirely when the drawer hydrates normally via the initial validation.

## [0.17.0](https://github.com/decocms/parity/compare/v0.16.0...v0.17.0) (2026-07-28)

### Added

* **`open-minicart`/`add-to-cart` reveal-failure diagnostics fed to LLM recovery.** A poll-based step (waiting for the minicart drawer or an add-to-cart confirmation to appear) previously reported a bare "not found"/"no signal" on timeout, with no evidence of *why*. Failed polls now attach a structured `diagnostics` object to the step (`timedOut`, `budgetMs`, `elapsedMs`, `pollCount`, and a per-selector `probes` snapshot distinguishing "present in the DOM but stayed hidden" from "never matched at all") — surfaced in `report.json` and rendered in the HTML report's step cell. When `open-minicart` fails with this evidence available, parity now spends one LLM recovery attempt passing the diagnostics as concrete context (`RecoverInput.diagnostics`) instead of a bare failure, and the recovery prompt is told not to re-suggest a selector already confirmed present-but-hidden.
* New `cartRevealTimeoutMs` (issue #149 follow-up) tunes how long `waitForCartReveal` polls for the drawer before giving up. Defaults to 4000ms (8000ms on localhost dev servers, which are slower).

### Fixed

* **`waitForCartReveal` polls instead of snapshotting once.** `openMinicart`'s reveal check (via `isCartRevealed`/Playwright `isVisible()`) was a one-shot read of the drawer's *current* state right after a fixed wait, not an actual wait. Drawers that reveal asynchronously — a CSS `allow-discrete` visibility/opacity transition, a data-gated render (react-query cart), or a slow click handler — can stay `visibility:hidden` (often positioned off-screen) for well over a second after the click, so the single snapshot landed inside the hidden window and wrongly reported the cart never opened, even with the correct selector, no overlay, and no console error. `openMinicart` now polls every 200ms up to an adaptive budget instead.
* **`open-minicart` re-checks for a blocking overlay before giving up.** `dismissOverlays` only ran once at the very top of `openMinicart`, before the trigger was clicked. Confirmed live against a production deploy: a newsletter popup can appear *after* the add-to-cart click and silently intercept the minicart-trigger click (`force: true` clicks whatever is topmost at the coordinates, not necessarily the intended target), so the drawer never opens even though the selector and reveal-polling logic are both correct. `openMinicart` now detects this structurally (mirroring `dismissBlockingOverlay`, issues #145/#146) and retries the click once after clearing it.

## [0.16.0](https://github.com/decocms/parity/compare/v0.15.1...v0.16.0) (2026-07-28)

### Added

* **Configurable `minicartPanel` selector for open-minicart reveal detection (issue #149).** `isCartUiVisible` and the title-scope sweep in `validateCartContainsTitleQuick` used a hardcoded list of name-based patterns (`[role='dialog']`, `[class*='minicart']`, etc.) to detect that the cart drawer was open. Any site built with utility-CSS (Tailwind) and `data-qa-*` testing attributes — a common modern stack — has no class/attribute those patterns can match, so detection always returns `null` and the step reports "failed" even when the drawer is genuinely open. The new `minicartPanel` selector key (`.parityrc.json`) is tried first, ahead of all hardcoded patterns. Built-in defaults cover `[data-qa-minicart]`, `[data-minicart]`, `[data-minicart-drawer]`, `[data-testid='minicart']` and common class patterns — so the `data-qa-*` case is handled out-of-the-box. Override with a single selector that matches the drawer root for your specific site.

### Fixed

* **`dismissOverlays` stall in `openMinicart` (issue #151).** The named-selector sweep inside `dismissOverlays` used a 400ms per-selector cap; with 12+ selectors none of which match, that's ~5s minimum before `openMinicart` could proceed — and on heavy pages the CDP calls could stall much longer, causing 50-100s gaps with zero debug output. Fixed by: (1) tightening the per-selector probe to 80ms (fast-failing `count()=0` before any `isVisible` call), (2) adding `dlog` at the entry of `dismissOverlays` and `openMinicart` so slow sweeps show up in `DEBUG_PARITY=1` output, and (3) wrapping the `dismissOverlays` call inside `openMinicart` with a 4s hard cap so it degrades gracefully instead of silently consuming the step budget.

## [0.15.0](https://github.com/decocms/parity/compare/v0.14.0...v0.15.0) (2026-07-27)

### Added

* **Structural overlay interception detection + configurable overlay selectors (issues #145, #146).** A "no-signal" add-to-cart failure is often not a broken cart but a newsletter/discount modal intercepting the click — classically one that pops on the very `mousemove` Playwright's `.click()` dispatches, in a cookie-less session (e.g. a `div.fixed bg-black/50 z-9999` backdrop over the buy button). Instead of name-matching every popup shape (whack-a-mole), parity now detects interception **structurally**: before retrying, it checks whether the buy button is still the topmost element at its click point (`document.elementFromPoint`) and, if something covers it, dismisses it least-destructive-first — Escape → a named close button → an icon/geometry close control inside the overlay (catches unnamed `<button><svg/></button>` X's) → a corner backdrop click → and, guarded, hiding the confirmed interceptor as a last resort (never an ancestor of the target, and it can't fake success — the step still needs a real confirmation signal) — then retries once. What was detected/dismissed is recorded in the step's `detail.overlayDismissed` and surfaced in the action text, so a report shows *why* a click was intercepted even when dismissal succeeded. Separately, `.parityrc.json` `overlaySelectors` adds explicit site-specific overlay selectors, merged with the built-in cookie/toast/newsletter defaults (never replacing them), as a fast-path override.

## [0.14.0](https://github.com/decocms/parity/compare/v0.13.0...v0.14.0) (2026-07-27)

### Added

* **Configurable add-to-cart confirmation deadline (issue #143).** The purchase-journey / `e2e` add-to-cart step polled a hardcoded 3000ms for a success signal (URL→cart, minicart count increase, drawer open, success toast). On sites whose success toast is short-lived, or with slow TTFB / popup overlays, that could race the deadline and report a false "no signal" failure on an add-to-cart that actually worked. Now tunable via `.parityrc.json` `addToCartConfirmMs` or `--add-to-cart-timeout <ms>` (on `parity run` and `parity e2e`); a non-positive/NaN override is ignored and falls back to the 3000ms default.

## [0.13.0](https://github.com/decocms/parity/compare/v0.12.0...v0.13.0) (2026-07-27)

### Added

* **`parity e2e` now automates selectors like `parity run` (issue #141).** Single-site runs previously saw only `DEFAULT_SELECTORS` + hand-written `.parityrc.json` — `e2e` never detected the platform, never ran LLM selector discovery, and never learned from its flow runs (so `learned-selectors.json`, keyed by platform, never applied). It now detects the platform, runs the same grounded LLM discovery + live-validation pass, threads the platform into every flow, and promotes selectors learned from real successful interactions. New flags mirror `run`: `--no-auto-selectors`, `--refresh-selectors`, `--no-learn`. The discovery pass is now shared code (`src/engine/selector-discovery-pass.ts`) used by both commands.
* **Discovery covers the journey variant/quantity keys.** LLM selector discovery now infers `variantRow`, `quantityIncrement`, `quantityInput`, `sizeSwatch`, and `colorSwatch` (grounded on the real PDP and live-validated) — exactly the keys single-site users kept hand-writing in `.parityrc.json`.

### Fixed

* **`purchase-journey-flow` now works in single-site mode.** The check was comparison-only: with no prod baseline it emitted a spurious "prod não produziu captura" issue per viewport instead of evaluating the journey. It now has a single-site branch (prod slot empty) that fails on a failed step or a skipped *critical* step, evaluating the checkout journey on its own terms — while still keeping the "cand crashed" critical signal for real prod↔cand comparisons.

### Changed

* **`parity run` without `--prod` now points you at `parity e2e`.** `--prod` is no longer a hard `requiredOption`; omitting it exits with code 2 and a hint to use `parity e2e --url <cand>` for single-site validation, instead of forcing a wasteful `--prod X --cand X` self-comparison (issue #141).

## [0.12.0](https://github.com/decocms/parity/compare/v0.11.17...v0.12.0) (2026-07-27)

### Known issues

* **A full `parity run` (multiple viewports/sides concurrently) has been observed to hang indefinitely in at least one resource-constrained sandboxed environment**, after selector discovery's own throwaway browser launch+close already succeeded. Isolated components (`launchBrowser`, `capturePage`, `parity journey`, sequential/concurrent browser launches) all completed correctly in the same environment, so this reads as environment resource contention rather than a confirmed code defect — but it was not fully root-caused. If a run seems stuck at "Launching browser…", try `--max-viewport-concurrency 1` or a narrower `--only`/`--viewports` scope, and please report reproduction steps.

### Fixed

* **The health score was stuck at 0 on every real run — now it actually rises as you fix issues.** The old formula (`100 - crit·20 - high·8 - med·3 - low·1`) had no dynamic range for real workloads: 13 high issues alone zeroed it, and checks emit one issue per occurrence (per page × viewport, per robots.txt user-agent, per broken link), so mid-migration runs carry 40–120 issues. Empirical evidence: across 15 real runs of the granadobr migration, issues fell 122 → 39 (criticals 18 → 0) and the score sat at **0 the entire time**. The new formula (score v2) normalizes the severity-weighted penalty by the number of analyzed page-pairs and applies exponential decay — `round(100·e^(-density/35))` — so the same 15 runs now read **20 → 7 (regression caught) → 35**, moving with every fix. Any FAIL verdict (critical issue or failed check) caps the score at 79 so "FAIL · score 91" can't happen. Status logic (pass/warn/fail), `--fail-on`, and exit codes are unchanged. Verdicts now carry `scoreVersion: 2` and `pagesAnalyzed`.

### Added

* **Score trend vs previous run.** `parity run` now records `previousRun: { id, timestamp, score, scoreDelta }` in `report.json` (most recent non-partial run against the same prod/cand host pair and same scoreVersion) and surfaces the delta in the CLI summary (`score 64/100 (+23 vs run anterior)`), the HTML dashboard (chip under the health ring), and the `parity pr` Markdown comment (header + score-trend line).
* **Root-cause grouping in issue displays.** New display-only grouper (`src/report/group-issues.ts`) collapses issues that share check + severity + normalized summary (paths/URLs/viewports/digits stripped), so "description ausente" on 10 pages reads as one row with an affected-pages note instead of 10 near-identical rows. Applied to the HTML Top issues card, the CLI Top issues list, and the PR comment. Issue IDs and baselines are untouched.
* **Module selection: `--only`/`--skip`/`--why`.** `parity run` now groups its ~30 checks into 8 named modules (`e2e`, `seo`, `visual`, `vitals`, `cache`, `console`, `html`, `network`). Scope a run with `--only e2e,seo` (or single-check granularity via `check:<name>`), subtract with `--skip`; unselected flows/sitemap-crawl/visual-diff passes are skipped entirely rather than run-and-discarded, making scoped runs genuinely lighter and faster. `--why <text>` records the scoping rationale in `report.json`. No selection at all = full back-compat (every check runs, exactly like before). `parity list modules [--json]` discovers the taxonomy programmatically. A TTY with no explicit selection shows an interactive prompt; non-TTY just gets a one-line heads-up and proceeds with everything.
* **Adaptive, per-module scoring.** The verdict score now reflects only the modules that ran: `--only e2e` scores purely on e2e; `--only e2e,seo` blends both, weighted by pages actually analyzed per module. `report.json` carries the full breakdown (`moduleVerdicts`), `verdict.modulesRun` lists contributing modules, and score-trend comparisons only match runs that scored the *same* module set.
* **Cart interactions overhauled.** Multi-item add + validation (`add-second-item`/`validate-multi-item`), cart persistence across reload (`verify-cart-persistence`), direct quantity input (`set-qty-input`), configurable coupon codes (`rc.coupon`) with an opt-in valid-coupon assertion (`apply-valid-coupon`), and a VTEX-only informational probe (`seller-code-null`, issue: typing the literal string `"null"` into a seller-code field is accepted by VTEX and resolves the seller itself) — always `ok`/`skipped`, never fails the run.
* **Interactive PLP pagination.** The `plp` flow now drives pagination like a user would — clicking a next-page link, clicking "load more", or scrolling — instead of only fetch-probing `?page=N`. Catches load-more/infinite-scroll sites the old fetch-only check couldn't, while keeping the fetch probe as a fallback for classic paginated PLPs.
* **New checks:** `pdp-breadcrumbs` (breadcrumb trail or JSON-LD `BreadcrumbList` still renders), `plp-sorting` (a sort query param actually reorders products), `spa-navigation-flow` (F5 vs client-side `<Link>` navigation — catches CMS sections/site-globals silently dropping on SPA nav, a real bug class from a production Fresh→TanStack migration post-mortem), `serverfn-hover-flood` (hovering product cards shouldn't flood the worker with more than a configurable budget of server-fn/preload requests).
* **Selector discovery v2.** Discovery now sees up to 3 labeled HTML sources (home + PLP + PDP) instead of home alone, so PDP-only and PLP-only selector keys are grounded in the page they actually live on. The model also flags low-confidence guesses (`low_confidence_keys`). A live-validation pass (`page.locator(sel).count() > 0`) runs before a selector is trusted or promoted to the learned-selectors library — a selector that validates AND wasn't flagged low-confidence is promoted directly as `origin: "verified"`; one that fails validation is dropped from the run entirely rather than silently misfiring later. `parity learned validate --url <url>` exposes this as a standalone diagnostic. Selector cache gained TTL + structural-fingerprint invalidation (previously cached forever until manually refreshed).
* **`parity extract`** — a new single-site command (no prod×cand comparison) that captures AI-ready structured data about a site's UI components (header, footer, nav, shelves, hero, minicart, …) for migrations where there's no source code to read: HTML, computed styles, cropped screenshots, asset/link inventories. Heuristic component auto-detection (semantic markup + Deco `data-section` convention + geometry, with an optional LLM relabeling pass) plus pluggable exporters (Markdown for pasting into an agent's context, JSON manifest).

### Changed

* **`computeVerdict` is now a single shared module** (`src/engine/verdict.ts`) — `run.ts`, `vitals.ts`, and `cache.ts` previously carried three drifting copies.
* **`src/engine/flows.ts` (3.9k lines) split into `src/engine/flows/`** (one file per flow + shared helpers) — no behavior change, just a maintainability split ahead of the M2 feature work above.
* Learned-selectors gained a lifecycle: entries now carry `origin: "verified" | "llm-guess"`, staleness decay based on `lastValidated` (previously stored but never read), and verified-first ranking.

### Fixed

* **`lazy-section-presence` false positive for Fresh→TanStack/Vite chunk naming** (issue #118) — Fresh names a lazy-loaded section chunk `render`, Vite names the same chunk `render.ts`; the check now strips bundler extensions before comparing, so it stops reporting a false "missing section" on every page with lazy sections.

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
