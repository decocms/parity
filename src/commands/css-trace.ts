/**
 * `parity css-trace` — inspect which CSS rules from which source files are
 * affecting a DOM element. Optionally diff between prod and cand to surface
 * rules that exist on one side and not the other.
 *
 * Motivation: when a visual regression appears between Fresh prod and the
 * TanStack migration, the usual debugging path is grep through node_modules
 * for the offending property. This automates that: navigate with Playwright,
 * use Chrome DevTools Protocol (CSS.getMatchedStylesForNode) to enumerate
 * every rule contributing to a target element, and print them grouped by
 * stylesheet source.
 *
 * Example: the daisyUI v5 drawer-end interacted with `scrollbar-gutter:
 * stable` on :root, holding the fixed drawer ~15px short of the viewport
 * right edge. With `css-trace --selector html --filter scrollbar-gutter`
 * the offending rule from daisyUI's base stylesheet would show up
 * immediately.
 */
import chalk from "chalk";
import type { Browser, Page } from "playwright";
import { launchBrowser, newContext } from "../engine/browser.ts";
import type { Viewport } from "../types/schema.ts";

export interface CssTraceOptions {
  /** Single URL to inspect. Mutually exclusive with --prod/--cand. */
  url?: string;
  /** Prod URL (when comparing). */
  prod?: string;
  /** Candidate URL (when comparing). */
  cand?: string;
  /** CSS selector for the target element. Required. */
  selector: string;
  /** Optional CSS property name(s) (comma-separated) to filter the output. */
  filter?: string;
  /** Viewport preset (default: desktop). */
  viewport?: Viewport;
  /** Wait this many ms after `load` for hydration / CSS-from-JS to settle. */
  settleMs?: number;
  /** Output as JSON instead of pretty text. */
  json?: boolean;
}

interface CssProperty {
  name: string;
  value: string;
  important: boolean;
  disabled?: boolean;
}

interface MatchedRule {
  /** "user-agent" | "inline" | "<stylesheet URL>" */
  source: string;
  /** Selector that matched (the specific one inside selectorList). */
  selector: string;
  /** All properties declared by this rule (not just the ones we care about). */
  properties: CssProperty[];
  /** Specificity tuple as reported by CDP, [a, b, c]. */
  specificity?: [number, number, number];
  /**
   * Distance up the ancestor chain when this rule comes from an inherited
   * match. `0` (or undefined) means the rule applied directly to the target
   * element. `1` = parent, `2` = grandparent, etc. The CDP
   * `CSS.getMatchedStylesForNode` response groups inherited matches by
   * ancestor; preserve that grouping so the reader can distinguish "the
   * element matched this rule" from "the element inherits this value from
   * an ancestor that matched it".
   */
  inheritedFromDistance?: number;
}

interface TraceResult {
  url: string;
  selector: string;
  found: boolean;
  /** Computed style for filtered/all properties of interest. */
  computed: Record<string, string>;
  /** Rules ordered by specificity descending. */
  rules: MatchedRule[];
}

