import { snapshotDom } from "../diff/dom.ts";
import type { Issue } from "../types/schema.ts";

/**
 * Audit SEO basics on a single page — no comparison baseline needed
 * because each rule is an absolute "this should exist" check.
 *
 * Reuses `snapshotDom().meta` for the meta extraction (cheerio-based).
 *
 * Rules:
 *   - <title> missing/empty                     → high   (worst SEO offender)
 *   - <title> < 10 chars or > 70 chars          → medium (truncation in SERPs)
 *   - <meta name="description"> missing/empty   → medium
 *   - description < 50 chars or > 160 chars     → low    (truncation in SERPs)
 *   - <link rel="canonical"> missing            → medium (duplicate-content risk)
 *   - <meta name="robots"> has "noindex"        → high   (unless explicitly desired)
 *   - <meta property="og:image"> missing        → medium (social previews break)
 *   - structured data (JSON-LD) ausente         → low    (lost rich results opportunity)
 */
export function auditSeo(pageKey: string, html: string): Issue[] {
  const out: Issue[] = [];
  if (!html) return out;
  const { meta } = snapshotDom(html);

  // 1. Title
  if (!meta.title || meta.title.length === 0) {
    out.push({
      id: `audit:seo:title-missing:${pageKey}`,
      severity: "high",
      category: "seo",
      page: pageKey,
      check: "audit-seo",
      summary: "<title> ausente ou vazio",
      details:
        "Página sem <title> aparece com fallback automático no Google (geralmente domínio + " +
        "path), reduzindo drasticamente o CTR. Ação: adicionar <title> único e descritivo " +
        "(<60 caracteres) em cada rota.",
    });
  } else if (meta.title.length < 10) {
    out.push({
      id: `audit:seo:title-short:${pageKey}`,
      severity: "medium",
      category: "seo",
      page: pageKey,
      check: "audit-seo",
      summary: `<title> muito curto: "${meta.title}" (${meta.title.length} chars)`,
      details: "Títulos < 10 chars perdem oportunidade de incluir palavras-chave + branding.",
    });
  } else if (meta.title.length > 70) {
    out.push({
      id: `audit:seo:title-long:${pageKey}`,
      severity: "low",
      category: "seo",
      page: pageKey,
      check: "audit-seo",
      summary: `<title> muito longo: ${meta.title.length} chars (Google trunca em ~60)`,
      details: `Título completo: "${meta.title}"\n\nGoogle trunca títulos com mais de ~60 chars dependendo do viewport. As palavras-chave principais devem estar nos primeiros 50 chars.`,
    });
  }

  // 2. Description
  if (!meta.description || meta.description.length === 0) {
    out.push({
      id: `audit:seo:description-missing:${pageKey}`,
      severity: "medium",
      category: "seo",
      page: pageKey,
      check: "audit-seo",
      summary: '<meta name="description"> ausente',
      details:
        "Sem description o Google gera um snippet automático do conteúdo, geralmente menos " +
        "atrativo. Ação: adicionar description única (50-160 chars) por rota.",
    });
  } else if (meta.description.length < 50) {
    out.push({
      id: `audit:seo:description-short:${pageKey}`,
      severity: "low",
      category: "seo",
      page: pageKey,
      check: "audit-seo",
      summary: `Description muito curta: ${meta.description.length} chars`,
    });
  } else if (meta.description.length > 160) {
    out.push({
      id: `audit:seo:description-long:${pageKey}`,
      severity: "low",
      category: "seo",
      page: pageKey,
      check: "audit-seo",
      summary: `Description muito longa: ${meta.description.length} chars (Google trunca em ~160)`,
    });
  }

  // 3. Canonical
  if (!meta.canonical) {
    out.push({
      id: `audit:seo:canonical-missing:${pageKey}`,
      severity: "medium",
      category: "seo",
      page: pageKey,
      check: "audit-seo",
      summary: '<link rel="canonical"> ausente',
      details:
        "Sem canonical, o Google decide sozinho qual URL é canônica (especialmente " +
        "problemático em sites com filtros / query strings). Ação: emitir " +
        '<link rel="canonical" href="..."> apontando pra URL "limpa" desta página.',
    });
  }

  // 4. Robots noindex (red flag — usually accidental)
  // Some URL patterns SHOULD be noindex by best practice — search empty
  // states, account areas, checkout, 404s, etc. Don't flag those.
  if (meta.robots && /noindex/i.test(meta.robots) && !isPageWhereNoindexIsExpected(pageKey)) {
    out.push({
      id: `audit:seo:noindex:${pageKey}`,
      severity: "high",
      category: "seo",
      page: pageKey,
      check: "audit-seo",
      summary: `Página tem noindex: meta robots="${meta.robots}"`,
      details:
        "Página NÃO aparecerá nos resultados de busca. Se for intencional (e.g. página de " +
        "login, /admin, página interna), pode ignorar. Mas em rotas públicas isso é quase " +
        "sempre acidente de SSR/middleware que escapou pro deploy.",
    });
  }

  // 5. Open Graph image
  const ogImage = meta.og["og:image"];
  if (!ogImage) {
    out.push({
      id: `audit:seo:og-image-missing:${pageKey}`,
      severity: "medium",
      category: "seo",
      page: pageKey,
      check: "audit-seo",
      summary: '<meta property="og:image"> ausente',
      details:
        "Sem og:image, links compartilhados no WhatsApp/Twitter/Facebook aparecem sem " +
        "preview visual — CTR cai drasticamente. Ação: adicionar imagem 1200×630 com " +
        '<meta property="og:image" content="...">.',
    });
  }

  // 6. JSON-LD structured data (opportunity, not strict required)
  if (meta.jsonLdTypes.length === 0) {
    out.push({
      id: `audit:seo:jsonld-missing:${pageKey}`,
      severity: "low",
      category: "seo",
      page: pageKey,
      check: "audit-seo",
      summary: "Sem structured data (JSON-LD) — perde oportunidade de rich results",
      details:
        "Páginas com JSON-LD (Product, BreadcrumbList, Organization, FAQPage) elegíveis a " +
        'rich results no Google ganham CTR. Ação: adicionar <script type="application/ld+json"> ' +
        "com schema relevante pro tipo da página (Product pra PDP, ItemList pra PLP, " +
        "Article pra blog).",
    });
  }

  return out;
}

