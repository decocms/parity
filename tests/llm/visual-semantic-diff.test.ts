import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  })),
}));

import { visualSemanticDiff } from "../../src/llm/visual-semantic-diff.ts";
import { makeTmpDir } from "../helpers/tmp-dir.ts";

function tinyPng(path: string): void {
  const png = new PNG({ width: 10, height: 10 });
  for (let i = 0; i < png.data.length; i++) png.data[i] = 100;
  writeFileSync(path, PNG.sync.write(png));
}

describe("visualSemanticDiff", () => {
  let dir: { path: string; cleanup: () => void };

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    mockCreate.mockReset();
    dir = makeTmpDir();
  });
  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    dir.cleanup();
  });

  it("returns null when PNGs cannot be loaded", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const out = await visualSemanticDiff({
      prodPath: join(dir.path, "missing-1.png"),
      candPath: join(dir.path, "missing-2.png"),
    });
    expect(out).toBeNull();
    spy.mockRestore();
  });

  it("returns parsed differences on LLM success", async () => {
    const prodPath = join(dir.path, "p.png");
    const candPath = join(dir.path, "c.png");
    tinyPng(prodPath);
    tinyPng(candPath);
    mockCreate.mockResolvedValue({
      content: [
        {
          type: "tool_use",
          name: "report_visual_differences",
          input: {
            differences: [
              {
                type: "missing-component",
                region: "hero",
                severity: "critical",
                description: "hero missing in cand",
              },
            ],
          },
        },
      ],
    });
    const out = await visualSemanticDiff({ prodPath, candPath });
    expect(out).toHaveLength(1);
    expect(out?.[0]).toMatchObject({
      type: "missing-component",
      region: "hero",
      severity: "critical",
    });
  });

  it("filters out malformed differences (missing fields)", async () => {
    const prodPath = join(dir.path, "p.png");
    const candPath = join(dir.path, "c.png");
    tinyPng(prodPath);
    tinyPng(candPath);
    mockCreate.mockResolvedValue({
      content: [
        {
          type: "tool_use",
          name: "report_visual_differences",
          input: {
            differences: [
              { type: "cosmetic", region: "footer", severity: "low", description: "ok" },
              { type: "cosmetic", region: "footer" /* no severity */ },
              { region: "footer", severity: "low", description: "no type" },
            ],
          },
        },
      ],
    });
    const out = await visualSemanticDiff({ prodPath, candPath });
    expect(out).toHaveLength(1);
    expect(out?.[0]?.description).toBe("ok");
  });

  it("returns null when LLM call returns null", async () => {
    const prodPath = join(dir.path, "p.png");
    const candPath = join(dir.path, "c.png");
    tinyPng(prodPath);
    tinyPng(candPath);
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "no tool" }] });
    const out = await visualSemanticDiff({ prodPath, candPath });
    expect(out).toBeNull();
  });

  it("injects sectionsOnlyInProd into the user prompt for LLM context", async () => {
    const prodPath = join(dir.path, "p.png");
    const candPath = join(dir.path, "c.png");
    tinyPng(prodPath);
    tinyPng(candPath);
    mockCreate.mockResolvedValue({
      content: [
        {
          type: "tool_use",
          name: "report_visual_differences",
          input: { differences: [] },
        },
      ],
    });
    await visualSemanticDiff({
      prodPath,
      candPath,
      sectionsOnlyInProd: ["HeroBanner", "ProductShelf"],
      prodSections: ["HeroBanner", "ProductShelf", "Footer"],
      candSections: ["Footer"],
    });
    const userText = mockCreate.mock.calls[0]?.[0]?.messages?.[0]?.content?.[0]?.text;
    expect(userText).toMatch(/HeroBanner/);
    expect(userText).toMatch(/ProductShelf/);
    expect(userText).toMatch(/AUSENTES em cand/);
  });

  it("includes both images as image content blocks", async () => {
    const prodPath = join(dir.path, "p.png");
    const candPath = join(dir.path, "c.png");
    tinyPng(prodPath);
    tinyPng(candPath);
    mockCreate.mockResolvedValue({
      content: [
        {
          type: "tool_use",
          name: "report_visual_differences",
          input: { differences: [] },
        },
      ],
    });
    await visualSemanticDiff({ prodPath, candPath });
    const content = mockCreate.mock.calls[0]?.[0]?.messages?.[0]?.content;
    const imgs = content.filter((c: { type: string }) => c.type === "image");
    expect(imgs).toHaveLength(2);
  });
});
