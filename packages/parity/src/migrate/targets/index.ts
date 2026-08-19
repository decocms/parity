/**
 * Target playbook registry. Add a target = add a `.ts` string here.
 * `--target <name>` resolves by key — no other code changes.
 */
import { faststore } from "./faststore.ts";

export const TARGETS: Record<string, string> = {
  faststore,
};

export function getTargetPlaybook(name: string): string | undefined {
  return Object.hasOwn(TARGETS, name) ? TARGETS[name] : undefined;
}

export const TARGET_NAMES = Object.keys(TARGETS);
