import { diffDom, snapshotDom } from "../diff/dom.ts";
import type { CheckResult, Issue } from "../types/schema.ts";
import type { CheckContext } from "./index.ts";
import { pairCaptures } from "./lib/pairing.ts";

export function htmlStructuralDiff(ctx: CheckContext): CheckResult {
  const start = Date.now();
  const { pairs } = pairCaptures(ctx.prodPages, ctx.candPages);
  const issues: Issue[] = [];

  for (const pair of pairs) {
    const prodSnap = snapshotDom(pair.prod.html);
    const candSnap = snapshotDom(pair.cand.html);
    const diff = diffDom(prodSnap, candSnap, { countTolerance: 2 });

    // Split the count deltas: structural tags (h1/forms/buttons/…) are a
    // reliable regression signal, but `imgs` (and to a lesser degree `links`)
    // are noisy when prod and cand use different render strategies — prod
    // defers everything (Lazy), cand SSRs; carousels clone slides for the
    // infinite loop; dynamic content (map markers, geocoding) inflates one
    // side. Reporting a raw img-count delta as `high` is a false-positive
    // (portal-davinci: "imgs 80→25" while the settled DOM had cand > prod).
    // Keep structural counts high; demote imgs to informational (#252).
    const NOISY = new Set(["imgs"]);
    const structural = Object.entries(diff.countsDelta).filter(([k]) => !NOISY.has(k));
    const noisy = Object.entries(diff.countsDelta).filter(([k]) => NOISY.has(k));

    if (structural.length > 0) {
      const summary = structural
        .map(([k, v]) => `${k}: ${v?.prod}→${v?.cand} (Δ${v?.delta})`)
        .join(", ");
      issues.push({
        id: `html-structural:counts:${pair.key}`,
        severity: "high",
        category: "functional",
        page: pair.key,
        check: "html-structural-diff",
        summary: `Contagem de elementos divergente em ${pair.key}: ${summary}`,
        evidence: [
          { kind: "screenshot", path: pair.prod.screenshotPath, label: "prod" },
          { kind: "screenshot", path: pair.cand.screenshotPath, label: "cand" },
        ],
      });
    }

    if (noisy.length > 0) {
      // Unique-src count collapses carousel clones — a more reliable read than
      // raw <img> count. Report as low + inconclusive so it never fails the
      // module on its own.
      const prodUnique = new Set(prodSnap.imageStats.src).size;
      const candUnique = new Set(candSnap.imageStats.src).size;
      const summary = noisy
        .map(([k, v]) => `${k}: ${v?.prod}→${v?.cand} (Δ${v?.delta})`)
        .join(", ");
      issues.push({
        id: `html-structural:counts-informational:${pair.key}`,
        severity: "low",
        category: "visual",
        page: pair.key,
        check: "html-structural-diff",
        inconclusive: true,
        summary: `Contagem de imagens divergente em ${pair.key} (informativo — estratégias de render diferentes): ${summary}. Imagens únicas por src: prod=${prodUnique} cand=${candUnique}`,
        details:
          "Contagem bruta de <img> não é sinal confiável quando prod defere (Lazy) e cand faz SSR, ou quando há clones de carousel / conteúdo dinâmico (geocoding). Compare imagens únicas por src acima.",
      });
    }

    if (diff.decoSectionsOnlyProd.length > 0) {
      issues.push({
        id: `html-structural:deco-missing:${pair.key}`,
        severity: "high",
        category: "functional",
        page: pair.key,
        check: "html-structural-diff",
        summary: `Sections renderizadas em prod ausentes em cand (${pair.key}): ${diff.decoSectionsOnlyProd.join(", ")}`,
      });
    }
  }

  const hasBlocking = issues.some((i) => i.severity === "high" && !i.inconclusive);
  return {
    name: "html-structural-diff",
    status: hasBlocking ? "fail" : issues.length > 0 ? "warn" : "pass",
    severity: "high",
    durationMs: Date.now() - start,
    summary: `${issues.length} divergência(s) estrutural(is) detectada(s)`,
    issues,
  };
}
