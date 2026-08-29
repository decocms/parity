/**
 * Tell the caller exactly why the CMS is unreachable, and what to type.
 *
 * The credential is the `vtex` toolbelt session, and it is a JWT that expires in about a day. An
 * agent running a migration the next morning gets a 401 that reads like a broken endpoint. Worse,
 * being logged into the *wrong account* also answers 401 — so a raw HTTP error is close to
 * useless here.
 *
 * None of this can be fixed by the agent on its own: `vtex login` opens a browser for SSO. The
 * only useful thing to do is name the state precisely and hand the human one command.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

export interface VtexSession {
  account: string | null;
  login: string | null;
  token: string;
  /** Epoch seconds from the token's own `exp` claim, or null when it is not a readable JWT. */
  expiresAt: number | null;
}

export type SessionState =
  | { status: "ok"; session: VtexSession }
  | { status: "env-token" }
  | { status: "no-cli" }
  | { status: "logged-out" }
  | { status: "expired"; session: VtexSession }
  | { status: "wrong-account"; session: VtexSession; expected: string };

function sessionFile(home: string): string {
  return join(home, ".config", "configstore", "vtex.json");
}

/** The `exp` claim, without verifying the signature — this is a hint for the user, not a gate. */
function expiryOf(token: string): number | null {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const json = Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const exp = (JSON.parse(json) as { exp?: number }).exp;
    return typeof exp === "number" ? exp : null;
  } catch {
    return null;
  }
}

export function readVtexSession(home: string = homedir()): VtexSession | null {
  try {
    const raw = JSON.parse(readFileSync(sessionFile(home), "utf8")) as Record<string, unknown>;
    const token = typeof raw.token === "string" ? raw.token : "";
    if (!token) return null;
    return {
      token,
      account: typeof raw.account === "string" ? raw.account : null,
      login: typeof raw.login === "string" ? raw.login : null,
      expiresAt: expiryOf(token),
    };
  } catch {
    return null;
  }
}

/** `vtex` on PATH. Without it there is no way to obtain a token at all. */
export function vtexCliInstalled(env: NodeJS.ProcessEnv = process.env): boolean {
  const dirs = (env.PATH ?? "").split(delimiter).filter(Boolean);
  return dirs.some((dir) => existsSync(join(dir, "vtex")));
}

export function sessionState(
  expectedAccount: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  now: number = Date.now()
): SessionState {
  if (env.PARITY_CMS_TOKEN) return { status: "env-token" };
  const session = readVtexSession(home);
  if (!session) return vtexCliInstalled(env) ? { status: "logged-out" } : { status: "no-cli" };
  if (session.expiresAt !== null && session.expiresAt * 1000 <= now) {
    return { status: "expired", session };
  }
  if (expectedAccount && session.account && session.account !== expectedAccount) {
    return { status: "wrong-account", session, expected: expectedAccount };
  }
  return { status: "ok", session };
}

/**
 * What to type. Every branch ends in a command the human can run — an agent reading this has no
 * browser and cannot complete SSO itself, so "ask the human to run this" is the whole contract.
 */
export function sessionAdvice(state: SessionState, expectedAccount = "<account>"): string {
  switch (state.status) {
    case "no-cli":
      return [
        "The VTEX toolbelt is not installed, so there is no way to get a session token.",
        "  npm i -g vtex",
        `  vtex login ${expectedAccount}`,
      ].join("\n");
    case "logged-out":
      return [
        "Not logged into VTEX.",
        `  vtex login ${expectedAccount}`,
        "  (opens a browser for SSO — a human has to complete it)",
      ].join("\n");
    case "expired":
      return [
        `VTEX session expired${state.session.login ? ` for ${state.session.login}` : ""} — the toolbelt token lasts about a day.`,
        `  vtex login ${expectedAccount}`,
      ].join("\n");
    case "wrong-account":
      return [
        `Logged into "${state.session.account}", but this run targets "${state.expected}". Wrong-account requests answer 401, which looks like a broken token.`,
        `  vtex login ${state.expected}`,
      ].join("\n");
    default:
      return "";
  }
}

/** Human-readable "logged in as X, N h left", for `doctor`. */
export function describeSession(state: SessionState): string {
  if (state.status === "env-token") return "using PARITY_CMS_TOKEN";
  if (state.status !== "ok") return "";
  const { login, account, expiresAt } = state.session;
  const left =
    expiresAt === null
      ? ""
      : ` · expires in ${Math.max(0, Math.round((expiresAt * 1000 - Date.now()) / 3_600_000))}h`;
  return `${login ?? "?"} on ${account ?? "?"}${left}`;
}
