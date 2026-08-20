import * as cheerio from "cheerio";
import type { CheckResult, Issue, PageCapture } from "../types/schema.ts";
import type { CheckContext } from "./index.ts";

/**
 * Favicon / webmanifest parity. A migration routinely ships only
 * `<link rel="icon" href="/favicon.ico">` and drops the size variants +
 * `site.webmanifest` the original had — bad bookmarks/PWA on mobile — or, worse,
 * deploys a favicon from a DIFFERENT site (branding regression). Neither shows
 * up in a screenshot diff. We compare the icon links present on the home page
 * and, when both sides expose a primary icon, hash the bytes.
 */
export async function faviconParity(ctx: CheckContext): Promise<CheckResult> {
  const start = Date.now();
  const issues: Issue[] = [];

  const prodHome = pickHome(ctx.prodPages);
  const candHome = pickHome(ctx.candPages);

  if (!candHome) {
    return skip(start, "Nenhuma captura de home do candidato — nada para validar");
  }
  if (!prodHome) {
    // Single-site: only flag a total absence of any icon.
    const cand = extractIcons(candHome);
    if (!cand.icon && !cand.manifest) {
      issues.push({
        id: "favicon:none",
        severity: "medium",
        category: "seo",
        check: "favicon-parity",
        summary: "Nenhum favicon nem webmanifest no candidato",
      });
    }
    return finish(start, issues, "single-site");
  }

  const prod = extractIcons(prodHome);
  const cand = extractIcons(candHome);

  if (prod.manifest && !cand.manifest) {
    issues.push({
      id: "favicon:manifest-missing",
      severity: "medium",
      category: "seo",
      check: "favicon-parity",
      summary: `prod expõe <link rel="manifest"> (${prod.manifest}) mas o candidato não — afeta PWA/bookmarks no mobile`,
    });
  }

  if (prod.icon && !cand.icon) {
    issues.push({
      id: "favicon:icon-missing",
      severity: "high",
      category: "seo",
      check: "favicon-parity",
      summary: "prod tem <link rel='icon'> mas o candidato não expõe nenhum favicon",
    });
  }

  // Content hash of the primary icon — catches a favicon from a different site.
  if (prod.icon && cand.icon) {
    const [ph, ch] = await Promise.all([
      hashUrl(prod.icon, prodHome.finalUrl),
      hashUrl(cand.icon, candHome.finalUrl),
    ]);
    if (ph && ch && ph !== ch) {
      issues.push({
        id: "favicon:hash-diff",
        severity: "high",
        category: "seo",
        check: "favicon-parity",
        summary:
          "Favicon do candidato é diferente do prod (hash divergente) — possível branding/site errado",
        details: `prod: ${prod.icon}\ncand: ${cand.icon}`,
      });
    }
  }

  return finish(start, issues, "comparative");
}

interface Icons {
  icon: string | null;
  manifest: string | null;
}

function extractIcons(page: PageCapture): Icons {
  try {
    const $ = cheerio.load(page.html);
    const icon =
      $('link[rel~="icon"]').first().attr("href")?.trim() ||
      $('link[rel="apple-touch-icon"]').first().attr("href")?.trim() ||
      null;
    const manifest = $('link[rel="manifest"]').first().attr("href")?.trim() || null;
    return { icon, manifest };
  } catch {
    return { icon: null, manifest: null };
  }
}

async function hashUrl(href: string, base: string): Promise<string | null> {
  let url: string;
  try {
    url = new URL(href, base).toString();
  } catch {
    return null;
  }
  try {
    const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", buf);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}

function pickHome(pages: PageCapture[]): PageCapture | undefined {
  return pages.find((p) => {
    try {
      const path = new URL(p.url).pathname;
      return path === "/" || path === "";
    } catch {
      return false;
    }
  });
}

function skip(start: number, summary: string): CheckResult {
  return {
    name: "favicon-parity",
    status: "skipped",
    severity: "medium",
    durationMs: Date.now() - start,
    summary,
    issues: [],
  };
}

function finish(start: number, issues: Issue[], mode: string): CheckResult {
  const status: CheckResult["status"] = issues.some((i) => i.severity === "high")
    ? "fail"
    : issues.length > 0
      ? "warn"
      : "pass";
  return {
    name: "favicon-parity",
    status,
    severity: "high",
    durationMs: Date.now() - start,
    summary: `${issues.length} issue(s) de favicon/manifest — mode: ${mode}`,
    issues,
  };
}
