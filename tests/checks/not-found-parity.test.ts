import { describe, expect, it } from "vitest";
import { notFoundParity } from "../../src/checks/not-found-parity.ts";
import { makeContext } from "../helpers/make-context.ts";
import { makePageCapture } from "../helpers/make-page-capture.ts";

const TEST_404_URL = "https://example.com/this-page-definitely-does-not-exist-abc";

describe("notFoundParity", () => {
  it("skipa quando não há captura de URL de teste 404", () => {
    const r = notFoundParity(makeContext());
    expect(r.status).toBe("skipped");
  });

  it("passa quando ambos retornam 404 com mensagem", () => {
    const html = "<html><body><h1>Página não encontrada</h1></body></html>";
    const r = notFoundParity(
      makeContext({
        prodPages: [makePageCapture({ url: TEST_404_URL, finalUrl: TEST_404_URL, status: 404, html, side: "prod" })],
        candPages: [makePageCapture({ url: TEST_404_URL, finalUrl: TEST_404_URL, status: 404, html, side: "cand" })],
      }),
    );
    expect(r.status).toBe("pass");
  });

  it("critical quando cand retorna 200 em URL inválida (catch-all bug)", () => {
    const html = "<html><body>Hi</body></html>";
    const r = notFoundParity(
      makeContext({
        prodPages: [makePageCapture({ url: TEST_404_URL, finalUrl: TEST_404_URL, status: 404, html, side: "prod" })],
        candPages: [makePageCapture({ url: TEST_404_URL, finalUrl: TEST_404_URL, status: 200, html, side: "cand" })],
      }),
    );
    expect(r.status).toBe("fail");
    expect(r.issues.some((i) => i.severity === "critical")).toBe(true);
  });

  it("medium quando empty state ausente em cand", () => {
    const r = notFoundParity(
      makeContext({
        prodPages: [
          makePageCapture({
            url: TEST_404_URL,
            finalUrl: TEST_404_URL,
            status: 404,
            html: "<html><body><h1>Página não encontrada</h1></body></html>",
            side: "prod",
          }),
        ],
        candPages: [
          makePageCapture({
            url: TEST_404_URL,
            finalUrl: TEST_404_URL,
            status: 404,
            html: "<html><body><h1>Oops</h1></body></html>",
            side: "cand",
          }),
        ],
      }),
    );
    expect(r.issues.some((i) => i.severity === "medium")).toBe(true);
  });
});
