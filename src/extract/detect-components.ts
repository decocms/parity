import type { Page } from "playwright";
import { isUnderstandingAvailable } from "../llm/section-understanding.ts";
import type { DetectedComponent } from "../types/extract.ts";

/**
 * Component auto-detection for `parity extract` (M5).
 *
 * A heuristic pass ALWAYS runs (no LLM required) — it walks semantic
 * HTML/selectors that show up across both classic Deco (Fresh/Preact,
 * `data-section`/`data-deco-section`) and TanStack Start sites, plus a
 * geometry pass for above-the-fold hero/banner content that has no
 * semantic marker at all.
 *
 * An OPTIONAL LLM refinement pass can relabel/merge/split the heuristic
 * candidates — gated by `opts.llm && isComponentDetectionLlmAvailable()`,
 * mirroring the `isUnderstandingAvailable()` gate `section-understanding.ts`
 * uses for `--llm-summary`. See `refineComponentsWithLlm` in
 * `component-refine.ts` for what's actually wired vs stubbed.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RawCandidate {
  role: string;
  selector: string;
  rect: Rect;
  /** Larger = prefer keeping this candidate over an overlapping one with a lower priority. */
  priority: number;
}

export async function detectComponents(
  page: Page,
  opts?: { llm?: boolean },
): Promise<DetectedComponent[]> {
  const raw = await page.evaluate(collectCandidatesInPage);
  const deduped = dedupeByContainment(raw);
  const components: DetectedComponent[] = deduped.map((c) => ({
    role: c.role,
    selector: c.selector,
    boundingBox: c.rect,
  }));

  if (opts?.llm && isComponentDetectionLlmAvailable()) {
    const { refineComponentsWithLlm } = await import("../llm/component-refine.ts");
    const refined = await refineComponentsWithLlm(page, components);
    if (refined) return refined;
  }

  return components;
}

/** Same "is a provider configured" gate other optional LLM passes use. */
export function isComponentDetectionLlmAvailable(): boolean {
  return isUnderstandingAvailable();
}

/**
 * Pure containment-based dedup — isolated (no Page dependency) so it's
 * unit-testable with plain bounding-box fixtures.
 *
 * Rule: sort candidates by AREA descending (biggest first). Greedily
 * accept a candidate unless it's ≥90% contained within an ALREADY
 * accepted box AND that box has priority ≥ the candidate's priority —
 * this drops e.g. a `nav` nested inside `header` (nav ⊂ header, header
 * has ≥ priority) while still keeping two same-size siblings (neither
 * contained in the other) and keeping a higher-priority small element
 * (e.g. `minicart`) even if it happens to sit inside a lower-priority
 * large one.
 */
export function dedupeByContainment(candidates: RawCandidate[]): RawCandidate[] {
  const valid = candidates.filter((c) => c.rect.width > 0 && c.rect.height > 0);
  const sorted = [...valid].sort((a, b) => boxArea(b.rect) - boxArea(a.rect));
  const accepted: RawCandidate[] = [];
  for (const candidate of sorted) {
    const containedInAccepted = accepted.some(
      (a) => a.priority >= candidate.priority && containmentRatio(candidate.rect, a.rect) >= 0.9,
    );
    if (containedInAccepted) continue;
    accepted.push(candidate);
  }
  // Restore document order (top-to-bottom) for a more readable output.
  return accepted.sort((a, b) => a.rect.y - b.rect.y);
}

export function boxArea(box: Rect): number {
  return Math.max(0, box.width) * Math.max(0, box.height);
}

/** Area of `inner` that overlaps with `outer`, in px². */
export function boxOverlapArea(inner: Rect, outer: Rect): number {
  const x1 = Math.max(inner.x, outer.x);
  const y1 = Math.max(inner.y, outer.y);
  const x2 = Math.min(inner.x + inner.width, outer.x + outer.width);
  const y2 = Math.min(inner.y + inner.height, outer.y + outer.height);
  return Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
}

