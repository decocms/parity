import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { VisualDifference } from "../../types/schema.ts";

/**
 * Cross-run cache of visual-diff verdicts, keyed by a content hash of
 * (prod screenshot bytes + cand screenshot bytes + prompt version).
 *
 * Lives at <baseOutputDir>/cache/verdicts.json so it persists between
 * `parity run` invocations within the same workspace.
 *
 * Why a cache: the LLM Vision call is the most expensive part of a parity
 * run (cost + latency) and most pages stay visually stable between runs.
 * Skipping the call when both screenshots are byte-identical to a previous
 * pass is safe — different bytes always invalidate the entry.
 *
 * Why the prompt version is part of the key: when we change the system
 * prompt or tool schema, prior verdicts may no longer be trustworthy.
 * Bumping LLM_PROMPT_VERSION in visual-semantic-diff.ts effectively
 * blasts the cache without touching the file.
 */

export interface ParityCacheEntry {
  verdict: "pass" | "diffs" | "failed";
  differences: VisualDifference[];
  sectionsOnlyInProd: string[];
  sectionsOnlyInCand: string[];
  pctDiff: number;
  llmPromptVersion: string;
  cachedAt: string;
}

export interface ParityCache {
  [hash: string]: ParityCacheEntry;
}

/**
 * Hash a (prodScreenshot, candScreenshot, promptVersion) tuple into a single
 * stable cache key. Reads both files synchronously — fine because the caller
 * already read them for pixelmatch on this same turn.
 */
export function hashScreenshotPair(
  prodPath: string,
  candPath: string,
  promptVersion: string,
): string {
  const h = createHash("sha256");
  h.update(readFileSync(prodPath));
  h.update("|");
  h.update(readFileSync(candPath));
  h.update("|");
  h.update(promptVersion);
  return h.digest("hex");
}

function cacheFilePath(cacheDir: string): string {
  return join(cacheDir, "verdicts.json");
}

export function readCache(cacheDir: string): ParityCache {
  const file = cacheFilePath(cacheDir);
  if (!existsSync(file)) return {};
  try {
    const raw = readFileSync(file, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") return parsed as ParityCache;
    return {};
  } catch {
    // Corrupted cache — don't crash the run, just start fresh.
    return {};
  }
}

export function writeCache(cacheDir: string, cache: ParityCache): void {
  const file = cacheFilePath(cacheDir);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(cache, null, 2));
}

/**
 * Look up an entry by hash, returning it only if the prompt version matches
 * the current LLM_PROMPT_VERSION. Stale entries from previous prompt versions
 * are treated as cache misses so they get re-judged.
 */
export function getCacheEntry(
  cache: ParityCache,
  hash: string,
  currentPromptVersion: string,
): ParityCacheEntry | undefined {
  const entry = cache[hash];
  if (!entry) return undefined;
  if (entry.llmPromptVersion !== currentPromptVersion) return undefined;
  return entry;
}

export function setCacheEntry(
  cache: ParityCache,
  hash: string,
  entry: ParityCacheEntry,
): void {
  cache[hash] = entry;
}