/**
 * URL patterns where `noindex` is the SEO best practice (not a bug):
 *  - empty search results / generic search landing
 *  - 404 / error pages
 *  - account / checkout / cart (private/transient state)
 *  - login / signup
 *
 * `pageKey` typically holds the pathname (e.g. "/buscapagina", "/login") or
 * a path+viewport key like "/login::mobile" — we just substring-match the
 * meaningful slug, so both formats work.
 */
function isPageWhereNoindexIsExpected(pageKey: string): boolean {
  // Strip the "::viewport" suffix that buildKey adds; treat the leading "/" as a
  // word boundary anchor so a 2-char path like "/s" can be matched safely.
  const path = pageKey.toLowerCase().split("::")[0]!;
  return (
    // search / empty-state — covers /search, /buscapagina (VTEX legacy), and /s (VTEX modern Intelligent Search short alias)
    /^\/search(\/|\?|$)/.test(path) ||
    /^\/busca(pagina)?(\/|\?|$)/.test(path) ||
    /^\/s(\/|\?|$)/.test(path) ||
    // 404 / error pages
    /\/404(\/|$)/.test(path) ||
    /\/not[-_]?found(\/|$)/.test(path) ||
    /\/error(\/|$)/.test(path) ||
    // private areas
    /\/account(\/|$)/.test(path) ||
    /\/minha[-_]?conta(\/|$)/.test(path) ||
    /\/checkout(\/|$)/.test(path) ||
    /\/cart(\/|$)/.test(path) ||
    /\/carrinho(\/|$)/.test(path) ||
    /\/login(\/|$)/.test(path) ||
    /\/signup(\/|$)/.test(path) ||
    /\/cadastr/.test(path)
  );
}
