import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Repo root: tests/plugin -> packages/parity -> packages -> <root>
const root = resolve(__dirname, "..", "..", "..", "..");
const readJson = (rel: string) => JSON.parse(readFileSync(resolve(root, rel), "utf8"));

describe("plugin manifests", () => {
  const plugin = readJson(".claude-plugin/plugin.json");
  const marketplace = readJson(".claude-plugin/marketplace.json");

  it("plugin.json has required keys", () => {
    for (const key of ["name", "version", "description"]) {
      expect(plugin[key], key).toBeTruthy();
    }
  });

  it("hooks path resolves to an existing file", () => {
    expect(plugin.hooks, "plugin.json.hooks").toBeTruthy();
    expect(existsSync(resolve(root, plugin.hooks))).toBe(true);
  });

  it("installCommand references the same repo as plugin.repository", () => {
    // "decocms/parity" must appear in both, regardless of URL vs slug form.
    const slug = marketplace.repository;
    expect(marketplace.installCommand).toContain(slug);
    expect(plugin.repository).toContain(slug);
  });

  it("agents/skills/commands dirs exist", () => {
    for (const dir of ["agents", "skills", "commands"]) {
      expect(existsSync(resolve(root, dir)), dir).toBe(true);
    }
  });

  it("every agent .md declares a name in front-matter", () => {
    const agents = readdirSync(resolve(root, "agents")).filter((f) => f.endsWith(".md"));
    expect(agents.length).toBeGreaterThan(0);
    for (const file of agents) {
      const text = readFileSync(resolve(root, "agents", file), "utf8");
      expect(text, file).toMatch(/^---[\s\S]*?\nname:\s*\S/m);
    }
  });
});
