import { describe, expect, it } from "vitest";
import {
  pictureMissingDims,
  scanForPictureMissingDims,
} from "../../src/checks/picture-missing-dims.ts";
import { makeContext } from "../helpers/make-context.ts";
import { makePageCapture } from "../helpers/make-page-capture.ts";

const PICTURE_WITHOUT_DIMS = `<html><body>
  <picture>
    <source srcset="a.webp 1x" media="(max-width: 768px)" />
    <img src="banner.jpg" alt="hero" />
  </picture>
</body></html>`;

const PICTURE_WITH_DIMS = `<html><body>
  <picture>
    <source srcset="a.webp 1x" media="(max-width: 768px)" />
    <img src="banner.jpg" alt="hero" width="800" height="400" />
  </picture>
</body></html>`;

const MULTIPLE_OFFENDERS = `<html><body>
  <picture><img src="a.jpg" /></picture>
  <picture><img src="b.jpg" /></picture>
  <picture><img src="c.jpg" /></picture>
</body></html>`;

const MIXED = `<html><body>
  <picture><img src="ok.jpg" width="100" height="50" /></picture>
  <picture><img src="bad.jpg" /></picture>
</body></html>`;

describe("scanForPictureMissingDims (issue #54 Tier 0: CLS from Picture without dims)", () => {
  it("detecta <img> dentro de <picture> sem width/height", () => {
    const page = makePageCapture({ html: PICTURE_WITHOUT_DIMS });
    expect(scanForPictureMissingDims(page)).toHaveLength(1);
  });

  it("não flagga quando width E height estão presentes", () => {
    const page = makePageCapture({ html: PICTURE_WITH_DIMS });
    expect(scanForPictureMissingDims(page)).toEqual([]);
  });

  it("conta múltiplos offenders separadamente", () => {
    const page = makePageCapture({ html: MULTIPLE_OFFENDERS });
    expect(scanForPictureMissingDims(page)).toHaveLength(3);
  });

  it("ignora <img> que NÃO está dentro de <picture>", () => {
    const page = makePageCapture({
      html: `<html><body><img src="standalone.jpg" /></body></html>`,
    });
    expect(scanForPictureMissingDims(page)).toEqual([]);
  });

  it("flagga só os offenders quando há mix de ok/bad", () => {
    const page = makePageCapture({ html: MIXED });
    const found = scanForPictureMissingDims(page);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("bad.jpg");
  });

  it("retorna [] em HTML vazio", () => {
    const page = makePageCapture({ html: "" });
    expect(scanForPictureMissingDims(page)).toEqual([]);
  });

  describe("review feedback: aspect-ratio + inline style hints reserve space", () => {
    it("NÃO flagga quando style tem aspect-ratio", () => {
      const page = makePageCapture({
        html: `<picture><img src="x.jpg" style="aspect-ratio: 16/9" /></picture>`,
      });
      expect(scanForPictureMissingDims(page)).toEqual([]);
    });

    it("NÃO flagga quando style tem width + height", () => {
      const page = makePageCapture({
        html: `<picture><img src="x.jpg" style="width: 100px; height: 50px" /></picture>`,
      });
      expect(scanForPictureMissingDims(page)).toEqual([]);
    });

    it("flagga quando style só tem width (sem height nem aspect-ratio)", () => {
      const page = makePageCapture({
        html: `<picture><img src="x.jpg" style="width: 100%" /></picture>`,
      });
      expect(scanForPictureMissingDims(page)).toHaveLength(1);
    });

    it("aceita aspect-ratio com case-insensitive matching", () => {
      const page = makePageCapture({
        html: `<picture><img src="x.jpg" style="ASPECT-RATIO:16/9" /></picture>`,
      });
      expect(scanForPictureMissingDims(page)).toEqual([]);
    });

    it("trata width='' como ausente (não reserva espaço)", () => {
      const page = makePageCapture({
        html: `<picture><img src="x.jpg" width="" height="" /></picture>`,
      });
      expect(scanForPictureMissingDims(page)).toHaveLength(1);
    });
  });

  it("requer AMBOS width e height (só um não basta)", () => {
    const widthOnly = makePageCapture({
      html: `<picture><img src="x.jpg" width="100" /></picture>`,
    });
    expect(scanForPictureMissingDims(widthOnly)).toHaveLength(1);
    const heightOnly = makePageCapture({
      html: `<picture><img src="x.jpg" height="50" /></picture>`,
    });
    expect(scanForPictureMissingDims(heightOnly)).toHaveLength(1);
  });
});

describe("pictureMissingDims check", () => {
  it("PASS quando nenhuma página tem offenders", () => {
    const r = pictureMissingDims(
      makeContext({
        candPages: [makePageCapture({ html: PICTURE_WITH_DIMS, side: "cand" })],
      }),
    );
    expect(r.status).toBe("pass");
    expect(r.issues).toHaveLength(0);
  });

  it("WARN com 1 issue medium quando cand tem <Picture> sem dims", () => {
    const r = pictureMissingDims(
      makeContext({
        candPages: [makePageCapture({ html: PICTURE_WITHOUT_DIMS, side: "cand" })],
      }),
    );
    expect(r.status).toBe("warn");
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]!.severity).toBe("medium");
    expect(r.issues[0]!.category).toBe("performance");
  });

  it("uma issue POR PÁGINA com pelo menos 1 offender", () => {
    const r = pictureMissingDims(
      makeContext({
        candPages: [
          makePageCapture({ url: "https://x/a", html: PICTURE_WITHOUT_DIMS, side: "cand" }),
          makePageCapture({ url: "https://x/b", html: MULTIPLE_OFFENDERS, side: "cand" }),
          makePageCapture({ url: "https://x/c", html: PICTURE_WITH_DIMS, side: "cand" }),
        ],
      }),
    );
    expect(r.issues).toHaveLength(2); // a e b, c clean
  });

  it("ignora páginas do lado prod (regressão de cand é o foco)", () => {
    const r = pictureMissingDims(
      makeContext({
        prodPages: [makePageCapture({ html: PICTURE_WITHOUT_DIMS, side: "prod" })],
        candPages: [makePageCapture({ html: PICTURE_WITH_DIMS, side: "cand" })],
      }),
    );
    expect(r.issues).toHaveLength(0);
  });

  it("summary conta offenders e detail trunca em 10", () => {
    const offenders = Array.from({ length: 15 }, (_, i) => `<picture><img src="i${i}.jpg" /></picture>`).join("");
    const r = pictureMissingDims(
      makeContext({
        candPages: [makePageCapture({ html: `<html><body>${offenders}</body></html>`, side: "cand" })],
      }),
    );
    expect(r.issues[0]!.summary).toMatch(/15 <Picture>/);
    expect(r.issues[0]!.details).toMatch(/e mais 5/);
  });
});
