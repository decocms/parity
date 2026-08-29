import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CmsCaller, CmsConfig, CmsRequest } from "../../src/cms/client.ts";
import { cmsPushCommand, cmsUndoCommand } from "../../src/commands/cms.ts";

const BRANCH = "4e3779e5-4065-423d-939f-aaa8675e83cb";

const pulled = {
  entryId: "e1",
  contentType: "home",
  branchId: BRANCH,
  commitId: "c0",
  baseHash: "hash1",
  entryName: "Home",
  identifierKeys: null,
  searchKeywords: null,
  data: { sections: { values: { "1": { id: 1, $position: 0, $componentKey: "HeroSwiper" } } } },
};

function fixture(overrides: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "parity-cms-"));
  const file = join(dir, "entry.json");
  writeFileSync(file, JSON.stringify({ ...pulled, ...overrides }));
  return file;
}

/** Answers the two GETs push makes before writing, then records the commit. */
function server(opts: { remoteHash?: string; published?: string[] } = {}) {
  const calls: CmsRequest[] = [];
  const call: CmsCaller = async <T>(_c: CmsConfig, req: CmsRequest) => {
    calls.push(req);
    if (req.path.includes("content-types")) {
      const anyOf = (opts.published ?? ["HeroSwiper"]).map((k) => ({ $componentKey: k }));
      return { home: { properties: { sections: { items: { anyOf } } } } } as T;
    }
    if (req.path.includes("last-version")) {
      return { ...pulled, baseHash: opts.remoteHash ?? "hash1" } as T;
    }
    return { id: "commit1", hash: "h", branchId: BRANCH, entryId: "e1" } as T;
  };
  return { calls, call };
}

beforeEach(() => {
  process.env.PARITY_CMS_ACCOUNT = "acme";
  process.env.PARITY_CMS_STORE = "store1";
  process.env.PARITY_CMS_TOKEN = "tok";
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  process.env.PARITY_CMS_ACCOUNT = undefined;
  process.env.PARITY_CMS_STORE = undefined;
  process.env.PARITY_CMS_TOKEN = undefined;
  vi.restoreAllMocks();
});

describe("cms push — guardrails", () => {
  it("e dry run por padrao: nao commita sem --yes", async () => {
    const { calls, call } = server();
    const code = await cmsPushCommand({ file: fixture() }, call);
    expect(code).toBe(0);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("recusa main sem --allow-main, antes de qualquer rede", async () => {
    const { calls, call } = server();
    const code = await cmsPushCommand({ file: fixture({ branchId: "main" }), yes: true }, call);
    expect(code).toBe(1);
    expect(calls).toHaveLength(0);
  });

  it("recusa nome de branch — so id enderec,a uma branch", async () => {
    const { calls, call } = server();
    const code = await cmsPushCommand({ file: fixture(), branch: "test", yes: true }, call);
    expect(code).toBe(1);
    expect(calls).toHaveLength(0);
  });

  it("recusa baseHash velho em vez de sobrescrever a edic,ao de outro", async () => {
    const { calls, call } = server({ remoteHash: "hash2" });
    const code = await cmsPushCommand({ file: fixture(), yes: true }, call);
    expect(code).toBe(1);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("recusa section que a conta nao publicou — commitaria e renderizaria nada", async () => {
    const { calls, call } = server({ published: ["CategoryBlocks"] });
    const code = await cmsPushCommand({ file: fixture(), yes: true }, call);
    expect(code).toBe(1);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("commita quando tudo passa", async () => {
    const { calls, call } = server();
    const code = await cmsPushCommand({ file: fixture(), yes: true }, call);
    expect(code).toBe(0);
    const post = calls.find((c) => c.method === "POST");
    expect(post?.path).toContain(`/branches/${BRANCH}/commits`);
  });
});

describe("cms undo — guardrails", () => {
  it("e dry run por padrao", async () => {
    const { calls, call } = server();
    expect(await cmsUndoCommand({ entry: "e1", branch: BRANCH }, call)).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("recusa main sem --allow-main", async () => {
    const { calls, call } = server();
    expect(await cmsUndoCommand({ entry: "e1", branch: "main", yes: true }, call)).toBe(1);
    expect(calls).toHaveLength(0);
  });
});
