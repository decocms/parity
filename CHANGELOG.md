# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

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
