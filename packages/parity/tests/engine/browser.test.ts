import type { Browser, BrowserContext, Page } from "playwright";
import { describe, expect, it, vi } from "vitest";
import { newContext } from "../../src/engine/browser.ts";

// We can't launch a real Chromium in unit tests, so we stub just the
// BrowserContext/Page surface `newContext()` touches: addInitScript,
// addCookies, tracing.start, newPage, and (for the noCache path)
// newCDPSession. This mirrors the plain-object mocking style used in
// tests/engine/carousel-stabilizer.test.ts rather than vi.mock'ing the
// `playwright` module wholesale.

function makeMockContext(): {
  ctx: BrowserContext;
  cdpSend: ReturnType<typeof vi.fn>;
  newCDPSession: ReturnType<typeof vi.fn>;
} {
  const cdpSend = vi.fn().mockResolvedValue(undefined);
  const newCDPSession = vi.fn().mockResolvedValue({ send: cdpSend });

  const ctx: Record<string, unknown> = {
    addInitScript: vi.fn().mockResolvedValue(undefined),
    addCookies: vi.fn().mockResolvedValue(undefined),
    tracing: { start: vi.fn().mockResolvedValue(undefined) },
    newCDPSession,
  };
  ctx.newPage = vi.fn().mockImplementation(
    async (): Promise<Page> => ({ context: () => ctx }) as unknown as Page,
  );

  return { ctx: ctx as unknown as BrowserContext, cdpSend, newCDPSession };
}

function makeMockBrowser(ctx: BrowserContext): Browser {
  return { newContext: vi.fn().mockResolvedValue(ctx) } as unknown as Browser;
}

describe("newContext / noCache CDP wiring (issue #186)", () => {
  it("does not touch CDP when noCache is not set", async () => {
    const { ctx, cdpSend, newCDPSession } = makeMockContext();
    const browser = makeMockBrowser(ctx);

    const result = await newContext(browser, { viewport: "desktop" });
    await result.newPage();

    expect(newCDPSession).not.toHaveBeenCalled();
    expect(cdpSend).not.toHaveBeenCalled();
  });

  it("disables the HTTP cache via CDP on every page created when noCache is set", async () => {
    const { ctx, cdpSend, newCDPSession } = makeMockContext();
    const browser = makeMockBrowser(ctx);

    const result = await newContext(browser, { viewport: "desktop", noCache: true });
    await result.newPage();

    expect(newCDPSession).toHaveBeenCalledTimes(1);
    expect(cdpSend).toHaveBeenCalledWith("Network.enable");
    expect(cdpSend).toHaveBeenCalledWith("Network.setCacheDisabled", { cacheDisabled: true });

    // A second page in the same (noCache) context gets it too — the wrapper
    // is installed once on the context, not a one-shot.
    await result.newPage();
    expect(newCDPSession).toHaveBeenCalledTimes(2);
  });

  it("still sends the Cache-Control/Pragma no-cache request headers as a fallback", async () => {
    const { ctx } = makeMockContext();
    const browser = makeMockBrowser(ctx);

    await newContext(browser, { viewport: "desktop", noCache: true });

    expect(browser.newContext).toHaveBeenCalledWith(
      expect.objectContaining({
        extraHTTPHeaders: { "Cache-Control": "no-cache", Pragma: "no-cache" },
      }),
    );
  });

  it("swallows CDP failures so page creation still resolves (best-effort)", async () => {
    const { ctx, newCDPSession } = makeMockContext();
    newCDPSession.mockRejectedValue(new Error("no CDP session available"));
    const browser = makeMockBrowser(ctx);

    const result = await newContext(browser, { viewport: "desktop", noCache: true });

    await expect(result.newPage()).resolves.toBeDefined();
  });
});
