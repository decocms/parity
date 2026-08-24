import { describe, expect, it } from "vitest";
import {
  LANE_TO_STUDIO,
  type StudioConfig,
  type ToolCaller,
  cardDescription,
  cardTitle,
  parseRpcBody,
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

  it("tira a barra final da url", () => {
    const c = studioConfigFromEnv({
      PARITY_STUDIO_URL: "https://s.example/",
      PARITY_STUDIO_TOKEN: "y",
    } as NodeJS.ProcessEnv);
    expect(c).toEqual({ url: "https://s.example", token: "y" });
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
  it("prefixa o host — o item é org-scoped e não tem campo de site", () => {
    expect(cardTitle("shop.example", "/p")).toBe("[shop.example] /p");
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
      call,
    );
    expect(res).toEqual({ created: 2, updated: 0, skipped: 1 });
    const created = calls.filter((c) => c.name === "TASK_BOARD_ITEM_CREATE");
    expect(created.map((c) => c.args.status).sort()).toEqual(["done", "todo"]);
  });

  it("atualiza em vez de duplicar quando o card já existe — rodar duas vezes não duplica", async () => {
    const { calls, call } = recorder([{ id: "id-1", title: "[shop.example] /a", status: "todo" }]);
    const res = await syncBoardToStudio(boardWith([card("/a", "building", ["hero"])]), cfg, call);
    expect(res).toEqual({ created: 0, updated: 1, skipped: 0 });
    const update = calls.find((c) => c.name === "TASK_BOARD_ITEM_UPDATE");
    expect(update?.args).toMatchObject({ id: "id-1", status: "in_progress" });
    expect(calls.some((c) => c.name === "TASK_BOARD_ITEM_CREATE")).toBe(false);
  });
});
