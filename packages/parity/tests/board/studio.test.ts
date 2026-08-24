import { describe, expect, it } from "vitest";
import {
  LANE_TO_STUDIO,
  PARITY_COMMENT_PREFIX,
  type StudioConfig,
  type ToolCaller,
  cardDescription,
  cardTitle,
  fetchClientNotes,
  mcpEndpoint,
  parseRpcBody,
  postParityComment,
  studioConfigFromEnv,
  syncBoardToStudio,
} from "../../src/board/studio.ts";
import type { Board, BoardCard, PageColumn } from "../../src/migrate/plan.ts";

const cfg: StudioConfig = { url: "https://studio.example", token: "t" };

function card(path: string, column: PageColumn, blockers: string[] = []): BoardCard {
  return {
    path,
    kind: "pdp",
    column,
    blockers,
    counts: { build: 0, validate: 0, upgrade: 0, "as-is": 0, settled: 0 },
    ready: false,
  };
}

function boardWith(cards: BoardCard[]): Board {
  const columns = {
    triage: [],
    backlog: [],
    building: [],
    review: [],
    done: [],
    skipped: [],
  } as Board["columns"];
  for (const c of cards) columns[c.column].push(c);
  return {
    url: "https://shop.example/",
    columns,
    shell: [],
    unassigned: [],
    sampled: cards.length,
  };
}

/** Records calls so a sync can be asserted without a network. */
function recorder(items: { id: string; title: string; status: string }[] = []) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const call: ToolCaller = async <T>(_c: StudioConfig, name: string, args: unknown) => {
    calls.push({ name, args: args as Record<string, unknown> });
    return (name === "TASK_BOARD_ITEM_LIST" ? { items } : {}) as T;
  };
  return { calls, call };
}

describe("studioConfigFromEnv", () => {
  it("devolve null quando falta url ou token — o board nunca derruba a migração", () => {
    expect(studioConfigFromEnv({} as NodeJS.ProcessEnv)).toBeNull();
    expect(studioConfigFromEnv({ PARITY_STUDIO_URL: "x" } as NodeJS.ProcessEnv)).toBeNull();
    expect(studioConfigFromEnv({ PARITY_STUDIO_TOKEN: "y" } as NodeJS.ProcessEnv)).toBeNull();
  });

  it("completa um host simples com o endpoint raiz", () => {
    const c = studioConfigFromEnv({
      PARITY_STUDIO_URL: "https://s.example/",
      PARITY_STUDIO_TOKEN: "y",
    } as NodeJS.ProcessEnv);
    expect(c).toEqual({ url: "https://s.example/mcp/self", token: "y" });
  });

  it("respeita um endpoint org-scoped completo — a org vive na URL, não só no token", () => {
    const c = studioConfigFromEnv({
      PARITY_STUDIO_URL: "https://studio.decocms.com/api/electrolux/mcp/self",
      PARITY_STUDIO_TOKEN: "y",
    } as NodeJS.ProcessEnv);
    expect(c?.url).toBe("https://studio.decocms.com/api/electrolux/mcp/self");
  });
});

describe("mapeamento de raia", () => {
  it("as 6 raias cabem nas 5 colunas fixas; skipped não vira card", () => {
    expect(LANE_TO_STUDIO).toEqual({
      triage: "triage",
      backlog: "todo",
      building: "in_progress",
      review: "in_review",
      done: "done",
      skipped: null,
    });
  });
});

describe("cardTitle / cardDescription", () => {
  it("usa o path puro — o repo vai no campo próprio do card", () => {
    expect(cardTitle("/p")).toBe("/p");
  });

  it("descreve o que bloqueia a página", () => {
    expect(cardDescription(card("/p", "backlog", ["hero"]))).toContain("blocked by: hero");
  });
});

describe("parseRpcBody", () => {
  it("lê resposta JSON simples", () => {
    expect(
      parseRpcBody('{"result":{"structuredContent":{"ok":true}}}').result?.structuredContent,
    ).toEqual({ ok: true });
  });

  it("lê resposta SSE pegando o último frame data:", () => {
    const body = 'event: message\ndata: {"result":{"structuredContent":{"n":1}}}\n\n';
    expect(parseRpcBody(body).result?.structuredContent).toEqual({ n: 1 });
  });
});

