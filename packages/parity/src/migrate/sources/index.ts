/**
 * Source registry — the input mirror of `../targets`. Add a source = add it to
 * `SOURCES`; `detectSource` and `--source-kind` resolve by key, no other code
 * changes.
 */
import { decoFresh } from "./deco-fresh.ts";
import { liveOnly } from "./live-only.ts";
import type { Source } from "./types.ts";
import { vtexIo } from "./vtex-io.ts";

/** Order matters: `detectSource` returns the first whose `detect` matches. */
const SOURCES: Source[] = [decoFresh, vtexIo];

const SOURCE_BY_KIND: Record<string, Source> = Object.fromEntries(
  [...SOURCES, liveOnly].map((s) => [s.kind, s]),
);

export const SOURCE_KINDS = Object.keys(SOURCE_BY_KIND);

/** Resolve an explicit `--source-kind`, or undefined when unknown. */
export function getSource(kind: string): Source | undefined {
  return Object.hasOwn(SOURCE_BY_KIND, kind) ? SOURCE_BY_KIND[kind] : undefined;
}

/**
 * Sniff the repo on disk. Returns the first matching source, or `liveOnly` when
 * nothing matches (an unknown or absent repo still migrates — from the capture).
 */
export function detectSource(repoDir: string): Source {
  return SOURCES.find((s) => s.detect(repoDir)) ?? liveOnly;
}

export { liveOnly };
export type { Source, SourceComponent, SourceInventory } from "./types.ts";
