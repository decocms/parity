import type { MatchedRule, TraceResult } from "../commands/css-trace.ts";

/**
 * "Which CSS rule produced this computed value?" resolver.
 *
 * For an LLM to write a pixel-perfect fix it isn't enough to know that
 * `color` differs between prod and cand — it needs to know which rule
 * is responsible so it can patch the *right* file. CDP gives us a
 * cascade-ordered list of matched rules; this module walks that list
 * and returns the *winning* rule per property using standard cascade
 * semantics:
 *
 *   1. `!important` declarations beat non-`!important`
 *   2. Within the same importance tier, the LAST matching rule wins
 *      (CDP returns rules in cascade order, last = highest specificity
 *      after the browser's resolution)
 *   3. Inherited rules count for inheritable properties only, and only
 *      when no direct rule sets the property
 *
 * Built on top of `tracePage()` (re-exported from `css-trace.ts`) so we
 * don't duplicate the heavy CDP plumbing.
 */

export interface CssSource {
  /** Stylesheet identifier returned by CDP — `"user-agent"`, `"inline"`, or `stylesheet#<id> (preview)`. */
  source: string;
  /** Selector that matched, e.g. `.btn, button.primary`. */
  selector: string;
  /** The actual declared value (may include shorthand expansion). */
  value: string;
  /** True when the rule declared this property with `!important`. */
  important: boolean;
  /** 0 = applied to the element itself; >0 = inherited from an ancestor at that distance. */
  inheritedFromDistance: number;
}

/** Properties commonly inherited via CSS cascade. Used as a fallback signal
 *  for the heuristic "this value isn't in any direct rule — must be
 *  inherited". Not exhaustive but covers the cases the section-bundle
 *  surfaces. */
const INHERITABLE_PROPERTIES = new Set<string>([
  "color",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "line-height",
  "letter-spacing",
  "text-align",
  "text-transform",
  "text-indent",
  "visibility",
  "direction",
]);

/**
 * Pure resolution from an already-fetched TraceResult. Exposed so tests
 * can inject synthetic cascades without booting Playwright.
 *
 * Returns a Map keyed by property name (lowercase, CSS standard). When
 * a property is in `props` but no matching rule was found, the map entry
 * is `null` — distinguishes "user-agent default" from "we forgot to
 * check that property".
 */
export function resolveFromTrace(
  trace: TraceResult,
  props: Iterable<string>,
): Map<string, CssSource | null> {
  const result = new Map<string, CssSource | null>();
  const wanted = new Set<string>();
  for (const p of props) wanted.add(p.toLowerCase());

  // Walk all rules and collect every (property → MatchedRule) candidate.
  // CDP returns rules in cascade order; we trust that ordering and
  // pick the LAST important match, falling back to the LAST non-important.
  const candidates = new Map<string, { rule: MatchedRule; value: string; important: boolean }[]>();
  for (const rule of trace.rules) {
    for (const prop of rule.properties) {
      const name = prop.name.toLowerCase();
      if (!wanted.has(name)) continue;
      // Skip rules that are inherited but the property isn't inheritable —
      // those wouldn't carry through to the target element.
      const dist = rule.inheritedFromDistance ?? 0;
      if (dist > 0 && !INHERITABLE_PROPERTIES.has(name)) continue;
      const list = candidates.get(name) ?? [];
      list.push({ rule, value: prop.value, important: prop.important });
      candidates.set(name, list);
    }
  }

  for (const prop of wanted) {
    const list = candidates.get(prop);
    if (!list || list.length === 0) {
      result.set(prop, null);
      continue;
    }
    // Prefer the LAST !important. Otherwise the LAST plain match.
    let winner = list[list.length - 1];
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i]?.important) {
        winner = list[i];
        break;
      }
    }
    if (!winner) {
      result.set(prop, null);
      continue;
    }
    result.set(prop, {
      source: winner.rule.source,
      selector: winner.rule.selector,
      value: winner.value,
      important: winner.important,
      inheritedFromDistance: winner.rule.inheritedFromDistance ?? 0,
    });
  }
  return result;
}
