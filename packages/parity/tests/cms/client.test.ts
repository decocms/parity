import { describe, expect, it } from "vitest";
import {
  type CmsCaller,
  type CmsConfig,
  type CmsRequest,
  cmsConfigFromEnv,
  commitEntry,
  getLastVersion,
  undoEntry,
} from "../../src/cms/client.ts";

const cfg: CmsConfig = { account: "acme", store: "store1", token: "tok" };

function recorder(result: unknown = {}) {
  const calls: CmsRequest[] = [];
  const call: CmsCaller = async <T>(_c: CmsConfig, req: CmsRequest) => {
    calls.push(req);
    return result as T;
  };
  return { calls, call };
}

const commit = {
  branchId: "4e3779e5-4065-423d-939f-aaa8675e83cb",
  contentTypeId: "home",
  entryId: "e1",
  entryName: "Home",
  baseHash: "hash1",
  data: { sections: {} },
  message: "m",
  author: "a@b.c",
};

describe("cmsConfigFromEnv", () => {
  it("devolve null quando falta account, store ou token", () => {
    const home = "/nonexistent-home";
    expect(cmsConfigFromEnv({} as NodeJS.ProcessEnv, home)).toBeNull();
    expect(cmsConfigFromEnv({ PARITY_CMS_ACCOUNT: "a" } as NodeJS.ProcessEnv, home)).toBeNull();
    expect(
      cmsConfigFromEnv({ PARITY_CMS_ACCOUNT: "a", PARITY_CMS_STORE: "s" } as NodeJS.ProcessEnv, home)
    ).toBeNull();
  });

  it("aceita token por env sem depender da sessao do vtex", () => {
    const env = {
      PARITY_CMS_ACCOUNT: "a",
      PARITY_CMS_STORE: "s",
      PARITY_CMS_TOKEN: "t",
    } as NodeJS.ProcessEnv;
    expect(cmsConfigFromEnv(env, "/nonexistent-home")).toEqual({ account: "a", store: "s", token: "t" });
  });
});

describe("commitEntry", () => {
  it("nao manda commitType — mandar da 500 no insert da tabela commits", async () => {
    const { calls, call } = recorder({ id: "c1" });
    await commitEntry(cfg, commit, call);
    expect(calls[0]?.body).not.toHaveProperty("commitType");
  });

  it("manda search_keywords em snake_case, como a API espera", async () => {
    const { calls, call } = recorder({ id: "c1" });
    await commitEntry(cfg, { ...commit, searchKeywords: ["/x"] }, call);
    expect(calls[0]?.body).toMatchObject({ search_keywords: ["/x"] });
    expect(calls[0]?.body).not.toHaveProperty("searchKeywords");
  });

  it("recusa commit sem baseHash antes de tocar a rede", async () => {
    const { calls, call } = recorder();
    await expect(commitEntry(cfg, { ...commit, baseHash: "" }, call)).rejects.toThrow(/baseHash/);
    expect(calls).toHaveLength(0);
  });

  it("aceita baseHash null, que e a primeira versao de uma entry recem duplicada", async () => {
    const { calls, call } = recorder({ id: "c1" });
    await commitEntry(cfg, { ...commit, baseHash: null }, call);
    expect(calls[0]?.body).toMatchObject({ baseHash: null });
  });

  it("posta em branches/<id>/commits", async () => {
    const { calls, call } = recorder({ id: "c1" });
    await commitEntry(cfg, commit, call);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.path).toBe(
      `api/content-platform/manage/acme/store1/branches/${commit.branchId}/commits`
    );
  });
});

describe("undoEntry", () => {
  it("usa DELETE no /undo da branch", async () => {
    const { calls, call } = recorder();
    await undoEntry(cfg, { branchId: "b1", entryId: "e1" }, call);
    expect(calls[0]).toMatchObject({
      method: "DELETE",
      path: "api/content-platform/manage/acme/store1/branches/b1/entries/e1/undo",
    });
  });
});

describe("getLastVersion", () => {
  /** A branch only carries entries somebody changed on it — the first edit always hits this. */
  function branchWithout(entryOnMain: Record<string, unknown>) {
    const paths: string[] = [];
    const call: CmsCaller = async <T>(_c: CmsConfig, req: CmsRequest) => {
      paths.push(req.path);
      if (req.path.includes("branchId=main")) return entryOnMain as T;
      throw new Error('HTTP 404 {"error":{"code":"ENTRY_VERSIONS_NOT_FOUND"}}');
    };
    return { paths, call };
  }

  it("cai para main quando a branch nao tem override, marcando de onde veio", async () => {
    const { paths, call } = branchWithout({ branchId: "main", baseHash: "h", data: {} });
    const v = await getLastVersion(cfg, { contentType: "home", entryId: "e1", branchId: "b1" }, call);
    expect(v.inheritedFromMain).toBe(true);
    expect(v.branchId).toBe("b1");
    expect(paths).toHaveLength(2);
  });

  it("nao mascara um 404 real em main — la nao ha de onde herdar", async () => {
    const call: CmsCaller = async () => {
      throw new Error('HTTP 404 {"error":{"code":"ENTRY_VERSIONS_NOT_FOUND"}}');
    };
    await expect(
      getLastVersion(cfg, { contentType: "home", entryId: "e1", branchId: "main" }, call)
    ).rejects.toThrow(/ENTRY_VERSIONS_NOT_FOUND/);
  });
});
