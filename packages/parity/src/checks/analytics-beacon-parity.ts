import type { CheckResult, Issue, NetworkEntry, PageCapture } from "../types/schema.ts";
import type { CheckContext } from "./index.ts";
import { pairCaptures } from "./lib/pairing.ts";

/**
 * Analytics beacon parity — Tier 1 of "events parity". This checks whether
 * the well-known analytics NETWORK CALLS fired (GA4 collect, GTM container
 * load, Meta Pixel, TikTok Pixel), using `PageCapture.network` that's
 * already captured. It does NOT compare `dataLayer.push()` event names or
 * payloads (e.g. `view_item` params matching between prod/cand) — that needs
 * new capture-side instrumentation (injecting a script that observes
 * `window.dataLayer`/`gtag` calls during each flow) which this check
 * deliberately does not attempt. See the parity repo issue tracker for the
 * full dataLayer-diff follow-up; this is the cheap, no-new-capture subset:
 * "did the container/pixel load at all", which already catches the most
 * common migration regression (the tag manager script itself never fires).
 *
 * Patterns are intentionally generic (not deco/Fila-specific) — vendor
 * beacon URLs are stable across sites using the same tool.
 */
interface BeaconPattern {
  id: string;
  label: string;
  match: (url: string) => boolean;
}

const BEACON_PATTERNS: BeaconPattern[] = [
  {
    id: "gtm-container",
    label: "Google Tag Manager (gtm.js)",
    match: (u) => /googletagmanager\.com\/gtm\.js/.test(u),
  },
  {
    id: "gtag-js",
    label: "Google gtag.js / Google Ads",
    match: (u) => /googletagmanager\.com\/gtag\/js/.test(u),
  },
  {
    id: "ga4-collect",
    label: "GA4 collect beacon",
    match: (u) => /google-analytics\.com\/g\/collect|analytics\.google\.com\/g\/collect/.test(u),
  },
  {
    id: "meta-pixel",
    label: "Meta (Facebook) Pixel",
    match: (u) => /connect\.facebook\.(net|com)\/.*\/fbevents\.js|facebook\.com\/tr\//.test(u),
  },
  {
    id: "tiktok-pixel",
    label: "TikTok Pixel",
    match: (u) => /analytics\.tiktok\.com\/i18n\/pixel/.test(u),
  },
  {
    id: "pinterest-tag",
    label: "Pinterest Tag",
    match: (u) => /ct\.pinterest\.com\/v3/.test(u),
  },
];

export function analyticsBeaconParity(ctx: CheckContext): CheckResult {
  const start = Date.now();
  if (ctx.prodPages.length === 0) {
    return skip(start, "sem baseline prod — nada para comparar (single-site)");
  }

  const { pairs } = pairCaptures(ctx.prodPages, ctx.candPages);
  const issues: Issue[] = [];
  let pairsWithAnyBeacon = 0;

  for (const pair of pairs) {
    const prodHits = detectedBeacons(pair.prod);
    const candHits = detectedBeacons(pair.cand);
    if (prodHits.size === 0 && candHits.size === 0) continue;
    pairsWithAnyBeacon++;

    for (const pattern of BEACON_PATTERNS) {
      const inProd = prodHits.has(pattern.id);
      const inCand = candHits.has(pattern.id);
      if (inProd && !inCand) {
        issues.push({
          id: `analytics-beacon:missing:${pattern.id}:${pair.key}`,
          severity: "high",
          category: "network",
          page: pair.key,
          check: "analytics-beacon-parity",
          summary: `${pattern.label} disparou em prod mas não no candidato em ${pair.key}`,
          suggestedFix:
            "Confirme o container/pixel ID no candidato — tag manager ausente derruba TODO o rastreamento a jusante dele, não só este evento.",
        });
      }
    }
  }

  const hasHigh = issues.some((i) => i.severity === "high");
  return {
    name: "analytics-beacon-parity",
    status: hasHigh ? "fail" : issues.length > 0 ? "warn" : "pass",
    severity: "high",
    durationMs: Date.now() - start,
    summary:
      pairsWithAnyBeacon === 0
        ? "Nenhum beacon de analytics conhecido observado em nenhum dos lados — nada a validar (ou o site usa uma ferramenta fora da lista de padrões)"
        : `${issues.length} beacon(s) de analytics perdido(s) em ${pairsWithAnyBeacon} página(s) com tráfego de analytics`,
    issues,
  };
}

function detectedBeacons(page: PageCapture): Set<string> {
  const hits = new Set<string>();
  for (const entry of page.network as NetworkEntry[]) {
    for (const pattern of BEACON_PATTERNS) {
      if (pattern.match(entry.url)) hits.add(pattern.id);
    }
  }
  return hits;
}

function skip(start: number, summary: string): CheckResult {
  return {
    name: "analytics-beacon-parity",
    status: "skipped",
    severity: "high",
    durationMs: Date.now() - start,
    summary,
    issues: [],
  };
}
