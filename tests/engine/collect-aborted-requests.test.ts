import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  CANCELLATION_ERROR_CODES,
  KNOWN_ASYNC_TRACKING_URL_PATTERNS,
  attachCollectors,
  isCancellationError,
  isKnownAsyncTrackingUrl,
} from "../../src/engine/collect.ts";

/**
 * Regression test for issue #40: async tracking pixels canceled by
 * the next navigation in the vitals crawler used to land as
 * `[request-failed]` console errors and got promoted to `high`
 * severity issues. The fix filters `net::ERR_ABORTED` (and a small
 * allowlist of known fire-and-forget tracking domains) at the
 * listener level so they never enter the console pipeline.
 */

describe("isCancellationError", () => {
  it("matches net::ERR_ABORTED", () => {
    expect(isCancellationError("net::ERR_ABORTED")).toBe(true);
  });
  it("matches net::ERR_NETWORK_CHANGED", () => {
    expect(isCancellationError("net::ERR_NETWORK_CHANGED")).toBe(true);
  });
  it("matches even when errorText has extra context", () => {
    expect(isCancellationError("Failed: net::ERR_ABORTED at start")).toBe(true);
  });
  it("does NOT match real failures we should surface", () => {
    expect(isCancellationError("net::ERR_CONNECTION_REFUSED")).toBe(false);
    expect(isCancellationError("net::ERR_NAME_NOT_RESOLVED")).toBe(false);
    expect(isCancellationError("net::ERR_TIMED_OUT")).toBe(false);
    expect(isCancellationError("net::ERR_FAILED")).toBe(false);
    expect(isCancellationError("net::ERR_BLOCKED_BY_CLIENT")).toBe(false);
  });
  it("exported constant aligns with the predicate", () => {
    for (const code of CANCELLATION_ERROR_CODES) {
      expect(isCancellationError(code)).toBe(true);
    }
  });
});

describe("isKnownAsyncTrackingUrl", () => {
  it("matches Google Ads endpoints from issue #40", () => {
    expect(isKnownAsyncTrackingUrl("https://www.google.com/ccm/collect?cv=12345")).toBe(true);
    expect(isKnownAsyncTrackingUrl("https://www.google.com/rmkt/collect/123456")).toBe(true);
  });
  it("matches Google Analytics beacons", () => {
    expect(
      isKnownAsyncTrackingUrl(
        "https://www.google-analytics.com/g/collect?v=2&tid=G-XXX&_p=1",
      ),
    ).toBe(true);
  });
  it("matches Facebook pixel", () => {
    expect(isKnownAsyncTrackingUrl("https://www.facebook.com/tr?id=123&ev=PageView")).toBe(true);
  });
  it("matches LiveIntent / Criteo / RevContent endpoints from issue #40", () => {
    expect(isKnownAsyncTrackingUrl("https://i.liadm.com/s/abc")).toBe(true);
    expect(isKnownAsyncTrackingUrl("https://trends.revcontent.com/cm/pixel_sync")).toBe(true);
    expect(isKnownAsyncTrackingUrl("https://www.criteo.com/delivery/x")).toBe(true);
  });
  it("does NOT match first-party URLs (would mask real errors)", () => {
    expect(isKnownAsyncTrackingUrl("https://www.miess.com.br/api/checkout")).toBe(false);
    expect(isKnownAsyncTrackingUrl("https://lojabagaggio.deco.site/p/produto-x")).toBe(false);
  });
  it("does NOT match third-party SDKs that DO matter (checkout, payments)", () => {
    // We only allowlist fire-and-forget pixels. Checkout SDKs, payment
    // gateways, and other operational third parties must still surface
    // failures.
    expect(isKnownAsyncTrackingUrl("https://js.stripe.com/v3/")).toBe(false);
    expect(isKnownAsyncTrackingUrl("https://secure.mlstatic.com/sdk/mp.js")).toBe(false);
  });
  it("exported pattern list is non-empty and used", () => {
    expect(KNOWN_ASYNC_TRACKING_URL_PATTERNS.length).toBeGreaterThan(5);
    for (const pattern of KNOWN_ASYNC_TRACKING_URL_PATTERNS) {
      // Each pattern produces a positive match when wrapped in a URL.
      expect(isKnownAsyncTrackingUrl(`https://x.example/${pattern}/y`)).toBe(true);
    }
  });
});

