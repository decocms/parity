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
  return { url: mcpEndpoint(url), token };
}

/**
 * Accept either a host or a full MCP endpoint. Deployments are org-scoped
 * (`https://studio.decocms.com/api/<org>/mcp/self`), so appending `/mcp/self` to whatever the
 * user pasted would hit the wrong path — and there the ORG lives in the URL, not only in the
 * token. A bare host still gets the root endpoint appended.
 */
export function mcpEndpoint(url: string): string {
  const trimmed = url.replace(/\/+$/, "");
  return /\/mcp(\/|$)/.test(trimmed) ? trimmed : `${trimmed}/mcp/self`;
}

/**
 * One card per page. The board item carries `repo`, so the site does not belong in the title —
 * a clean path is what the client reads on the card.
 */
export function cardTitle(path: string): string {
  return path;
}

/** Comments we wrote. Prefixed so reading client input back never echoes our own confirmations. */
export const PARITY_COMMENT_PREFIX = "[parity]";

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
  const res = await fetch(cfg.url, {
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
  /** Card id per page path — the caller persists these so the link survives a re-capture. */
  ids: Record<string, string>;
}

export interface SyncOptions {
  /** `owner/name`, stored on the card so the board knows which repo the work lives in. */
  repo?: string;
  /** Client-legible fixes to mirror alongside the page cards. */
  fixes?: FixCard[];
}

/**
 * Upsert one card per page, plus a card per client-legible fix. Idempotency comes from the id
 * stored on the page (preferred) and a title match as the recovery path — the task board has no
 * upsert, so without this every run would duplicate the whole board.
 */
export async function syncBoardToStudio(
  board: Board,
  cfg: StudioConfig,
  opts: SyncOptions = {},
  call: ToolCaller = callTool,
): Promise<SyncResult> {
  const existing = await call<{ items?: StudioItem[] }>(cfg, "TASK_BOARD_ITEM_LIST", {});
  const byTitle = new Map((existing.items ?? []).map((i) => [i.title, i]));
  const byId = new Map((existing.items ?? []).map((i) => [i.id, i]));

  const result: SyncResult = { created: 0, updated: 0, skipped: 0, ids: {} };

  const upsert = async (
    title: string,
    description: string,
    status: StudioStatus,
    knownId?: string,
  ): Promise<string | undefined> => {
    const found = (knownId ? byId.get(knownId) : undefined) ?? byTitle.get(title);
    if (found) {
      await call(cfg, "TASK_BOARD_ITEM_UPDATE", { id: found.id, title, status, description });
      result.updated += 1;
      return found.id;
    }
    const created = await call<{ item?: StudioItem }>(cfg, "TASK_BOARD_ITEM_CREATE", {
      title,
      description,
      status,
      ...(opts.repo ? { repo: opts.repo } : {}),
    });
    result.created += 1;
    return created.item?.id;
  };

  for (const cards of Object.values(board.columns)) {
    for (const card of cards) {
      const status = LANE_TO_STUDIO[card.column];
      if (!status) {
        result.skipped += 1;
        continue;
      }
      const id = await upsert(
        cardTitle(card.path),
        cardDescription(card),
        status,
        card.boardItemId,
      );
      if (id) result.ids[card.path] = id;
    }
  }

  for (const fix of opts.fixes ?? []) {
    await upsert(fix.title, fixDescription(fix), FIX_STATE_TO_STUDIO[fix.state]);
  }

  return result;
}

export interface StudioComment {
  id: string;
  taskBoardItemId: string;
  authorId: string;
  body: string;
  resolved: boolean;
  createdAt: string;
}

/**
 * A client note on a page's card. This is the input channel: the client says "this component
 * should match the Brazil site, not Ecuador" on the card, and it becomes a proposed plan change.
 */
export interface ClientNote {
  path: string;
  boardItemId: string;
  commentId: string;
  body: string;
  createdAt: string;
}

/**
 * Read client comments off the page cards. Our own comments are filtered out by prefix — without
 * that, every confirmation we post would come back as fresh input on the next cycle.
 */
export async function fetchClientNotes(
  pages: { path: string; boardItemId: string }[],
  cfg: StudioConfig,
  call: ToolCaller = callTool,
): Promise<ClientNote[]> {
  const notes: ClientNote[] = [];
  for (const page of pages) {
    const res = await call<{ comments?: StudioComment[] }>(cfg, "TASK_BOARD_COMMENT_LIST", {
      taskBoardItemId: page.boardItemId,
    });
    for (const c of res.comments ?? []) {
      if (c.body.trimStart().startsWith(PARITY_COMMENT_PREFIX)) continue;
      if (c.resolved) continue;
      notes.push({
        path: page.path,
        boardItemId: page.boardItemId,
        commentId: c.id,
        body: c.body,
        createdAt: c.createdAt,
      });
    }
  }
  return notes;
}

/**
 * Post a confirmation back on the card, so the client sees their note turned into a decision.
 * Prefixed so `fetchClientNotes` skips it next cycle.
 */
export async function postParityComment(
  boardItemId: string,
  body: string,
  cfg: StudioConfig,
  call: ToolCaller = callTool,
): Promise<void> {
  await call(cfg, "TASK_BOARD_COMMENT_CREATE", {
    taskBoardItemId: boardItemId,
    body: `${PARITY_COMMENT_PREFIX} ${body}`,
  });
}

/**
 * A fix the client would recognise — "we fixed X" — mirrored so they see it without reading
 * GitHub. Deliberately NOT every issue: lint and bundle findings mean nothing to them and would
 * bury the board.
 */
export interface FixCard {
  title: string;
  body?: string;
  prUrl?: string;
  state: "open" | "in_review" | "closed";
}

const FIX_STATE_TO_STUDIO: Record<FixCard["state"], StudioStatus> = {
  open: "todo",
  in_review: "in_review",
  closed: "done",
};

function fixDescription(fix: FixCard): string {
  const lines: string[] = [];
  if (fix.body) lines.push(fix.body);
  // The PR link goes in the description rather than through TASK_BOARD_ITEM_PR_LINK, which
  // matches PRs to tasks by its own rules and cannot be pointed at a specific card.
  if (fix.prUrl) lines.push(`PR: ${fix.prUrl}`);
  return lines.join("\n");
}
