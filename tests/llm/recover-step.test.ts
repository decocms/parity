import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  })),
}));

import { compactHtmlForRecovery, suggestRecovery } from "../../src/llm/recover-step.ts";

describe("compactHtmlForRecovery", () => {
  it("strips scripts, styles, svg", () => {
    const html = "<html><head><script>alert(1)</script><style>body{}</style></head><body><svg><path/></svg><button>Buy</button></body></html>";
    const out = compactHtmlForRecovery(html);
    expect(out).not.toMatch(/<script/);
    expect(out).not.toMatch(/<style/);
    expect(out).not.toMatch(/<svg/);
    expect(out).toMatch(/<button/);
  });

  it("truncates output at maxChars", () => {
    const big = `<button>${"x".repeat(20_000)}</button>`;
    const out = compactHtmlForRecovery(big, 1000);
    expect(out.length).toBeLessThan(1500);
    expect(out).toMatch(/TRUNCATED/);
  });

  it("falls back to plain truncation if cheerio crashes (just slices)", () => {
    // Pass legitimately bizarre input — cheerio is usually tolerant, this is more
    // about ensuring we don't throw.
    const out = compactHtmlForRecovery("@@not really html@@", 100);
    expect(typeof out).toBe("string");
  });
});

describe("suggestRecovery", () => {
  beforeEach(() => mockCreate.mockReset());
  afterEach(() => delete process.env.ANTHROPIC_API_KEY);

  it("returns null when no LLM key", async () => {
    const out = await suggestRecovery({
      stepName: "click-buy",
      intendedAction: "click the buy button",
      html: "<button>Buy</button>",
    });
    expect(out).toBeNull();
  });

  it("returns suggestion when LLM responds with selector + action", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    mockCreate.mockResolvedValue({
      content: [
        {
          type: "tool_use",
          name: "suggest_recovery",
          input: {
            selector: "button:has-text('Comprar')",
            action: "click",
            reasoning: "Visible primary CTA",
          },
        },
      ],
    });
    const out = await suggestRecovery({
      stepName: "buy",
      intendedAction: "click buy",
      html: "<button>Comprar</button>",
    });
    expect(out).toEqual({
      selector: "button:has-text('Comprar')",
      action: "click",
      value: undefined,
      reasoning: "Visible primary CTA",
    });
  });

  it("returns null when LLM omits selector or action", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    mockCreate.mockResolvedValue({
      content: [
        { type: "tool_use", name: "suggest_recovery", input: { selector: "btn" /* no action */ } },
      ],
    });
    const out = await suggestRecovery({
      stepName: "buy",
      intendedAction: "click buy",
      html: "<button>Buy</button>",
    });
    expect(out).toBeNull();
  });

  it("includes alreadyTried hint in the prompt when provided", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    mockCreate.mockResolvedValue({
      content: [
        { type: "tool_use", name: "suggest_recovery", input: { selector: "x", action: "click" } },
      ],
    });
    await suggestRecovery({
      stepName: "x",
      intendedAction: "y",
      html: "<button>x</button>",
      alreadyTried: ["#failed-1", "#failed-2"],
    });
    const userText = mockCreate.mock.calls[0]?.[0]?.messages?.[0]?.content?.[0]?.text;
    expect(userText).toMatch(/Já tentei/);
    expect(userText).toMatch(/#failed-1/);
  });

  it("propagates fill action with value", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    mockCreate.mockResolvedValue({
      content: [
        {
          type: "tool_use",
          name: "suggest_recovery",
          input: { selector: "input[name='cep']", action: "fill", value: "01310-100" },
        },
      ],
    });
    const out = await suggestRecovery({
      stepName: "fill-cep",
      intendedAction: "fill CEP input",
      html: "<input name='cep'/>",
    });
    expect(out?.action).toBe("fill");
    expect(out?.value).toBe("01310-100");
  });
});
