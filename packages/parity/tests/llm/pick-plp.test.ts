import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  })),
}));

import { pickCategoryLink } from "../../src/llm/pick-plp.ts";

describe("pickCategoryLink", () => {
  beforeEach(() => mockCreate.mockReset());
  afterEach(() => delete process.env.ANTHROPIC_API_KEY);

  it("returns null when no candidates", async () => {
    expect(await pickCategoryLink([])).toBeNull();
  });

  it("returns the only candidate when there's just one", async () => {
    const c = { text: "Vestidos", href: "/vestidos" };
    expect(await pickCategoryLink([c])).toEqual(c);
  });

  it("filters out institutional pages via blocklist", async () => {
    const cands = [
      { text: "Sobre", href: "/sobre" },
      { text: "Atendimento", href: "/atendimento" },
      { text: "Vestidos", href: "/vestidos" },
    ];
    expect(await pickCategoryLink(cands)).toEqual({ text: "Vestidos", href: "/vestidos" });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("returns first candidate when blocklist removes everything", async () => {
    const cands = [
      { text: "Sobre", href: "/sobre" },
      { text: "Contato", href: "/contato" },
    ];
    expect(await pickCategoryLink(cands)).toEqual(cands[0]);
  });

  it("prefers URLs with /c/ /category/ /collections/", async () => {
    const cands = [
      { text: "Calçados", href: "/c/calcados" },
      { text: "Roupas", href: "/roupas" },
    ];
    expect(await pickCategoryLink(cands)).toEqual({ text: "Calçados", href: "/c/calcados" });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("falls back to LLM when multiple strong candidates exist", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    mockCreate.mockResolvedValue({
      content: [{ type: "tool_use", name: "pick_category", input: { index: 1, reasoning: "" } }],
    });
    const cands = [
      { text: "Lar e Decoração", href: "/c/lar" },
      { text: "Vestidos", href: "/c/vestidos" },
      { text: "Calçados", href: "/c/calcados" },
    ];
    const out = await pickCategoryLink(cands);
    expect(out).toEqual(cands[1]);
    expect(mockCreate).toHaveBeenCalled();
  });

  it("falls back to first candidate when LLM returns an invalid index", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    mockCreate.mockResolvedValue({
      content: [{ type: "tool_use", name: "pick_category", input: { index: 999 } }],
    });
    const cands = [
      { text: "A", href: "/c/a" },
      { text: "B", href: "/c/b" },
    ];
    const out = await pickCategoryLink(cands);
    expect(out).toEqual(cands[0]);
  });
});
