import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { Platform } from "./platform.ts";

export const SelectorKey = z.enum([
  "categoryLink",
  "productCard",
  "buyButton",
  "minicartTrigger",
  "cepInputPdp",
  "cepInputCart",
  "checkoutButton",
  "sizeSwatch",
  "colorSwatch",
  "variantRow",
  "quantityIncrement",
  "quantityInput",
  "minicartCount",
  // Search flow
  "searchTrigger",
  "searchInput",
  "searchSuggestions",
  // Cart interactions flow
  "cartItemRow",
  "cartQuantityIncrement",
  "cartQuantityDecrement",
  "cartRemoveItem",
  "cartCouponInput",
  "cartCouponSubmit",
  "cartTotalPrice",
  // PDP gallery + related
  "pdpGalleryThumbnail",
  "pdpGalleryMain",
  "pdpRelatedShelf",
  // Login flow
  "loginTrigger",
  "loginEmailInput",
  "loginPasswordInput",
  "loginSubmit",
  "loginErrorMessage",
  "accountMenuTrigger",
]);
export type SelectorKey = z.infer<typeof SelectorKey>;

export const SelectorEntry = z.object({
  selector: z.string(),
  confirmedHosts: z.array(z.string()),
  successRate: z.number().min(0).max(1),
  totalAttempts: z.number().int().nonnegative(),
  lastValidated: z.string(),
  deprecated: z.boolean().optional(),
});
export type SelectorEntry = z.infer<typeof SelectorEntry>;

export const LearnedSelectors = z.object({
  schemaVersion: z.literal("0.1"),
  platforms: z.record(z.string(), z.record(SelectorKey, z.array(SelectorEntry))),
});
export type LearnedSelectors = z.infer<typeof LearnedSelectors>;

const DEFAULT_PATH = "learned-selectors.json";

function emptyLib(): LearnedSelectors {
  return { schemaVersion: "0.1", platforms: {} };
}

export function loadLearned(path: string = DEFAULT_PATH): LearnedSelectors {
  if (!existsSync(path)) return emptyLib();
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return LearnedSelectors.parse(raw);
  } catch (err) {
    console.warn(`[learned] failed to parse ${path}: ${(err as Error).message}, starting fresh`);
    return emptyLib();
  }
}

/** Atomic write: tempfile + rename, prevents corruption on parallel runs. */
export function saveLearned(lib: LearnedSelectors, path: string = DEFAULT_PATH): void {
  const dir = dirname(path);
  if (dir && dir !== "." && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(lib, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

/**
 * Get selectors for (platform, key), ordered by successRate desc.
 * Excludes deprecated entries.
 */
export function getLearnedSelectors(
  lib: LearnedSelectors,
  platform: Platform,
  key: SelectorKey,
): SelectorEntry[] {
  const platformEntries = lib.platforms[platform];
  if (!platformEntries) return [];
  const entries = platformEntries[key] ?? [];
  return entries.filter((e) => !e.deprecated).sort((a, b) => b.successRate - a.successRate);
}

function ensureSlot(lib: LearnedSelectors, platform: Platform, key: SelectorKey): SelectorEntry[] {
  if (!lib.platforms[platform])
    lib.platforms[platform] = {} as Record<SelectorKey, SelectorEntry[]>;
  const platformEntries = lib.platforms[platform]!;
  if (!platformEntries[key]) platformEntries[key] = [];
  return platformEntries[key]!;
}

/**
 * Record that a selector worked for a host. Updates stats; bumps confirmedHosts.
 * Returns the updated entry (creates one if necessary).
 */
export function recordSuccess(
  lib: LearnedSelectors,
  platform: Platform,
  key: SelectorKey,
  selector: string,
  host: string,
): SelectorEntry {
  const list = ensureSlot(lib, platform, key);
  let entry = list.find((e) => e.selector === selector);
  if (!entry) {
    entry = {
      selector,
      confirmedHosts: [host],
      successRate: 1,
      totalAttempts: 1,
      lastValidated: new Date().toISOString(),
    };
    list.push(entry);
    return entry;
  }
  const successes = entry.successRate * entry.totalAttempts + 1;
  entry.totalAttempts += 1;
  entry.successRate = successes / entry.totalAttempts;
  if (!entry.confirmedHosts.includes(host)) entry.confirmedHosts.push(host);
  entry.lastValidated = new Date().toISOString();
  if (entry.deprecated && entry.successRate > 0.5) entry.deprecated = undefined;
  return entry;
}

/**
 * Record that a selector failed for a host. After accumulating ≥3 failures
 * across distinct hosts, mark as deprecated (removed from rotation).
 */
export function recordFailure(
  lib: LearnedSelectors,
  platform: Platform,
  key: SelectorKey,
  selector: string,
  host: string,
): SelectorEntry | null {
  const list = ensureSlot(lib, platform, key);
  const entry = list.find((e) => e.selector === selector);
  if (!entry) return null;
  const successes = entry.successRate * entry.totalAttempts;
  entry.totalAttempts += 1;
  entry.successRate = successes / entry.totalAttempts;
  // simplistic deprecation: if successRate < 0.3 and totalAttempts >= 3
  if (entry.successRate < 0.3 && entry.totalAttempts >= 3) {
    entry.deprecated = true;
  }
  entry.lastValidated = new Date().toISOString();
  return entry;
}

export function promoteFromLlm(
  lib: LearnedSelectors,
  platform: Platform,
  key: SelectorKey,
  selector: string,
  host: string,
): SelectorEntry {
  const list = ensureSlot(lib, platform, key);
  const existing = list.find((e) => e.selector === selector);
  if (existing) return recordSuccess(lib, platform, key, selector, host);
  const entry: SelectorEntry = {
    selector,
    confirmedHosts: [host],
    successRate: 0.5,
    totalAttempts: 1,
    lastValidated: new Date().toISOString(),
  };
  list.push(entry);
  return entry;
}

export interface LearnedStats {
  platforms: Array<{
    platform: string;
    totalSelectors: number;
    activeSelectors: number;
    deprecatedSelectors: number;
    topByKey: Array<{ key: string; selector: string; successRate: number; hosts: number }>;
  }>;
}

export function statsFromLib(lib: LearnedSelectors): LearnedStats {
  const out: LearnedStats = { platforms: [] };
  for (const [platform, byKey] of Object.entries(lib.platforms)) {
    let totalSelectors = 0;
    let deprecated = 0;
    const topByKey: LearnedStats["platforms"][number]["topByKey"] = [];
    for (const [key, entries] of Object.entries(byKey)) {
      for (const e of entries) {
        totalSelectors += 1;
        if (e.deprecated) deprecated += 1;
      }
      const top = entries
        .filter((e) => !e.deprecated)
        .sort((a, b) => b.successRate - a.successRate)[0];
      if (top) {
        topByKey.push({
          key,
          selector: top.selector,
          successRate: top.successRate,
          hosts: top.confirmedHosts.length,
        });
      }
    }
    out.platforms.push({
      platform,
      totalSelectors,
      activeSelectors: totalSelectors - deprecated,
      deprecatedSelectors: deprecated,
      topByKey,
    });
  }
  return out;
}

export const LEARNED_PATH = DEFAULT_PATH;
