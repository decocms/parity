import type { FlowName } from "../types/schema.ts";
import { ALL_CHECKS_BY_NAME } from "./index.ts";

/**
 * Module = a named, selectable slice of the check suite (M3 phase A of the
 * parity 1.0.0 roadmap — docs/ROADMAP-1.0.md). Every check registered in
 * `ALL_CHECKS_BY_NAME` belongs to EXACTLY ONE module — enforced by
 * `tests/checks/modules.test.ts`.
 *
 * This is a SELECTION mechanism only (which checks run, which flows get
 * captured). Per-module scoring/weighting is a separate follow-up phase —
 * intentionally not built here.
 */
export type ModuleName =
  | "e2e"
  | "seo"
  | "visual"
  | "vitals"
  | "cache"
  | "console"
  | "html"
  | "network";

export interface ModuleDef {
  name: ModuleName;
  /** One-liner for --help / `parity list modules` / the interactive prompt. */
  description: string;
  /** Must be keys that exist in `ALL_CHECKS_BY_NAME`. */
  checks: string[];
  /** Flows that must be captured for this module's checks to have data. */
  flows: FlowName[];
  /** Drives whether the sitemap crawl (vitals-pages/visual-pages) runs. */
  needsSitemapPages?: boolean;
  /** Whether this module's checks need an LLM pass to produce full value. */
  needsLlm?: boolean;
}

export const MODULES: Record<ModuleName, ModuleDef> = {
  e2e: {
    name: "e2e",
    description:
      "Functional flows — purchase journey, search, cart interactions, login, PDP gallery/breadcrumbs, PLP sorting",
    checks: [
      "purchase-journey-flow",
      "cart-reveal-mode-divergence",
      "cart-interactions-flow",
      "search-presence",
      "search-autocomplete",
      "search-results",
      "search-no-results",
      "login-flow",
      "pdp-gallery-related",
      "pdp-breadcrumbs",
      "plp-sorting",
    ],
    flows: ["purchase-journey", "search", "cart-interactions", "login", "plp", "pdp"],
  },
  seo: {
    name: "seo",
    description:
      "SEO parity — meta tags, deep audit, 404 handling, footer links, pagination, HTTP status",
    checks: [
      "meta-seo-parity",
      "seo-deep-audit",
      "not-found-parity",
      "footer-links-health",
      "plp-pagination",
      "http-status-parity",
    ],
    flows: ["homepage", "plp", "pdp"],
    needsSitemapPages: true,
  },
  visual: {
    name: "visual",
    description:
      "Visual regression — keyframe screenshots, banner aspect ratio, cookie/CEP modal layout shift",
    checks: ["visual-regression-keyframes", "banner-aspect-ratio", "cookie-cep-modal-cls"],
    flows: ["homepage", "plp", "pdp"],
    needsLlm: true,
  },
  vitals: {
    name: "vitals",
    description: "Web Vitals (mobile) across the flow pages plus extra sitemap-sampled pages",
    checks: ["web-vitals-mobile"],
    flows: ["homepage", "plp", "pdp"],
    needsSitemapPages: true,
  },
  cache: {
    name: "cache",
    description: "Cache-header coverage parity between prod and cand",
    checks: ["cache-coverage"],
    flows: ["homepage", "plp", "pdp"],
  },
  console: {
    name: "console",
    description: "Browser console error baseline parity",
    checks: ["console-errors-baseline"],
    flows: ["homepage", "plp", "pdp"],
  },
  html: {
    name: "html",
    description:
      "HTML structure — structural diff, lazy sections, image loading health, missing picture dimensions",
    checks: [
      "html-structural-diff",
      "lazy-section-presence",
      "image-loading-health",
      "picture-missing-dims",
    ],
    flows: ["homepage", "plp", "pdp"],
  },
  network: {
    name: "network",
    description: "Network request summary delta (counts, sizes, failures) between prod and cand",
    checks: ["network-summary-delta"],
    flows: ["homepage", "plp", "pdp"],
  },
};

