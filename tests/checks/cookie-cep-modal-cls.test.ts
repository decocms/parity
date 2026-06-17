import { describe, expect, it } from "vitest";
import { cookieCepModalCls } from "../../src/checks/cookie-cep-modal-cls.ts";
import { makeContext } from "../helpers/make-context.ts";
import { makePageCapture } from "../helpers/make-page-capture.ts";

const MODAL_HTML =
  '<html><body><div role="dialog" class="cookie-banner">Accept cookies</div></body></html>';

describe("cookieCepModalCls", () => {
  it("passa quando ambos têm CLS baixo", () => {
    const r = cookieCepModalCls(
      makeContext({
        prodPages: [
          makePageCapture({
            url: "https://example.com/",
            html: MODAL_HTML,
            vitals: { lcp: null, cls: 0.02, fcp: null, ttfb: null, inp: null },
            side: "prod",
          }),
        ],
        candPages: [
          makePageCapture({
            url: "https://example.com/",
            html: MODAL_HTML,
            vitals: { lcp: null, cls: 0.03, fcp: null, ttfb: null, inp: null },
            side: "cand",
          }),
        ],
      }),
    );
    expect(r.status).toBe("pass");
  });

  it("high quando cand introduz CLS >0.1 com modal", () => {
    const r = cookieCepModalCls(
      makeContext({
        prodPages: [
          makePageCapture({
            url: "https://example.com/",
            html: MODAL_HTML,
            vitals: { lcp: null, cls: 0.05, fcp: null, ttfb: null, inp: null },
            side: "prod",
          }),
        ],
        candPages: [
          makePageCapture({
            url: "https://example.com/",
            html: MODAL_HTML,
            vitals: { lcp: null, cls: 0.25, fcp: null, ttfb: null, inp: null },
            side: "cand",
          }),
        ],
      }),
    );
    expect(r.issues.some((i) => i.severity === "high")).toBe(true);
  });

  it("medium quando CLS piorou >50%", () => {
    const r = cookieCepModalCls(
      makeContext({
        prodPages: [
          makePageCapture({
            url: "https://example.com/",
            html: MODAL_HTML,
            vitals: { lcp: null, cls: 0.04, fcp: null, ttfb: null, inp: null },
            side: "prod",
          }),
        ],
        candPages: [
          makePageCapture({
            url: "https://example.com/",
            html: MODAL_HTML,
            vitals: { lcp: null, cls: 0.07, fcp: null, ttfb: null, inp: null },
            side: "cand",
          }),
        ],
      }),
    );
    expect(r.issues.some((i) => i.severity === "medium")).toBe(true);
  });
});
