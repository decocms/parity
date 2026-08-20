import { describe, expect, it } from "vitest";
import { faviconParity } from "../../src/checks/favicon-parity.ts";
import { fontParity } from "../../src/checks/font-parity.ts";
import { navLinksHealth } from "../../src/checks/nav-links-health.ts";
import type { NetworkEntry } from "../../src/types/schema.ts";
import { makeContext } from "../helpers/make-context.ts";
import { makePageCapture } from "../helpers/make-page-capture.ts";

const HOME = "https://x.com/";
const CAND = "https://cand.x.com/";

const fontReq = (url: string): NetworkEntry => ({
  url,
  method: "GET",
  status: 200,
  resourceType: "font",
  fromCache: false,
  bytes: 1000,
  durationMs: 10,
  cacheControl: null,
  serverTiming: null,
  decoSection: null,
});

describe("faviconParity", () => {
  // Kept hermetic: cand has NO icon, so the byte-hash fetch path never runs.
  it("flags missing icon (high) and missing webmanifest (medium)", async () => {
    const prod = makePageCapture({
      url: HOME,
      side: "prod",
      html: `<html><head><link rel="icon" href="/favicon.ico"><link rel="manifest" href="/site.webmanifest"></head><body></body></html>`,
    });
    const cand = makePageCapture({
      url: CAND,
      side: "cand",
      html: "<html><head></head><body></body></html>",
    });
    const r = await faviconParity(makeContext({ prodPages: [prod], candPages: [cand] }));
    expect(r.issues.find((i) => i.id === "favicon:icon-missing")?.severity).toBe("high");
    expect(r.issues.find((i) => i.id === "favicon:manifest-missing")?.severity).toBe("medium");
  });

  it("single-site with no icon at all flags favicon:none", async () => {
    const cand = makePageCapture({
      url: CAND,
      side: "cand",
      html: "<html><head></head><body></body></html>",
    });
    const r = await faviconParity(makeContext({ candPages: [cand] }));
    expect(r.issues[0]?.id).toBe("favicon:none");
  });
});

describe("fontParity", () => {
  it("flags silent fallback when prod loads fonts and cand loads none", () => {
    const prod = makePageCapture({
      url: HOME,
      side: "prod",
      network: [fontReq("https://fonts.gstatic.com/s/lato/v1.woff2")],
    });
    const cand = makePageCapture({
      url: CAND,
      side: "cand",
      html: `<html><head><style>:root{--font-sans:'Lato'}</style></head><body></body></html>`,
      network: [],
    });
    const r = fontParity(makeContext({ prodPages: [prod], candPages: [cand] }));
    expect(r.status).toBe("fail");
    expect(r.issues[0]?.id).toBe("font:no-font-loaded");
    expect(r.issues[0]?.summary).toMatch(/Lato/);
  });

  it("passes when both sides load the same font count", () => {
    const net = [fontReq("https://fonts.gstatic.com/s/lato/v1.woff2")];
    const r = fontParity(
      makeContext({
        prodPages: [makePageCapture({ url: HOME, side: "prod", network: net })],
        candPages: [makePageCapture({ url: CAND, side: "cand", network: net })],
      }),
    );
    expect(r.status).toBe("pass");
  });
});

describe("navLinksHealth", () => {
  it("flags a dead same-page anchor present in prod but broken in cand as high", async () => {
    const prod = makePageCapture({
      url: HOME,
      side: "prod",
      html: `<html><body><nav><a href="#depoimentos">Depoimentos</a></nav><section id="depoimentos"></section></body></html>`,
    });
    const cand = makePageCapture({
      url: CAND,
      side: "cand",
      html: `<html><body><nav><a href="#depoimentos">Depoimentos</a></nav></body></html>`,
    });
    const r = await navLinksHealth(makeContext({ prodPages: [prod], candPages: [cand] }));
    const anchor = r.issues.find((i) => i.id === "nav:dead-anchor:#depoimentos");
    expect(anchor?.severity).toBe("high");
  });

  it("flags an anchor dead on both sides as low (pre-existing)", async () => {
    const html = `<html><body><nav><a href="#nope">X</a></nav></body></html>`;
    const r = await navLinksHealth(
      makeContext({
        prodPages: [makePageCapture({ url: HOME, side: "prod", html })],
        candPages: [makePageCapture({ url: CAND, side: "cand", html })],
      }),
    );
    expect(r.issues.find((i) => i.id === "nav:dead-anchor:#nope")?.severity).toBe("low");
  });
});