/** Reverse lookup: which module a given check name belongs to. */
export function moduleOfCheck(checkName: string): ModuleName | undefined {
  for (const mod of Object.values(MODULES)) {
    if (mod.checks.includes(checkName)) return mod.name;
  }
  return undefined;
}

export interface ResolveSelectionInput {
  /** Comma-separated module names and/or `check:<name>` entries. */
  only?: string;
  /** Comma-separated module names and/or `check:<name>` entries, subtracted from the base set. */
  skip?: string;
}

export interface ResolveSelectionResult {
  /** Resolved module set (after only/skip applied). */
  modules: ModuleName[];
  /**
   * Union of `MODULES[m].checks` for included modules, PLUS any explicit
   * `check:<name>` entries from `--only` (even if their owning module was
   * otherwise excluded).
   */
  checkNames: Set<string>;
  /** Union of `MODULES[m].flows` for included modules. */
  flows: Set<FlowName>;
  /** Unknown module/check names encountered — caller decides fatal vs warn. */
  errors: string[];
}

const ALL_MODULE_NAMES = Object.keys(MODULES) as ModuleName[];

function isModuleName(s: string): s is ModuleName {
  return Object.hasOwn(MODULES, s);
}

/**
 * Parses a comma-separated `--only`/`--skip` value into module names and
 * explicit `check:<name>` entries. Unknown module/check names are
 * collected into `errors` rather than thrown, so the caller can decide
 * whether to hard-fail (CLI) or just warn.
 */
function parseSelectionList(
  raw: string | undefined,
  errors: string[],
): { modules: Set<ModuleName>; explicitChecks: Set<string> } {
  const modules = new Set<ModuleName>();
  const explicitChecks = new Set<string>();
  if (!raw) return { modules, explicitChecks };
  for (const entryRaw of raw.split(",")) {
    const entry = entryRaw.trim();
    if (!entry) continue;
    if (entry.startsWith("check:")) {
      const checkName = entry.slice("check:".length).trim();
      if (!checkName || !Object.hasOwn(ALL_CHECKS_BY_NAME, checkName)) {
        errors.push(`unknown check "${checkName}" (from "${entry}")`);
        continue;
      }
      explicitChecks.add(checkName);
      continue;
    }
    if (!isModuleName(entry)) {
      errors.push(`unknown module "${entry}" (valid: ${ALL_MODULE_NAMES.join(", ")})`);
      continue;
    }
    modules.add(entry);
  }
  return { modules, explicitChecks };
}

/**
 * Resolves `--only`/`--skip` into the concrete set of modules, check names,
 * and flows a run should exercise. `--only` is the base (defaults to ALL
 * modules when absent); `--skip` subtracts from whatever base was chosen —
 * so `--skip` alone still starts from "everything".
 *
 * `resolveSelection({})` (no only/skip at all) returns all 8 modules
 * already assembled — the full back-compat default, not an empty
 * selection — so "default is default" is cheap to test/reason about.
 */
export function resolveSelection(input: ResolveSelectionInput): ResolveSelectionResult {
  const errors: string[] = [];
  const onlyParsed = parseSelectionList(input.only, errors);
  const skipParsed = parseSelectionList(input.skip, errors);

  const baseModules = input.only ? onlyParsed.modules : new Set<ModuleName>(ALL_MODULE_NAMES);
  for (const m of skipParsed.modules) baseModules.delete(m);

  const checkNames = new Set<string>();
  for (const m of baseModules) {
    for (const c of MODULES[m].checks) checkNames.add(c);
  }
  // Explicit `check:<name>` entries from --only are additive, even if their
  // owning module wasn't otherwise selected.
  for (const c of onlyParsed.explicitChecks) checkNames.add(c);
  // Explicit `check:<name>` entries from --skip are subtractive.
  for (const c of skipParsed.explicitChecks) checkNames.delete(c);

  const flows = new Set<FlowName>();
  for (const m of baseModules) {
    for (const f of MODULES[m].flows) flows.add(f);
  }

  return {
    modules: Array.from(baseModules).sort() as ModuleName[],
    checkNames,
    flows,
    errors,
  };
}
