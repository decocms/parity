import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Anthropic SDK BEFORE importing client.ts
const mockCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  })),
}));

// Force the local-CLI provider to report unavailable so tests are deterministic
// regardless of whether the dev's machine has `~/.claude/`.
vi.mock("../../src/llm/providers/claude-agent-sdk.ts", () => ({
  isClaudeAgentSdkAvailable: () => false,
  callToolSdk: vi.fn(),
  callMessageSdk: vi.fn(),
}));

import {
  callMessage,
  callTool,
  getProvider,
  isLlmAvailable,
  providerLabel,
} from "../../src/llm/client.ts";
import { mockFetch } from "../helpers/mock-fetch.ts";

describe("getProvider / isLlmAvailable / providerLabel", () => {
  const ORIG_ANTHROPIC = process.env.ANTHROPIC_API_KEY;
  const ORIG_OPENROUTER = process.env.OPENROUTER_API_KEY;

  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
  });
  afterEach(() => {
    if (ORIG_ANTHROPIC) process.env.ANTHROPIC_API_KEY = ORIG_ANTHROPIC;
    if (ORIG_OPENROUTER) process.env.OPENROUTER_API_KEY = ORIG_OPENROUTER;
  });

  it("returns null when no key is set and no claude CLI", () => {
    expect(getProvider()).toBeNull();
    expect(isLlmAvailable()).toBe(false);
    expect(providerLabel()).toBe("none");
  });

  it("prefers Anthropic when ANTHROPIC_API_KEY is set", () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    expect(getProvider()).toBe("anthropic");
    expect(providerLabel()).toMatch(/anthropic/);
  });

  it("falls back to OpenRouter when only OPENROUTER_API_KEY is set", () => {
    process.env.OPENROUTER_API_KEY = "or-test";
    expect(getProvider()).toBe("openrouter");
    expect(providerLabel()).toMatch(/openrouter/);
  });

  it("Anthropic wins over OpenRouter when both are set", () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    process.env.OPENROUTER_API_KEY = "or-test";
    expect(getProvider()).toBe("anthropic");
  });
});

