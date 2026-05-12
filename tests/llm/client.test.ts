import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Anthropic SDK BEFORE importing client.ts
const mockCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  })),
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

  it("returns null when no key is set", () => {
    expect(getProvider()).toBeNull();
    expect(isLlmAvailable()).toBe(false);
    expect(providerLabel()).toBe("none");
  });

  it("prefers Anthropic when ANTHROPIC_API_KEY is set", () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    expect(getProvider()).toBe("anthropic");
    expect(providerLabel()).toMatch(/Anthropic/);
  });

  it("falls back to OpenRouter when only OPENROUTER_API_KEY is set", () => {
    process.env.OPENROUTER_API_KEY = "or-test";
    expect(getProvider()).toBe("openrouter");
    expect(providerLabel()).toMatch(/OpenRouter/);
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

  it("uses default model (sonnet 4.6) and 2000 max_tokens", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "tool_use", name: "t", input: {} }],
    });
    await callTool({
      systemPrompt: "s",
      userText: "u",
      tool: { name: "t", description: "d", inputSchema: { type: "object" } },
    });
    const call = mockCreate.mock.calls[0]?.[0];
    expect(call.model).toBe("claude-sonnet-4-6");
    expect(call.max_tokens).toBe(2000);
  });

  it("passes AbortSignal for timeout enforcement", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "tool_use", name: "t", input: {} }],
    });
    await callTool({
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
      systemPrompt: "s",
      userText: "u",
      tool: { name: "t", description: "d", inputSchema: { type: "object" } },
    });
    expect(out).toBeNull();
    spy.mockRestore();
  });
});

describe("callTool — no provider", () => {
  it("returns null when no API key", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    const out = await callTool({
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

  it("joins text blocks from Anthropic response", async () => {
    mockCreate.mockResolvedValue({
      content: [
        { type: "text", text: "hello" },
        { type: "text", text: "world" },
      ],
    });
    const out = await callMessage({ systemPrompt: "s", userText: "u" });
    expect(out).toBe("hello\nworld");
  });

  it("returns null on error", async () => {
    mockCreate.mockRejectedValue(new Error("boom"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const out = await callMessage({ systemPrompt: "s", userText: "u" });
    expect(out).toBeNull();
    spy.mockRestore();
  });

  it("returns null when no provider is configured", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    const out = await callMessage({ systemPrompt: "s", userText: "u" });
    expect(out).toBeNull();
  });
});
