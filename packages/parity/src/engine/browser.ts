import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve as resolvePath } from "node:path";
import type { Browser, BrowserContext, BrowserContextOptions, Page } from "playwright";
import { chromium, devices } from "playwright";
import type { Viewport } from "../types/schema.ts";
import { CAROUSEL_STABILIZER_INIT_SCRIPT } from "./carousel-stabilizer.ts";

/**
 * Disable CSS animations + transitions to eliminate flake from in-flight motion
 * during screenshots and DOM snapshots.
 */
const DISABLE_ANIMATIONS_CSS = `
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    scroll-behavior: auto !important;
  }
`;

/**
 * Per-viewport User-Agent strings. Exposed for callers that issue raw
 * `fetch()` requests (preflight, sitemap warmup, html prefetch) so that
 * those calls match the UA the browser will send for the same viewport.
 *
 * Why this matters: workers and CDNs frequently key their edge cache by
 * device-class derived from UA (e.g. miess-tanstack does
 * `detectDevice(ua)` inside `buildSegment`). If a pre-flight fetch with a
 * desktop UA hits the worker before the mobile browser run, the desktop
 * cache segment gets populated, the mobile segment may remain cold, and
 * the mobile run reads a desktop variant.
 *
 * Use `userAgentFor(viewport)` from any non-Playwright call site.
 */
const USER_AGENT_BY_VIEWPORT: Record<Viewport, string> = {
  mobile:
    "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
  tablet:
    "Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1",
  desktop:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
};

export function userAgentFor(viewport: Viewport): string {
  return USER_AGENT_BY_VIEWPORT[viewport];
}

/**
 * Mobile preset is built on top of `devices["Pixel 7"]` but we also pin
 * `userAgent`, `isMobile`, and `hasTouch` explicitly. Pinning shields
 * parity from silent regressions when Playwright bumps its device
 * catalog (or drops `Pixel 7` entirely on older versions) and guarantees
 * device-segmented edge caches see a real mobile UA.
 */
const VIEWPORT_PRESETS: Record<Viewport, BrowserContextOptions> = {
  mobile: {
    ...devices["Pixel 7"],
    userAgent: USER_AGENT_BY_VIEWPORT.mobile,
    isMobile: true,
    hasTouch: true,
  },
  tablet: {
    ...devices["iPad Mini"],
    userAgent: USER_AGENT_BY_VIEWPORT.tablet,
    isMobile: true,
    hasTouch: true,
  },
  desktop: {
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    userAgent: USER_AGENT_BY_VIEWPORT.desktop,
    isMobile: false,
    hasTouch: false,
  },
};

export interface LaunchOptions {
  headless?: boolean;
  slowMo?: number;
}

