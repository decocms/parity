/**
 * Live-site stack classification — the migration-relevant "what is this site
 * made of?" verdict, read from captured HTML (+ cookies). Sharper than
 * `detectPlatform` (which returns a single commerce `Platform`): it separates
 *
 *  - the FRONTEND we migrate FROM (`deco-fresh` / `vtex-io` / `faststore` /
 *    `salesforce-commerce`), which decides the orchestrator's path, from
 *  - the commerce BACKEND, which the ported components keep calling, and
 *  - `htmx` — the signal that decides whether a deco-fresh port needs an
 *    `hx-*` / `useScript` → React refactor pass (deco's HTMX plugin) on top of
 *    the plain `deco-migrate` run.
 *
 * A deco frontend on a CUSTOM domain (no `.deco.site` host) is detected here
 * from markup, not the URL — the common case for a real store.
 *
 * Markers calibrated against real stores (2026-08):
 *  - deco:       `deco.cx` generator, `__fresh`/`_frsh` runtime, `/live/invoke`
 *  - htmx:       `hx-get|post|swap|target|trigger` attrs, `htmx.org`
 *  - vtex-io:    `__RUNTIME__` + `render-runtime` (Store Framework)
 *  - faststore:  `data-fs-`
 *  - salesforce: `demandware` / `cquotient` / `dw_`+`cqcid` cookies
 *  - commerce vtex often coexists with a deco frontend (`vtexassets`).
 */

export type Frontend =
  | "deco-fresh"
  | "vtex-io"
  | "faststore"
  | "salesforce-commerce"
  | "unknown";

export type Commerce = "vtex" | "shopify" | "salesforce-commerce" | "unknown";

export interface StackSignals {
  /** What the storefront is built with — drives the migration path. */
  frontend: Frontend;
  /** deco-fresh only: HTMX plugin in use → needs an hx-* / useScript refactor pass. */
  htmx: boolean;
  /** Commerce backend the ported components call, when distinguishable. */
  commerce: Commerce;
  /** Matched markers, for the report + debugging a mis-detect. */
  evidence: string[];
}

const has = (re: RegExp, text: string) => re.test(text);

/** True when a deco storefront (Fresh runtime + deco markers) is present. */
function isDeco(html: string): boolean {
  return (
    /deco\.cx|__DECO\b|data-deco\b/i.test(html) ||
    /__FRSH|_frsh/.test(html) ||
    html.includes("/live/invoke")
  );
}

function detectHtmx(html: string): boolean {
  return /\bhx-(get|post|target|swap|trigger)\b/i.test(html) || /htmx(\.org|\.min)?\b/i.test(html);
}

function detectCommerce(html: string, cookies: string): Commerce {
  if (/demandware|cquotient/i.test(html) || /\b(dwac_|cqcid|dwanonymous_)/.test(cookies))
    return "salesforce-commerce";
  if (/vtexassets|__RUNTIME__|myvtex|vtexcommercestable/i.test(html)) return "vtex";
  if (/cdn\.shopify\.com|Shopify\./.test(html)) return "shopify";
  return "unknown";
}

export function classifyLiveStack(html: string, cookies = ""): StackSignals {
  const evidence: string[] = [];
  const commerce = detectCommerce(html, cookies);

  // Salesforce Commerce Cloud (Demandware) — unambiguous host/cookie markers,
  // checked first so a store using generic classes isn't mis-read.
  if (commerce === "salesforce-commerce") {
    evidence.push("demandware/cquotient");
    return { frontend: "salesforce-commerce", htmx: false, commerce, evidence };
  }

  // VTEX FastStore (v4) — the `data-fs-*` design-system attributes.
  if ((html.match(/data-fs-/g) ?? []).length > 3) {
    evidence.push("data-fs-*");
    return { frontend: "faststore", htmx: false, commerce: commerce === "unknown" ? "vtex" : commerce, evidence };
  }

  // VTEX IO Store Framework — the render-runtime serialized into the page.
  if (has(/__RUNTIME__/, html) && has(/render-runtime/i, html)) {
    evidence.push("__RUNTIME__ + render-runtime");
    return { frontend: "vtex-io", htmx: false, commerce: commerce === "unknown" ? "vtex" : commerce, evidence };
  }

  // Deco on Fresh — the frontend we most often migrate. Custom domains land here.
  if (isDeco(html)) {
    if (/deco\.cx/i.test(html)) evidence.push("deco.cx");
    if (/__FRSH|_frsh/.test(html)) evidence.push("fresh-runtime");
    if (html.includes("/live/invoke")) evidence.push("/live/invoke");
    const htmx = detectHtmx(html);
    if (htmx) evidence.push("htmx");
    return { frontend: "deco-fresh", htmx, commerce, evidence };
  }

  if (commerce !== "unknown") evidence.push(`commerce:${commerce}`);
  return { frontend: "unknown", htmx: false, commerce, evidence };
}

/** One-line summary for the migrate log + the report. */
export function describeStack(s: StackSignals): string {
  const parts = [s.frontend + (s.htmx ? " + htmx" : "")];
  if (s.commerce !== "unknown" && s.commerce !== s.frontend) parts.push(`commerce: ${s.commerce}`);
  return parts.join(", ");
}
