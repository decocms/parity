# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
