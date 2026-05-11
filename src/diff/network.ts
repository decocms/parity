import { normalizeUrl } from "../engine/normalize.ts";
import type { NetworkEntry } from "../types/schema.ts";

export interface NetworkSummary {
  total: number;
  totalBytes: number;
  status: Record<string, number>; // "2xx" | "3xx" | "4xx" | "5xx" | "other"
  cacheHits: number;
  cacheMisses: number;
  cacheHitRate: number;
  byType: Record<string, { count: number; bytes: number }>;
  decoSectionsHit: string[];
  apiCalls: number;
  lazySectionCalls: number;
}

export function summarizeNetwork(entries: NetworkEntry[]): NetworkSummary {
  const summary: NetworkSummary = {
    total: entries.length,
    totalBytes: 0,
    status: {},
    cacheHits: 0,
    cacheMisses: 0,
    cacheHitRate: 0,
    byType: {},
    decoSectionsHit: [],
    apiCalls: 0,
    lazySectionCalls: 0,
  };

  const decoSet = new Set<string>();

  for (const e of entries) {
    summary.totalBytes += e.bytes ?? 0;
    const bucket =
      e.status >= 500
        ? "5xx"
        : e.status >= 400
          ? "4xx"
          : e.status >= 300
            ? "3xx"
            : e.status >= 200
              ? "2xx"
              : "other";
    summary.status[bucket] = (summary.status[bucket] ?? 0) + 1;

    if (e.fromCache) summary.cacheHits++;
    else summary.cacheMisses++;

    const tBucket = summary.byType[e.resourceType] ?? { count: 0, bytes: 0 };
    tBucket.count++;
    tBucket.bytes += e.bytes ?? 0;
    summary.byType[e.resourceType] = tBucket;

    if (e.decoSection) decoSet.add(e.decoSection);

    if (/\/api\//.test(e.url) || /\/_loader\//.test(e.url)) summary.apiCalls++;
    if (/\/deco\/render/.test(e.url) || /\/_loader\//.test(e.url)) summary.lazySectionCalls++;
  }

  summary.decoSectionsHit = [...decoSet].sort();
  const cacheTotal = summary.cacheHits + summary.cacheMisses;
  summary.cacheHitRate = cacheTotal > 0 ? summary.cacheHits / cacheTotal : 0;
  return summary;
}

export interface UrlDiff {
  onlyProd: string[];
  onlyCand: string[];
  common: string[];
}

export function diffUrls(
  prod: NetworkEntry[],
  cand: NetworkEntry[],
  options: { ignorePatterns?: string[] } = {},
): UrlDiff {
  const ignore = (options.ignorePatterns ?? []).map(toRegex);
  const matches = (url: string) => ignore.some((re) => re.test(url));

  const prodSet = new Set(prod.map((e) => normalizeUrl(e.url)).filter((u) => !matches(u)));
  const candSet = new Set(cand.map((e) => normalizeUrl(e.url)).filter((u) => !matches(u)));

  const onlyProd = [...prodSet].filter((u) => !candSet.has(u)).sort();
  const onlyCand = [...candSet].filter((u) => !prodSet.has(u)).sort();
  const common = [...prodSet].filter((u) => candSet.has(u)).sort();
  return { onlyProd, onlyCand, common };
}

export interface NetworkDiff {
  prod: NetworkSummary;
  cand: NetworkSummary;
  delta: {
    totalPct: number;
    bytesPct: number;
    cacheHitRateDelta: number;
  };
  urls: UrlDiff;
  anyFailed: boolean;
  reason?: string;
}

export interface NetworkDiffOptions {
  maxTotalPct?: number; // default 30%
  ignorePatterns?: string[];
}

export function diffNetwork(
  prod: NetworkEntry[],
  cand: NetworkEntry[],
  opts: NetworkDiffOptions = {},
): NetworkDiff {
  const maxPct = opts.maxTotalPct ?? 0.3;
  const pSum = summarizeNetwork(prod);
  const cSum = summarizeNetwork(cand);
  const totalPct = pSum.total > 0 ? (cSum.total - pSum.total) / pSum.total : 0;
  const bytesPct = pSum.totalBytes > 0 ? (cSum.totalBytes - pSum.totalBytes) / pSum.totalBytes : 0;
  const urls = diffUrls(prod, cand, { ignorePatterns: opts.ignorePatterns });
  const failedByVolume = Math.abs(totalPct) > maxPct;
  return {
    prod: pSum,
    cand: cSum,
    delta: {
      totalPct,
      bytesPct,
      cacheHitRateDelta: cSum.cacheHitRate - pSum.cacheHitRate,
    },
    urls,
    anyFailed: failedByVolume,
    reason: failedByVolume
      ? `request count delta ${(totalPct * 100).toFixed(0)}% exceeds ±${(maxPct * 100).toFixed(0)}%`
      : undefined,
  };
}

function toRegex(pattern: string): RegExp {
  // glob-ish: ** -> .*, * -> [^/]*, escape rest
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "::DOUBLESTAR::")
    .replace(/\*/g, "[^/]*")
    .replace(/::DOUBLESTAR::/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}
