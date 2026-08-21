/**
 * Target registry. A target is its playbook plus, optionally, how to write a starter theme.
 *
 * Adding a target used to mean adding a string here — but theme generation was hardcoded to one
 * target in `commands/migrate.ts`, so `--target faststore-next` and `--target tanstack-deco`
 * silently produced no theme at all while `--target faststore` produced one (issue #309). The
 * declaration lives here now, so a target either declares a theme or visibly does not, and no
 * caller can skip one by omission.
 */
import type { ThemeBundle } from "../../types/migrate.ts";
import { buildFastStoreNextTheme, faststoreNext } from "./faststore-next.ts";
import { buildFastStoreTheme, faststore as faststoreV4 } from "./faststore-v4.ts";
import { buildTanstackDecoTheme, tanstackDeco } from "./tanstack-deco.ts";

export interface TargetTheme {
  /** Output filename inside the migrate run dir. */
  filename: string;
  build: (theme: ThemeBundle) => string;
}

export interface Target {
  playbook: string;
  /** Absent = this target has no deterministic starter theme. Say why in a comment when so. */
  theme?: TargetTheme;
}

const FASTSTORE_V4: Target = {
  playbook: faststoreV4,
  // `@faststore/cli` mandates the `--fs-*` SCSS token contract, so the output is SCSS.
  theme: { filename: "custom-theme.scss", build: buildFastStoreTheme },
};

const FASTSTORE_NEXT: Target = {
  playbook: faststoreNext,
  theme: { filename: "theme.css", build: buildFastStoreNextTheme },
};

const TANSTACK_DECO: Target = {
  playbook: tanstackDeco,
  theme: { filename: "theme.css", build: buildTanstackDecoTheme },
};

export const TARGETS: Record<string, Target> = {
  // Bare "faststore" stays an alias for v4 (@faststore/cli) — the older,
  // better-established target. "faststore-next" needs its own explicit
  // key; it must never inherit the bare alias, or every existing
  // `--target faststore` invocation silently starts resolving a different
  // playbook.
  faststore: FASTSTORE_V4,
  "faststore-v4": FASTSTORE_V4,
  "faststore-next": FASTSTORE_NEXT,
  tanstack: TANSTACK_DECO,
  "tanstack-deco": TANSTACK_DECO,
};

export function getTarget(name: string): Target | undefined {
  return Object.hasOwn(TARGETS, name) ? TARGETS[name] : undefined;
}

export function getTargetPlaybook(name: string): string | undefined {
  return getTarget(name)?.playbook;
}

/** The starter theme for a target, or null when it declares none. */
export function getTargetTheme(name: string): TargetTheme | null {
  return getTarget(name)?.theme ?? null;
}

export const TARGET_NAMES = Object.keys(TARGETS);
