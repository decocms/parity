/**
 * Push the per-page board to the deco Studio task board, so the client sees the migration
 * moving without reading a terminal.
 *
 * Talks to the Studio's self MCP endpoint (`/mcp/self`, which exposes the management tools)
 * over plain JSON-RPC with `fetch`. The MCP SDK would be a dependency for what is one POST.
 *
 * The org is NOT a parameter: `TASK_BOARD_ITEM_CREATE` takes no `organizationId` and resolves it
 * from the caller's auth context. Pointing at another org means using that org's token.
 */

import type { Board, BoardCard, PageColumn } from "../migrate/plan.ts";

/** The task board's columns are fixed (`apps/mesh/src/tools/task-board/schema.ts`). */
export type StudioStatus = "triage" | "todo" | "in_progress" | "in_review" | "done";

/**
 * Lane -> column. The five fixed columns absorb the six lanes exactly: `skipped` gets no card
 * (a card for work nobody will do is noise on a board a client reads).
 */
export const LANE_TO_STUDIO: Record<PageColumn, StudioStatus | null> = {
  triage: "triage",
  backlog: "todo",
  building: "in_progress",
  review: "in_review",
  done: "done",
  skipped: null,
};

export interface StudioConfig {
  url: string;
  token: string;
}

/**
 * Read config from the environment. Returns null when unset — the caller falls back to the
 * terminal instead of failing, because a board is a reporting nicety and must never take a
 * migration down with it.
 */
export function studioConfigFromEnv(env: NodeJS.ProcessEnv = process.env): StudioConfig | null {
  const url = env.PARITY_STUDIO_URL;
  const token = env.PARITY_STUDIO_TOKEN;
  if (!url || !token) return null;
  return { url: url.replace(/\/+$/, ""), token };
}

/**
 * One card per page. The site goes in the TITLE because a task board item is org-scoped and
 * carries no site/project field — without the prefix, two migrations in one org collide.
 */
export function cardTitle(host: string, path: string): string {
  return `[${host}] ${path}`;
}

export function cardDescription(card: BoardCard): string {
  const lines = [`kind: ${card.kind}`, `lane: ${card.column}`];
  if (card.blockers.length) lines.push(`blocked by: ${card.blockers.join(", ")}`);
  else if (card.column === "triage") {
    lines.push("scope not confirmed — no page/component edges yet");
  }
  return lines.join("\n");
}

interface StudioItem {
  id: string;
  title: string;
  status: StudioStatus;
}

interface RpcPayload {
  error?: { message?: string };
  result?: {
    isError?: boolean;
    content?: { text?: string }[];
    structuredContent?: unknown;
  };
}

/** SSE frames the JSON-RPC payload in `data:` lines; a plain JSON response does not. */
export function parseRpcBody(body: string): RpcPayload {
  const trimmed = body.trim();
  if (!trimmed.startsWith("event:") && !trimmed.startsWith("data:")) {
    return JSON.parse(trimmed) as RpcPayload;
  }
  const data = trimmed
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim())
    .filter(Boolean);
  const last = data[data.length - 1];
  if (!last) throw new Error("empty SSE response");
  return JSON.parse(last) as RpcPayload;
}

export type ToolCaller = <T>(cfg: StudioConfig, name: string, args: unknown) => Promise<T>;

/** Minimal MCP `tools/call` over StreamableHTTP. Throws with the server's message on failure. */
export const callTool: ToolCaller = async <T>(
  cfg: StudioConfig,
  name: string,
  args: unknown,
): Promise<T> => {
  const res = await fetch(`${cfg.url}/mcp/self`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // StreamableHTTP may answer with either; accept both and parse accordingly.
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${cfg.token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  if (!res.ok) {
    throw new Error(`${name}: HTTP ${res.status} ${await res.text().catch(() => "")}`);
  }

  const payload = parseRpcBody(await res.text());
  if (payload.error) throw new Error(`${name}: ${payload.error.message ?? "unknown error"}`);
  const result = payload.result;
  if (result?.isError) {
    const text = result.content?.map((c) => c.text).join(" ") ?? "tool reported an error";
    throw new Error(`${name}: ${text}`);
  }
  return (result?.structuredContent ?? {}) as T;
};

export interface SyncResult {
  created: number;
  updated: number;
  skipped: number;
}

/**
 * Upsert one card per page. Idempotency comes from listing first and matching on title — the
 * task board has no upsert, so without this every run would duplicate the whole board.
 */
export async function syncBoardToStudio(
  board: Board,
  cfg: StudioConfig,
  call: ToolCaller = callTool,
): Promise<SyncResult> {
  const host = new URL(board.url).host;

  const existing = await call<{ items?: StudioItem[] }>(cfg, "TASK_BOARD_ITEM_LIST", {});
  const byTitle = new Map((existing.items ?? []).map((i) => [i.title, i]));

  const result: SyncResult = { created: 0, updated: 0, skipped: 0 };
  for (const cards of Object.values(board.columns)) {
    for (const card of cards) {
      const status = LANE_TO_STUDIO[card.column];
      if (!status) {
        result.skipped += 1;
        continue;
      }
      const title = cardTitle(host, card.path);
      const description = cardDescription(card);
      const found = byTitle.get(title);
      if (found) {
        await call(cfg, "TASK_BOARD_ITEM_UPDATE", { id: found.id, status, description });
        result.updated += 1;
      } else {
        await call(cfg, "TASK_BOARD_ITEM_CREATE", { title, description, status });
        result.created += 1;
      }
    }
  }
  return result;
}
