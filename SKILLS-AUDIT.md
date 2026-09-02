# Skills Audit

Sources surveyed: `decocms/skills` (86), `decocms/blocks .agents/skills/` (6),
`decocms/blocks .cursor/skills/` (20), `decocms/storefront-skills` (24).

## Kept as skills (plugin entry points)

| Skill | File | Reason |
|---|---|---|
| migration-orchestrator | `skills/migration-orchestrator/SKILL.md` | Main entry point — phase machine |
| migration-discovery | `skills/migration-discovery/SKILL.md` | Phase: discovery + reconcile |
| parity-validation | `skills/parity-validation/SKILL.md` | Phase: parity measurement |
| issue-loop | `skills/issue-loop/SKILL.md` | Phase: triage + fix issue management |
| source-deco-fresh | `skills/source-deco-fresh/SKILL.md` | Source: what to expect in Fresh/Deno repos |
| source-vtex-io | `skills/source-vtex-io/SKILL.md` | Source: VTEX IO block trees |
| target-tanstack-deco | `skills/target-tanstack-deco/SKILL.md` | Target: TanStack + Deco CMS |
| target-faststore-v4 | `skills/target-faststore-v4/SKILL.md` | Target: FastStore v4 3-point invariant |
| stakeholder-report | `skills/stakeholder-report/SKILL.md` | Phase: reporting — deck / one-pager kit + evidence rules |

## Kept as knowledge references (load by explicit path)

| File | Source | When to load |
|---|---|---|
| `knowledge/tanstack/jsx-migration.md` | blocks .agents | Preact→React JSX |
| `knowledge/tanstack/react-hooks-patterns.md` | blocks .agents | Signal→state patterns |
| `knowledge/tanstack/search.md` | blocks .agents | Intelligent Search |
| `knowledge/tanstack/hydration-fixes.md` | blocks .agents (stub) | Hydration errors |
| `knowledge/tanstack/navigation.md` | blocks .agents (stub) | SPA nav |
| `knowledge/tanstack/typescript-fixes.md` | written locally | TS errors |
| `knowledge/vtex/invoke.md` | blocks .cursor | createServerFn, CORS |
| `knowledge/vtex/fetch-cache.md` | blocks .cursor | SWR VTEX cache |
| `knowledge/vtex/apps-porting.md` | written locally (from vtex-commerce.md) | Block→component map |
| `knowledge/vtex/cart.md` | written locally | useCart, CartSidebar |
| `knowledge/perf/render-location.md` | written locally | Small HTML, long TTFB; work resolved and discarded |
| `knowledge/perf/payload-trim.md` | written locally | Heavy HTML |
| `knowledge/perf/edge-caching.md` | written locally | Cache-Control |

## Dropped (out of scope for migration)

**Analytics/ClickHouse**: `clickhouse*`, `chdb*`, `deco-tool-clickhouse*` — infra monitoring, not migration.
**Observability**: `victoria-metrics`, `sli-slo*`, `system-health*`, `peon-ping*` — ops, not migration.
**Marketing**: `product-updates-*`, `deco-product-positioning`, `deco-brand-guidelines`, `deco-writing-style`, `deco-sales-pitch-*` — business content.
**Customer-specific**: `customer-osklen`, `osklen-jira`, `onedollarstats`, `montecarlo` — private.
**Meta**: `template`, `find-skills`, `unslopify`, `html-slide-designer`, `people` — tooling meta.
**Admin/Publish**: `decocms-admin-publishing`, `decocms-blog-posts`, `decocms-landing-pages`, `decocms-marketing-pages` — CMS authoring, not migration.
**Deployment ops**: `deco-site-deployment`, `deco-site-scaling-tuning`, `deco-site-memory-debugging` — post-migration ops.

## Deduped (same skill in 2+ sources → kept most recent)

`deco-to-tanstack-migration`: blocks .agents wins over decocms/skills (newer + more references).
`deco-vtex-fetch-cache`: blocks .cursor wins over decocms/skills.
`deco-server-functions-invoke`: blocks .cursor wins over decocms/skills.
`incident-report`: blocks .cursor dropped (deployment ops, out of scope).