describe("callTool — Anthropic branch", () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    delete process.env.OPENROUTER_API_KEY;
    mockCreate.mockReset();
  });
  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  it("returns parsed tool input on success", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "tool_use", name: "my-tool", input: { foo: "bar" } }],
    });
    const out = await callTool<{ foo: string }>({
      feature: "selector-discovery",
      systemPrompt: "sys",
      userText: "hello",
      tool: { name: "my-tool", description: "d", inputSchema: { type: "object" } },
    });
    expect(out).toEqual({ foo: "bar" });
  });

  it("returns null when SDK call throws", async () => {
    mockCreate.mockRejectedValue(new Error("boom"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const out = await callTool({
      feature: "selector-discovery",
      systemPrompt: "s",
      userText: "u",
      tool: { name: "t", description: "d", inputSchema: { type: "object" } },
    });
    expect(out).toBeNull();
    spy.mockRestore();
  });

  it("returns null when no tool_use block in response", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "hello there" }],
    });
    const out = await callTool({
      feature: "selector-discovery",
      systemPrompt: "s",
      userText: "u",
      tool: { name: "t", description: "d", inputSchema: { type: "object" } },
    });
    expect(out).toBeNull();
  });

  it("passes images in user content when provided", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "tool_use", name: "t", input: { ok: true } }],
    });
    await callTool({
      feature: "visual-diff",
      systemPrompt: "s",
      userText: "u",
      tool: { name: "t", description: "d", inputSchema: { type: "object" } },
      userImages: [{ base64: "iVBOR=", mediaType: "image/png" }],
    });
    const call = mockCreate.mock.calls[0]?.[0];
    expect(call.messages[0].content).toEqual(
      expect.arrayContaining([
        { type: "text", text: "u" },
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "iVBOR=" },
        },
      ]),
    );
  });

  it("routes selector-discovery feature to haiku model by default", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "tool_use", name: "t", input: {} }],
    });
    await callTool({
      feature: "selector-discovery",
      systemPrompt: "s",
      userText: "u",
      tool: { name: "t", description: "d", inputSchema: { type: "object" } },
    });
    const call = mockCreate.mock.calls[0]?.[0];
    expect(call.model).toBe("claude-haiku-4-5");
    expect(call.max_tokens).toBe(2000);
  });

  it("routes visual-diff feature to sonnet model by default", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "tool_use", name: "t", input: {} }],
    });
    await callTool({
      feature: "visual-diff",
      systemPrompt: "s",
      userText: "u",
      tool: { name: "t", description: "d", inputSchema: { type: "object" } },
    });
    const call = mockCreate.mock.calls[0]?.[0];
    expect(call.model).toBe("claude-sonnet-4-6");
  });

  it("passes AbortSignal for timeout enforcement", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "tool_use", name: "t", input: {} }],
    });
    await callTool({
      feature: "selector-discovery",
      systemPrompt: "s",
      userText: "u",
      tool: { name: "t", description: "d", inputSchema: { type: "object" } },
    });
    const opts = mockCreate.mock.calls[0]?.[1];
    expect(opts?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("callTool — OpenRouter branch", () => {
  let restore: () => void = () => undefined;

  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.OPENROUTER_API_KEY = "or-test";
  });
  afterEach(() => {
    delete process.env.OPENROUTER_API_KEY;
    restore();
  });

  it("posts to OpenRouter and parses tool arguments", async () => {
    ({ restore } = mockFetch({
      "/api/v1/chat/completions": {
        status: 200,
        body: JSON.stringify({
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    function: { name: "t", arguments: JSON.stringify({ x: 1 }) },
                  },
                ],
              },
            },
          ],
        }),
      },
    }));
    const out = await callTool<{ x: number }>({
      feature: "selector-discovery",
      systemPrompt: "s",
      userText: "u",
      tool: { name: "t", description: "d", inputSchema: { type: "object" } },
    });
    expect(out).toEqual({ x: 1 });
  });

  it("returns null on non-2xx OpenRouter response", async () => {
    ({ restore } = mockFetch({
      "/api/v1/chat/completions": { status: 500, body: "server error" },
    }));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const out = await callTool({
      feature: "selector-discovery",
      systemPrompt: "s",
      userText: "u",
      tool: { name: "t", description: "d", inputSchema: { type: "object" } },
    });
    expect(out).toBeNull();
    spy.mockRestore();
  });

  it("returns null on network failure", async () => {
    ({ restore } = mockFetch({ "/api/v1/chat/completions": { error: "ECONNRESET" } }));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const out = await callTool({
      feature: "selector-discovery",
      systemPrompt: "s",
      userText: "u",
      tool: { name: "t", description: "d", inputSchema: { type: "object" } },
    });
    expect(out).toBeNull();
    spy.mockRestore();
  });
});

describe("callTool — no provider", () => {
  it("returns null when no API key and no claude CLI", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    const out = await callTool({
      feature: "selector-discovery",
      systemPrompt: "s",
      userText: "u",
      tool: { name: "t", description: "d", inputSchema: { type: "object" } },
    });
    expect(out).toBeNull();
  });
});

describe("callMessage", () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    delete process.env.OPENROUTER_API_KEY;
    mockCreate.mockReset();
  });
  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  it("returns text content on success", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "hello world" }],
    });
    const out = await callMessage({ feature: "explain", systemPrompt: "s", userText: "u" });
    expect(out).toBe("hello world");
  });

  it("returns null when SDK throws", async () => {
    mockCreate.mockRejectedValue(new Error("boom"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const out = await callMessage({ feature: "explain", systemPrompt: "s", userText: "u" });
    expect(out).toBeNull();
    spy.mockRestore();
  });

  it("joins multiple text blocks", async () => {
    mockCreate.mockResolvedValue({
      content: [
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ],
    });
    const out = await callMessage({ feature: "explain", systemPrompt: "s", userText: "u" });
    expect(out).toBe("a\nb");
  });
});
