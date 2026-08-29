/**
 * Write content to VTEX's Content Platform — the CMS behind FastStore v4 — so a migration stops
 * ending with someone retyping the merchant's pages into the Admin.
 *
 * The API is not documented publicly; the routes here were read off the Admin's own bundle and
 * confirmed against a live account. Three things cost real time to find out, so they are
 * invariants of this module rather than caller responsibilities:
 *
 * 1. Auth is `Authorization: Bearer <token>`. The `VtexIdclientAutCookie` cookie does NOT work,
 *    even though the same token value is what the browser sends as that cookie.
 * 2. A wrong path answers `400 Missing account name in URL parameters` or `401`, which reads like
 *    an auth problem and is not. Route shape is the usual suspect, not the credential.
 * 3. Saving is a git-style commit, not a PUT: `POST .../branches/<id>/commits` carrying the whole
 *    `data` plus the `baseHash` it was read at. Same call creates and updates.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

const MANAGE = "api/content-platform/manage";
const SCHEMAS = "api/content-platform/schemas";

export interface CmsConfig {
  /** VTEX account, e.g. `electroluxecfaststore`. */
  account: string;
  /** Store id inside the account, e.g. `electrolux`. Not the same thing as the account. */
  store: string;
  token: string;
}

export interface CmsRequest {
  path: string;
  method?: "GET" | "POST" | "DELETE";
  body?: unknown;
}

/**
 * Injected so tests can record calls instead of mocking `fetch`, matching `ToolCaller` in
 * `board/studio.ts`.
 */
export type CmsCaller = <T>(cfg: CmsConfig, req: CmsRequest) => Promise<T>;

/**
 * The token the `vtex` toolbelt writes on `vtex login`. Reading it beats asking for a second
 * credential: whoever runs a migration is already logged into the account.
 */
export function tokenFromVtexSession(home: string = homedir()): string | null {
  try {
    const raw = readFileSync(join(home, ".config", "configstore", "vtex.json"), "utf8");
    const token = (JSON.parse(raw) as { token?: string }).token;
    return token && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

/**
 * Returns null when anything is missing, like `studioConfigFromEnv` — the caller prints what to do
 * instead of getting a stack trace.
 */
export function cmsConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir()
): CmsConfig | null {
  const account = env.PARITY_CMS_ACCOUNT;
  const store = env.PARITY_CMS_STORE;
  const token = env.PARITY_CMS_TOKEN ?? tokenFromVtexSession(home);
  if (!account || !store || !token) return null;
  return { account, store, token };
}

function baseUrl(cfg: CmsConfig): string {
  return `https://${cfg.account}.myvtex.com`;
}

export const callCms: CmsCaller = async <T>(cfg: CmsConfig, req: CmsRequest): Promise<T> => {
  const method = req.method ?? "GET";
  const res = await fetch(`${baseUrl(cfg)}/${req.path}`, {
    method,
    headers: {
      authorization: `Bearer ${cfg.token}`,
      accept: "application/json",
      ...(req.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(req.body === undefined ? {} : { body: JSON.stringify(req.body) }),
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(`${method} ${req.path}: HTTP ${res.status} ${text.slice(0, 300)}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
};

export interface CmsBranch {
  id: string;
  name: string;
}

export interface CmsEntrySummary {
  id: string;
  name: string;
  contentTypeId: string;
  storeId: string;
  updatedAt?: string;
  search_keywords?: string[];
  branches?: { branchId: string; branchName: string }[];
}

export interface CmsVersion {
  entryId: string;
  contentType: string;
  branchId: string;
  commitId: string;
  baseHash: string;
  entryName: string | null;
  identifierKeys: unknown;
  searchKeywords: string[] | null;
  data: Record<string, unknown>;
}

export async function listBranches(cfg: CmsConfig, call: CmsCaller = callCms): Promise<CmsBranch[]> {
  return call<CmsBranch[]>(cfg, { path: `${MANAGE}/${cfg.account}/${cfg.store}/branches` });
}

export async function listEntries(
  cfg: CmsConfig,
  opts: { contentType?: string; pageSize?: number } = {},
  call: CmsCaller = callCms
): Promise<CmsEntrySummary[]> {
  const params = new URLSearchParams({
    contentTypes: opts.contentType ?? "",
    page: "1",
    pageSize: String(opts.pageSize ?? 100),
  });
  const res = await call<{ entries?: CmsEntrySummary[] }>(cfg, {
    path: `${MANAGE}/${cfg.account}/entries?${params}`,
  });
  return res.entries ?? [];
}

export async function getLastVersion(
  cfg: CmsConfig,
  args: { contentType: string; entryId: string; branchId: string },
  call: CmsCaller = callCms
): Promise<CmsVersion> {
  const { contentType, entryId, branchId } = args;
  return call<CmsVersion>(cfg, {
    path: `${MANAGE}/${cfg.account}/${cfg.store}/${contentType}/entries/${entryId}/last-version?branchId=${branchId}`,
  });
}

export interface CommitInput {
  branchId: string;
  contentTypeId: string;
  entryId: string;
  entryName: string | null;
  baseHash: string;
  data: Record<string, unknown>;
  message: string;
  author: string;
  identifierKeys?: unknown;
  searchKeywords?: string[] | null;
}

export interface CommitResult {
  id: string;
  hash: string;
  branchId: string;
  entryId: string;
}

/**
 * Creates and updates — a new page is the same call with an entryId nobody has used yet.
 *
 * `commitType` is deliberately absent. The Admin only sends it when restoring a version
 * (`"restored"`); sending `"update"` on a normal save fails with a 500 from the INSERT into the
 * `commits` table, which looks like an outage and is a bad request.
 */
export async function commitEntry(
  cfg: CmsConfig,
  input: CommitInput,
  call: CmsCaller = callCms
): Promise<CommitResult> {
  if (!input.baseHash) {
    throw new Error("commitEntry: baseHash is required — it is the lock against clobbering a concurrent edit");
  }
  return call<CommitResult>(cfg, {
    path: `${MANAGE}/${cfg.account}/${cfg.store}/branches/${input.branchId}/commits`,
    method: "POST",
    body: {
      author: input.author,
      contentTypeId: input.contentTypeId,
      message: input.message,
      data: input.data,
      entryId: input.entryId,
      entryName: input.entryName,
      baseHash: input.baseHash,
      identifierKeys: input.identifierKeys ?? null,
      search_keywords: input.searchKeywords ?? null,
    },
  });
}

/** Drops an entry's changes on a branch — the platform's own rollback, cheaper than re-committing. */
export async function undoEntry(
  cfg: CmsConfig,
  args: { branchId: string; entryId: string },
  call: CmsCaller = callCms
): Promise<void> {
  await call(cfg, {
    path: `${MANAGE}/${cfg.account}/${cfg.store}/branches/${args.branchId}/entries/${args.entryId}/undo`,
    method: "DELETE",
  });
}

export interface CmsContentType {
  $singleton?: boolean;
  identifierKeys?: string[];
  title?: string;
  properties?: Record<string, unknown>;
}

/** Lives outside `manage/` — the schema registry is a different service. */
export async function getContentTypes(
  cfg: CmsConfig,
  call: CmsCaller = callCms
): Promise<Record<string, CmsContentType>> {
  return call<Record<string, CmsContentType>>(cfg, {
    path: `${SCHEMAS}/${cfg.account}.${cfg.store}/content-types`,
  });
}
