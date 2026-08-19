/**
 * Target playbook registry. Add a target = add a `.ts` string here.
 * `--target <name>` resolves by key — no other code changes.
 */
import { faststore as faststoreV4 } from "./faststore-v4.ts";
import { tanstackDeco } from "./tanstack-deco.ts";

export const TARGETS: Record<string, string> = {
  faststore: faststoreV4,
  "faststore-v4": faststoreV4,
  tanstack: tanstackDeco,
  "tanstack-deco": tanstackDeco,
};

export function getTargetPlaybook(name: string): string | undefined {
  return Object.hasOwn(TARGETS, name) ? TARGETS[name] : undefined;
}

export const TARGET_NAMES = Object.keys(TARGETS);