describe("syncBoardToStudio", () => {
  it("cria card por página e pula skipped", async () => {
    const { calls, call } = recorder();
    const res = await syncBoardToStudio(
      boardWith([card("/a", "backlog"), card("/b", "done"), card("/c", "skipped")]),
      cfg,
      {},
      call,
    );
    expect(res).toMatchObject({ created: 2, updated: 0, skipped: 1 });
    const created = calls.filter((c) => c.name === "TASK_BOARD_ITEM_CREATE");
    expect(created.map((c) => c.args.status).sort()).toEqual(["done", "todo"]);
  });

  it("atualiza em vez de duplicar quando o card já existe — rodar duas vezes não duplica", async () => {
    const { calls, call } = recorder([{ id: "id-1", title: "/a", status: "todo" }]);
    const res = await syncBoardToStudio(
      boardWith([card("/a", "building", ["hero"])]),
      cfg,
      {},
      call,
    );
    expect(res).toMatchObject({ created: 0, updated: 1, skipped: 0 });
    const update = calls.find((c) => c.name === "TASK_BOARD_ITEM_UPDATE");
    expect(update?.args).toMatchObject({ id: "id-1", status: "in_progress" });
    expect(calls.some((c) => c.name === "TASK_BOARD_ITEM_CREATE")).toBe(false);
  });
});

describe("syncBoardToStudio — âncora por id e fixes", () => {
  it("prefere o boardItemId guardado ao título — sobrevive a renomear o card", async () => {
    const { calls, call } = recorder([{ id: "kept", title: "outro nome", status: "todo" }]);
    const c = { ...card("/a", "building"), boardItemId: "kept" };
    const res = await syncBoardToStudio(boardWith([c]), cfg, {}, call);
    expect(res).toMatchObject({ created: 0, updated: 1 });
    expect(calls.find((x) => x.name === "TASK_BOARD_ITEM_UPDATE")?.args).toMatchObject({
      id: "kept",
    });
  });

  it("devolve o id por página pra quem chama persistir no plano", async () => {
    const call: ToolCaller = async <T>(_c: StudioConfig, name: string) =>
      (name === "TASK_BOARD_ITEM_LIST" ? { items: [] } : { item: { id: "novo" } }) as T;
    const res = await syncBoardToStudio(boardWith([card("/a", "backlog")]), cfg, {}, call);
    expect(res.ids).toEqual({ "/a": "novo" });
  });

  it("manda o repo no create — o card sabe onde o trabalho vive", async () => {
    const { calls, call } = recorder();
    await syncBoardToStudio(boardWith([card("/a", "backlog")]), cfg, { repo: "org/site" }, call);
    expect(calls.find((c) => c.name === "TASK_BOARD_ITEM_CREATE")?.args).toMatchObject({
      repo: "org/site",
    });
  });

  it("espelha fixes com o PR na descrição e fechado vira done", async () => {
    const { calls, call } = recorder();
    await syncBoardToStudio(
      boardWith([]),
      cfg,
      {
        fixes: [
          {
            title: "Corrigido: CLS no banner",
            prUrl: "https://github.com/o/r/pull/9",
            state: "closed",
          },
        ],
      },
      call,
    );
    const created = calls.find((c) => c.name === "TASK_BOARD_ITEM_CREATE");
    expect(created?.args).toMatchObject({ status: "done" });
    expect(String(created?.args.description)).toContain("https://github.com/o/r/pull/9");
  });
});

describe("fetchClientNotes / postParityComment", () => {
  it("lê nota do cliente e ignora as nossas e as resolvidas", async () => {
    const call: ToolCaller = async <T>() =>
      ({
        comments: [
          {
            id: "c1",
            taskBoardItemId: "i1",
            authorId: "u",
            body: "usar o componente do site BR",
            resolved: false,
            createdAt: "t",
          },
          {
            id: "c2",
            taskBoardItemId: "i1",
            authorId: "u",
            body: "[parity] aplicado: referência → BR",
            resolved: false,
            createdAt: "t",
          },
          {
            id: "c3",
            taskBoardItemId: "i1",
            authorId: "u",
            body: "já resolvido",
            resolved: true,
            createdAt: "t",
          },
        ],
      }) as T;
    const notes = await fetchClientNotes([{ path: "/p", boardItemId: "i1" }], cfg, call);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ path: "/p", commentId: "c1" });
  });

  it("prefixa o que escrevemos, pra não virar insumo de novo no ciclo seguinte", async () => {
    const { calls, call } = recorder();
    await postParityComment("i1", "referência apontada para o site BR", cfg, call);
    const body = String(calls[0]?.args.body);
    expect(body.startsWith(PARITY_COMMENT_PREFIX)).toBe(true);
  });
});

describe("mcpEndpoint", () => {
  it.each([
    ["https://studio.decocms.com", "https://studio.decocms.com/mcp/self"],
    ["https://studio.decocms.com/", "https://studio.decocms.com/mcp/self"],
    [
      "https://studio.decocms.com/api/electrolux/mcp/self",
      "https://studio.decocms.com/api/electrolux/mcp/self",
    ],
    ["https://studio.decocms.com/api/org/mcp/self/", "https://studio.decocms.com/api/org/mcp/self"],
  ])("%s -> %s", (input, expected) => {
    expect(mcpEndpoint(input)).toBe(expected);
  });
});
