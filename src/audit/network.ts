import { summarizeNetwork } from "../diff/network.ts";
import type { Issue, NetworkEntry } from "../types/schema.ts";

/**
 * Audit network activity from one page load. Reuses `summarizeNetwork()`
 * from `src/diff/network.ts` for the aggregate stats, then applies
 * absolute thresholds for the audit verdict.
 *
 * Thresholds:
 *   - HTTP 4xx/5xx on any first-party request → high (or critical for the navigation itself)
 *   - Slow requests (durationMs > SLOW_REQUEST_MS) → medium
 *   - Total bytes downloaded > BLOATED_BYTES → medium (payload too heavy)
 *   - Cache hit rate < LOW_CACHE_HIT_PCT and total static > 10 → medium
 *
 * `firstPartyHost` is inferred from the page's own URL so third-party
 * tracker failures (e.g. Google Analytics blocked by ad blocker) don't
 * spam the report. Third-party 4xx/5xx are still surfaced but at lower
 * severity.
 */

const SLOW_REQUEST_MS = 3_000;
const BLOATED_BYTES = 5_000_000; // 5MB
const LOW_CACHE_HIT_PCT = 0.5;
const MIN_STATIC_FOR_CACHE_CHECK = 10;
const STATIC_RESOURCE_TYPES = new Set(["script", "stylesheet", "image", "font"]);

export function auditNetwork(pageKey: string, pageUrl: string, entries: NetworkEntry[]): Issue[] {
  const out: Issue[] = [];
  if (entries.length === 0) return out;

  const firstPartyHost = hostOf(pageUrl);
  const summary = summarizeNetwork(entries);

  // 1. HTTP errors (4xx/5xx, plus status=0 which Playwright uses for
  //    network-level failures: blocked by client, DNS fail, CORS). The
  //    navigation response itself failing is its own category — we
  //    check that separately via PageCapture.status upstream — but
  //    sub-resource failures are flagged here.
  const errored = entries.filter((e) => e.status >= 400 || e.status === 0);
  const firstPartyErrors = errored.filter((e) => isFirstParty(e.url, firstPartyHost));
  const thirdPartyErrors = errored.filter((e) => !isFirstParty(e.url, firstPartyHost));
  for (const e of firstPartyErrors.slice(0, 10)) {
    out.push({
      id: `audit:network:fp-error:${pageKey}:${hashUrl(e.url)}`,
      severity: e.status >= 500 ? "high" : "medium",
      category: "network",
      page: pageKey,
      check: "audit-network",
      summary: `[${e.status}] first-party request falhou: ${truncate(e.url, 160)}`,
      details: `Resource type: ${e.resourceType}\nMethod: ${e.method}\nDuration: ${e.durationMs ?? "?"}ms\n\nFirst-party errors são tipicamente bugs reais: rotas que não existem, APIs caindo, assets removidos do deploy.`,
    });
  }
  if (thirdPartyErrors.length > 0) {
    // Aggregate — too noisy to surface each one.
    out.push({
      id: `audit:network:tp-errors:${pageKey}`,
      severity: "low",
      category: "network",
      page: pageKey,
      check: "audit-network",
      summary: `${thirdPartyErrors.length} third-party request(s) com erro (analytics, ads, widgets)`,
      details: `Sample (até 5):\n${thirdPartyErrors
        .slice(0, 5)
        .map((e) => `  [${e.status}] ${e.url.slice(0, 120)}`)
        .join(
          "\n",
        )}\n\nA maioria desses erros vem de ad blockers do usuário, não são bugs do site. Worth investigating only if a third-party serviço crítico (e.g. checkout SDK) está aí.`,
    });
  }

  // 2. Slow requests
  const slow = entries.filter((e) => (e.durationMs ?? 0) > SLOW_REQUEST_MS);
  if (slow.length > 0) {
    out.push({
      id: `audit:network:slow:${pageKey}`,
      severity: slow.length > 3 ? "high" : "medium",
      category: "performance",
      page: pageKey,
      check: "audit-network",
      summary: `${slow.length} request(s) > ${SLOW_REQUEST_MS}ms — degrada TTFB/LCP`,
      details: `Mais lentos (top 5):\n${slow
        .slice(0, 5)
        .map((e) => `  ${Math.round(e.durationMs ?? 0)}ms · [${e.status}] ${e.url.slice(0, 120)}`)
        .join(
          "\n",
        )}\n\nCausas comuns: SSR sem cache, queries N+1, third-party slow (ads, analytics não-async).`,
    });
  }

  // 3. Bloat
  if (summary.totalBytes > BLOATED_BYTES) {
    out.push({
      id: `audit:network:bloat:${pageKey}`,
      severity: "medium",
      category: "performance",
      page: pageKey,
      check: "audit-network",
      summary: `Page peso ${(summary.totalBytes / 1e6).toFixed(1)}MB total — acima de ${BLOATED_BYTES / 1e6}MB`,
      details: `Total: ${summary.total} requests · ${(summary.totalBytes / 1e6).toFixed(2)}MB\n\nPor tipo:\n${Object.entries(
        summary.byType,
      )
        .sort((a, b) => b[1].bytes - a[1].bytes)
        .slice(0, 5)
        .map(([t, v]) => `  ${t}: ${v.count} requests · ${(v.bytes / 1e6).toFixed(2)}MB`)
        .join(
          "\n",
        )}\n\nAções: code-splitting, lazy-load de imagens, remover libs não usadas, fonts subset.`,
    });
  }

  // 4. Cache hit rate (only for static resources, and only when there are enough to be statistically meaningful)
  const staticEntries = entries.filter((e) => STATIC_RESOURCE_TYPES.has(e.resourceType));
  if (staticEntries.length >= MIN_STATIC_FOR_CACHE_CHECK) {
    const hits = staticEntries.filter((e) => e.fromCache).length;
    const rate = hits / staticEntries.length;
    if (rate < LOW_CACHE_HIT_PCT) {
      out.push({
        id: `audit:network:cache:${pageKey}`,
        severity: "medium",
        category: "performance",
        page: pageKey,
        check: "audit-network",
        summary: `Cache hit rate de assets estáticos: ${(rate * 100).toFixed(0)}% (target: ≥ ${LOW_CACHE_HIT_PCT * 100}%)`,
        details: `${hits}/${staticEntries.length} assets estáticos vieram do cache.\n\nCausas comuns: deploy invalidou CDN, sem Cache-Control imutável nos assets versionados, URLs sem fingerprint forçam revalidação.`,
      });
    }
  }

  return out;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function isFirstParty(url: string, fpHost: string): boolean {
  if (!fpHost) return false;
  try {
    const u = new URL(url);
    // Treat same-host AND subdomains as first-party.
    return u.hostname === fpHost || u.hostname.endsWith(`.${fpHost}`);
  } catch {
    return false;
  }
}

function hashUrl(url: string): string {
  let h = 0;
  for (let i = 0; i < url.length; i++) {
    h = (h << 5) - h + url.charCodeAt(i);
    h |= 0;
  }
  return (h >>> 0).toString(16).slice(0, 8);
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
