/**
 * Source registry — the input mirror of `../targets`. A target answers "what am
 * I migrating TO" (a playbook string); a source answers "what am I migrating
 * FROM" and, crucially, whether the original code is on disk.
 *
 * `parity migrate` was born as a live-only capture (scrape one URL, works
 * whether or not the source exists). The source registry adds the other half:
 * when `--source <dir>` points at the real repo, the component inventory comes
 * from the CODE (exhaustive, exact names) instead of DOM heuristics, and the
 * VTEX-IO runtime scrape only runs when the source actually is VTEX IO.
 */

/** A component discovered by reading the source repo (not the live DOM). */
export interface SourceComponent {
  /** Stable id — the source's own name (export, section key, block id). */
  name: string;
  /** Repo-relative path of the file that defines it, when there is one. */
  file: string | null;
  /**
   * Coarse role, aligned with the live-capture roles so the two inventories
   * can be reconciled: "section" | "component" | "app" | "route" | "theme".
   */
  role: string;
  /** "global" (header/footer/every page) vs "page" (route-specific), if known. */
  scope: "global" | "page" | null;
}

/** What reading the source repo yields, before any live capture. */
export interface SourceInventory {
  /** Every component/section found by reading the code. */
  components: SourceComponent[];
  /** Free-form facts a target playbook or the agent can use (framework, css system…). */
  notes: string[];
}

/**
 * A source platform. `detect` is a cheap on-disk sniff (presence of a manifest,
 * a dep, a config file) — NOT a network call. `inventory` reads the tree.
 * `kind` gates behaviour elsewhere (e.g. the VTEX-IO runtime scrape).
 */
export interface Source {
  /** Registry key, also the `--source-kind` value: "deco-fresh" | "vtex-io" | … */
  kind: string;
  /** Human label for reports. */
  label: string;
  /** True when this source matches the repo at `repoDir` (cheap file sniff). */
  detect(repoDir: string): boolean;
  /** Read the component inventory from the source tree. */
  inventory(repoDir: string): SourceInventory;
  /** Short pointer appended to the migration prompt (source-side gotchas). */
  playbook: string;
}
