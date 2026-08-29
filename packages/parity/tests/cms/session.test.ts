import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sessionAdvice, sessionState, vtexCliInstalled } from "../../src/cms/session.ts";

/** A JWT the code only reads — the signature is never checked, so a fake payload is enough. */
function jwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "ES256" })}.${b64(claims)}.sig`;
}

/** A directory with a `vtex` file in it, so PATH lookup finds the toolbelt. */
function binWithVtex(): string {
  const dir = mkdtempSync(join(tmpdir(), "parity-bin-"));
  writeFileSync(join(dir, "vtex"), "#!/bin/sh\n");
  return dir;
}

function home(session?: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "parity-session-"));
  if (session) {
    mkdirSync(join(dir, ".config", "configstore"), { recursive: true });
    writeFileSync(join(dir, ".config", "configstore", "vtex.json"), JSON.stringify(session));
  }
  return dir;
}

const NOW = 1_700_000_000_000;
const live = { account: "acme", login: "a@b.c", token: jwt({ exp: NOW / 1000 + 3600 }) };
const dead = { account: "acme", login: "a@b.c", token: jwt({ exp: NOW / 1000 - 60 }) };
const noPath = { PATH: "" } as NodeJS.ProcessEnv;

describe("sessionState", () => {
  it("PARITY_CMS_TOKEN pula a sessao — o caminho de CI nao tem browser", () => {
    const env = { PARITY_CMS_TOKEN: "t" } as NodeJS.ProcessEnv;
    expect(sessionState("acme", env, home(), NOW).status).toBe("env-token");
  });

  it("sem sessao e sem CLI, o problema e a instalacao", () => {
    expect(sessionState("acme", noPath, home(), NOW).status).toBe("no-cli");
  });

  it("distingue token expirado de ausente — expira em ~1 dia e o 401 e igual", () => {
    expect(sessionState("acme", noPath, home(dead), NOW).status).toBe("expired");
  });

  it("pega conta errada, que tambem responde 401 e parece token quebrado", () => {
    const state = sessionState("outra", noPath, home(live), NOW);
    expect(state.status).toBe("wrong-account");
  });

  it("ok quando a conta bate e o token esta vivo", () => {
    expect(sessionState("acme", noPath, home(live), NOW).status).toBe("ok");
  });

  it("nao exige conta esperada para considerar a sessao valida", () => {
    expect(sessionState(undefined, noPath, home(live), NOW).status).toBe("ok");
  });
});

describe("sessionAdvice", () => {
  it("manda instalar a toolbelt quando ela nao existe", () => {
    const advice = sessionAdvice(sessionState("acme", noPath, home(), NOW), "acme");
    expect(advice).toContain("npm i -g vtex");
    expect(advice).toContain("vtex login acme");
  });

  it("avisa que o login abre browser — o agente nao consegue completar sozinho", () => {
    const state = sessionState("acme", { PATH: binWithVtex() } as NodeJS.ProcessEnv, home(), NOW);
    expect(state.status).toBe("logged-out");
    expect(sessionAdvice(state, "acme")).toContain("browser");
  });

  it("na conta errada, manda logar na conta certa", () => {
    const advice = sessionAdvice(sessionState("outra", noPath, home(live), NOW), "outra");
    expect(advice).toContain("vtex login outra");
  });
});

describe("vtexCliInstalled", () => {
  it("procura o binario no PATH", () => {
    expect(vtexCliInstalled(noPath)).toBe(false);
  });
});
