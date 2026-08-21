import type { CheckResult, Issue, PageCapture } from "../types/schema.ts";
import type { CheckContext } from "./index.ts";
import { pairCaptures } from "./lib/pairing.ts";

/**
 * Third-party script/tag parity. `network-summary-delta` already diffs
 * request COUNT/BYTES/cache-hit-rate in aggregate — it can't tell you WHICH
 * third party disappeared, only that the total shifted. A migration that
 * silently drops the GTM container, a chat widget, or a pixel is exactly the
 * kind of regression that never shows up in a screenshot and rarely gets
 * manually re-checked once the visual layout matches.
 *
 * Scope: distinct third-party ORIGINS observed in `PageCapture.network`
 * (already captured by every run — no new capture-side work). First-party
 * origins (the page's own host, its `www.`/apex variant, and known CDN
 * suffixes of the page's own host) are excluded so this doesn't flag a
 * migration's own asset CDN as a "lost" or "new" third party.
 */
export function thirdPartyScriptsParity(ctx: CheckContext): CheckResult {
  const start = Date.now();
  if (ctx.prodPages.length === 0) {
    return skip(start, "sem baseline prod — nada para comparar (single-site)");
  }

  const { pairs } = pairCaptures(ctx.prodPages, ctx.candPages);
  const issues: Issue[] = [];
  let pairsChecked = 0;

  for (const pair of pairs) {
    if (pair.prod.network.length === 0 && pair.cand.network.length === 0) continue;
    pairsChecked++;

    const prodOrigins = thirdPartyOrigins(pair.prod);
    const candOrigins = thirdPartyOrigins(pair.cand);

    const missing = [...prodOrigins].filter((o) => !candOrigins.has(o)).sort();
    const added = [...candOrigins].filter((o) => !prodOrigins.has(o)).sort();

    if (missing.length > 0) {
      issues.push({
        id: `3p-scripts:missing:${pair.key}`,
        severity: "high",
        category: "network",
        page: pair.key,
        check: "third-party-scripts-parity",
        summary: `${missing.length} origem(ns) de terceiro presente(s) em prod mas ausente(s) no candidato em ${pair.key}`,
        details: missing.join("\n"),
        suggestedFix:
          "Confirme se o script foi migrado deliberadamente ou se a tag (GTM, pixel, chat, avaliações, etc.) foi perdida na porta.",
      });
    }
    if (added.length > 0) {
      issues.push({
        id: `3p-scripts:added:${pair.key}`,
        severity: "low",
        category: "network",
        page: pair.key,
        check: "third-party-scripts-parity",
        summary: `${added.length} origem(ns) de terceiro nova(s) no candidato (ausente em prod) em ${pair.key}`,
        details: added.join("\n"),
        inconclusive: true,
      });
    }
  }

  const hasHigh = issues.some((i) => i.severity === "high");
  return {
    name: "third-party-scripts-parity",
    status: hasHigh ? "fail" : issues.length > 0 ? "warn" : "pass",
    severity: "high",
    durationMs: Date.now() - start,
    summary:
      pairsChecked === 0
        ? "Nenhuma página com tráfego de rede capturado"
        : `${issues.length} divergência(s) de terceiros em ${pairsChecked} página(s)`,
    issues,
  };
}

/** Registrable domain: last two labels, e.g. "cdn.example.co.uk" → "example.co.uk"
 *  is wrong for co.uk-style TLDs but this is a heuristic for de-duplicating
 *  first-party subdomains, not a public-suffix-list-accurate parser — a false
 *  "third party" hit on a co.uk site's own subdomain is a low-cost false
 *  positive, not a broken check. */
function registrableDomain(hostname: string): string {
  const parts = hostname.split(".");
  return parts.length <= 2 ? hostname : parts.slice(-2).join(".");
}

function thirdPartyOrigins(page: PageCapture): Set<string> {
  let pageHost: string;
  try {
    pageHost = new URL(page.finalUrl || page.url).hostname;
  } catch {
    return new Set();
  }
  const pageDomain = registrableDomain(pageHost);

  const origins = new Set<string>();
  for (const entry of page.network) {
    let host: string;
    try {
      host = new URL(entry.url).hostname;
    } catch {
      continue;
    }
    if (!host) continue;
    if (registrableDomain(host) === pageDomain) continue; // first-party (incl. subdomains)
    origins.add(host);
  }
  return origins;
}

function skip(start: number, summary: string): CheckResult {
  return {
    name: "third-party-scripts-parity",
    status: "skipped",
    severity: "high",
    durationMs: Date.now() - start,
    summary,
    issues: [],
  };
}
