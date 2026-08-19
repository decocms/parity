import { createHash } from "node:crypto";
import * as cheerio from "cheerio";

/**
 * Shared HTML-compaction helpers for the LLM prompts (selector discovery,
 * step recovery) and the selector-cache fingerprint. Previously duplicated
 * between `discover-selectors.ts:isSemanticClass` and
 * `recover-step.ts:isSemanticClassToken` (drift risk, acknowledged in a
 * code comment) — now single-sourced here.
 */

/**
 * Heuristic: should this class token survive the Tailwind purge?
 *
 * Keep:
 *   - Single descriptive word: `card`, `header`, `product-card`
 *   - Component-style hyphenated: `product-list`, `nav-item`
 *   - Platform prefixed: `vtex-*`, `fs-*`, `shopify-*`, `bag-*`
 *
 * Drop:
 *   - Utility tokens: `w-full`, `h-12`, `lg:text-xs`, `after:bg-no-repeat`
 *   - Pseudo-prefixed: `hover:*`, `lg:*`, `sm:*`, `2xl:*`, `dark:*`, `before:*`
 *   - Numeric utilities: `h-12`, `min-h-9`, `w-[198px]`
 *   - Anything with `:` or `[` (Tailwind variants / arbitrary values)
 *   - Single-letter or very short cryptic tokens: `p`, `m`, `px`, `py`
 */
export function isSemanticClassToken(token: string): boolean {
  if (token.length === 0 || token.length > 40) return false;
  if (token.includes(":") || token.includes("[") || token.includes("/")) return false;
  // Numeric/utility shape: "h-12", "min-h-9", "px-5", "gap-1"
  if (/^[a-z]{1,4}(-[a-z]{1,3})?-\d/.test(token)) return false;
  // Single-letter + digit (`m2`, `p5`)
  if (/^[a-z]{1,2}\d+$/.test(token)) return false;
  // Pure prefix tokens
  if (
    /^(w|h|p|m|px|py|pt|pb|pl|pr|mt|mb|ml|mr|gap|flex|grid|text|bg|border|rounded|shadow|opacity|cursor|min|max)-/i.test(
      token,
    ) &&
    !/^(text|bg|border)-(primary|secondary|accent|brand|warning|error|success|muted|base|surface)$/i.test(
      token,
    )
  ) {
    // Keep semantic color tokens like `text-primary` / `bg-brand`; drop
    // everything else from this list.
    return false;
  }
  // Plain bare tokens like `flex`, `block`, `hidden`, `relative`, `absolute`
  if (
    /^(flex|grid|block|inline|hidden|relative|absolute|fixed|static|sticky|visible|invisible|truncate|uppercase|lowercase|capitalize|italic|underline|overline|line-through|no-underline|antialiased|subpixel-antialiased|whitespace|break-words|break-all|object-cover|object-contain|object-fill|object-none|object-scale-down|select-none|select-text|select-all|pointer-events-none|pointer-events-auto|appearance-none|resize-none|leading-none|font-bold|font-medium|font-semibold|font-light|tracking-wide|tracking-tight)$/.test(
      token,
    )
  ) {
    return false;
  }
  return true;
}

/**
 * Reduce HTML to the chunks the LLM actually needs to infer selectors,
 * to fit comfortably in a Sonnet context. Key passes:
 *
 *   1. Drop the obvious heavy noise (scripts, styles, SVG, JSON-LD, etc).
 *   2. Strip Tailwind utility-class soup — the typical Deco TanStack card
 *      has `class="card w-full card-compact group rounded border ..."`
 *      where every word is a utility token. None of it is useful for
 *      identifying the element; it just blows up the prompt. We keep
 *      classes that look semantic (single-token, no spaces, has a dash
 *      OR plain word, < 40 chars) and drop the rest.
 *   3. Strip URL-encoded JSON in data-event / data-track attrs (Deco
 *      sites embed product analytics blobs that can be 5-10kb each).
 *   4. Re-extract the shelf region using broader patterns (Deco TanStack
 *      uses `[data-product-list]`; Bagaggio carries `aria-label="view product"`
 *      on the actual product link).
 */