async function tracePage(
  page: Page,
  url: string,
  selector: string,
  settleMs: number,
): Promise<TraceResult> {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForLoadState("load", { timeout: 12_000 }).catch(() => undefined);
  await page.waitForLoadState("networkidle", { timeout: 6_000 }).catch(() => undefined);
  await page.waitForTimeout(settleMs);

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("DOM.enable");
  await cdp.send("CSS.enable");

  const { root } = (await cdp.send("DOM.getDocument", { depth: -1 })) as {
    root: { nodeId: number };
  };
  const found = (await cdp.send("DOM.querySelector", {
    nodeId: root.nodeId,
    selector,
  })) as { nodeId: number };

  if (!found.nodeId) {
    await cdp.detach();
    return { url, selector, found: false, computed: {}, rules: [] };
  }

  // Computed style for the element — full set; caller can filter.
  const computedResult = (await cdp.send("CSS.getComputedStyleForNode", {
    nodeId: found.nodeId,
  })) as { computedStyle: Array<{ name: string; value: string }> };
  const computed: Record<string, string> = {};
  for (const e of computedResult.computedStyle) computed[e.name] = e.value;

  // Matched styles — the goldmine.
  const matched = (await cdp.send("CSS.getMatchedStylesForNode", {
    nodeId: found.nodeId,
  })) as {
    matchedCSSRules?: Array<{
      rule: {
        styleSheetId?: string;
        selectorList: { selectors: Array<{ text: string }> };
        style: { cssProperties: Array<{ name: string; value: string; important?: boolean; disabled?: boolean }> };
        origin: string;
      };
      matchingSelectors: number[];
    }>;
    inherited?: Array<{
      matchedCSSRules?: Array<{
        rule: {
          styleSheetId?: string;
          selectorList: { selectors: Array<{ text: string }> };
          style: {
            cssProperties: Array<{ name: string; value: string; important?: boolean; disabled?: boolean }>;
          };
          origin: string;
        };
        matchingSelectors: number[];
      }>;
    }>;
  };

  // Map styleSheetId → source URL via CSS.getStyleSheetText is heavy; instead
  // we rely on the styleSheetText / sourceURL from CSS.styleSheetAdded events.
  // We can't listen retroactively, so use CSS.getStyleSheetText only for IDs
  // we actually see (cheaper than enumerating all).
  const sheetUrlCache = new Map<string, string>();
  async function sheetSource(styleSheetId?: string, origin?: string): Promise<string> {
    if (!styleSheetId) {
      if (origin === "user-agent") return "user-agent";
      return "inline";
    }
    if (sheetUrlCache.has(styleSheetId)) return sheetUrlCache.get(styleSheetId)!;
    try {
      const header = (await cdp.send("CSS.getStyleSheetText", {
        styleSheetId,
      })) as { text: string };
      // CDP doesn't return URL via getStyleSheetText. Fall back to a stable
      // marker derived from the first ~80 chars of the sheet — enough to
      // tell daisyUI apart from app.css, etc.
      const preview = header.text
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 100);
      const label = `stylesheet#${styleSheetId} (${preview})`;
      sheetUrlCache.set(styleSheetId, label);
      return label;
    } catch {
      const label = `stylesheet#${styleSheetId}`;
      sheetUrlCache.set(styleSheetId, label);
      return label;
    }
  }

  // Shared rule-extraction logic for both direct matches and matches on
  // ancestors that inherit into the target element.
  const buildRule = async (
    m: { rule: { styleSheetId?: string; selectorList: { selectors: Array<{ text: string }> }; style: { cssProperties: Array<{ name: string; value: string; important?: boolean; disabled?: boolean }> }; origin: string }; matchingSelectors: number[] },
    inheritedFromDistance?: number,
  ): Promise<MatchedRule> => {
    const r = m.rule;
    // Resolve the specific selector that matched (CDP gives indices).
    const selectors = r.selectorList.selectors.map((s) => s.text);
    const matchedSelectors = m.matchingSelectors.map((i) => selectors[i]).filter(Boolean);
    const sel = matchedSelectors.join(", ") || selectors.join(", ") || "(no selector text)";
    const source = await sheetSource(r.styleSheetId, r.origin);
    return {
      source,
      selector: sel,
      properties: (r.style.cssProperties ?? [])
        .filter((p) => p.name && p.value && !p.disabled)
        .map((p) => {
          // CDP sometimes returns the trailing "!important" baked into
          // `value` while also setting `important: true`. Strip it so
          // we don't print "!important !important" downstream.
          const trimmed = p.value.replace(/\s*!important\s*$/i, "").trim();
          return {
            name: p.name,
            value: trimmed || p.value,
            important: p.important === true || /\s*!important\s*$/i.test(p.value),
            disabled: p.disabled,
          };
        }),
      ...(inheritedFromDistance !== undefined ? { inheritedFromDistance } : {}),
    };
  };

  const rules: MatchedRule[] = [];
  for (const m of matched.matchedCSSRules ?? []) {
    rules.push(await buildRule(m));
  }

  // Inherited matches: CDP returns an array indexed by ancestor distance
  // (index 0 = direct parent, 1 = grandparent, …). Each ancestor entry has
  // its own `matchedCSSRules` listing the rules that applied to *that*
  // ancestor. CSS inheritance then carries inheritable properties (color,
  // font-*, line-height, visibility, etc.) down to the target element, so a
  // value in `computed` that doesn't appear in any direct rule almost
  // certainly came from one of these inherited rules. Skipping them was
  // making the diff output incomplete on properties that propagate from a
  // wrapper (often the case for typography and theme tokens applied to
  // `<html>` / `<body>`).
  const inheritedGroups = matched.inherited ?? [];
  for (let i = 0; i < inheritedGroups.length; i++) {
    const group = inheritedGroups[i];
    if (!group?.matchedCSSRules?.length) continue;
    const distance = i + 1;
    for (const m of group.matchedCSSRules) {
      rules.push(await buildRule(m, distance));
    }
  }

  await cdp.detach();
  return { url, selector, found: true, computed, rules };
}

