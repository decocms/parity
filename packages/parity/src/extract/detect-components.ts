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
    if (refined) return sanitizeDetectedComponents(refined);
  }

  return sanitizeDetectedComponents(components);
}

/** Same "is a provider configured" gate other optional LLM passes use. */
export function isComponentDetectionLlmAvailable(): boolean {
  return isUnderstandingAvailable();
}

/**
 * Tokens that name a layout wrapper, not a content component. A role built
 * ENTIRELY from these (`main-wrapper`, `portal-root`, `overlay-container`,
 * `modal-dialog`) is DOM plumbing the live capture snagged — never a migratable
 * section. A role that also carries a content noun (`newsletter-modal`,
 * `product-hero`) is kept.
 */
const STRUCTURAL_TOKENS = new Set([
  "wrapper",
  "container",
  "root",
  "overlay",
  "portal",
  "backdrop",
  "modal",
  "dialog",
  "layout",
  "main",
  "site",
  "page",
  "app",
  "body",
  "inner",
  "outer",
  "scroll",
  "sticky",
  "shell",
  "region",
  "content",
]);

/** Synonyms that all mean the same shared global block. */
const HEADER_SYNONYMS = new Set(["header", "masthead"]);
const FOOTER_SYNONYMS = new Set(["footer"]);
const NAV_SYNONYMS = new Set(["nav", "navbar", "navigation", "menu", "megamenu", "mega"]);

function roleTokens(role: string): string[] {
  return role
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** All tokens are structural plumbing (or numeric) → not a real component. */
export function isStructuralJunkRole(role: string): boolean {
  const tokens = roleTokens(role);
  if (tokens.length === 0) return true;
  return tokens.every((t) => STRUCTURAL_TOKENS.has(t) || /^\d+$/.test(t));
}

/**
 * Fold a role's many capture-time spellings down to a canonical shared-global
 * name so global dedup + target reconcile actually match. `site-header` →
 * `header`, `main-navigation`/`navigation-mega-menu` → `nav`, `footer-content`
 * → `footer`. Only folds when EVERY non-structural token is a synonym of that
 * global — so `product-navigation`/`product-header` stay distinct.
 */
export function canonicalRole(role: string): string {
  const meaningful = roleTokens(role).filter((t) => !STRUCTURAL_TOKENS.has(t));
  if (meaningful.length === 0) return role; // pure junk — the filter drops it
  if (meaningful.every((t) => HEADER_SYNONYMS.has(t))) return "header";
  if (meaningful.every((t) => FOOTER_SYNONYMS.has(t))) return "footer";
  if (meaningful.every((t) => NAV_SYNONYMS.has(t))) return "nav";
  return role;
}

/**
 * Post-process detected/refined components: drop structural-wrapper junk the
 * capture snagged (`portal-root`, `overlay-container`, `modal-overlay`) and
 * canonicalize shared-global spellings, collapsing the many `site-header` /
 * `navigation-*` / `footer-*` variants to ONE `header`/`nav`/`footer` each.
 * Pure — unit-tested. Without this, a live-only capture emits 25+ rows where
 * ~half are DOM plumbing and ~half are re-spellings of the same shell.
 */
export function sanitizeDetectedComponents(components: DetectedComponent[]): DetectedComponent[] {
  const seenGlobal = new Set<string>();
  const out: DetectedComponent[] = [];
  for (const c of components) {
    if (isStructuralJunkRole(c.role)) continue;
    const role = canonicalRole(c.role);
    if (role === "header" || role === "footer" || role === "nav") {
      if (seenGlobal.has(role)) continue; // keep the first spelling only
      seenGlobal.add(role);
    }
    out.push(role === c.role ? c : { ...c, role });
  }
  return out;
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

  // Fallback header/footer for sites that render them as plain <div>s with no
  // semantic tag (e.g. VTEX IO). Only fires when nothing semantic matched, so
  // it can't regress sites that DO use <header>/<footer>.
  const docHeight = Math.max(
    document.documentElement.scrollHeight,
    document.body?.scrollHeight ?? 0,
  );
  function widest(els: Element[]): Element | null {
    let best: Element | null = null;
    let bestArea = 0;
    for (const el of els) {
      const r = rectOf(el);
      if (r.width < viewportWidth * 0.85) continue;
      const area = r.width * r.height;
      if (area > bestArea && area > 0) {
        best = el;
        bestArea = area;
      }
    }
    return best;
  }

  if (!out.some((c) => c.role === "header")) {
    // Anchor: the top-most full-width ancestor of the nav / logo / search.
    let header: Element | null = null;
    const anchor = document.querySelector("nav, [class*='logo' i], [class*='search' i]");
    let el: Element | null = anchor;
    while (el?.parentElement) {
      const r = rectOf(el.parentElement);
      if (r.y <= 5 && r.width >= viewportWidth * 0.85 && r.height < window.innerHeight * 1.5) {
        header = el.parentElement;
      }
      el = el.parentElement;
    }
    header ??= widest(
      Array.from(document.querySelectorAll("[class*='header' i]")).filter((e) => rectOf(e).y < 200),
    );
    if (header) push("header", header);
  }

  if (!out.some((c) => c.role === "footer")) {
    const footer =
      widest(
        Array.from(document.querySelectorAll("[class*='footer' i]")).filter((e) => {
          const r = rectOf(e);
          return (
            r.y + r.height > docHeight - window.innerHeight && e.querySelectorAll("a").length >= 4
          );
        }),
      ) ??
      // Geometry fallback: bottom full-width block with many links.
      widest(
        Array.from(document.querySelectorAll("div, section")).filter((e) => {
          const r = rectOf(e);
          return (
            r.y + r.height > docHeight - window.innerHeight * 0.6 &&
            r.y > docHeight * 0.5 &&
            e.querySelectorAll("a").length >= 6
          );
        }),
      );
    if (footer) push("footer", footer);
  }

  return out;
}
