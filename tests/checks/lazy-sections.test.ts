import { describe, expect, it } from "vitest";
import { lazySectionPresence } from "../../src/checks/lazy-sections.ts";
import { makeContext } from "../helpers/make-context.ts";
import { makePageCapture } from "../helpers/make-page-capture.ts";
import type { NetworkEntry } from "../../src/types/schema.ts";

function net(over: Partial<NetworkEntry> = {}): NetworkEntry {
  return {
    url: "https://x.com/deco/render?s=hero",
    method: "GET",
    status: 200,
    resourceType: "fetch",
    fromCache: false,
    bytes: 100,
    durationMs: 20,
    cacheControl: null,
    serverTiming: null,
    decoSection: null,
    ...over,
  };
}

describe("lazySectionPresence", () => {
  it("passes when both sides render the same lazy sections", () => {
    const requests: NetworkEntry[] = [
      net({ url: "https://x.com/deco/render?s=hero", decoSection: "Hero" }),
      net({ url: "https://x.com/deco/render?s=shelf", decoSection: "Shelf" }),
      net({ url: "https://x.com/_loader/footer", decoSection: "Footer" }),
    ];
    const r = lazySectionPresence(
      makeContext({
        prodPages: [makePageCapture({ url: "https://x.com/", side: "prod", network: requests })],
        candPages: [makePageCapture({ url: "https://x.com/", side: "cand", network: requests })],
      }),
    );
    expect(r.status).toBe("pass");
  });

  it("flags as high severity when prod has sections missing in cand", () => {
    const r = lazySectionPresence(
      makeContext({
        prodPages: [
          makePageCapture({
            url: "https://x.com/",
            side: "prod",
            network: [
              net({ decoSection: "Hero" }),
              net({ decoSection: "Shelf" }),
              net({ decoSection: "Newsletter" }),
            ],
          }),
        ],
        candPages: [
          makePageCapture({
            url: "https://x.com/",
            side: "cand",
            network: [net({ decoSection: "Hero" })],
          }),
        ],
      }),
    );
    expect(r.status).toBe("fail");
    const missing = r.issues.find((i) => i.id.includes("lazy:missing"));
    expect(missing?.severity).toBe("high");
    expect(missing?.summary).toMatch(/2 lazy section/);
  });

  it("extracts section id from URL when decoSection header is absent", () => {
    const r = lazySectionPresence(
      makeContext({
        prodPages: [
          makePageCapture({
            url: "https://x.com/",
            side: "prod",
            network: [net({ url: "https://x.com/_loader/Hero" })],
          }),
        ],
        candPages: [makePageCapture({ url: "https://x.com/", side: "cand", network: [] })],
      }),
    );
    expect(r.issues.find((i) => i.id.includes("lazy:missing"))).toBeDefined();
  });

  it("ignores requests outside the lazy URL pattern", () => {
    const r = lazySectionPresence(
      makeContext({
        prodPages: [
          makePageCapture({
            url: "https://x.com/",
            side: "prod",
            network: [{ ...net({ url: "https://x.com/api/products" }), decoSection: null }],
          }),
        ],
        candPages: [makePageCapture({ url: "https://x.com/", side: "cand", network: [] })],
      }),
    );
    expect(r.status).toBe("pass");
  });
});
