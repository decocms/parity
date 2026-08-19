import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Read the published version from the nearest `package.json`.
 *
 * Works in both dev (`bun run --hot src/cli.ts` → `src/cli.ts` → `../package.json`)
 * and built (`dist/cli.js` → `../package.json`) because both layouts sit one
 * directory below the package root. Falls back to `"0.0.0"` if anything fails
 * (broken install, mangled bundle) so the CLI never crashes on `--version`.
 *
 * Issue #52: `parity --version` was hard-coded to "0.0.0" in `src/cli.ts`.
 */
export function getPackageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // Search up to 3 levels: covers src/util/, src/, and dist/ layouts.
    for (const up of ["..", "../..", "../../.."]) {
      try {
        const pkgPath = resolve(here, up, "package.json");
        const raw = readFileSync(pkgPath, "utf8");
        const parsed = JSON.parse(raw) as { name?: string; version?: string };
        if (parsed.name === "@decocms/parity" && typeof parsed.version === "string") {
          return parsed.version;
        }
      } catch {
        /* try next level */
      }
    }
  } catch {
    /* fall through to default */
  }
  return "0.0.0";
}
