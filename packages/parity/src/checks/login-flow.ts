import type { CheckResult, Issue } from "../types/schema.ts";
import type { CheckContext } from "./index.ts";
import { buildPairEvidence, findFlow, findStep, isSingleSite } from "./lib/flow-pairing.ts";

const STEP_LABELS: Record<string, string> = {
  "visit-home": "Visitar home",
  "open-login": "Abrir formulário de login",
  "submit-invalid": "Submeter credencial inválida (esperar erro)",
  "submit-valid": "Submeter credencial válida (esperar redirect)",
  "verify-account-area": "Verificar área logada",
};

const CRITICAL_STEPS = new Set(["submit-valid", "verify-account-area"]);

/**
 * Login flow parity check. Only meaningful when the flow ran (gated by
 * `rc.login.enabled` + env credentials). Critical when cand can't log in
 * with valid credentials that work in prod.
 */
export function loginFlow(ctx: CheckContext): CheckResult {
  const start = Date.now();
  const issues: Issue[] = [];
  const single = isSingleSite(ctx.prodFlows, ctx.candFlows);

  const hasFlow =
    ctx.prodFlows.some((f) => f.flow === "login") || ctx.candFlows.some((f) => f.flow === "login");
  if (!hasFlow) {
    return {
      name: "login-flow",
      status: "skipped",
      severity: "critical",
      durationMs: Date.now() - start,
      summary:
        "login flow não estava no escopo do run (rc.login.enabled=false ou credenciais ausentes)",
      issues: [],
    };
  }

  for (const viewport of ctx.viewports) {
    const prodFlow = findFlow(ctx.prodFlows, "login", viewport);
    const candFlow = findFlow(ctx.candFlows, "login", viewport);

    if (single) {
      const flow = prodFlow ?? candFlow;
      const submitValid = findStep(flow, "submit-valid");
      if (submitValid && submitValid.status === "failed") {
        issues.push({
          id: `login:${viewport}:submit-valid-failed`,
          severity: "critical",
          category: "functional",
          check: "login-flow",
          summary: `[${viewport}] Login com credenciais válidas falhou: ${submitValid.note ?? submitValid.actionDescription ?? ""}`,
          evidence: submitValid.screenshotPath
            ? [{ kind: "screenshot", path: submitValid.screenshotPath }]
            : [],
        });
      }
      const submitInvalid = findStep(flow, "submit-invalid");
      if (submitInvalid && submitInvalid.status === "failed") {
        issues.push({
          id: `login:${viewport}:no-error-message`,
          severity: "high",
          category: "functional",
          check: "login-flow",
          summary: `[${viewport}] Credencial inválida não exibiu mensagem de erro — UX prejudicada (usuário não sabe o que falhou)`,
        });
      }
      continue;
    }

    const prodSteps = new Map((prodFlow?.steps ?? []).map((s) => [s.name, s]));
    const candSteps = new Map((candFlow?.steps ?? []).map((s) => [s.name, s]));
    const allNames = new Set([...prodSteps.keys(), ...candSteps.keys()]);
    for (const name of allNames) {
      const p = prodSteps.get(name);
      const c = candSteps.get(name);
      if (!p || !c) continue;
      const label = STEP_LABELS[name] ?? name;

      if (p.status === "ok" && c.status === "failed") {
        issues.push({
          id: `login:${viewport}:${name}:failed-cand`,
          severity: CRITICAL_STEPS.has(name) ? "critical" : "high",
          category: "functional",
          check: "login-flow",
          summary: `[${viewport}] "${label}" falhou em cand (passou em prod) — ${c.note ?? c.actionDescription ?? ""}`,
          evidence: buildPairEvidence(p, c),
        });
      }
    }
  }

  const status: CheckResult["status"] = issues.some((i) => i.severity === "critical")
    ? "fail"
    : issues.length > 0
      ? "warn"
      : "pass";

  return {
    name: "login-flow",
    status,
    severity: "critical",
    durationMs: Date.now() - start,
    summary: `${issues.length} issue(s) — mode: ${single ? "single-site" : "comparative"}`,
    issues,
  };
}
