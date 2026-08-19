import type { PageCapture, Side, Viewport, WebVitals } from "../../src/types/schema.ts";

const EMPTY_VITALS: WebVitals = { lcp: null, cls: null, fcp: null, ttfb: null, inp: null };

export function makePageCapture(over: Partial<PageCapture> = {}): PageCapture {
  return {
    url: "https://example.com/",
    finalUrl: "https://example.com/",
    status: 200,
    viewport: "mobile" as Viewport,
    side: "prod" as Side,
    durationMs: 1000,
    html: "<html><head><title>OK</title></head><body>OK</body></html>",
    vitals: EMPTY_VITALS,
    console: [],
    network: [],
    screenshotPath: "/tmp/fake.png",
    ...over,
  };
}

export function makePairedPages(opts: {
  url?: string;
  viewport?: Viewport;
  prodHtml?: string;
  candHtml?: string;
  prodOver?: Partial<PageCapture>;
  candOver?: Partial<PageCapture>;
}): { prod: PageCapture; cand: PageCapture } {
  const url = opts.url ?? "https://example.com/";
  const viewport = opts.viewport ?? "mobile";
  return {
    prod: makePageCapture({
      url,
      viewport,
      side: "prod",
      html: opts.prodHtml ?? "",
      ...opts.prodOver,
    }),
    cand: makePageCapture({
      url: url.replace("example.com", "candidate.example.com"),
      viewport,
      side: "cand",
      html: opts.candHtml ?? "",
      ...opts.candOver,
    }),
  };
}
