import { describe, expect, it } from "vitest";
import { diffDom, snapshotDom } from "../../src/diff/dom.ts";

const HTML_PROD = `
<!doctype html>
<html>
<head>
  <title>Loja XYZ - Produtos</title>
  <meta name="description" content="A melhor loja de produtos"/>
  <link rel="canonical" href="https://prod.loja.com/"/>
  <meta property="og:title" content="Loja XYZ"/>
  <script type="application/ld+json">{"@type":"WebSite","name":"Loja XYZ"}</script>
</head>
<body>
  <header><h1>Loja XYZ</h1></header>
  <main>
    <section><h2>Categorias</h2><a href="/c/a">A</a><a href="/c/b">B</a></section>
    <section data-section="hero"><img src="a.jpg" srcset="a.jpg 1x, a2.jpg 2x" alt="hero"/></section>
  </main>
  <footer><button>Comprar</button><form><input/></form></footer>
</body>
</html>`;

const HTML_CAND_OK = HTML_PROD; // identical

const HTML_CAND_MISSING_SECTION = `
<!doctype html>
<html>
<head>
  <title>Loja XYZ - Produtos</title>
  <meta name="description" content="A melhor loja de produtos"/>
  <link rel="canonical" href="https://prod.loja.com/"/>
  <meta property="og:title" content="Loja XYZ"/>
  <script type="application/ld+json">{"@type":"WebSite","name":"Loja XYZ"}</script>
</head>
<body>
  <header><h1>Loja XYZ</h1></header>
  <main>
    <section><h2>Categorias</h2><a href="/c/a">A</a><a href="/c/b">B</a></section>
    <!-- hero section missing -->
  </main>
  <footer><button>Comprar</button><form><input/></form></footer>
</body>
</html>`;

describe("snapshotDom", () => {
  it("extrai counts básicos", () => {
    const s = snapshotDom(HTML_PROD);
    expect(s.counts.h1).toBe(1);
    expect(s.counts.h2).toBe(1);
    expect(s.counts.links).toBe(2);
    expect(s.counts.imgs).toBe(1);
    expect(s.counts.forms).toBe(1);
    expect(s.counts.buttons).toBe(1);
  });

  it("extrai meta tags e JSON-LD", () => {
    const s = snapshotDom(HTML_PROD);
    expect(s.meta.title).toBe("Loja XYZ - Produtos");
    expect(s.meta.description).toBe("A melhor loja de produtos");
    expect(s.meta.canonical).toBe("https://prod.loja.com/");
    expect(s.meta.og["og:title"]).toBe("Loja XYZ");
    expect(s.meta.jsonLdTypes).toContain("WebSite");
  });

  it("conta image stats com alt + srcset", () => {
    const s = snapshotDom(HTML_PROD);
    expect(s.imageStats.total).toBe(1);
    expect(s.imageStats.withAlt).toBe(1);
    expect(s.imageStats.withSrcset).toBe(1);
  });

  it("lista deco sections renderizadas", () => {
    const s = snapshotDom(HTML_PROD);
    expect(s.decoSectionsRendered).toContain("hero");
  });

  describe("skeletonCount", () => {
    it("returns 0 for HTML with no skeleton elements", () => {
      const s = snapshotDom(HTML_PROD);
      expect(s.skeletonCount).toBe(0);
    });

    it("counts elements matching common skeleton patterns", () => {
      const html = `
        <html><body>
          <div class="skeleton"></div>
          <div class="product-skeleton"></div>
          <div class="ProductSkeleton"></div>
          <div class="animate-pulse"></div>
          <div aria-busy="true"></div>
          <div data-skeleton></div>
          <div data-loading="true"></div>
          <div class="shimmer-card"></div>
          <div class="react-loading-skeleton"></div>
        </body></html>`;
      const s = snapshotDom(html);
      // 9 distinct elements above; we count each via its first matching selector
      // (the loop sums per-selector hits so some overlap is expected, but
      // shouldn't undercount).
      expect(s.skeletonCount).toBeGreaterThanOrEqual(9);
    });

    it("counts repeated skeletons (typical shelf card pattern)", () => {
      const cards = "<div class='skeleton-card'></div>".repeat(8);
      const s = snapshotDom(`<html><body>${cards}</body></html>`);
      expect(s.skeletonCount).toBeGreaterThanOrEqual(8);
    });
  });
});

describe("diffDom", () => {
  it("retorna anyFailed=false para HTMLs idênticos", () => {
    const d = diffDom(snapshotDom(HTML_PROD), snapshotDom(HTML_CAND_OK));
    expect(d.anyFailed).toBe(false);
    expect(d.decoSectionsOnlyProd.length).toBe(0);
  });

  it("detecta section faltando em cand", () => {
    const d = diffDom(snapshotDom(HTML_PROD), snapshotDom(HTML_CAND_MISSING_SECTION));
    expect(d.decoSectionsOnlyProd).toContain("hero");
    expect(d.anyFailed).toBe(true);
  });
});
