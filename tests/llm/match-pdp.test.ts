import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  })),
}));

import { fingerprintPdp, matchPdps } from "../../src/llm/match-pdp.ts";

describe("fingerprintPdp", () => {
  it("extracts name + sku + price from JSON-LD Product", () => {
    const html = `<html><head><script type="application/ld+json">${JSON.stringify({
      "@type": "Product",
      name: "Tênis Esporte",
      sku: "TX-100",
      offers: { price: 199.9 },
    })}</script></head></html>`;
    expect(fingerprintPdp(html)).toEqual({ name: "Tênis Esporte", sku: "TX-100", price: 199.9 });
  });

  it("coerces SKU number to string", () => {
    const html = `<html><head><script type="application/ld+json">${JSON.stringify({
      "@type": "Product",
      name: "X",
      sku: 12345,
    })}</script></head></html>`;
    expect(fingerprintPdp(html).sku).toBe("12345");
  });

  it("handles BR-format price string ('1.500,00' → 1500.00)", () => {
    const html = `<html><head><script type="application/ld+json">${JSON.stringify({
      "@type": "Product",
      name: "X",
      offers: { price: "199,90" },
    })}</script></head></html>`;
    expect(fingerprintPdp(html).price).toBe(199.9);
  });

  it("returns all nulls when no Product JSON-LD", () => {
    expect(fingerprintPdp("<html></html>")).toEqual({ name: null, sku: null, price: null });
  });
});

describe("matchPdps", () => {
  beforeEach(() => mockCreate.mockReset());
  afterEach(() => delete process.env.ANTHROPIC_API_KEY);

  it("returns 'same' when SKUs match exactly (no LLM call)", async () => {
    const v = await matchPdps({ name: "A", price: 100, sku: "X-1" }, { name: "B", price: 200, sku: "X-1" });
    expect(v).toBe("same");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("returns 'different' when one name is missing", async () => {
    const v = await matchPdps({ name: "A", price: 100, sku: null }, { name: null, price: null, sku: null });
    expect(v).toBe("different");
  });

  it("returns 'same' for near-identical names (similarity ≥ 0.95)", async () => {
    const v = await matchPdps(
      { name: "Tênis Esporte", price: 100, sku: null },
      { name: "Tênis  Esporte ", price: 100, sku: null },
    );
    expect(v).toBe("same");
  });

  it("returns 'different' when name similarity < 0.6 and no LLM", async () => {
    const v = await matchPdps(
      { name: "Caderno espiral 100 folhas", price: 100, sku: null },
      { name: "Notebook gamer i7", price: 100, sku: null },
    );
    expect(v).toBe("different");
  });

  it("falls back to LLM when name similarity is in ambiguous range (0.8–0.95)", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    mockCreate.mockResolvedValue({
      content: [
        {
          type: "tool_use",
          name: "classify_pdp_match",
          input: { verdict: "same", reasoning: "color variant" },
        },
      ],
    });
    const v = await matchPdps(
      { name: "Tênis Esporte Preto 42", price: 100, sku: null },
      { name: "Tênis Esporte Branco 42", price: 100, sku: null },
    );
    expect(v).toBe("same");
    expect(mockCreate).toHaveBeenCalled();
  });

  it("returns 'similar' as fallback when LLM returns nothing valid", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    mockCreate.mockResolvedValue({ content: [] });
    const v = await matchPdps(
      { name: "Tênis Esporte Preto 42", price: 100, sku: null },
      { name: "Tênis Esporte Branco 42", price: 100, sku: null },
    );
    expect(v).toBe("similar");
  });
});
