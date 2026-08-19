import { describe, expect, it } from "vitest";
import { normalizeColor, stylesToTailwind } from "../../src/migrate/tailwind.ts";

describe("stylesToTailwind", () => {
  it("maps exact-scale values to Tailwind utilities", () => {
    const tw = stylesToTailwind({
      display: "flex",
      "flex-direction": "column",
      "justify-content": "space-between",
      "align-items": "center",
      gap: "16px",
      "font-size": "14px",
      "font-weight": "700",
      "border-radius": "8px",
    });
    expect(tw).toEqual(
      expect.arrayContaining([
        "flex",
        "flex-col",
        "justify-between",
        "items-center",
        "gap-4",
        "text-sm",
        "font-bold",
        "rounded-lg",
      ]),
    );
  });

  it("falls back to arbitrary values (no wrong 'nearest' rewrite)", () => {
    const tw = stylesToTailwind({ "font-size": "13px", "border-radius": "5px" });
    expect(tw).toContain("text-[13px]");
    expect(tw).toContain("rounded-[5px]");
  });

  it("resolves colors to theme tokens when they match, arbitrary otherwise", () => {
    const tokens = { primary: "rgb(228, 0, 43)" };
    const tw = stylesToTailwind(
      { color: "rgb(228, 0, 43)", "background-color": "rgb(0, 0, 0)" },
      tokens,
    );
    expect(tw).toContain("text-primary");
    expect(tw).toContain("bg-[rgb(0,0,0)]");
  });

  it("drops transparent/none and splits padding shorthand", () => {
    const tw = stylesToTailwind({
      "background-color": "rgba(0, 0, 0, 0)",
      "box-shadow": "none",
      padding: "16px 8px",
    });
    expect(tw).not.toContain("shadow");
    expect(tw.some((c) => c.startsWith("bg-"))).toBe(false);
    expect(tw).toEqual(expect.arrayContaining(["py-4", "px-2"]));
  });

  it("normalizeColor strips spaces so arbitrary values stay valid", () => {
    expect(normalizeColor("rgb(228, 0, 43)")).toBe("rgb(228,0,43)");
  });
});
