import { describe, expect, it } from "vitest";
import { parsePriceBRL } from "../../../src/engine/flows/cart-helpers.ts";

describe("parsePriceBRL", () => {
  it("parses a simple BRL price with symbol", () => {
    expect(parsePriceBRL("R$ 129,90")).toBe(129.9);
  });

  it("parses a BRL price with thousands separator", () => {
    expect(parsePriceBRL("R$ 1.234,56")).toBe(1234.56);
  });

  it("parses without the currency symbol", () => {
    expect(parsePriceBRL("129,90")).toBe(129.9);
  });

  it("parses embedded in surrounding text", () => {
    expect(parsePriceBRL("Total: R$ 2.500,00 à vista")).toBe(2500);
  });

  it("falls back to dot-decimal when no comma format is present", () => {
    expect(parsePriceBRL("129.90")).toBe(129.9);
  });

  it("returns null for text with no currency-shaped number", () => {
    expect(parsePriceBRL("carrinho vazio")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parsePriceBRL("")).toBeNull();
  });
});
