import { describe, expect, it } from "vitest";
import { isLocalhost } from "../../src/util/localhost.ts";

describe("isLocalhost (issue #55: detect dev servers to skip networkidle)", () => {
  it.each([
    ["http://localhost:5173/", true],
    ["http://localhost/", true],
    ["http://127.0.0.1:8080/foo", true],
    ["http://0.0.0.0/", true],
    ["http://[::1]:3000/", true],
    ["https://localhost:8443/", true],
  ])("identifica %s como localhost", (url, expected) => {
    expect(isLocalhost(url)).toBe(expected);
  });

  it.each([
    "https://www.granado.com.br/",
    "https://miess-tanstack.deco-cx.workers.dev/",
    "https://example.com/",
    "https://localtest.example.com/",
    "https://localhost.example.com/",
    "http://192.168.1.10/",
  ])("não identifica %s como localhost", (url) => {
    expect(isLocalhost(url)).toBe(false);
  });

  it("não lança em URLs inválidas", () => {
    expect(() => isLocalhost("nem://é uma url://")).not.toThrow();
    expect(isLocalhost("nope")).toBe(false);
    expect(isLocalhost("")).toBe(false);
  });
});
