/**
 * Matching for divergences the team already decided are intentional. Issue #296.
 *
 * The motivating case: a migration target that deliberately ships a BETTER component than prod —
 * usually one brought over from another site. prod stops being the reference for it, so every run
 * reports the same difference forever, the score never reaches its target, and the finding trains
 * the reader to ignore the visual module entirely.
 *
 * Reclassify, don't silence. Suppressing the region would hide a real regression inside the
 * improved component just as effectively as it hides the expected difference.
 */

import type { ExpectedDivergence } from "../types/schema.ts";

/**
 * The first entry whose `match` appears in any of `haystacks` (case-insensitive), or null.
 *
 * Substring rather than exact: one component surfaces as a section name (`ProductShelf`), a region
 * label (`main`), and prose from the LLM ("the product shelf uses a different card layout"), and a
 * team should not have to write three rules for one decision.
 */
export function matchExpectedDivergence(
  haystacks: (string | undefined)[],
  expected: ExpectedDivergence[],
): ExpectedDivergence | null {
  if (expected.length === 0) return null;
  const text = haystacks
    .filter((h): h is string => Boolean(h))
    .join("   ")
    .toLowerCase();
  if (!text) return null;
  for (const e of expected) {
    const needle = e.match.trim().toLowerCase();
    // An empty `match` would silently swallow every finding — the worst possible failure mode for
    // a feature whose whole point is making decisions visible.
    if (!needle) continue;
    if (text.includes(needle)) return e;
  }
  return null;
}

/** Split section names into the ones already accounted for and the ones still worth reporting. */
export function partitionExpectedSections(
  sections: string[],
  expected: ExpectedDivergence[],
): { reportable: string[]; accepted: { section: string; note: string }[] } {
  const reportable: string[] = [];
  const accepted: { section: string; note: string }[] = [];
  for (const section of sections) {
    const hit = matchExpectedDivergence([section], expected);
    if (hit) accepted.push({ section, note: hit.note });
    else reportable.push(section);
  }
  return { reportable, accepted };
}
