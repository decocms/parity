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

  // Was the purchase-journey flow even in scope for this run? If neither
  // side has any flow capture for it, the user didn't request it — skip
  // the check entirely instead of silently reporting "0 steps / pass",
  // which would let real checkout regressions slip through.
  const hasAnyPurchaseFlow =
    ctx.prodFlows.some((f) => f.flow === "purchase-journey") ||
    ctx.candFlows.some((f) => f.flow === "purchase-journey");
  if (!hasAnyPurchaseFlow) {
    return {
      name: "purchase-journey-flow",
      status: "skipped",
      severity: "critical",
      durationMs: Date.now() - start,
      summary: "purchase-journey não estava no escopo do run (sem captura de flow)",
      issues: [],
      data: { totalSteps: 0, failedSteps: 0, asymmetricSkips: 0 },
    };
  }

  // Pair flows by viewport
  for (const viewport of ctx.viewports) {
    const prodFlow = findFlow(ctx.prodFlows, viewport);
    const candFlow = findFlow(ctx.candFlows, viewport);
    if (!prodFlow || !candFlow) {
      // The flow was requested for the run (we just confirmed above), so a
      // missing side here is itself a critical signal — either prod never
      // produced steps (selectors broke against the source-of-truth) or
      // cand crashed before any step could run. Either way, "pass" is
      // dangerous.
      if (prodFlow && !candFlow) {
        issues.push({
          id: `pj:${viewport}:missing-cand-flow`,
          severity: "critical",
          category: "functional",
          check: "purchase-journey-flow",
          summary: `[${viewport}] cand não produziu captura da purchase-journey (prod produziu) — checkout indisponível ou cliente nunca hidratou`,
        });
      } else if (!prodFlow && candFlow) {
        issues.push({
          id: `pj:${viewport}:missing-prod-flow`,
          severity: "high",
          category: "functional",
          check: "purchase-journey-flow",
          summary: `[${viewport}] prod não produziu captura da purchase-journey — selectors podem estar desalinhados com a source-of-truth`,
        });
      } else {
        issues.push({
          id: `pj:${viewport}:no-flow-either-side`,
          severity: "critical",
          category: "functional",
          check: "purchase-journey-flow",
          summary: `[${viewport}] purchase-journey foi requisitada mas não há captura em prod nem cand — flow falhou completamente`,
        });
      }
      continue;
    }

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

  // Captures existed but 0 steps were actually evaluated (selectors produced
  // empty step arrays on both sides, or the only steps were cand-only and
  // skipped at line 47). With no comparable steps the check can't claim
  // pass — the purchase-journey is effectively unverified.
  if (totalSteps === 0 && issues.length === 0) {
    issues.push({
      id: "pj:zero-steps-evaluated",
      severity: "critical",
      category: "functional",
      check: "purchase-journey-flow",
      summary:
        "purchase-journey rodou mas avaliou 0 step(s) — capturas existem mas estão vazias dos dois lados (selectors quebrados ou home não hidratou)",
    });
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
