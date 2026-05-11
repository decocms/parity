import * as cheerio from "cheerio";
import { collapseWhitespace, normalizeForCompare } from "../engine/normalize.ts";

export interface DomCounts {
  h1: number;
  h2: number;
  links: number;
  imgs: number;
  forms: number;
  buttons: number;
  inputs: number;
  scripts: number;
  iframes: number;
}

export interface MetaSeo {
  title: string | null;
  description: string | null;
  canonical: string | null;
  robots: string | null;
  og: Record<string, string>;
  twitter: Record<string, string>;
  jsonLdTypes: string[];
}

export interface DomSnapshot {
  counts: DomCounts;
  meta: MetaSeo;
  imageStats: {
    total: number;
    withSrcset: number;
    withAlt: number;
    withoutAlt: number;
    src: string[];
  };
  decoSectionsRendered: string[];
}

export function snapshotDom(html: string): DomSnapshot {
  const $ = cheerio.load(html);

  const counts: DomCounts = {
    h1: $("h1").length,
    h2: $("h2").length,
    links: $("a[href]").length,
    imgs: $("img").length,
    forms: $("form").length,
    buttons: $("button").length,
    inputs: $("input").length,
    scripts: $("script").length,
    iframes: $("iframe").length,
  };

  const og: Record<string, string> = {};
  const twitter: Record<string, string> = {};
  $('meta[property^="og:"]').each((_, el) => {
    const prop = $(el).attr("property")!;
    og[prop] = $(el).attr("content") ?? "";
  });
  $('meta[name^="twitter:"]').each((_, el) => {
    const name = $(el).attr("name")!;
    twitter[name] = $(el).attr("content") ?? "";
  });

  const jsonLdTypes: string[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const parsed = JSON.parse($(el).text());
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        const type = (item as Record<string, unknown>)["@type"];
        if (typeof type === "string") jsonLdTypes.push(type);
        else if (Array.isArray(type)) jsonLdTypes.push(...type.filter((t) => typeof t === "string"));
      }
    } catch {
      /* invalid JSON-LD, ignore */
    }
  });

  const meta: MetaSeo = {
    title: $("title").first().text().trim() || null,
    description: $('meta[name="description"]').attr("content")?.trim() ?? null,
    canonical: $('link[rel="canonical"]').attr("href") ?? null,
    robots: $('meta[name="robots"]').attr("content") ?? null,
    og,
    twitter,
    jsonLdTypes: jsonLdTypes.sort(),
  };

  const imgs = $("img");
  const imageStats = {
    total: imgs.length,
    withSrcset: imgs.filter((_, el) => Boolean($(el).attr("srcset"))).length,
    withAlt: imgs.filter((_, el) => Boolean($(el).attr("alt"))).length,
    withoutAlt: imgs.filter((_, el) => !$(el).attr("alt")).length,
    src: imgs
      .map((_, el) => $(el).attr("src") ?? "")
      .get()
      .filter(Boolean),
  };

  // Deco-specific: sections may be marked with data-section or x-deco-* annotations
  const decoSectionsRendered: string[] = [];
  $("[data-section]").each((_, el) => {
    const v = $(el).attr("data-section");
    if (v) decoSectionsRendered.push(v);
  });

  return { counts, meta, imageStats, decoSectionsRendered: [...new Set(decoSectionsRendered)] };
}

export interface DomDiff {
  countsDelta: Partial<Record<keyof DomCounts, { prod: number; cand: number; delta: number }>>;
  metaDelta: Array<{ key: string; prod: string | null; cand: string | null; equal: boolean }>;
  imagesDelta: {
    totalDelta: number;
    withSrcsetDelta: number;
    withoutAltDelta: number;
  };
  decoSectionsOnlyProd: string[];
  decoSectionsOnlyCand: string[];
  anyFailed: boolean;
}

export interface DomDiffOptions {
  countTolerance?: number; // ±N per count
}

export function diffDom(
  prod: DomSnapshot,
  cand: DomSnapshot,
  opts: DomDiffOptions = {},
): DomDiff {
  const tol = opts.countTolerance ?? 2;
  const countsDelta: DomDiff["countsDelta"] = {};
  let anyFailed = false;
  for (const key of Object.keys(prod.counts) as (keyof DomCounts)[]) {
    const p = prod.counts[key];
    const c = cand.counts[key];
    const d = c - p;
    if (Math.abs(d) > tol) {
      countsDelta[key] = { prod: p, cand: c, delta: d };
      anyFailed = true;
    }
  }

  const metaDelta = diffMeta(prod.meta, cand.meta);
  if (metaDelta.some((m) => !m.equal)) anyFailed = true;

  const imagesDelta = {
    totalDelta: cand.imageStats.total - prod.imageStats.total,
    withSrcsetDelta: cand.imageStats.withSrcset - prod.imageStats.withSrcset,
    withoutAltDelta: cand.imageStats.withoutAlt - prod.imageStats.withoutAlt,
  };

  const prodSecs = new Set(prod.decoSectionsRendered);
  const candSecs = new Set(cand.decoSectionsRendered);
  const decoSectionsOnlyProd = [...prodSecs].filter((s) => !candSecs.has(s));
  const decoSectionsOnlyCand = [...candSecs].filter((s) => !prodSecs.has(s));
  if (decoSectionsOnlyProd.length > 0) anyFailed = true;

  return { countsDelta, metaDelta, imagesDelta, decoSectionsOnlyProd, decoSectionsOnlyCand, anyFailed };
}

function diffMeta(prod: MetaSeo, cand: MetaSeo): DomDiff["metaDelta"] {
  const out: DomDiff["metaDelta"] = [];
  const norm = (s: string | null) => (s == null ? null : normalizeForCompare(collapseWhitespace(s)).toLowerCase());

  const simpleKeys: (keyof MetaSeo)[] = ["title", "description", "canonical", "robots"];
  for (const key of simpleKeys) {
    const p = prod[key] as string | null;
    const c = cand[key] as string | null;
    out.push({ key: String(key), prod: p, cand: c, equal: norm(p) === norm(c) });
  }

  const allOg = new Set([...Object.keys(prod.og), ...Object.keys(cand.og)]);
  for (const k of allOg) {
    out.push({
      key: k,
      prod: prod.og[k] ?? null,
      cand: cand.og[k] ?? null,
      equal: norm(prod.og[k] ?? null) === norm(cand.og[k] ?? null),
    });
  }
  const allTw = new Set([...Object.keys(prod.twitter), ...Object.keys(cand.twitter)]);
  for (const k of allTw) {
    out.push({
      key: k,
      prod: prod.twitter[k] ?? null,
      cand: cand.twitter[k] ?? null,
      equal: norm(prod.twitter[k] ?? null) === norm(cand.twitter[k] ?? null),
    });
  }

  out.push({
    key: "json-ld-types",
    prod: prod.jsonLdTypes.join(","),
    cand: cand.jsonLdTypes.join(","),
    equal: prod.jsonLdTypes.join(",") === cand.jsonLdTypes.join(","),
  });

  return out;
}
