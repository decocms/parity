# Roadmap → parity 1.0.0

> Artefato de tracking do release 1.0.0. Atualizado a cada milestone.
> Regra operacional: **nenhum milestone fecha com PR aberto**.

## Visão

O parity 1.0.0 é um **validador de migração dirigível por agente LLM**: o agente
(ou o dev) escolhe exatamente o que testar (`--only e2e,seo`), recebe uma saída
leve e machine-readable escopada ao que rodou, e uma **pontuação que reflete só
os módulos executados**. O teste end-to-end é o coração do produto: jornada de
compra, carrinho multi-item, cupom, paginação interativa e probes específicos
de plataforma (VTEX) — tudo com descoberta de seletores confiável e cacheada
com invalidação real.

## Critérios de release (gate da 1.0.0)

- [ ] Zero bugs abertos: #118 (lazy-section false positive) e nota travada em 0 (#116) fechados
- [ ] Todos os checks verdes ponta-a-ponta em **2 migrações de referência reais** (Fresh → TanStack)
- [ ] `--only/--skip` + score por módulo shipped e documentados
- [ ] Cache de seletores com invalidação (TTL + fingerprint) + validação ao vivo shipped
- [ ] E2E novo rodando: carrinho multi-item, cupom válido/inválido configurável, seller-null (VTEX, informativo), paginação interativa (page-link / load-more / infinite-scroll), persistência do carrinho
- [ ] `parity extract` gerando bundle usável em **3 lojas reais**
- [ ] Docs atualizadas: `cli.md`, `checks.md`, `config.md` + novos `modules.md`, `extract.md`
- [ ] Suíte vitest verde; schema do report/JSONL documentado como estável (política additive-only)

## Milestones

| Milestone | Versão | Escopo | Status |
| --- | --- | --- | --- |
| **M1 Estabilizar** | 0.12.x | Merge #116 (score v2) · fix #118 · invalidação do cache de seletores (TTL 7d + fingerprint estrutural + zod) · merge de TODAS as chaves descobertas (bug: 7 de ~14 eram descartadas) · dedupe da compaction HTML (`html-compact.ts`) · ciclo de vida learned-selectors (`origin: verified/llm-guess`, staleness por `lastValidated`) | 🚧 em andamento |
| **M2 E2E completo** | 0.13.x | Split de `flows.ts` (3.9k linhas → `src/engine/flows/`) · robustez (waitForCartMutation, selectVariant no seed, memoização de seletores) · **multi-item no carrinho** · **cupom configurável** (`rc.coupon`, passo `apply-valid-coupon`) · **seller "null" VTEX via UI** (informativo, nunca bloqueia) · **paginação interativa** (3 modos) · `verify-cart-persistence` · `pdp-breadcrumbs` · `plp-sorting` · `set-qty-input` | ⬜ |
| **M3 Seleção + score** | 0.14.x | Registry de módulos (`e2e, seo, visual, vitals, cache, console, html, network`) · `parity run --only/--skip/--why` · prompt interativo checkbox no TTY · presets module-aware · score v2 **por módulo** + composto (nota reflete só o que rodou) · trend só entre runs comparáveis · `parity list modules --json` | ⬜ |
| **M4 Descoberta v2** | 0.15.x | Descoberta multi-página (home+PLP+PDP) · confidence por chave · few-shots por plataforma · **validação ao vivo** dos seletores antes de cachear · `parity learned --validate` | ⬜ |
| **M5 Extract** | 0.16.x | `parity extract`: evolução da máquina de `parity section`/`fix` para extração single-site — detecção automática de componentes (header/footer/nav/shelf/…), HTML + computed styles + screenshots + CSS source + **assets/links/textos**, exporters plugáveis (markdown p/ agentes de migração + JSON manifest) | ⬜ |
| **M6 Release** | 1.0.0 | Matriz completa nas migrações de referência · freeze de flags · docs · CHANGELOG · publish npm | ⬜ |

## Non-goals da 1.0

- **Exporter Figma** — fica pós-1.0. A preparação é só arquitetural: exporters
  plugáveis (`ExtractExporter`) e o `ExtractBundle` já carregando bounding boxes,
  tokens de estilo, hierarquia e screenshots — Figma vira um arquivo novo
  (`exporters/figma.ts`) sem mudança no core.
- Seleção de módulos **obrigatória** em não-TTY (breaking; hoje sem seleção = roda tudo).
- Filtros de PLP (facets) e wishlist no e2e.
- Reports multi-idioma.

## Garantias de back-compat

- Sem `--only` = comportamento atual (todos os checks) — CI existente não quebra.
- `report.json`/JSONL: mudanças **aditivas apenas**; checks casam passos por `name`.
- `learned-selectors.json` auto-migra via zod defaults.
- `FlowName` inalterado; `flows.ts` vira shim de re-export após o split.
