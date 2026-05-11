import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Baseline, type Run } from "../types/schema.ts";

const DEFAULT_DIR = "./parity-baselines";

function safeName(name: string): string {
  if (!/^[a-z0-9_-]+$/i.test(name)) {
    throw new Error(`Invalid baseline name "${name}". Use only [a-z0-9_-].`);
  }
  return name;
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function baselinePath(name: string, dir: string = DEFAULT_DIR): string {
  return join(dir, `${safeName(name)}.json`);
}

export function saveBaseline(name: string, run: Run, dir: string = DEFAULT_DIR): string {
  ensureDir(dir);
  const baseline: Baseline = {
    name: safeName(name),
    createdAt: new Date().toISOString(),
    fromRunId: run.id,
    prodUrl: run.prodUrl,
    candUrl: run.candUrl,
    verdict: run.verdict,
    issues: run.issues,
  };
  const path = baselinePath(name, dir);
  writeFileSync(path, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
  return path;
}

export function loadBaseline(name: string, dir: string = DEFAULT_DIR): Baseline {
  const path = baselinePath(name, dir);
  if (!existsSync(path)) {
    throw new Error(`Baseline not found: ${name}`);
  }
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return Baseline.parse(raw);
}

export function listBaselines(dir: string = DEFAULT_DIR): { name: string; path: string; createdAt: string }[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const path = join(dir, f);
      try {
        const raw = JSON.parse(readFileSync(path, "utf8")) as { name: string; createdAt: string };
        return { name: raw.name, path, createdAt: raw.createdAt };
      } catch {
        return { name: f.replace(/\.json$/, ""), path, createdAt: "" };
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function deleteBaseline(name: string, dir: string = DEFAULT_DIR): void {
  const path = baselinePath(name, dir);
  if (existsSync(path)) unlinkSync(path);
}

export interface BaselineDelta {
  resolved: string[]; // issue ids no longer present
  new: string[]; // issue ids only in current
  regressions: string[]; // issue ids present in both but worse severity
}

export function compareToBaseline(current: Run, baseline: Baseline): BaselineDelta {
  const baseIds = new Map(baseline.issues.map((i) => [i.id, i]));
  const currIds = new Map(current.issues.map((i) => [i.id, i]));

  const order: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  const resolved = [...baseIds.keys()].filter((id) => !currIds.has(id));
  const created = [...currIds.keys()].filter((id) => !baseIds.has(id));
  const regressions: string[] = [];
  for (const [id, cur] of currIds) {
    const base = baseIds.get(id);
    if (base && order[cur.severity]! < order[base.severity]!) {
      regressions.push(id);
    }
  }
  return { resolved, new: created, regressions };
}
