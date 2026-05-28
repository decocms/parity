import { describe, expect, it } from "vitest";
import type { MatchedRule, TraceResult } from "../../src/commands/css-trace.ts";
import { resolveFromTrace } from "../../src/engine/css-source-resolver.ts";

function rule(
  source: string,
  selector: string,
  props: Array<{ name: string; value: string; important?: boolean }>,
  inheritedFromDistance?: number,
): MatchedRule {
  return {
    source,
    selector,
    properties: props.map((p) => ({
      name: p.name,
      value: p.value,
      important: p.important === true,
    })),
    ...(inheritedFromDistance !== undefined ? { inheritedFromDistance } : {}),
  };
}

function trace(...rules: MatchedRule[]): TraceResult {
  return {
    url: "http://example.com/",
    selector: ".test",
    found: true,
    computed: {},
    rules,
  };
}

describe("resolveFromTrace", () => {
  it("retorna o último match não-!important (cascade)", () => {
    const t = trace(
      rule("base.css", ".btn", [{ name: "color", value: "red" }]),
      rule("override.css", ".btn", [{ name: "color", value: "blue" }]),
    );
    const r = resolveFromTrace(t, ["color"]);
    expect(r.get("color")?.value).toBe("blue");
    expect(r.get("color")?.source).toBe("override.css");
  });

  it("!important vence regra posterior sem !important", () => {
    const t = trace(
      rule("important.css", ".btn", [{ name: "color", value: "green", important: true }]),
      rule("base.css", ".btn", [{ name: "color", value: "purple" }]),
    );
    const r = resolveFromTrace(t, ["color"]);
    expect(r.get("color")?.value).toBe("green");
    expect(r.get("color")?.important).toBe(true);
  });

  it("último !important vence !important anterior", () => {
    const t = trace(
      rule("a.css", ".btn", [{ name: "color", value: "red", important: true }]),
      rule("b.css", ".btn", [{ name: "color", value: "blue", important: true }]),
    );
    const r = resolveFromTrace(t, ["color"]);
    expect(r.get("color")?.value).toBe("blue");
  });

  it("propriedade inheritable vinda de ancestral é considerada", () => {
    const t = trace(
      rule("theme.css", "body", [{ name: "color", value: "rgb(51,51,51)" }], 1),
    );
    const r = resolveFromTrace(t, ["color"]);
    expect(r.get("color")?.value).toBe("rgb(51,51,51)");
    expect(r.get("color")?.inheritedFromDistance).toBe(1);
  });

  it("propriedade NÃO-inheritable em rule herdada é ignorada", () => {
    // `padding` is not inheritable — a rule on `body` doesn't propagate.
    const t = trace(rule("theme.css", "body", [{ name: "padding", value: "20px" }], 1));
    const r = resolveFromTrace(t, ["padding"]);
    expect(r.get("padding")).toBeNull();
  });

  it("retorna null quando propriedade pedida não tem nenhuma regra", () => {
    const t = trace(rule("base.css", ".btn", [{ name: "color", value: "red" }]));
    const r = resolveFromTrace(t, ["margin"]);
    expect(r.get("margin")).toBeNull();
  });

  it("resolve múltiplas propriedades de uma vez", () => {
    const t = trace(
      rule("base.css", ".btn", [
        { name: "color", value: "red" },
        { name: "padding", value: "16px" },
      ]),
      rule("override.css", ".btn", [{ name: "padding", value: "12px" }]),
    );
    const r = resolveFromTrace(t, ["color", "padding"]);
    expect(r.get("color")?.value).toBe("red");
    expect(r.get("color")?.source).toBe("base.css");
    expect(r.get("padding")?.value).toBe("12px");
    expect(r.get("padding")?.source).toBe("override.css");
  });

  it("é case-insensitive nos nomes de propriedade", () => {
    const t = trace(rule("base.css", ".btn", [{ name: "Color", value: "red" }]));
    const r = resolveFromTrace(t, ["COLOR"]);
    expect(r.get("color")?.value).toBe("red");
  });

  it("prefere regra direta sobre herdada (mesma propriedade inheritable)", () => {
    const t = trace(
      // Inherited from body: red
      rule("theme.css", "body", [{ name: "color", value: "red" }], 1),
      // Direct rule on the element: blue → should win because both candidates
      // exist and the direct one has higher specificity in CDP's ordering.
      rule("button.css", ".btn", [{ name: "color", value: "blue" }]),
    );
    const r = resolveFromTrace(t, ["color"]);
    expect(r.get("color")?.value).toBe("blue");
    expect(r.get("color")?.inheritedFromDistance).toBe(0);
  });
});