/** Fraction of `inner`'s area that overlaps with `outer` (0..1). */
export function containmentRatio(inner: Rect, outer: Rect): number {
  const innerArea = boxArea(inner);
  if (innerArea === 0) return 0;
  return boxOverlapArea(inner, outer) / innerArea;
}

/**
 * Runs INSIDE the page via `page.evaluate` — no access to Node-only
 * symbols. Kept as a single function (not split across files) since
 * Playwright serializes it as a source string.
 */
function collectCandidatesInPage(): RawCandidate[] {
  function cssPath(el: Element): string {
    if (el.id) return `#${CSS.escape(el.id)}`;
    const parts: string[] = [];
    let node: Element | null = el;
    let depth = 0;
    while (node && node.nodeType === 1 && depth < 6) {
      let selector = node.tagName.toLowerCase();
      if (node.id) {
        parts.unshift(`#${CSS.escape(node.id)}`);
        break;
      }
      const parent: Element | null = node.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((c) => c.tagName === node!.tagName);
        if (siblings.length > 1) {
          const idx = siblings.indexOf(node) + 1;
          selector += `:nth-of-type(${idx})`;
        }
      }
      parts.unshift(selector);
      node = parent;
      depth++;
    }
    return parts.join(" > ");
  }

  function rectOf(el: Element) {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }

  function slug(s: string): string {
    return (
      s
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) || "section"
    );
  }

  const priorityByRole: Record<string, number> = {
    header: 100,
    footer: 100,
    nav: 60,
    banner: 70,
    hero: 80,
    minicart: 90,
    shelf: 50,
    carousel: 40,
    section: 30,
  };

  const seen = new Set<Element>();
  const out: RawCandidate[] = [];

  function push(role: string, el: Element): void {
    if (seen.has(el)) return;
    seen.add(el);
    out.push({
      role,
      selector: cssPath(el),
      rect: rectOf(el),
      priority: priorityByRole[role] ?? 30,
    });
  }

  for (const el of Array.from(document.querySelectorAll("header"))) push("header", el);
  for (const el of Array.from(document.querySelectorAll("footer"))) push("footer", el);
  for (const el of Array.from(document.querySelectorAll("nav"))) push("nav", el);
  for (const el of Array.from(document.querySelectorAll("[role='banner']"))) push("banner", el);
  for (const el of Array.from(
    document.querySelectorAll("[class*='minicart' i], [data-minicart], [data-cart-drawer]"),
  ))
    push("minicart", el);
  for (const el of Array.from(document.querySelectorAll("[class*='shelf' i]"))) push("shelf", el);
  for (const el of Array.from(document.querySelectorAll("[class*='carousel' i]")))
    push("carousel", el);

  // Deco-authored sections — same convention `carousel-stabilizer.ts` /
  // `lazy-sections.ts` use: `[data-section]`, `[data-deco-section]`.
  for (const el of Array.from(document.querySelectorAll("[data-section], [data-deco-section]"))) {
    const name =
      el.getAttribute("data-section") ?? el.getAttribute("data-deco-section") ?? "section";
    push(`section-${slug(name)}`, el);
  }

  // Geometry heuristic: above-the-fold, full-width, non-semantic content
  // (hero/banner candidates that carry no semantic tag or data attr at
  // all). Only look at direct children of <main>/<body> to avoid deeply
  // nested false positives.
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
  const root = document.querySelector("main") ?? document.body;
  if (root) {
    let heroAssigned = false;
    for (const el of Array.from(root.children)) {
      const tag = el.tagName.toLowerCase();
      if (["header", "footer", "nav", "script", "style"].includes(tag)) continue;
      if (seen.has(el)) continue;
      const rect = rectOf(el);
      if (rect.width === 0 || rect.height === 0) continue;
      const isFullWidth = rect.width >= viewportWidth * 0.9;
      const isAboveFold = rect.y < window.innerHeight * 1.2;
      if (isFullWidth && isAboveFold) {
        push(heroAssigned ? "banner" : "hero", el);
        heroAssigned = true;
      }
    }
  }

  return out;
}
