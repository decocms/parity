import { describe, expect, it } from "vitest";
import { pdpGalleryRelated } from "../../src/checks/pdp-gallery-related.ts";
import { makeContext } from "../helpers/make-context.ts";
import { makePageCapture } from "../helpers/make-page-capture.ts";

const PDP_URL = "https://example.com/p/some-product";

const FULL_PDP_HTML = `
<html><body>
  <div data-gallery-main><img src="/main.jpg"></div>
  <div data-gallery-thumb><img src="/thumb.jpg"></div>
  <section data-related-products>Você também pode gostar</section>
</body></html>
`;

const BAD_PDP_HTML = "<html><body>Just the title</body></html>";

describe("pdpGalleryRelated", () => {
  it("skipa quando nenhuma PDP foi capturada", () => {
    const r = pdpGalleryRelated(makeContext());
    expect(r.status).toBe("skipped");
  });

  it("passa quando ambos PDPs têm gallery main, thumbs, e related", () => {
    const r = pdpGalleryRelated(
      makeContext({
        prodPages: [makePageCapture({ url: PDP_URL, html: FULL_PDP_HTML, side: "prod" })],
        candPages: [makePageCapture({ url: PDP_URL, html: FULL_PDP_HTML, side: "cand" })],
      }),
    );
    expect(r.status).toBe("pass");
  });

  it("critical quando gallery main desapareceu em cand", () => {
    const r = pdpGalleryRelated(
      makeContext({
        prodPages: [makePageCapture({ url: PDP_URL, html: FULL_PDP_HTML, side: "prod" })],
        candPages: [makePageCapture({ url: PDP_URL, html: BAD_PDP_HTML, side: "cand" })],
      }),
    );
    expect(r.status).toBe("fail");
    expect(r.issues.some((i) => i.severity === "critical")).toBe(true);
  });

  it("medium quando related-products ausente em cand", () => {
    const html = `<html><body>
      <div data-gallery-main><img src="/main.jpg"></div>
      <div data-gallery-thumb><img src="/thumb.jpg"></div>
    </body></html>`;
    const r = pdpGalleryRelated(
      makeContext({
        prodPages: [makePageCapture({ url: PDP_URL, html: FULL_PDP_HTML, side: "prod" })],
        candPages: [makePageCapture({ url: PDP_URL, html, side: "cand" })],
      }),
    );
    expect(r.issues.some((i) => i.severity === "medium" && /related/i.test(i.summary))).toBe(true);
  });
});