/**
 * Build a minimal stand-in for a Playwright Page object — only the
 * EventEmitter half attachCollectors actually consumes. Enough to
 * verify the listener filters correctly without booting Chromium.
 */
function makeMockPage(): EventEmitter & { on: EventEmitter["on"] } {
  const e = new EventEmitter();
  return e as EventEmitter & { on: EventEmitter["on"] };
}

function makeFailedRequest(url: string, errorText: string): {
  url: () => string;
  failure: () => { errorText: string };
} {
  return {
    url: () => url,
    failure: () => ({ errorText }),
  };
}

describe("attachCollectors — requestfailed filtering (issue #40)", () => {
  it("DROPS net::ERR_ABORTED from any URL (root cause of issue)", () => {
    const page = makeMockPage();
    // biome-ignore lint/suspicious/noExplicitAny: minimal mock
    const state = attachCollectors(page as any);
    page.emit(
      "requestfailed",
      makeFailedRequest("https://www.miess.com.br/api/x", "net::ERR_ABORTED"),
    );
    expect(state.console).toHaveLength(0);
  });

  it("DROPS net::ERR_NETWORK_CHANGED", () => {
    const page = makeMockPage();
    // biome-ignore lint/suspicious/noExplicitAny: minimal mock
    const state = attachCollectors(page as any);
    page.emit(
      "requestfailed",
      makeFailedRequest("https://example.com/api", "net::ERR_NETWORK_CHANGED"),
    );
    expect(state.console).toHaveLength(0);
  });

  it("DROPS known async tracking URLs even when errorText is generic ERR_FAILED", () => {
    const page = makeMockPage();
    // biome-ignore lint/suspicious/noExplicitAny: minimal mock
    const state = attachCollectors(page as any);
    page.emit(
      "requestfailed",
      makeFailedRequest("https://www.google.com/ccm/collect?cv=1", "net::ERR_FAILED"),
    );
    expect(state.console).toHaveLength(0);
  });

  it("KEEPS real first-party failures (404, 5xx, connection refused, etc)", () => {
    const page = makeMockPage();
    // biome-ignore lint/suspicious/noExplicitAny: minimal mock
    const state = attachCollectors(page as any);
    page.emit(
      "requestfailed",
      makeFailedRequest("https://www.miess.com.br/api/checkout", "net::ERR_CONNECTION_REFUSED"),
    );
    expect(state.console).toHaveLength(1);
    expect(state.console[0]?.text).toMatch(/checkout/);
    expect(state.console[0]?.text).toMatch(/ERR_CONNECTION_REFUSED/);
  });

  it("KEEPS ERR_BLOCKED_BY_CLIENT (ad blocker) for now — user can .parityignore", () => {
    // Conservative choice: ERR_BLOCKED_BY_CLIENT is informative (a
    // tracker is being blocked), even if often noisy. Users who want
    // it gone can add to .parityignore.ignoreConsolePatterns.
    const page = makeMockPage();
    // biome-ignore lint/suspicious/noExplicitAny: minimal mock
    const state = attachCollectors(page as any);
    page.emit(
      "requestfailed",
      makeFailedRequest(
        "https://example.com/analytics.js",
        "net::ERR_BLOCKED_BY_CLIENT",
      ),
    );
    expect(state.console).toHaveLength(1);
  });

  it("retains the standard [request-failed] prefix on real failures (downstream classify() still works)", () => {
    const page = makeMockPage();
    // biome-ignore lint/suspicious/noExplicitAny: minimal mock
    const state = attachCollectors(page as any);
    page.emit(
      "requestfailed",
      makeFailedRequest("https://example.com/x", "net::ERR_TIMED_OUT"),
    );
    expect(state.console[0]?.text).toMatch(/^\[request-failed\]/);
  });
});
