import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Repo root: tests/plugin -> packages/parity -> packages -> <root>
const root = resolve(__dirname, "..", "..", "..", "..");
const script = resolve(root, "hooks", "require-runner.mjs");

// Run the hook with a given stdin payload + cwd; return {stdout, denied}.
function runHook(input: Record<string, unknown>, cwd = root) {
  const stdout = execFileSync("node", [script], {
    input: JSON.stringify(input),
    cwd,
    encoding: "utf8",
  });
  const denied = stdout.includes('"permissionDecision":"deny"');
  return { stdout, denied };
}

function migrationDir(phase: string) {
  const dir = mkdtempSync(join(tmpdir(), "parity-hook-"));
  mkdirSync(join(dir, ".parity"), { recursive: true });
  writeFileSync(join(dir, ".parity", "migration.json"), JSON.stringify({ phase }));
  return dir;
}

describe("require-runner PreToolUse hook", () => {
  const bash = { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "gh pr list" } };

  it("allows bash inside a subagent (agent_type present)", () => {
    const dir = migrationDir("fix"); // active migration, but we're a subagent
    expect(runHook({ ...bash, agent_type: "runner", cwd: dir }, dir).denied).toBe(false);
  });

  it("allows main-thread bash when no migration is active", () => {
    // root has no .parity/migration.json
    expect(runHook({ ...bash, cwd: root }, root).denied).toBe(false);
  });

  it("allows main-thread bash when the migration is done", () => {
    const dir = migrationDir("done");
    expect(runHook({ ...bash, cwd: dir }, dir).denied).toBe(false);
  });

  it("denies main-thread bash during an active migration", () => {
    const dir = migrationDir("fix");
    const { denied, stdout } = runHook({ ...bash, cwd: dir }, dir);
    expect(denied).toBe(true);
    expect(stdout).toContain("runner");
  });

  it("fails open on unparseable stdin", () => {
    const out = execFileSync("node", [script], { input: "not json", cwd: root, encoding: "utf8" });
    expect(out.includes('"deny"')).toBe(false);
  });
});
