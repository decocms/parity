/**
 * Read the Content Platform's authoring shape, which is not the shape the storefront reads.
 *
 * The delivery API (`/data/...`) hands out flat arrays and plain values. Authoring wraps
 * everything twice: collections become `{ $fnType, values: { "<numeric id>": item } }`, and every
 * leaf becomes a per-locale switch:
 *
 *     { "$fnType": "switch", "varyByKeys": ["locale"], "cases": null,
 *       "defaultCase": "https://…png", "configurationSourceType": "contexts" }
 *
 * Pulling from delivery and committing that back does not work. These helpers only *read* the
 * authoring shape so diffs and listings are legible; nothing here rewrites it. Converting a
 * captured VTEX IO block tree into it is a separate job with its own reviewable plan.
 */

/** A locale switch, or a plain value that was never wrapped. */
export function unwrapValue(node: unknown): unknown {
  if (node && typeof node === "object" && !Array.isArray(node)) {
    const obj = node as Record<string, unknown>;
    if (obj.$fnType === "switch" && "defaultCase" in obj) return obj.defaultCase;
  }
  return node;
}

/** An authoring collection (`{values}`) as an array, or an already-flat array unchanged. */
export function collectionToArray(node: unknown): Record<string, unknown>[] {
  if (Array.isArray(node)) return node as Record<string, unknown>[];
  if (node && typeof node === "object") {
    const values = (node as Record<string, unknown>).values;
    if (values && typeof values === "object") {
      return Object.values(values as Record<string, Record<string, unknown>>);
    }
  }
  return [];
}

export interface AuthoringSection {
  id: string | number | null;
  componentKey: string;
  position: number | null;
}

/**
 * The sections of an entry, ordered the way the page renders them. `$position` is the source of
 * truth; the numeric keys only look ordered because they are creation timestamps.
 */
export function sectionsOf(data: Record<string, unknown> | undefined): AuthoringSection[] {
  if (!data) return [];
  return collectionToArray(data.sections)
    .map((s) => ({
      id: (s.id as string | number) ?? null,
      componentKey: String(s.$componentKey ?? "?"),
      position: typeof s.$position === "number" ? s.$position : null,
    }))
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
}

/**
 * A one-line summary per section, for terminal output. Counting nested collections is what makes
 * a diff readable — "HeroSwiper slides 12 → 13" is the whole story most of the time.
 */
export function summarizeSections(data: Record<string, unknown> | undefined): string[] {
  if (!data) return [];
  const sections = collectionToArray(data.sections);
  return sectionsOf(data).map((s) => {
    const raw = sections.find((x) => x.id === s.id) ?? {};
    const counts = Object.entries(raw)
      .filter(([, v]) => collectionToArray(v).length > 0)
      .map(([k, v]) => `${k}=${collectionToArray(v).length}`);
    return counts.length > 0 ? `${s.componentKey} (${counts.join(", ")})` : s.componentKey;
  });
}
