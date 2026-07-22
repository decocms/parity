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

- [x] Zero bugs abertos: #118 (lazy-section false positive) e nota travada em 0 (#116) fechados
- [ ] Todos os checks verdes ponta-a-ponta em **2 migrações de referência reais** (Fresh → TanStack)
- [ ] `--only/--skip` + score por módulo shipped e documentados
- [x] Cache de seletores com invalidação (TTL + fingerprint) shipped — validação ao vivo fica no M4
- [x] E2E novo rodando: carrinho multi-item, cupom válido/inválido configurável, seller-null (VTEX, informativo), paginação interativa (page-link / load-more / infinite-scroll), persistência do carrinho
- [ ] Flow `spa-navigation` + budget de `_serverFn`/preload (M2.5, #54) — fast-follow antes do M6
- [ ] `parity extract` gerando bundle usável em **3 lojas reais**
- [ ] Docs atualizadas: `cli.md`, `checks.md`, `config.md` + novos `modules.md`, `extract.md`
- [ ] Suíte vitest verde; schema do report/JSONL documentado como estável (política additive-only)

## Milestones

| Milestone | Versão | Escopo | Status |
| --- | --- | --- | --- |
| **M1 Estabilizar** | 0.12.x | Merge #116 (score v2) · fix #118 · invalidação do cache de seletores (TTL 7d + fingerprint estrutural + zod) · merge de TODAS as chaves descobertas (bug: 7 de ~14 eram descartadas) · dedupe da compaction HTML (`html-compact.ts`) · ciclo de vida learned-selectors (`origin: verified/llm-guess`, staleness por `lastValidated`) | ✅ concluído |
| **M2 E2E completo** | 0.13.x | Split de `flows.ts` (3.9k linhas → `src/engine/flows/`) · robustez (waitForCartMutation, selectVariant no seed) · **multi-item no carrinho** · **cupom configurável** (`rc.coupon`, passo `apply-valid-coupon`) · **seller "null" VTEX via UI** (informativo, nunca bloqueia) · **paginação interativa** (3 modos, check híbrido com fallback fetch) · `verify-cart-persistence` · `set-qty-input` · `pdp-breadcrumbs` · `plp-sorting` | ✅ concluído |
| **M2.5 SPA-nav (fast-follow, #54)** | 0.13.x | **Flow `spa-navigation`** (F5 vs navegação client-side `<Link>` — diff de DOM/sections + console, pega globals sumindo e hydration mismatch só-SPA) · **check de flood `_serverFn`/preload** (budget de requests por hover). Escopados na auditoria de issues mas não entraram no corpo principal do M2 — ficam como próximo passo antes do M6. | ⬜ |
| **M3 Seleção + score** | 0.14.x | Registry de módulos (`e2e, seo, visual, vitals, cache, console, html, network`) · `parity run --only/--skip/--why` · prompt interativo checkbox no TTY · presets module-aware · score v2 **por módulo** + composto (nota reflete só o que rodou) · trend só entre runs comparáveis · `parity list modules --json` | ⬜ |
| **M4 Descoberta v2** | 0.15.x | Descoberta multi-página (home+PLP+PDP) · confidence por chave · few-shots por plataforma · **validação ao vivo** dos seletores antes de cachear · `parity learned --validate` | ⬜ |
| **M5 Extract** | 0.16.x | `parity extract`: evolução da máquina de `parity section`/`fix` para extração single-site — detecção automática de componentes (header/footer/nav/shelf/…), HTML + computed styles + screenshots + CSS source + **assets/links/textos**, exporters plugáveis (markdown p/ agentes de migração + JSON manifest) | ⬜ |
| **M6 Release** | 1.0.0 | Matriz completa nas migrações de referência · freeze de flags · docs · CHANGELOG · publish npm | ⬜ |

## Aprendizados das issues (auditoria jul/2026)

Varredura de todas as issues (abertas e fechadas) atrás de pistas de bugs e
melhorias ainda não endereçadas:

- **#54 (Bagaggio post-mortem)** — a fonte mais rica: 6 classes de bugs que o
  parity não pegou. Incorporado ao M2: flow `spa-navigation` (prioridade
  máxima segundo a própria issue) e budget de `_serverFn`/preload. Já coberto
  desde então: `picture-missing-dims` (CLS de `<img>` sem dims), classificação
  de console hydration. **Pós-1.0**: debug bridge (`window.__DECO_DEBUG__`,
  depende de suporte no deco-start), diff pre/post-hydrate completo,
  atribuição de CLS por elemento, cenário de pressão de memória (worker OOM).
- **#102** — tier de modelo importa: selector-discovery/step-recovery em Haiku
  regrediu a jornada; ficaram em Sonnet. O M4 (descoberta v2) mantém Sonnet e
  mede antes de qualquer downgrade de custo.
- **#100** — dashboard dizia "3/3 completed" quando a jornada abortou no passo
  3\. Verificar na 1.0 que todo aborto precoce fica explícito no report.
- **#53** — runs isolados por flow com saída estruturada: é exatamente o M3
  (`--only`), validando a direção.
- **#12 / #47 / #46 / #40 / #22** — falsos positivos históricos (session quirk
  VTEX, cart-reveal unknown, eager rendering, pixels async, carousel) já
  tratados; padrão a manter: todo check novo do M2 nasce com fixture de falso
  positivo no teste.

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
