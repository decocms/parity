import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ParityIgnore, ParityRc } from "../types/schema.ts";

/**
 * Load `.parityrc.json` from the given cwd. Returns defaults if absent.
 */
export function loadParityRc(cwd: string = process.cwd()): ParityRc {
  const path = join(cwd, ".parityrc.json");
  if (!existsSync(path)) return ParityRc.parse({});
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return ParityRc.parse(raw);
  } catch (err) {
    console.warn(`[parity] failed to parse ${path}: ${(err as Error).message}`);
    return ParityRc.parse({});
  }
}

/**
 * Load `.parityignore` from the given cwd. Returns defaults if absent.
 * Accepts either JSON (preferred) or — when extension is `.parityignore` — JSON content.
 */
export function loadParityIgnore(cwd: string = process.cwd()): ParityIgnore {
  const path = join(cwd, ".parityignore");
  if (!existsSync(path)) return ParityIgnore.parse({});
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    // accept legacy keys without prefix conversion: assume same shape
    return ParityIgnore.parse(raw);
  } catch (err) {
    console.warn(`[parity] failed to parse ${path}: ${(err as Error).message}`);
    return ParityIgnore.parse({});
  }
}
