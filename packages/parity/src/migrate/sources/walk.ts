import { type Dirent, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Recursively list files under `dir` whose name ends with one of `exts`,
 * returned as paths RELATIVE to `dir` (POSIX separators). Skips the usual noise
 * dirs so a source scan doesn't wander into node_modules or build output.
 *
 * Kept local (not a dependency) — it's a dozen lines and the repo has no glob
 * lib; `src/storage/*` uses `readdirSync` the same way.
 */
const SKIP = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".faststore",
  "coverage",
  ".cache",
]);

export function walkFiles(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  const recurse = (abs: string, rel: string) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(abs, { withFileTypes: true }) as Dirent[];
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") && e.isDirectory()) continue;
      if (SKIP.has(e.name)) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        recurse(join(abs, e.name), childRel);
      } else if (exts.some((ext) => e.name.endsWith(ext))) {
        out.push(childRel);
      }
    }
  };
  recurse(dir, "");
  return out.sort();
}
