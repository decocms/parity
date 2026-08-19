/**
 * Determinístic normalizers applied before comparison to reduce false positives.
 * Each function is pure and idempotent.
 */

const TIMESTAMP_PATTERNS = [
  /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g,
  /\d{10,13}/g, // unix epoch
  /\d{2}\/\d{2}\/\d{4}/g,
  /\d{1,2}h\d{2}/g,
];

const DYNAMIC_ID_PATTERNS = [
  /\b[a-z]{1,4}-[a-z0-9]{6,}/gi, // r-abc123, k-xyz789
  /[?&]_=\d+/g, // cache busters
  /[?&]t=\d+/g,
  /\b[0-9a-f]{32,}\b/gi, // MD5/SHA
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, // UUIDs
];

const HASH_PATTERNS = [
  /\.[a-f0-9]{8,32}\.(js|css|woff2?|png|jpe?g|webp|avif|svg)/gi,
  /-[a-f0-9]{8,32}\.(js|css|woff2?|png|jpe?g|webp|avif|svg)/gi,
];

export function stripTimestamps(input: string): string {
  let out = input;
  for (const p of TIMESTAMP_PATTERNS) out = out.replace(p, "__TS__");
  return out;
}

export function stripDynamicIds(input: string): string {
  let out = input;
  for (const p of DYNAMIC_ID_PATTERNS) out = out.replace(p, "__DYN__");
  return out;
}

export function stripHashes(input: string): string {
  let out = input;
  for (const p of HASH_PATTERNS) {
    out = out.replace(p, (_m, ext) => `.__HASH__.${ext}`);
  }
  return out;
}

export function collapseWhitespace(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

export function sortClassAttribute(htmlClassValue: string): string {
  return htmlClassValue.split(/\s+/).filter(Boolean).sort().join(" ");
}

export function normalizeForCompare(input: string): string {
  return collapseWhitespace(stripHashes(stripDynamicIds(stripTimestamps(input))));
}

/**
 * Normalize a URL for comparison: strip dynamic IDs from path, normalize hash assets,
 * sort search params, strip known tracking params.
 */
const TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
  "gclid",
  "fbclid",
  "_ga",
  "_gl",
  "mc_cid",
  "mc_eid",
]);

export function normalizeUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    // strip tracking
    for (const param of [...u.searchParams.keys()]) {
      if (TRACKING_PARAMS.has(param)) u.searchParams.delete(param);
    }
    // sort params
    const sorted = [...u.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
    u.search = "";
    for (const [k, v] of sorted) u.searchParams.append(k, v);
    // normalize hashed asset filenames in path
    u.pathname = stripHashes(u.pathname);
    u.pathname = stripDynamicIds(u.pathname);
    return u.toString();
  } catch {
    return rawUrl;
  }
}
