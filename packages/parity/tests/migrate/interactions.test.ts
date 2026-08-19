import { describe, expect, it } from "vitest";
import { classifyE2eKey } from "../../src/migrate/interactions.ts";

describe("classifyE2eKey", () => {
  it("maps commerce affordances to SelectorKeys", () => {
    expect(classifyE2eKey("adicionar ao carrinho", "button")).toBe("buyButton");
    expect(classifyE2eKey("finalizar compra", "button")).toBe("checkoutButton");
    expect(classifyE2eKey("buscar produtos", "input")).toBe("searchInput");
    expect(classifyE2eKey("abrir sacola", "button")).toBe("minicartTrigger");
    expect(classifyE2eKey("entrar na minha conta", "link")).toBe("loginTrigger");
    expect(classifyE2eKey("carregar mais", "button")).toBe("loadMoreButton");
  });

  it("prefers input-email over generic login for email fields", () => {
    expect(classifyE2eKey("email login", "input")).toBe("loginEmailInput");
    expect(classifyE2eKey("senha password", "input")).toBe("loginPasswordInput");
  });

  it("returns null for generic interactive elements", () => {
    expect(classifyE2eKey("home", "link")).toBeNull();
    expect(classifyE2eKey("read our blog", "link")).toBeNull();
  });
});
