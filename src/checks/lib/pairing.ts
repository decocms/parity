import type { PageCapture, Viewport } from "../../types/schema.ts";

export interface PagePair {
  prod: PageCapture;
  cand: PageCapture;
  viewport: Viewport;
  /** Logical URL key — strips host so same logical path compares */
  key: string;
}

/**
 * Pair up prod and cand captures by (pathname, viewport). Captures without a
 * matching counterpart are returned in `orphans`.
 */
export function pairCaptures(
  prod: PageCapture[],
  cand: PageCapture[],
): { pairs: PagePair[]; orphansProd: PageCapture[]; orphansCand: PageCapture[] } {
  const candByKey = new Map<string, PageCapture>();
  for (const c of cand) candByKey.set(captureKey(c), c);

  const pairs: PagePair[] = [];
  const orphansProd: PageCapture[] = [];
  for (const p of prod) {
    const key = captureKey(p);
    const c = candByKey.get(key);
    if (c) {
      pairs.push({ prod: p, cand: c, viewport: p.viewport, key });
      candByKey.delete(key);
    } else {
      orphansProd.push(p);
    }
  }
  return { pairs, orphansProd, orphansCand: [...candByKey.values()] };
}

export function captureKey(c: PageCapture): string {
  let path = "";
  try {
    path = new URL(c.url).pathname || "/";
  } catch {
    path = c.url;
  }
  return `${path}::${c.viewport}`;
}

export function pageRoleHint(urlOrPath: string): string {
  if (/\/p\b|\/p\/|\/products\//.test(urlOrPath)) return "pdp";
  if (/\/c\/|\/category\/|\/collections\//.test(urlOrPath)) return "plp";
  if (/\/search/.test(urlOrPath)) return "search";
  if (/\/checkout/.test(urlOrPath)) return "checkout";
  if (urlOrPath === "/" || /\/$/.test(urlOrPath)) return "home";
  return "page";
}
