import * as cheerio from "cheerio";

export type JsonLdObject = Record<string, unknown>;

/**
 * Extract all JSON-LD blocks from an HTML string and group them by @type.
 * Returns a Map<type, JsonLdObject[]> — types may appear multiple times.
 */
export function extractJsonLd(html: string): Map<string, JsonLdObject[]> {
  const out = new Map<string, JsonLdObject[]>();
  try {
    const $ = cheerio.load(html);
    $('script[type="application/ld+json"]').each((_, el) => {
      const text = $(el).text();
      try {
        const parsed = JSON.parse(text) as JsonLdObject | JsonLdObject[];
        const items = Array.isArray(parsed) ? parsed : [parsed];
        for (const item of items) {
          // Skip null/non-object entries so one bad item doesn't drop the whole array
          if (!item || typeof item !== "object") continue;
          collectByType(item, out);
        }
      } catch {
        /* invalid JSON-LD */
      }
    });
  } catch {
    /* ignore */
  }
  return out;
}

function collectByType(obj: JsonLdObject, out: Map<string, JsonLdObject[]>): void {
  const type = obj["@type"];
  if (typeof type === "string") {
    const arr = out.get(type) ?? [];
    arr.push(obj);
    out.set(type, arr);
  } else if (Array.isArray(type)) {
    for (const t of type) {
      if (typeof t === "string") {
        const arr = out.get(t) ?? [];
        arr.push(obj);
        out.set(t, arr);
      }
    }
  }
  // Also recurse into @graph
  const graph = obj["@graph"];
  if (Array.isArray(graph)) {
    for (const g of graph) {
      if (g && typeof g === "object") collectByType(g as JsonLdObject, out);
    }
  }
}

export interface ProductSchemaDiff {
  bothPresent: boolean;
  prodOnly: boolean;
  candOnly: boolean;
  missingFieldsInCand: string[]; // critical fields that vanished
  changedFields: Array<{ field: string; prod: unknown; cand: unknown }>;
}

const PRODUCT_REQUIRED_PATHS = [
  "name",
  "image",
  "sku",
  "brand",
  "description",
  "offers.price",
  "offers.priceCurrency",
  "offers.availability",
];

export function diffProductSchema(
  prodMap: Map<string, JsonLdObject[]>,
  candMap: Map<string, JsonLdObject[]>,
): ProductSchemaDiff {
  const p = prodMap.get("Product")?.[0];
  const c = candMap.get("Product")?.[0];

  const out: ProductSchemaDiff = {
    bothPresent: !!p && !!c,
    prodOnly: !!p && !c,
    candOnly: !p && !!c,
    missingFieldsInCand: [],
    changedFields: [],
  };

  if (!p || !c) return out;

  for (const path of PRODUCT_REQUIRED_PATHS) {
    const prodValue = getPath(p, path);
    const candValue = getPath(c, path);
    if (prodValue !== undefined && prodValue !== null && (candValue === undefined || candValue === null)) {
      out.missingFieldsInCand.push(path);
      continue;
    }
    if (path === "offers.price") {
      const pNum = toNumber(prodValue);
      const cNum = toNumber(candValue);
      if (pNum != null && cNum != null && Math.abs((cNum - pNum) / pNum) > 0.01) {
        out.changedFields.push({ field: path, prod: pNum, cand: cNum });
      }
    } else if (typeof prodValue === "string" && typeof candValue === "string") {
      if (normalize(prodValue) !== normalize(candValue)) {
        out.changedFields.push({ field: path, prod: prodValue, cand: candValue });
      }
    }
  }
  return out;
}

export interface BreadcrumbSchemaDiff {
  bothPresent: boolean;
  prodOnly: boolean;
  candOnly: boolean;
  prodItemCount: number;
  candItemCount: number;
}

export function diffBreadcrumbSchema(
  prodMap: Map<string, JsonLdObject[]>,
  candMap: Map<string, JsonLdObject[]>,
): BreadcrumbSchemaDiff {
  const p = prodMap.get("BreadcrumbList")?.[0];
  const c = candMap.get("BreadcrumbList")?.[0];
  return {
    bothPresent: !!p && !!c,
    prodOnly: !!p && !c,
    candOnly: !p && !!c,
    prodItemCount: itemListLength(p),
    candItemCount: itemListLength(c),
  };
}

export interface OrganizationSchemaDiff {
  prodPresent: boolean;
  candPresent: boolean;
}

export function diffOrganizationSchema(
  prodMap: Map<string, JsonLdObject[]>,
  candMap: Map<string, JsonLdObject[]>,
): OrganizationSchemaDiff {
  return {
    prodPresent: prodMap.has("Organization"),
    candPresent: candMap.has("Organization"),
  };
}

function itemListLength(obj: JsonLdObject | undefined): number {
  if (!obj) return 0;
  const list = obj.itemListElement;
  if (Array.isArray(list)) return list.length;
  return 0;
}

function getPath(obj: JsonLdObject, path: string): unknown {
  const parts = path.split(".");
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur && typeof cur === "object" && p in (cur as object)) {
      cur = (cur as Record<string, unknown>)[p];
    } else if (Array.isArray(cur) && cur.length > 0) {
      const first = cur[0];
      if (first && typeof first === "object" && p in (first as object)) {
        cur = (first as Record<string, unknown>)[p];
      } else {
        return undefined;
      }
    } else {
      return undefined;
    }
  }
  return cur;
}

function toNumber(v: unknown): number | null {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v.replace(",", "."));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function normalize(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}
