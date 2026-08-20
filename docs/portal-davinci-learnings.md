# Portal-davinci run — learnings & architecture decision

First real end-to-end migration of a **deco-fresh content site** (no commerce)
through the parity orchestrator, `deco-sites/portal-davinci` →
`deco-sites/portaldavinci-tanstack`. It became a stress-test of the whole plugin.
26 gaps filed (#233–#265). This doc synthesizes what we learned and proposes how
to evolve the agents + parity.

## Outcome
- Migration code: **0 real criticals**, TanStack build green, deployed to CF Workers.
- Parity (localhost & prod): console/cache/e2e/network **100**, visual **92**, CLS ~0.
- PageSpeed mobile **87** (FCP 1.5s, LCP 2.4s, CLS 0.001) after the perf pass.
- Remaining deltas are prod anomalies (prod is `noindex` test-mode) or parity
  measurement gaps, not migration bugs.

## What we learned, by theme

### 1. Migration mechanics (one-time deco-migrate / template bugs)
Fixes belong in `deco-migrate` (blocks-cli) or the orchestrator `migrate-script` phase:
- #234 `bun run predev` fails on deco-fresh (no package.json)
- #235 template emits `css/fonts/meta/previewWrapper` not in `SiteSetupOptions`
- #236 `bun run generate` must run before typecheck
- #238 `wrangler.jsonc` ships invalid `dev-sites-kv` placeholder
- #239 routes generate `siteName` with capital → CMS lookup returns empty (blank SSR)
- #249 `//` line comments inside `useScript` fns break after minification (fatal)
- #250 migrate must preserve `Secret` blocks encrypted, not inline plaintext
- #253 generate `public/_headers` (immutable `/assets/*`)

### 2. Rendering strategy = the biggest perf lever (content sites)
- CMS `Lazy` wrapper + `respectCmsLazy:true` deferred EVERYTHING → blank no-JS
  render + CLS 0.92. Fix: `setAsyncRenderingConfig({ respectCmsLazy:false,
  foldThreshold:Infinity })` → SSR-everything for a light content site.
- **SEO/speed/correctness are one decision, gated by SEO** (spa-strategist): a
  content site whose value is organic search should SSR everything; async render
  only pays off for heavy below-fold + `botAwareSeo:on`.
- Deferred section without a `LoadingFallback` = blank + CLS (#245).

### 3. Navigation & prefetch
- Content nav ≠ commerce nav. Right pattern for content = **`<a>` + Speculation
  Rules** (SSR + SEO + no-JS intact, instant nav, one call) — NOT client `<Link>` SPA.
- Speculation-rules injection must fire on `load` (not parse) or it races React
  hydration → #418.
- Deco dropdowns open on **click**, not hover — matters for benchmark reveal (#259).
- `<a href="#anchor">` to a non-existent id = pre-existing broken nav (#247).

### 4. Performance transform catalog (the reusable knowledge)
Each is a detect→transform pair, applicable to any migrated site:
| Symptom (Lighthouse/PageSpeed) | Transform |
|---|---|
| render-blocking webfont | async font (`media=print`→`onload`), keep `display=swap` |
| LCP image `loading=lazy` / no fetchpriority | first hero/banner eager + fetchpriority=high |
| eager 3rd-party embed (YouTube/Vimeo) | facade: thumbnail + click→iframe |
| heavy below-fold embed (Maps/chat) | `IntersectionObserver` defer-until-visible |
| oversized image (thumb 480 shown at 305) | right-size (YouTube mqdefault, responsive srcset) |
| hashed assets `max-age=0` | `public/_headers` immutable |
| deferred section, no skeleton | `LoadingFallback` sized to prod (fallbacker) |

### 5. Parity measurement is only fair when strategy-aware
- Element-count / timing compare deferred-prod vs SSR-cand at a snapshot →
  false "cand slower" (#252). Benchmark nav must time to **FCP**, not networkidle.
- Modules/flows/CEP are commerce-shaped; a content site has no plp/pdp/cep
  (#254, #255). Needs a **site profile** that scopes checks + journey + benchmark.
- Parity runs Lighthouse but **throws away the opportunities** (#264) — the most
  actionable data. Surfacing them is the highest-leverage parity change.
- No no-JS test (#244), no favicon/font/nav validation (#240/#241/#247).

## Architecture decision: improve existing vs new

**Do BOTH, with clear roles. Three tracks:**

### Track A — Parity: surface what Lighthouse already computes (ENABLER, do first)
`#264` is the keystone: the vitals module must extract Lighthouse
`audits`/opportunities (render-block, lcp-lazy, unused-js, third-party-summary,
uses-responsive-images, unused-preconnect…) and report them as issues, severity
by `overallSavingsMs`, prod-vs-cand diffed. Without this the perf agent is blind.
Plus the site-profile scoping (#254/#255) and no-JS test (#244).

### Track B — New agent: `perf-optimizer` (+ new `performance` phase)
Owns the **transform catalog** (section 4). Fed by Track A's opportunities +
static detection. Runs in a new `performance` phase (after `build-green`/`fallbacks`,
before `triage`): parity vitals → opportunities → perf-optimizer applies the
catalog → rebuild → re-measure. This is genuinely new work the current agents
don't cover (porter=port, builder=build, fixer=one issue, triager=find).
Complements the two narrow perf agents already built:
- `fallbacker` (CLS/skeletons) ✓ built this session
- `spa-strategist` (nav/prefetch/SEO/speed) ✓ built this session
- `perf-optimizer` (JS/image/font/LCP/cache) ← NEW

### Track C — Improve existing agents (static front line)
- `triager`: add static perf checks — LoadingFallback missing (#245), useScript
  `//` comments (#249), eager embeds (#265), dead template code (#243, done),
  broken anchors (#247). Cheap, pre-deploy, no browser.
- `reviewer`: JSON-only contract (#242, done).
- orchestrator `migrate-script`: fold in the mechanics fixes (Track 1).

## Recommended order
1. **Parity #264** (surface Lighthouse opportunities) — unblocks everything.
2. **`perf-optimizer` agent + `performance` phase** — turns opportunities into fixes.
3. **Site-profile** (#254/#255) — scopes modules/flows/benchmark by site type.
4. **triager static perf checks** (#245/#249/#265) — pre-deploy front line.
5. The deco-migrate mechanics bugs (Track 1) — hand to blocks-cli.