export function compactHtmlForSelectors(html: string, maxChars = 30_000): string {
  try {
    const $ = cheerio.load(html);
    // Drop irrelevant heavy parts
    $("script, style, noscript, svg, picture source, link[rel='stylesheet']").remove();
    $("[type='application/ld+json']").remove();
    // Strip noisy attributes that don't help selector discovery — these are
    // usually huge URL-encoded JSON blobs (analytics events).
    $("*").each((_, el) => {
      const attrs = (el as { attribs?: Record<string, string> }).attribs ?? {};
      for (const name of Object.keys(attrs)) {
        if (name === "data-event" || name === "data-track" || name === "data-analytics") {
          const value = attrs[name] ?? "";
          // Replace the value with a short marker so the structural fact "this
          // element carries a tracking attr" survives (sometimes useful to
          // detect product cards) without the multi-kb blob.
          if (value.length > 100) attrs[name] = "[…]";
        }
        // Drop inline style — never used as a selector anchor.
        if (name === "style") delete attrs[name];
      }
      // Tailwind utility-class purge. Keep tokens that look like semantic
      // names; drop classic utility patterns: "w-full", "h-12", "flex",
      // "items-center", "bg-primary", "lg:text-xs", "after:bg-no-repeat", etc.
      if (attrs.class) {
        const tokens = attrs.class.split(/\s+/).filter(Boolean);
        const kept = tokens.filter((t) => isSemanticClassToken(t));
        const joined = kept.join(" ");
        if (joined) {
          attrs.class = joined;
        } else {
          // Drop the attribute entirely when nothing semantic remains —
          // cheerio's attribs type is `Record<string, string>` so we
          // can't assign undefined; delete is the right tool here.
          // biome-ignore lint/performance/noDelete: cheerio attribs are a plain object that needs the key gone, not undefined.
          delete attrs.class;
        }
      }
    });

    const sections: string[] = [];

    // Always include the head meta (helps detect platform)
    const head = $("head").clone();
    head
      .find(
        "title, meta[name='generator'], meta[name='vtex'], meta[name='platform'], link[rel='canonical']",
      )
      .each((_, el) => {
        sections.push($.html(el)!);
      });

    // Header + nav
    $("header, nav, [role='banner']").each((_, el) => {
      sections.push($.html(el)!);
    });

    // First "shelf"/product list-like region. Includes:
    // - explicit data attrs from VTEX / Deco classic
    // - `data-product-list` from Deco TanStack (bagaggio pattern)
    // - any `<a aria-label="view product">` link's container
    const shelf = $(
      "[data-product-card], [data-deco='view-product'], [data-product-list], article a[href*='/p/'], article a[href*='/products/'], a[aria-label='view product']",
    )
      .closest("section, ul, div")
      .first();
    if (shelf.length > 0) sections.push($.html(shelf)!);

    // Forms (search, newsletter, login) — may contain useful affordances
    $("form").each((_, el) => {
      sections.push($.html(el)!);
    });

    // Footer for completeness
    const footer = $("footer").first();
    if (footer.length > 0) sections.push($.html(footer)!);

    const joined = sections.join("\n<!-- ── section break ── -->\n");
    if (joined.length <= maxChars) return joined;
    return `${joined.slice(0, maxChars)}\n<!-- TRUNCATED -->`;
  } catch {
    return html.slice(0, maxChars);
  }
}

/**
 * Structural fingerprint of a page, used to invalidate the selector cache
 * when the site's THEME/STRUCTURE changes while staying stable across
 * routine content rotation (new products, banners, copy).
 *
 * Built from the sorted, deduped set of structural anchors a selector could
 * target: tag names, ids, semantic class tokens (post Tailwind purge) and
 * data-* / aria-label attribute NAMES. Content text, hrefs and attribute
 * values are deliberately excluded.
 */
export function computeHtmlFingerprint(html: string): string {
  const anchors = new Set<string>();
  try {
    const $ = cheerio.load(html);
    $("script, style, noscript, svg").remove();
    $("*").each((_, el) => {
      const node = el as { tagName?: string; attribs?: Record<string, string> };
      if (node.tagName) anchors.add(`t:${node.tagName.toLowerCase()}`);
      const attrs = node.attribs ?? {};
      for (const name of Object.keys(attrs)) {
        if (name === "id") {
          const id = attrs.id ?? "";
          // Skip generated/hashed ids — they change every deploy.
          if (id && !/\d{3,}|[A-Za-z0-9]{12,}/.test(id)) anchors.add(`#:${id}`);
        } else if (name.startsWith("data-") || name === "aria-label" || name === "role") {
          anchors.add(`a:${name}`);
        } else if (name === "class") {
          for (const token of (attrs.class ?? "").split(/\s+/).filter(Boolean)) {
            if (isSemanticClassToken(token)) anchors.add(`c:${token}`);
          }
        }
      }
    });
  } catch {
    // Malformed HTML: fall back to hashing the raw prefix so the function
    // still returns a stable value instead of throwing mid-discovery.
    return createHash("sha256").update(html.slice(0, 50_000)).digest("hex");
  }
  const sorted = [...anchors].sort().join("\n");
  return createHash("sha256").update(sorted).digest("hex");
}
