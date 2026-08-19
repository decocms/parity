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
 *
 * **Last-wins for duplicates on either side.** Both prod and cand can have
 * multiple captures of the same path (e.g. homepage flow captures `/`, then
 * visual-diff capture pass captures `/` again with longer settle for
 * cleaner screenshots). Using last-wins means the most-recently-pushed
 * capture is the one used for comparison — and the visual-diff capture
 * pass deliberately pushes after the flows so its higher-quality artifact
 * is what the LLM judges against.
 */
export function pairCaptures(
  prod: PageCapture[],
  cand: PageCapture[],
): { pairs: PagePair[]; orphansProd: PageCapture[]; orphansCand: PageCapture[] } {
  const prodByKey = new Map<string, PageCapture>();
  for (const p of prod) prodByKey.set(captureKey(p), p);
  const candByKey = new Map<string, PageCapture>();
  for (const c of cand) candByKey.set(captureKey(c), c);

  const pairs: PagePair[] = [];
  const orphansProd: PageCapture[] = [];
  for (const [key, p] of prodByKey) {
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
