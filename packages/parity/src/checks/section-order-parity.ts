import { snapshotDom } from "../diff/dom.ts";
import type { CheckResult, Issue } from "../types/schema.ts";
import type { CheckContext } from "./index.ts";
import { pairCaptures } from "./lib/pairing.ts";

/**
 * Section ORDER parity. `visual-regression.ts` already diffs `[data-section]`
 * PRESENCE (`sectionsOnlyInProd`/`sectionsOnlyInCand`, via a `Set` — see
 * `decoSectionsRendered` in `diff/dom.ts`), which catches a section dropped or
 * added. It cannot catch a REORDER: same set of sections, different sequence
 * — e.g. a migration that ports every section correctly but assembles the
 * page (banner, shelf, newsletter) instead of (banner, newsletter, shelf).
 * That's an editorial/content regression a screenshot diff can miss when the
 * two sections look similar enough in isolation, and it's invisible to a pure
 * set comparison by construction.
 *
 * Deliberately narrow: only fires when prod and cand render the EXACT SAME
 * set of sections (so this never duplicates a presence issue already raised
 * elsewhere) but in a different order.
 */
export function sectionOrderParity(ctx: CheckContext): CheckResult {
  const start = Date.now();
  if (ctx.prodPages.length === 0) {
    return skip(start, "sem baseline prod — nada para comparar (single-site)");
  }

  const { pairs } = pairCaptures(ctx.prodPages, ctx.candPages);
  const issues: Issue[] = [];

  for (const pair of pairs) {
    if (!pair.prod.html || !pair.cand.html) continue;
    const prodOrder = snapshotDom(pair.prod.html).decoSectionsOrder;
    const candOrder = snapshotDom(pair.cand.html).decoSectionsOrder;

    if (prodOrder.length === 0 || candOrder.length === 0) continue;
    if (prodOrder.length !== candOrder.length) continue; // presence issue, not ours

    const sameSet =
      new Set(prodOrder).size === new Set(candOrder).size &&
      prodOrder.every((s) => candOrder.includes(s));
    if (!sameSet) continue; // presence issue, not ours

    const sameOrder = prodOrder.every((s, i) => s === candOrder[i]);
    if (sameOrder) continue;

    issues.push({
      id: `section-order:${pair.key}`,
      severity: "medium",
      category: "functional",
      page: pair.key,
      check: "section-order-parity",
      summary: `Seções na mesma página em ordem diferente em ${pair.key}`,
      details: `prod:  ${prodOrder.join(" → ")}\ncand:  ${candOrder.join(" → ")}`,
      evidence: [
        { kind: "screenshot", path: pair.prod.screenshotPath, label: "prod" },
        { kind: "screenshot", path: pair.cand.screenshotPath, label: "cand" },
      ],
    });
  }

  return {
    name: "section-order-parity",
    status: issues.length > 0 ? "warn" : "pass",
    severity: "medium",
    durationMs: Date.now() - start,
    summary:
      issues.length > 0
        ? `${issues.length} página(s) com seções reordenadas`
        : "Ordem das seções consistente entre prod e cand",
    issues,
  };
}

function skip(start: number, summary: string): CheckResult {
  return {
    name: "section-order-parity",
    status: "skipped",
    severity: "medium",
    durationMs: Date.now() - start,
    summary,
    issues: [],
  };
}
