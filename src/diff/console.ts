import type { ConsoleEntry } from "../types/schema.ts";

export type ConsoleClass = "hydration" | "not-found" | "csp" | "request-failed" | "generic";

export interface ClassifiedConsole {
  entry: ConsoleEntry;
  cls: ConsoleClass;
  key: string; // dedup key (normalized text without volatile numbers/IDs)
}

const HYDRATION_PATTERNS = [
  /hydrat/i,
  /text content does not match/i,
  /server rendered html/i,
  /did not match/i,
  /tree hydration/i,
  /useDevice/i,
  /usePlatform/i,
];

const CSP_PATTERNS = [
  /content security policy/i,
  /violates the following content security/i,
  /refused to (?:execute|load|connect)/i,
];

const NOT_FOUND_PATTERNS = [
  /404/,
  /not found/i,
  /failed to load resource: the server responded with a status of 404/i,
];

export function classify(entry: ConsoleEntry): ConsoleClass {
  if (HYDRATION_PATTERNS.some((p) => p.test(entry.text))) return "hydration";
  if (CSP_PATTERNS.some((p) => p.test(entry.text))) return "csp";
  if (NOT_FOUND_PATTERNS.some((p) => p.test(entry.text))) return "not-found";
  if (entry.text.startsWith("[request-failed]")) return "request-failed";
  return "generic";
}

function dedupKey(entry: ConsoleEntry): string {
  // Strip numbers, hex IDs, line:column anchors
  return entry.text
    .replace(/\b\d{2,}\b/g, "<N>")
    .replace(/\b[0-9a-f]{8,}\b/gi, "<HEX>")
    .replace(/:\d+:\d+/g, "")
    .toLowerCase()
    .trim();
}

export interface ConsoleDiff {
  prodErrors: ClassifiedConsole[];
  candErrors: ClassifiedConsole[];
  newInCand: ClassifiedConsole[];
  resolvedInCand: ClassifiedConsole[];
  anyFailed: boolean;
}

export interface ConsoleDiffOptions {
  /** Glob/regex patterns to ignore (e.g. "ERR_BLOCKED_BY_CLIENT"). */
  ignorePatterns?: string[];
  /** Only consider errors (drop warnings, info, etc). Default true. */
  errorsOnly?: boolean;
}

export function diffConsole(
  prod: ConsoleEntry[],
  cand: ConsoleEntry[],
  opts: ConsoleDiffOptions = {},
): ConsoleDiff {
  const errorsOnly = opts.errorsOnly ?? true;
  const ignoreRes = (opts.ignorePatterns ?? []).map((p) => new RegExp(p, "i"));

  const filter = (entries: ConsoleEntry[]): ClassifiedConsole[] => {
    const seen = new Map<string, ClassifiedConsole>();
    for (const e of entries) {
      if (errorsOnly && e.type !== "error") continue;
      if (ignoreRes.some((re) => re.test(e.text))) continue;
      const key = dedupKey(e);
      if (!seen.has(key)) {
        seen.set(key, { entry: e, cls: classify(e), key });
      }
    }
    return [...seen.values()];
  };

  const prodErrors = filter(prod);
  const candErrors = filter(cand);
  const prodKeys = new Set(prodErrors.map((e) => e.key));
  const candKeys = new Set(candErrors.map((e) => e.key));

  const newInCand = candErrors.filter((e) => !prodKeys.has(e.key));
  const resolvedInCand = prodErrors.filter((e) => !candKeys.has(e.key));
  return {
    prodErrors,
    candErrors,
    newInCand,
    resolvedInCand,
    anyFailed: newInCand.length > 0,
  };
}
