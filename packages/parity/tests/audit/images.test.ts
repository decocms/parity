import { describe, expect, it } from "vitest";
import { auditImages } from "../../src/audit/images.ts";

function htmlWith(body: string): string {
  return `<!doctype html><html><body>${body}</body></html>`;
}

describe("auditImages", () => {
  it("retorna vazio quando não há imagens", () => {
    expect(auditImages("/::mobile", htmlWith(""))).toEqual([]);
  });

  it("flagga alt ausente >50% como high", () => {
    const body =
      `<img src="/a.jpg" alt="ok">` +
      `<img src="/b.jpg">` +
      `<img src="/c.jpg">` +
      `<img src="/d.jpg">`;
    const r = auditImages("/::mobile", htmlWith(body));
    const altIssue = r.find((i) => i.id.includes(":alt:"));
    expect(altIssue?.severity).toBe("high");
    expect(altIssue?.summary).toMatch(/3\/4/);
  });

  it("flagga banner sem width/height como medium (CLS risk)", () => {
    const body =
      '<div data-section="Images/Carousel">' + '<img src="/banner.jpg" alt="banner">' + "</div>";
    const r = auditImages("/::mobile", htmlWith(body));
    const dimIssue = r.find((i) => i.id.includes(":banner-dims:"));
    expect(dimIssue?.severity).toBe("medium");
  });

  it("não flagga dims quando banner tem width+height", () => {
    const body =
      '<div data-section="Images/Carousel">' +
      '<img src="/banner.jpg" width="1440" height="600" alt="banner">' +
      "</div>";
    const r = auditImages("/::mobile", htmlWith(body));
    const dimIssue = r.find((i) => i.id.includes(":banner-dims:"));
    expect(dimIssue).toBeUndefined();
  });

  it("flagga baixa cobertura de srcset como low", () => {
    const body = Array.from({ length: 8 }, (_, i) => `<img src="/p${i}.jpg" alt="p">`).join("");
    const r = auditImages("/::mobile", htmlWith(body));
    const srcsetIssue = r.find((i) => i.id.includes(":srcset:"));
    expect(srcsetIssue?.severity).toBe("low");
  });

  it("não flagga srcset quando há <5 imagens (amostra pequena)", () => {
    const body = `<img src="/a.jpg" alt="a"><img src="/b.jpg" alt="b">`;
    const r = auditImages("/::mobile", htmlWith(body));
    const srcsetIssue = r.find((i) => i.id.includes(":srcset:"));
    expect(srcsetIssue).toBeUndefined();
  });
});
