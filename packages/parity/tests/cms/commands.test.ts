import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CmsCaller, CmsConfig, CmsRequest } from "../../src/cms/client.ts";
import { cmsCreateCommand, cmsPushCommand, cmsUndoCommand } from "../../src/commands/cms.ts";

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
    const code = await cmsPushCommand({ file: fixture({ branchId: "main" }), author: "a@b.com", yes: true }, call);
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
    const code = await cmsPushCommand({ file: fixture(), yes: true, author: "a@b.com" }, call);
    expect(code).toBe(1);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("recusa section que a conta nao publicou — commitaria e renderizaria nada", async () => {
    const { calls, call } = server({ published: ["CategoryBlocks"] });
    const code = await cmsPushCommand({ file: fixture(), yes: true, author: "a@b.com" }, call);
    expect(code).toBe(1);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("commita quando tudo passa", async () => {
    const { calls, call } = server();
    const code = await cmsPushCommand({ file: fixture(), yes: true, author: "a@b.com" }, call);
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

/**
 * Create has to talk to six endpoints in order, and the one that matters is the last: if the
 * commit fails, the duplicate it already made must not survive. `commitFails` exercises that.
 */
function createServer(
  opts: { singleton?: boolean; existing?: string[]; commitFails?: boolean; withContent?: string[] } = {}
) {
  const calls: CmsRequest[] = [];
  let duplicated = false;
  const existing = (opts.existing ?? ["Landing Page"]).map((name, i) => ({
    id: `src${i}`,
    name,
    contentTypeId: "landingPage",
    storeId: "store1",
  }));
  const call: CmsCaller = async <T>(_c: CmsConfig, req: CmsRequest) => {
    calls.push(req);
    if (req.path.includes("content-types")) {
      return { landingPage: { $singleton: Boolean(opts.singleton) } } as T;
    }
    if (req.path.includes("/duplicate")) {
      duplicated = true;
      return undefined as T;
    }
    if (req.path.includes("entries?")) {
      const copy = { id: "new1", name: "Landing Page - Copy", contentTypeId: "landingPage", storeId: "store1" };
      return { entries: duplicated ? [...existing, copy] : existing } as T;
    }
    if (req.path.includes("last-version")) {
      const owner = req.path.match(/entries\/([^/]+)\/last-version/)?.[1] ?? "";
      const filled = (opts.withContent ?? []).includes(owner);
      const blank = { slug: { $fnType: "switch", defaultCase: "" }, sections: { $fnType: "array", values: {} } };
      const full = {
        slug: { $fnType: "switch", defaultCase: "/tyc" },
        sections: { $fnType: "array", values: { "1": { id: 1, $position: 0, $componentKey: "Hero" } } },
      };
      return { baseHash: "h0", data: filled ? full : blank } as T;
    }
    if (req.path.endsWith("/commits")) {
      if (opts.commitFails) throw new Error("boom");
      return { id: "commit1", hash: "h1", branchId: BRANCH, entryId: "new1" } as T;
    }
    return undefined as T;
  };
  return { calls, call };
}

describe("cms push — author", () => {
  it("recusa author que nao e email, antes de commitar", async () => {
    const { calls, call } = server();
    const code = await cmsPushCommand({ file: fixture(), author: "parity", yes: true }, call);
    expect(code).toBe(1);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });
});

describe("cms create", () => {
  it("e dry run por padrao: nao duplica sem --yes", async () => {
    const { calls, call } = createServer();
    const code = await cmsCreateCommand({ contentType: "landingPage", slug: "/x", branch: BRANCH }, call);
    expect(code).toBe(0);
    expect(calls.some((c) => c.path.includes("/duplicate"))).toBe(false);
  });

  it("recusa main sem --allow-main, antes de qualquer rede", async () => {
    const { calls, call } = createServer();
    const code = await cmsCreateCommand(
      { contentType: "landingPage", slug: "/x", branch: "main", author: "a@b.com", yes: true },
      call
    );
    expect(code).toBe(1);
    expect(calls).toHaveLength(0);
  });

  it("recusa slug que nao comeca com barra", async () => {
    const { calls, call } = createServer();
    const code = await cmsCreateCommand({ contentType: "landingPage", slug: "x", branch: BRANCH, author: "a@b.com", yes: true }, call);
    expect(code).toBe(1);
    expect(calls).toHaveLength(0);
  });

  it("recusa singleton, que ja tem sua unica entry", async () => {
    const { call } = createServer({ singleton: true });
    const code = await cmsCreateCommand(
      { contentType: "landingPage", slug: "/x", branch: BRANCH, author: "a@b.com", yes: true },
      call
    );
    expect(code).toBe(1);
  });

  it("recusa nome que ja existe, para nao criar pagina duplicada", async () => {
    const { calls, call } = createServer({ existing: ["Preguntas Frecuentes"] });
    const code = await cmsCreateCommand(
      { contentType: "landingPage", slug: "/x", name: "Preguntas Frecuentes", branch: BRANCH, author: "a@b.com", yes: true },
      call
    );
    expect(code).toBe(1);
    expect(calls.some((c) => c.path.includes("/duplicate"))).toBe(false);
  });

  it("duplica, renomeia e commita o slug", async () => {
    const { calls, call } = createServer();
    const code = await cmsCreateCommand(
      { contentType: "landingPage", slug: "/cuida/faq", name: "FAQ", branch: BRANCH, author: "a@b.com", yes: true },
      call
    );
    expect(code).toBe(0);
    expect(calls.find((c) => c.path.includes("/rename"))?.body).toEqual({ name: "FAQ" });
    const commit = calls.find((c) => c.path.endsWith("/commits"))?.body as {
      entryId: string;
      baseHash: string;
      data: { slug: { defaultCase: string } };
    };
    expect(commit.entryId).toBe("new1");
    expect(commit.data.slug.defaultCase).toBe("/cuida/faq");
    expect(commit.baseHash).toBe("h0");
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("recusa copiar uma entry que responde um slug: a copia nasce em main na mesma rota", async () => {
    const { calls, call } = createServer({ withContent: ["src0"] });
    const code = await cmsCreateCommand(
      { contentType: "landingPage", slug: "/cuida/faq", branch: BRANCH, author: "a@b.com", yes: true },
      call
    );
    expect(code).toBe(1);
    expect(calls.some((c) => c.path.includes("/duplicate"))).toBe(false);
  });

  it("recusa --from apontando para uma entry que responde um slug", async () => {
    const { calls, call } = createServer({ withContent: ["src0"] });
    const code = await cmsCreateCommand(
      { contentType: "landingPage", slug: "/cuida/faq", branch: BRANCH, from: "src0", author: "a@b.com", yes: true },
      call
    );
    expect(code).toBe(1);
    expect(calls.some((c) => c.path.includes("/duplicate"))).toBe(false);
  });

  it("apaga a copia se o commit falhar, para nao deixar pagina pela metade", async () => {
    const { calls, call } = createServer({ commitFails: true });
    const code = await cmsCreateCommand(
      { contentType: "landingPage", slug: "/cuida/faq", branch: BRANCH, author: "a@b.com", yes: true },
      call
    );
    expect(code).toBe(1);
    expect(calls.some((c) => c.method === "DELETE" && c.path.endsWith("/entries/new1"))).toBe(true);
  });
});