export async function launchBrowser(opts: LaunchOptions = {}): Promise<Browser> {
  const doLaunch = () =>
    // JS-level race as a 35 s backstop: Playwright's own pipe-level timeout
    // (30 s) sometimes doesn't fire on macOS when the Chromium subprocess
    // stalls inside the zygote/sandbox init before writing anything to the
    // pipe, leaving the Node event loop blocked with no pending microtasks.
    // The extra 5 s gap lets Playwright's timeout win first in normal cases.
    Promise.race([
      chromium.launch({
        headless: opts.headless ?? true,
        slowMo: opts.slowMo ?? 0,
        // 30 s hard ceiling on the launch handshake at the subprocess/pipe
        // level — fires even when libuv is blocked (unlike JS timers).
        timeout: 30_000,
        args: [
          "--disable-blink-features=AutomationControlled",
          // Prevents macOS sandbox_init stalls that headless-shell triggers
          // when no GUI session is present. Safe for CLI testing tools.
          "--no-sandbox",
          // Belt-and-suspenders: removes the inner setuid sandbox that
          // --no-sandbox doesn't cover and that can also deadlock on macOS.
          "--disable-setuid-sandbox",
          // Avoids GPU-init hangs in headless mode on macOS and Linux CI.
          "--disable-gpu",
          // Disables the zygote launcher process. The zygote inherits open
          // file descriptors from the parent and on macOS headless it can
          // deadlock waiting for a socket that never connects (issue #163).
          "--no-zygote",
        ],
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Chromium launch timeout (35 s)")), 35_000),
      ),
    ]);
  try {
    return await doLaunch();
  } catch (err) {
    const msg = (err as Error).message ?? "";
    // Playwright TimeoutError or JS-level race timeout.
    // Common on macOS with headless-shell against localhost (issue #163).
    if (
      msg.includes("Timeout") ||
      msg.includes("timed out") ||
      msg.includes("Chromium launch timeout")
    ) {
      throw new Error(
        [
          "Chromium timed out while launching (30 s).",
          "On macOS, try reinstalling the browser binaries:",
          "  npx playwright install chromium chromium-headless-shell",
          "Or set PARITY_SKIP_PLAYWRIGHT_INSTALL=1 and install manually.",
        ].join("\n"),
      );
    }
    if (!msg.includes("Executable doesn't exist")) throw err;
    // First-run after `npm install -g @decocms/parity`: the postinstall
    // hook didn't run (npm `ignore-scripts=true`, or npm 11+ default for
    // global installs). Auto-install the binary on demand — the user
    // explicitly asked us to run, so blocking on a 140 MB download is
    // better than failing with an error message and making them re-run.
    if (process.env.PARITY_SKIP_PLAYWRIGHT_INSTALL === "1") {
      throw missingBrowserError(err);
    }
    console.log("");
    console.log(
      "  ⚠  Playwright's Chromium binary is not installed yet — downloading now (~140 MB, one-time)…",
    );
    console.log("     Set PARITY_SKIP_PLAYWRIGHT_INSTALL=1 to disable this auto-install.");
    console.log("");
    const installRc = installChromiumSync();
    if (installRc !== 0) throw missingBrowserError(err);
    console.log("  ✓ Chromium ready. Continuing the run.");
    console.log("");
    // Retry the launch once. If it still fails the binary install
    // didn't actually land where Playwright expects — surface the
    // friendly error so the user can rerun the install manually.
    try {
      return await doLaunch();
    } catch (retryErr) {
      throw missingBrowserError(retryErr);
    }
  }
}

function installChromiumSync(): number {
  // Playwright 1.49+ launches `chromium-headless-shell` for `headless: true`
  // by default — that's a *separate* download from `chromium`. Installing
  // only `chromium` leaves headless launches failing with
  // "Executable doesn't exist at .../chrome-headless-shell". Install both.
  //
  // We prefer the locally-bundled playwright CLI over `npx --yes playwright`:
  // `npx` may fetch a *different* playwright version into its cache, and the
  // binary downloaded there may not match the version parity actually runs
  // against, so the post-install retry still fails.
  const localCli = resolveLocalPlaywrightCli();
  const cmd = localCli
    ? {
        command: process.execPath,
        args: [localCli, "install", "chromium", "chromium-headless-shell"],
      }
    : {
        command: "npx",
        args: ["--yes", "playwright", "install", "chromium", "chromium-headless-shell"],
      };
  const result = spawnSync(cmd.command, cmd.args, {
    stdio: "inherit",
    env: process.env,
  });
  return result.status ?? 1;
}

function resolveLocalPlaywrightCli(): string | null {
  try {
    const req = createRequire(import.meta.url);
    // `playwright/cli.js` is not in package `exports`, so we resolve via
    // package.json and join the `bin` path manually.
    const pkgJsonPath = req.resolve("playwright/package.json");
    const pkg = req("playwright/package.json") as { bin?: string | Record<string, string> };
    const binEntry = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.playwright;
    if (!binEntry) return null;
    return resolvePath(dirname(pkgJsonPath), binEntry);
  } catch {
    return null;
  }
}

function missingBrowserError(cause: unknown): Error {
  const original = cause instanceof Error ? cause.message : String(cause);
  return new Error(
    [
      "Playwright's Chromium binary is not installed.",
      "Run: npx playwright install chromium chromium-headless-shell",
      "Or unset PARITY_SKIP_PLAYWRIGHT_INSTALL and rerun `parity` to auto-install.",
      "",
      `Original error: ${original}`,
    ].join("\n"),
  );
}

export interface ContextOptions {
  viewport: Viewport;
  harPath?: string;
  tracesDir?: string;
  /** Force cohort/A-B cookies to a stable bucket */
  cohortCookieValue?: string;
  /**
   * Force a cold-visit fetch, approximating what Lighthouse simulates by
   * default (cache disabled, no warm connection). Two layers, belt and
   * suspenders:
   *  1. `Cache-Control: no-cache` + `Pragma: no-cache` request headers,
   *     which only force revalidation — a `304` still lets the browser
   *     serve its own cached body.
   *  2. A CDP `Network.setCacheDisabled(true)` call (see `disableHttpCache`
   *     below) wired onto every page created in this context, which skips
   *     the disk/memory cache entirely.
   *
   * Wired up by `--bypass-cache`.
   *
   * IMPORTANT: without this flag, parity's default captures are a
   * warm-connection / cache-enabled scenario ("repeat visit"), not
   * Lighthouse/CrUX's cold first-visit simulation — the two are not
   * directly comparable 1:1 for TTFB/FCP/LCP. Pass `noCache: true` to
   * approximate the cold-visit numbers those tools report. See issue #186.
   */
  noCache?: boolean;
  /**
   * Disable ONLY the browser's own disk/memory HTTP cache (CDP
   * `Network.setCacheDisabled`), WITHOUT sending `Cache-Control: no-cache`.
   * Every asset is refetched over the network, but the CDN/edge (e.g.
   * Cloudflare) still serves its warm cache — exactly the "returning visitor
   * hits a warm edge, cold local cache" scenario a production user sees. This
   * is the benchmark's cache model. Distinct from `noCache`, which also sends
   * the revalidation header and thus bypasses the edge too.
   */
  diskCacheDisabled?: boolean;
  /**
   * Override the preset device-scale-factor. The mobile preset renders at retina
   * DSF (~2.6), which makes full-page screenshots enormous. Set to 1 for report
   * captures — same layout/viewport, ~7× smaller images.
   */
  deviceScaleFactor?: number;
}

/**
 * Force a genuinely cold fetch via CDP — the DevTools "Disable cache"
 * checkbox, not just a revalidation header. CDP sessions are per-page (not
 * per-context), so this must run once per `Page`, before its first
 * navigation. Chromium-only (parity only ever launches `chromium`, see
 * `launchBrowser` above — no Firefox/WebKit code paths exist in this repo),
 * so no engine-detection guard is needed; the try/catch is just defensive
 * in case a CDP session can't be opened, so a hiccup here degrades to the
 * header-based no-cache above instead of failing the whole capture.
 */
async function disableHttpCache(page: Page): Promise<void> {
  try {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  } catch {
    // Best-effort — the Cache-Control/Pragma request headers still apply.
  }
}

export async function newContext(browser: Browser, opts: ContextOptions): Promise<BrowserContext> {
  const baseContext = VIEWPORT_PRESETS[opts.viewport];
  const ctx = await browser.newContext({
    ...baseContext,
    ...(opts.deviceScaleFactor != null ? { deviceScaleFactor: opts.deviceScaleFactor } : {}),
    // `full` (not `minimal`) so the downloaded HAR carries the complete
    // request waterfall + per-entry `timings` a HAR viewer/DevTools needs to
    // "validate the time of each thing"; `content: "omit"` drops response
    // bodies so the artifact stays shareable (timings/sizes/headers kept).
    recordHar: opts.harPath ? { path: opts.harPath, mode: "full", content: "omit" } : undefined,
    bypassCSP: true,
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: opts.noCache
      ? { "Cache-Control": "no-cache", Pragma: "no-cache" }
      : undefined,
  });

  if (opts.noCache || opts.diskCacheDisabled) {
    // Every call site across the codebase creates pages via `ctx.newPage()`
    // (there's no other choke point), so wrap it here rather than threading
    // a duplicate noCache flag through every capture call site — this way
    // the CDP cache-disable is guaranteed to run, and to finish, before the
    // caller can reach `page.goto()`. (`diskCacheDisabled` reuses the same CDP
    // path but skips the no-cache request header so the edge cache still serves.)
    const rawNewPage = ctx.newPage.bind(ctx);
    ctx.newPage = (async () => {
      const page = await rawNewPage();
      await disableHttpCache(page);
      return page;
    }) as BrowserContext["newPage"];
  }

  // Disable animations on every page in this context
  await ctx.addInitScript({
    content: `
      try {
        const style = document.createElement('style');
        style.textContent = ${JSON.stringify(DISABLE_ANIMATIONS_CSS)};
        (document.head || document.documentElement).appendChild(style);
      } catch (e) {}
    `,
  });

  // Install the carousel-stabilizer hook (issue #22). Runs before any user
  // JS so `window.__parityStabilizeCarousels()` is callable from
  // `stabilizeCarousels(page)` right before any screenshot.
  await ctx.addInitScript({ content: CAROUSEL_STABILIZER_INIT_SCRIPT });

  // Stable cohort cookie if requested
  if (opts.cohortCookieValue) {
    await ctx.addCookies([
      {
        name: "_abtest",
        value: opts.cohortCookieValue,
        url: "https://localhost",
      },
    ]);
  }

  if (opts.tracesDir) {
    await ctx.tracing.start({ screenshots: true, snapshots: true, sources: false });
  }

  return ctx;
}

export async function stopTracing(ctx: BrowserContext, path: string): Promise<void> {
  await ctx.tracing.stop({ path });
}
