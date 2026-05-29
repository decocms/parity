import type { FlowCapture, FlowName, StepCapture, Viewport } from "../../types/schema.ts";

/** Find the FlowCapture for a (flow, viewport) pair, or undefined. */
export function findFlow(
  flows: FlowCapture[],
  flow: FlowName,
  viewport: Viewport,
): FlowCapture | undefined {
  return flows.find((f) => f.flow === flow && f.viewport === viewport);
}

/** Look up a step by name inside a flow capture (or undefined). */
export function findStep(
  flow: FlowCapture | undefined,
  stepName: string,
): StepCapture | undefined {
  return flow?.steps?.find((s) => s.name === stepName);
}

/**
 * Are we in single-site mode? Set when only one side has any captures —
 * used by `parity e2e` to make checks run in absolute mode (no comparison).
 */
export function isSingleSite(
  prodFlows: FlowCapture[],
  candFlows: FlowCapture[],
): boolean {
  return prodFlows.length === 0 || candFlows.length === 0;
}

export function buildPairEvidence(prod?: StepCapture, cand?: StepCapture) {
  const out: { kind: "screenshot"; path: string; label?: string }[] = [];
  if (prod?.screenshotPath) out.push({ kind: "screenshot", path: prod.screenshotPath, label: "prod" });
  if (cand?.screenshotPath) out.push({ kind: "screenshot", path: cand.screenshotPath, label: "cand" });
  return out;
}
