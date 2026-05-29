import { describe, expect, it } from "vitest";
import { auditSeo } from "../../src/audit/seo.ts";

function html(head: string, body = "<body></body>"): string {
  return `<!doctype html><html><head>${head}</head>${body}</html>`;
}

describe("auditSeo", () => {
  it("page completa → zero issues (exceto JSON-LD low quando ausente)", () => {
    const r = auditSeo(
      "/::mobile",
      html(`
        <title>Boa loja online de cosméticos premium</title>
        <meta name="description" content="Encontre os melhores cosméticos premium com entrega expressa para todo o Brasil. Aproveite frete grátis acima de 200 reais e o melhor catálogo do mercado.">
        <link rel="canonical" href="https://x.com/">
        <meta property="og:image" content="https://x.com/og.jpg">
        <script type="application/ld+json">{"@type":"Organization"}</script>
      `),
    );
    expect(r).toHaveLength(0);
  });

  it("title ausente → high", () => {
    const r = auditSeo("/::mobile", html(""));
    const titleIssue = r.find((i) => i.id.includes("title-missing"));
    expect(titleIssue?.severity).toBe("high");
  });

  it("title muito longo → low", () => {
    const longTitle = "A".repeat(120);
    const r = auditSeo("/::mobile", html(`<title>${longTitle}</title>`));
    const issue = r.find((i) => i.id.includes("title-long"));
    expect(issue?.severity).toBe("low");
  });

  it("noindex em página → high (red flag)", () => {
    const r = auditSeo(
      "/::mobile",
      html(`<title>ok</title><meta name="robots" content="noindex, nofollow">`),
    );
    const issue = r.find((i) => i.id.includes("noindex"));
    expect(issue?.severity).toBe("high");
  });

  it("noindex em /buscapagina (VTEX legacy) → ignorado (boa prática)", () => {
    const r = auditSeo(
      "/buscapagina::mobile",
      html(`<title>Busca</title><meta name="robots" content="noindex, follow">`),
    );
    expect(r.find((i) => i.id.includes("noindex"))).toBeUndefined();
  });

  it("noindex em /search → ignorado", () => {
    const r = auditSeo(
      "/search::mobile",
      html(`<title>Search</title><meta name="robots" content="noindex, follow">`),
    );
    expect(r.find((i) => i.id.includes("noindex"))).toBeUndefined();
  });

  it("noindex em /account → ignorado", () => {
    const r = auditSeo(
      "/account/orders::mobile",
      html(`<title>Pedidos</title><meta name="robots" content="noindex">`),
    );
    expect(r.find((i) => i.id.includes("noindex"))).toBeUndefined();
  });

  it("noindex em /s (VTEX Intelligent Search) → ignorado", () => {
    const r = auditSeo(
      "/s::mobile",
      html(`<title>Busca</title><meta name="robots" content="noindex, follow">`),
    );
    expect(r.find((i) => i.id.includes("noindex"))).toBeUndefined();
  });

  it("noindex em /store (não é VTEX /s) → flagado normalmente", () => {
    const r = auditSeo(
      "/store::mobile",
      html(`<title>Store</title><meta name="robots" content="noindex">`),
    );
    expect(r.find((i) => i.id.includes("noindex"))?.severity).toBe("high");
  });

  it("canonical ausente → medium", () => {
    const r = auditSeo("/::mobile", html("<title>Loja online incrível</title>"));
    const issue = r.find((i) => i.id.includes("canonical-missing"));
    expect(issue?.severity).toBe("medium");
  });

  it("og:image ausente → medium", () => {
    const r = auditSeo(
      "/::mobile",
      html(`<title>Loja online incrível</title><link rel="canonical" href="x">`),
    );
    const issue = r.find((i) => i.id.includes("og-image-missing"));
    expect(issue?.severity).toBe("medium");
  });

  it("JSON-LD ausente → low (oportunidade)", () => {
    const r = auditSeo(
      "/::mobile",
      html(`
        <title>Loja online incrível</title>
        <meta name="description" content="${"x".repeat(80)}">
        <link rel="canonical" href="x">
        <meta property="og:image" content="x">
      `),
    );
    const issue = r.find((i) => i.id.includes("jsonld-missing"));
    expect(issue?.severity).toBe("low");
  });
});
