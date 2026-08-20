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

  it("uses the conventional hooks file, not an explicit manifest reference", () => {
    // Claude Code auto-loads hooks/hooks.json by convention. Referencing it via
    // manifest.hooks too triggers a "Duplicate hooks file" load error on install.
    expect(existsSync(resolve(root, "hooks", "hooks.json")), "hooks/hooks.json").toBe(true);
    expect(plugin.hooks, "plugin.json must NOT re-reference the conventional hooks file").toBeUndefined();
  });

  it("marketplace.json matches the Claude Code catalog schema", () => {
    // owner object + non-empty plugins[] — without these, `claude plugin
    // marketplace add` registers the marketplace but finds zero installable
    // plugins. Guards against the "app-store listing" shape that shipped in #268.
    expect(marketplace.owner?.name, "marketplace.owner.name").toBeTruthy();
    expect(Array.isArray(marketplace.plugins), "marketplace.plugins is array").toBe(true);
    expect(marketplace.plugins.length, "marketplace.plugins non-empty").toBeGreaterThan(0);

    for (const entry of marketplace.plugins) {
      expect(entry.name, "plugins[].name").toBeTruthy();
      // source resolves to a dir holding a plugin.json
      const manifestPath = resolve(root, entry.source ?? ".", ".claude-plugin", "plugin.json");
      expect(existsSync(manifestPath), entry.source).toBe(true);
      // the entry's plugin.json declares the same name
      const declared = JSON.parse(readFileSync(manifestPath, "utf8"));
      expect(declared.name, `${entry.name} plugin.json name`).toBe(entry.name);
    }
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
