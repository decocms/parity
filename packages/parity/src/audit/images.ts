import { snapshotDom } from "../diff/dom.ts";
import type { Issue } from "../types/schema.ts";

/**
 * Audit images on a single page. Reuses `snapshotDom().imageStats` for
 * counts; goes deeper into the HTML with cheerio to flag specific
 * problems that need per-image data.
 *
 * Checks (all absolute, no comparison):
 *   - withoutAlt > 0 and withoutAlt / total > 0.2 → medium (a11y + SEO)
 *   - any banner-class <img> missing width/height → medium (CLS risk)
 *   - withSrcset < 50% of total when total >= 5 → low (perf)
 *
 * Banner identification reuses the same threshold as
 * `bannerAspectRatio`: width ≥ 600 OR inside a [data-section]
 * matching /(carousel|slider|banner|hero)/i.
 */
export function auditImages(pageKey: string, html: string): Issue[] {
  const out: Issue[] = [];
  if (!html) return out;
  const snap = snapshotDom(html);
  const stats = snap.imageStats;
  if (stats.total === 0) return out;

  // 1. Alt text missing — accessibility + SEO
  if (stats.withoutAlt > 0) {
    const pct = stats.withoutAlt / stats.total;
    const severity = pct > 0.5 ? "high" : pct > 0.2 ? "medium" : "low";
    if (pct > 0.05) {
      out.push({
        id: `audit:images:alt:${pageKey}`,
        severity,
        category: "seo",
        page: pageKey,
        check: "audit-images",
        summary: `${stats.withoutAlt}/${stats.total} imagens sem alt text (${(pct * 100).toFixed(0)}%)`,
        details:
          "Imagens sem alt text falham acessibilidade (WCAG 1.1.1) e perdem indexação no " +
          "Google Images. Ações: adicionar alt descritivo nas imagens de conteúdo. Imagens " +
          'puramente decorativas devem usar alt="" (vazio explícito, não ausente).',
      });
    }
  }

  // 2. Banner images sem width/height — CLS risk
  const bannersMissingDims = stats.banners.filter((b) => b.width === null || b.height === null);
  if (bannersMissingDims.length > 0) {
    out.push({
      id: `audit:images:banner-dims:${pageKey}`,
      severity: "medium",
      category: "performance",
      page: pageKey,
      check: "audit-images",
      summary: `${bannersMissingDims.length}/${stats.banners.length} banner(s) sem width/height (CLS risk)`,
      details: `Banner-class images sem dimensões fazem o browser não conseguir reservar o slot antes da imagem decodificar, gerando layout shift quando a imagem chega.\n\nBanners afetados (até 5):\n${bannersMissingDims
        .slice(0, 5)
        .map((b) => `  - ${b.src.split("?")[0]?.split("/").pop() ?? b.src}`)
        .join(
          "\n",
        )}\n\nAção: adicionar atributos width="..." e height="..." em todos os <img> de banner. CSS pode redimensionar depois, mas o atributo HTML preserva o aspect ratio.`,
    });
  }

  // 3. Srcset coverage — perf
  if (stats.total >= 5) {
    const srcsetPct = stats.withSrcset / stats.total;
    if (srcsetPct < 0.5) {
      out.push({
        id: `audit:images:srcset:${pageKey}`,
        severity: "low",
        category: "performance",
        page: pageKey,
        check: "audit-images",
        summary: `Só ${stats.withSrcset}/${stats.total} imagens têm srcset (${(srcsetPct * 100).toFixed(0)}%)`,
        details:
          "Imagens sem srcset não permitem ao browser escolher a resolução adequada pro " +
          "viewport — mobile baixa o asset desktop, gastando bytes e degradando LCP. Ações: " +
          'usar <Image> do framework com srcset gerado automaticamente, ou srcset="img-400.jpg 400w, img-800.jpg 800w, ..." manual.',
      });
    }
  }

  return out;
}
