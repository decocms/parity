/**
 * Heuristic for "this URL points at a local dev server". Dev servers
 * (Vite, Webpack, Next.js dev, Fresh dev) keep HMR / SSE channels open
 * forever, which makes Playwright's `waitForLoadState("networkidle")`
 * hang indefinitely. Issue #55. Detecting localhost lets parity reduce
 * the default `--vitals-pages` and disable networkidle waits without
 * forcing the user to remember the right flags.
 *
 * Conservative: only matches the unambiguous localhost markers. A
 * production URL that happens to resolve to a private IP won't be
 * flagged.
 */
const LOCALHOST_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"]);

export function isLocalhost(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    // URL.hostname returns IPv6 wrapped in brackets ("[::1]"), so we check
    // both forms to be robust across runtimes.
    return LOCALHOST_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}