function applyFilter(result: TraceResult, filter?: string): TraceResult {
  if (!filter) return result;
  const wanted = new Set(filter.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
  const computed: Record<string, string> = {};
  for (const [k, v] of Object.entries(result.computed)) {
    if (wanted.has(k.toLowerCase())) computed[k] = v;
  }
  const rules = result.rules
    .map((r) => ({
      ...r,
      properties: r.properties.filter((p) => wanted.has(p.name.toLowerCase())),
    }))
    .filter((r) => r.properties.length > 0);
  return { ...result, computed, rules };
}

function printResult(result: TraceResult, header: string): void {
  console.log(chalk.bold(`\n${header}`));
  console.log(chalk.dim(`URL: ${result.url}`));
  console.log(chalk.dim(`Selector: ${result.selector}`));
  if (!result.found) {
    console.log(chalk.red("✖ Element not found"));
    return;
  }
  const computedKeys = Object.keys(result.computed);
  if (computedKeys.length > 0) {
    console.log(chalk.bold("\n  Computed:"));
    for (const k of computedKeys) {
      console.log(`    ${chalk.cyan(k)}: ${result.computed[k]}`);
    }
  }
  if (result.rules.length === 0) {
    console.log(chalk.yellow("\n  No matching rules after filter."));
    return;
  }
  console.log(chalk.bold("\n  Rules (ordered by CDP — most specific last):"));
  for (const r of result.rules) {
    const inheritLabel =
      r.inheritedFromDistance !== undefined
        ? chalk.yellow(` ↑ inherited from ancestor (${r.inheritedFromDistance})`)
        : "";
    console.log(`    ${chalk.magenta(r.source)}${inheritLabel}`);
    console.log(`      ${chalk.green(r.selector)} {`);
    for (const p of r.properties) {
      const bang = p.important ? chalk.red(" !important") : "";
      console.log(`        ${p.name}: ${p.value}${bang};`);
    }
    console.log("      }");
  }
}

interface DiffOutput {
  property: string;
  prod: string | undefined;
  cand: string | undefined;
}

function diffComputed(prod: TraceResult, cand: TraceResult): DiffOutput[] {
  const keys = new Set([...Object.keys(prod.computed), ...Object.keys(cand.computed)]);
  const out: DiffOutput[] = [];
  for (const k of keys) {
    const p = prod.computed[k];
    const c = cand.computed[k];
    if (p !== c) out.push({ property: k, prod: p, cand: c });
  }
  return out.sort((a, b) => a.property.localeCompare(b.property));
}

function printComparison(prod: TraceResult, cand: TraceResult): void {
  printResult(prod, "── PROD ──────────────────────────────────────────────");
  printResult(cand, "── CAND ──────────────────────────────────────────────");
  const diffs = diffComputed(prod, cand);
  console.log(chalk.bold("\n── DIFF (computed) ───────────────────────────────────"));
  if (diffs.length === 0) {
    console.log(chalk.green("  No computed-style differences in the filtered set."));
    return;
  }
  for (const d of diffs) {
    console.log(`  ${chalk.cyan(d.property)}`);
    console.log(`    prod: ${chalk.green(d.prod ?? "(unset)")}`);
    console.log(`    cand: ${chalk.red(d.cand ?? "(unset)")}`);
  }
}

export async function cssTraceCommand(opts: CssTraceOptions): Promise<number> {
  const viewport: Viewport = opts.viewport ?? "desktop";
  const settleMs = opts.settleMs ?? 1500;

  if (!opts.selector) {
    console.error(chalk.red("--selector is required"));
    return 1;
  }

  // Enforce the mutual exclusion that --help documents on `--url`:
  // either single-URL mode (`--url`) or comparison mode (`--prod` AND
  // `--cand`), never a mix. Silently picking one when the user passed
  // both is the worst behavior — it makes "why is `--url` being
  // ignored?" debugging painful.
  const hasUrl = !!opts.url;
  const hasProd = !!opts.prod;
  const hasCand = !!opts.cand;
  if (hasUrl && (hasProd || hasCand)) {
    console.error(
      chalk.red("--url is mutually exclusive with --prod / --cand. Pass one mode only."),
    );
    return 1;
  }
  if ((hasProd && !hasCand) || (!hasProd && hasCand)) {
    console.error(
      chalk.red("Comparison mode needs both --prod and --cand (got only one)."),
    );
    return 1;
  }
  if (!hasUrl && !hasProd && !hasCand) {
    console.error(chalk.red("Provide either --url or both --prod and --cand."));
    return 1;
  }
  const isCompare = hasProd && hasCand;

  let browser: Browser | null = null;
  try {
    browser = await launchBrowser({ headless: true });

    if (isCompare) {
      const prodCtx = await newContext(browser, { viewport });
      const candCtx = await newContext(browser, { viewport });
      const prodPage = await prodCtx.newPage();
      const candPage = await candCtx.newPage();
      try {
        const [prodRes, candRes] = await Promise.all([
          tracePage(prodPage, opts.prod!, opts.selector, settleMs),
          tracePage(candPage, opts.cand!, opts.selector, settleMs),
        ]);
        const prodF = applyFilter(prodRes, opts.filter);
        const candF = applyFilter(candRes, opts.filter);
        if (opts.json) {
          console.log(JSON.stringify({ prod: prodF, cand: candF, diff: diffComputed(prodF, candF) }, null, 2));
        } else {
          printComparison(prodF, candF);
        }
      } finally {
        await prodCtx.close().catch(() => undefined);
        await candCtx.close().catch(() => undefined);
      }
    } else {
      const ctx = await newContext(browser, { viewport });
      const page = await ctx.newPage();
      try {
        const res = await tracePage(page, opts.url!, opts.selector, settleMs);
        const filtered = applyFilter(res, opts.filter);
        if (opts.json) {
          console.log(JSON.stringify(filtered, null, 2));
        } else {
          printResult(filtered, "── RESULT ────────────────────────────────────────────");
        }
      } finally {
        await ctx.close().catch(() => undefined);
      }
    }
    return 0;
  } catch (err) {
    console.error(chalk.red(`Error: ${(err as Error).message}`));
    return 1;
  } finally {
    await browser?.close().catch(() => undefined);
  }
}
