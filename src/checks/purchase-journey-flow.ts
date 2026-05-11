import type { CheckResult, FlowCapture, Issue, StepCapture, Viewport } from "../types/schema.ts";
import type { CheckContext } from "./index.ts";

const STEP_LABELS: Record<string, string> = {
  "visit-home": "Visitar home",
  "navigate-plp": "Navegar para categoria (PLP)",
  "enter-pdp": "Entrar em PDP",
  "shipping-calc-pdp": "Cálculo de frete na PDP",
  "add-to-cart": "Adicionar ao carrinho",
  "open-minicart": "Abrir minicart",
  "shipping-calc-cart": "Cálculo de frete no carrinho",
  "go-checkout": "Ir para checkout",
};

const CRITICAL_STEPS = new Set([
  "visit-home",
  "navigate-plp",
  "enter-pdp",
  "add-to-cart",
  "open-minicart",
  "go-checkout",
]);

export function purchaseJourneyFlow(ctx: CheckContext): CheckResult {
  const start = Date.now();
  const issues: Issue[] = [];
  let totalSteps = 0;
  let failedSteps = 0;
  let asymmetricSkips = 0;

  // Pair flows by viewport
  for (const viewport of ctx.viewports) {
    const prodFlow = findFlow(ctx.prodFlows, viewport);
    const candFlow = findFlow(ctx.candFlows, viewport);
    if (!prodFlow || !candFlow) continue;

    const prodSteps = indexBy(prodFlow.steps ?? [], (s) => s.name);
    const candSteps = indexBy(candFlow.steps ?? [], (s) => s.name);
    const allNames = new Set([...prodSteps.keys(), ...candSteps.keys()]);

    for (const name of allNames) {
      totalSteps++;
      const p = prodSteps.get(name);
      const c = candSteps.get(name);
      const label = STEP_LABELS[name] ?? name;

      if (!p && c) continue; // step só em cand, ignore
      if (p && !c) {
        failedSteps++;
        issues.push({
          id: `pj:${viewport}:${name}:missing-cand`,
          severity: "critical",
          category: "functional",
          check: "purchase-journey-flow",
          summary: `[${viewport}] Step "${label}" não executou em cand (existe em prod)`,
          evidence: p.screenshotPath ? [{ kind: "screenshot", path: p.screenshotPath, label: "prod" }] : [],
        });
        continue;
      }
      if (!p || !c) continue;

      // Both present — compare
      if (p.status === "ok" && c.status === "failed") {
        failedSteps++;
        issues.push({
          id: `pj:${viewport}:${name}:failed-cand`,
          severity: CRITICAL_STEPS.has(name) ? "critical" : "high",
          category: "functional",
          check: "purchase-journey-flow",
          summary: `[${viewport}] Step "${label}" falhou em cand mas passou em prod`,
          evidence: buildPairEvidence(p, c),
        });
      } else if (p.status === "ok" && c.status === "skipped") {
        asymmetricSkips++;
        issues.push({
          id: `pj:${viewport}:${name}:skipped-cand`,
          severity: CRITICAL_STEPS.has(name) ? "critical" : "high",
          category: "functional",
          check: "purchase-journey-flow",
          summary: `[${viewport}] Step "${label}" pulou em cand (motivo: ${c.note ?? "elemento não encontrado"}) mas executou em prod — provável regressão de UI`,
          evidence: buildPairEvidence(p, c),
        });
      } else if (p.status === "skipped" && c.status === "ok") {
        // Cand has something prod doesn't — neutral
      }
    }
  }

  const status: CheckResult["status"] =
    issues.some((i) => i.severity === "critical")
      ? "fail"
      : issues.length > 0
        ? "warn"
        : "pass";

  return {
    name: "purchase-journey-flow",
    status,
    severity: "critical",
    durationMs: Date.now() - start,
    summary: `${totalSteps} step(s) avaliado(s), ${failedSteps} falha(s), ${asymmetricSkips} skip(s) assimétrico(s)`,
    issues,
    data: { totalSteps, failedSteps, asymmetricSkips },
  };
}

function findFlow(flows: FlowCapture[], viewport: Viewport): FlowCapture | undefined {
  return flows.find((f) => f.flow === "purchase-journey" && f.viewport === viewport);
}

function indexBy<T, K>(arr: T[], key: (t: T) => K): Map<K, T> {
  const m = new Map<K, T>();
  for (const it of arr) m.set(key(it), it);
  return m;
}

function buildPairEvidence(p: StepCapture, c: StepCapture) {
  const out: Issue["evidence"] = [];
  if (p.screenshotPath) out.push({ kind: "screenshot", path: p.screenshotPath, label: "prod" });
  if (c.screenshotPath) out.push({ kind: "screenshot", path: c.screenshotPath, label: "cand" });
  return out;
}
