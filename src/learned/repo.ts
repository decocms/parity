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
  "cartOpenedIndicator",
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
  "sellerCodeInput",
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
  // PLP pagination flow
  "paginationNext",
  "loadMoreButton",
]);
export type SelectorKey = z.infer<typeof SelectorKey>;

export const SelectorEntry = z.object({
  selector: z.string(),
  confirmedHosts: z.array(z.string()),
  successRate: z.number().min(0).max(1),
  totalAttempts: z.number().int().nonnegative(),
  lastValidated: z.string(),
  deprecated: z.boolean().optional(),
  /**
   * Provenance: "verified" = confirmed working on a live page at least once;
   * "llm-guess" = promoted from an LLM suggestion, never confirmed. Default
   * keeps pre-existing libraries parsing (entries written before this field
   * were all flow-confirmed, so verified is the honest default for them).
   */
  origin: z.enum(["verified", "llm-guess"]).default("verified"),
});
export type SelectorEntry = z.infer<typeof SelectorEntry>;

/** Staleness thresholds (issue: `lastValidated` was stored but never read). */
const STALE_DECAY_DAYS = 90;
const EXPIRE_GUESS_DAYS = 180;
const DAY_MS = 24 * 60 * 60 * 1000;

function ageDays(entry: SelectorEntry): number {
  const t = Date.parse(entry.lastValidated);
  if (!Number.isFinite(t)) return Number.POSITIVE_INFINITY;
  return (Date.now() - t) / DAY_MS;
}

/**
 * Ranking score: verified entries always outrank llm-guesses; entries not
 * validated in 90+ days have their effective rate halved so a recently
 * confirmed selector wins over a stale champion.
 */
export function effectiveRate(entry: SelectorEntry): number {
  const decay = ageDays(entry) > STALE_DECAY_DAYS ? 0.5 : 1;
  return entry.successRate * decay;
}

export const LearnedSelectors = z.object({
  schemaVersion: z.literal("0.1"),
  platforms: z.record(z.string(), z.partialRecord(SelectorKey, z.array(SelectorEntry))),
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
 * Get selectors for (platform, key), verified-first, then by effective
 * (staleness-decayed) successRate desc. Excludes deprecated entries and
 * llm-guesses never confirmed in 180+ days (they were a model's untested
 * hunch — after 6 months the markup has almost certainly drifted).
 */
export function getLearnedSelectors(
  lib: LearnedSelectors,
  platform: Platform,
  key: SelectorKey,
): SelectorEntry[] {
  const platformEntries = lib.platforms[platform];
  if (!platformEntries) return [];
  const entries = platformEntries[key] ?? [];
  return entries
    .filter((e) => !e.deprecated)
    .filter((e) => !(e.origin === "llm-guess" && ageDays(e) > EXPIRE_GUESS_DAYS))
    .sort((a, b) => {
      if (a.origin !== b.origin) return a.origin === "verified" ? -1 : 1;
      return effectiveRate(b) - effectiveRate(a);
    });
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
      origin: "verified",
    };
    list.push(entry);
    return entry;
  }
  const successes = entry.successRate * entry.totalAttempts + 1;
  entry.totalAttempts += 1;
  entry.successRate = successes / entry.totalAttempts;
  if (!entry.confirmedHosts.includes(host)) entry.confirmedHosts.push(host);
  entry.lastValidated = new Date().toISOString();
  entry.origin = "verified"; // a live success upgrades an llm-guess
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

/**
 * Seed (or bump) a learned-selectors entry from an LLM suggestion.
 *
 * @param verified - When `true`, the caller has independent live-confirmation
 *   for this exact selector (M4: it live-validated via `validateSelectors`
 *   on the page it's supposed to live on, AND the model itself did not flag
 *   the key in `low_confidence_keys`). In that case the entry is seeded
 *   directly at `origin: "verified"` / `successRate: 1`, same as a normal
 *   flow-confirmed success — skipping the usual "unverified guess" limbo.
 *   Defaults to `false` (today's pre-M4 behavior: seed as `llm-guess` below
 *   anything ever confirmed live; a later real success upgrades it).
 */
export function promoteFromLlm(
  lib: LearnedSelectors,
  platform: Platform,
  key: SelectorKey,
  selector: string,
  host: string,
  verified = false,
): SelectorEntry {
  const list = ensureSlot(lib, platform, key);
  const existing = list.find((e) => e.selector === selector);
  if (existing || verified) return recordSuccess(lib, platform, key, selector, host);
  // Unverified LLM suggestion: seed BELOW anything ever confirmed live
  // (0.35, was 0.5 — a guess used to sit mid-pack among proven selectors)
  // and tag provenance so ranking and expiry can treat it accordingly.
  const entry: SelectorEntry = {
    selector,
    confirmedHosts: [host],
    successRate: 0.35,
    totalAttempts: 1,
    lastValidated: new Date().toISOString(),
    origin: "llm-guess",
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
    verifiedSelectors: number;
    llmGuessSelectors: number;
    staleSelectors: number;
    topByKey: Array<{
      key: string;
      selector: string;
      successRate: number;
      hosts: number;
      origin: SelectorEntry["origin"];
    }>;
  }>;
}

export function statsFromLib(lib: LearnedSelectors): LearnedStats {
  const out: LearnedStats = { platforms: [] };
  for (const [platform, byKey] of Object.entries(lib.platforms)) {
    let totalSelectors = 0;
    let deprecated = 0;
    let verified = 0;
    let guesses = 0;
    let stale = 0;
    const topByKey: LearnedStats["platforms"][number]["topByKey"] = [];
    for (const [key, entries] of Object.entries(byKey)) {
      for (const e of entries) {
        totalSelectors += 1;
        if (e.deprecated) deprecated += 1;
        else if (e.origin === "verified") verified += 1;
        else guesses += 1;
        if (!e.deprecated && ageDays(e) > STALE_DECAY_DAYS) stale += 1;
      }
      const top = entries
        .filter((e) => !e.deprecated)
        .sort((a, b) => {
          if (a.origin !== b.origin) return a.origin === "verified" ? -1 : 1;
          return effectiveRate(b) - effectiveRate(a);
        })[0];
      if (top) {
        topByKey.push({
          key,
          selector: top.selector,
          successRate: top.successRate,
          hosts: top.confirmedHosts.length,
          origin: top.origin,
        });
      }
    }
    out.platforms.push({
      platform,
      totalSelectors,
      activeSelectors: totalSelectors - deprecated,
      deprecatedSelectors: deprecated,
      verifiedSelectors: verified,
      llmGuessSelectors: guesses,
      staleSelectors: stale,
      topByKey,
    });
  }
  return out;
}

export const LEARNED_PATH = DEFAULT_PATH;
