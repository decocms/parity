#!/usr/bin/env node
/**
 * Best-effort Playwright Chromium install on first `npm install` of
 * `@decocms/parity`. Skipped when:
 *   - `PARITY_SKIP_PLAYWRIGHT_INSTALL=1` is set (CI / Docker / monorepos
 *     that manage the browser separately).
 *   - The binary is already present.
 *
 * Failures are downgraded to a warning so a `npm install -g` that
 * happens to be offline / behind a corp proxy doesn't block the whole
 * install. The runtime path in `engine/browser.ts:launchBrowser` catches
 * the missing-browser case and tells the user exactly what to run.
 */

if (process.env.PARITY_SKIP_PLAYWRIGHT_INSTALL === "1") {
  console.log("[parity] PARITY_SKIP_PLAYWRIGHT_INSTALL=1 set — skipping Chromium install");
  process.exit(0);
}

const { spawnSync } = require("node:child_process");

// Probe Playwright to find out if Chromium is already extracted. The cheap
// way: try to resolve the binary via `npx playwright install --dry-run`.
// `--dry-run` exits 0 when everything is already installed and non-zero
// when downloads are needed. We don't actually rely on the exit code; we
// always attempt `install chromium` (idempotent) and let Playwright print
// "already up to date" when there's nothing to do.
try {
  console.log("[parity] Installing Playwright Chromium (one-time, ~140 MB)…");
  const result = spawnSync("npx", ["--yes", "playwright", "install", "chromium"], {
    stdio: "inherit",
    env: process.env,
  });
  if (result.status === 0) {
    console.log("[parity] Chromium ready.");
  } else {
    console.log(
      "[parity] Chromium install returned a non-zero exit. " +
        "If `parity run` later fails with 'Executable doesn't exist', " +
        "run `npx playwright install chromium` manually.",
    );
  }
} catch (err) {
  const reason = err?.message ?? "unknown error";
  console.log(
    `[parity] Playwright install skipped (${reason}). Run \`npx playwright install chromium\` before your first \`parity run\`.`,
  );
}
