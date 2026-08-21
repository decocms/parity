/**
 * Target playbook registry. Add a target = add a `.ts` string here.
 * `--target <name>` resolves by key — no other code changes.
 */
import { faststore as faststoreV4 } from "./faststore-v4.ts";
import { faststoreNext } from "./faststore-next.ts";
import { tanstackDeco } from "./tanstack-deco.ts";

export const TARGETS: Record<string, string> = {
  // Bare "faststore" stays an alias for v4 (@faststore/cli) — the older,
  // better-established target. "faststore-next" needs its own explicit
  // key; it must never inherit the bare alias, or every existing
  // `--target faststore` invocation silently starts resolving a different
  // playbook.
  faststore: faststoreV4,
  "faststore-v4": faststoreV4,
  "faststore-next": faststoreNext,
  tanstack: tanstackDeco,
  "tanstack-deco": tanstackDeco,
};

export function getTargetPlaybook(name: string): string | undefined {
  return Object.hasOwn(TARGETS, name) ? TARGETS[name] : undefined;
}

export const TARGET_NAMES = Object.keys(TARGETS);
