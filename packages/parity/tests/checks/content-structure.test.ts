import { describe, expect, it } from "vitest";
import { contentStructureParity } from "../../src/checks/content-structure.ts";
import { makeContext } from "../helpers/make-context.ts";
import { makePageCapture } from "../helpers/make-page-capture.ts";

const PATH = "/politica-de-privacidad";
const url = (host: string) => `https://${host}${PATH}`;

/** Long enough to clear the "prod is a stub too" floor. */
const filler = "Cláusula ".repeat(80);

function page(html: string, side: "prod" | "cand") {
  return makePageCapture({
    url: url(side === "prod" ? "www.example.com" : "cand.example.com"),
    side,
    html: `<html><body><main>${html}</main></body></html>`,
  });
}

/** VTEX IO marks bold with a class, not a tag — the blind spot this check exists for. */
const legacy = `
  <p><span class="b vtex-rich-text-0-x-strong">TÍTULO DA CLÁUSULA</span><br>${filler}</p>
  <p><span class="b vtex-rich-text-0-x-strong">SEGUNDA CLÁUSULA</span><br>${filler}</p>
  <p>${filler}<a href="/x">ver mais</a></p>
`;

const faithful = `
  <p><strong>TÍTULO DA CLÁUSULA</strong><br>${filler}</p>
  <p><strong>SEGUNDA CLÁUSULA</strong><br>${filler}</p>
  <p>${filler}<a href="/x">ver mais</a></p>
`;

/** Same words, flattened markup: what an innerText-based extractor produces. */
const flattened = `
  <p>TÍTULO DA CLÁUSULA ${filler}</p>
  <p>SEGUNDA CLÁUSULA ${filler}</p>
  <p>${filler}<a href="/x">ver mais</a></p>
`;

const run = (prodHtml: string, candHtml: string) =>
  contentStructureParity(
    makeContext({ prodPages: [page(prodHtml, "prod")], candPages: [page(candHtml, "cand")] }),
  );

describe("content-structure", () => {
  it("passa quando a estrutura foi preservada", () => {
    const r = run(legacy, faithful);
    expect(r.status).toBe("pass");
    expect(r.issues).toHaveLength(0);
  });

  it("acusa negrito e quebras perdidos mesmo com a contagem de caracteres batendo", () => {
    const r = run(legacy, flattened);
    expect(r.status).toBe("warn");
    expect(r.issues[0]?.id).toContain("lost-formatting");
    expect(r.issues[0]?.summary).toMatch(/negrito/);
    expect(r.issues[0]?.summary).toMatch(/quebras de linha/);
  });

  it("acusa corpo faltando como falha, nao como formatacao", () => {
    const r = run(legacy, "<p>Política de Privacidad</p>");
    expect(r.status).toBe("fail");
    expect(r.issues[0]?.id).toContain("missing-body");
    expect(r.issues[0]?.severity).toBe("high");
  });

  it("nao cobra do candidato quando o prod tambem e um stub", () => {
    const r = run("<p>Política de Privacidad</p>", "<p>Política de Privacidad</p>");
    expect(r.status).toBe("pass");
  });

  it("ignora paginas que nao sao editoriais", () => {
    const plp = (side: "prod" | "cand") =>
      makePageCapture({
        url: `https://${side === "prod" ? "www" : "cand"}.example.com/refrigeracion`,
        side,
        html: `<html><body><main><p>${filler}</p></main></body></html>`,
      });
    const r = contentStructureParity(makeContext({ prodPages: [plp("prod")], candPages: [plp("cand")] }));
    expect(r.status).toBe("skipped");
  });

  it("pula quando falta um dos lados", () => {
    const r = contentStructureParity(
      makeContext({ prodPages: [page(legacy, "prod")], candPages: [] }),
    );
    expect(r.status).toBe("skipped");
  });
});
