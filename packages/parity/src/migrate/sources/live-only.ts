import type { Source } from "./types.ts";

/**
 * The fallback source: no repo on disk, or an unrecognized one. Everything comes
 * from the live capture (theme + sitemap + DOM component detection). This is the
 * ORIGINAL `parity migrate` behaviour, now named — it's what you get when
 * `--source` is omitted or `detect` matches nothing.
 */
export const liveOnly: Source = {
  kind: "live-only",
  label: "Live site only (no source code)",
  detect: () => false, // never auto-detected; it's the explicit fallback
  inventory: () => ({
    components: [],
    notes: ["No source repo — component inventory comes entirely from the live capture."],
  }),
  playbook: `## Source: live site only
There is no source repo. Every component is reconstructed from the live capture
(screenshots, computed styles, suggested Tailwind, interaction hints). Treat the
captured HTML/computed-styles as the source of truth for structure and styling.`,
};
