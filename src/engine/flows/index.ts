import type { FlowCapture, FlowName, PageCapture, StepCapture } from "../../types/schema.ts";
import { flowCartInteractions } from "./cart-interactions.ts";
import { flowLogin } from "./login.ts";
import { flowPurchaseJourney } from "./purchase-journey.ts";
import { flowSearch } from "./search.ts";
import type { FlowContext } from "./shared.ts";
import { flowHomepage, flowPdp, flowPlp } from "./simple.ts";

export { collectCandidateLinks, findElement } from "./shared.ts";
export type { FlowContext, StepActionResult, StepProgressEvent } from "./shared.ts";

/**
 * Per-flow hard deadlines so a single misbehaving page can never freeze the
 * whole crawl. `capturePage` already has its own 60s + 10s outer race in
 * `collect.ts`, but a flow can include several page captures plus selector
 * discovery, click + navigation waits, and LLM recovery calls. Real-world
 * runs against CMS-heavy sites have hung for 1h+ at `running flow "plp"`
 * because something inside the flow was waiting on a Playwright op that
 * doesn't honor its declared timeout (most commonly `page.click` followed
 * by an implicit navigation wait when the target page never reaches a
 * settled state).
 *
 * Budget scales with how much each flow has to do — homepage is a single
 * capture, plp/pdp add a navigation step, purchase-journey runs 9 steps.
 * Each individual step has its own timeout caps; this is the safety net
 * for the case where those caps misbehave.
 */
const FLOW_DEADLINE_MS: Record<FlowName, number> = {
  homepage: 90_000,
  plp: 180_000,
  pdp: 240_000,
  "purchase-journey": 420_000, // 9 steps × ~30s + LLM recovery + variant heuristic scroll
  search: 300_000, // 6 steps (home + autocomplete + results + no-results + empty)
  "cart-interactions": 240_000, // 7 steps (seed via PJ + qty + coupon + remove)
  login: 180_000, // 5 steps (gated, only with credentials)
};

/**
 * Run a named flow. Returns all pages visited and (for purchase-journey) ordered steps.
 */
export async function runFlow(flow: FlowName, ctx: FlowContext): Promise<FlowCapture> {
  const start = Date.now();
  const deadlineMs = FLOW_DEADLINE_MS[flow];
  // Catch ANY inner error and convert to a failed FlowCapture. Without this
  // a thrown error inside e.g. `flowSearch` (the most common being
  // "browserContext.newPage: Target page, context or browser has been
  // closed" when a previous flow corrupted the context) propagates through
  // `Promise.race` below and aborts the entire run. Returning a failed
  // capture instead means one bad flow doesn't kill the other 3 sides ×
  // viewports — the report still renders with the surviving data.
  const inner = async (): Promise<FlowCapture> => {
    try {
      switch (flow) {
        case "homepage":
          return finalize(flow, ctx, await flowHomepage(ctx), [], start);
        case "plp":
          return finalize(flow, ctx, await flowPlp(ctx), [], start);
        case "pdp":
          return finalize(flow, ctx, await flowPdp(ctx), [], start);
        case "purchase-journey": {
          const { pages, steps } = await flowPurchaseJourney(ctx);
          return finalize(flow, ctx, pages, steps, start);
        }
        case "search": {
          const { pages, steps } = await flowSearch(ctx);
          return finalize(flow, ctx, pages, steps, start);
        }
        case "cart-interactions": {
          const { pages, steps } = await flowCartInteractions(ctx);
          return finalize(flow, ctx, pages, steps, start);
        }
        case "login": {
          const { pages, steps } = await flowLogin(ctx);
          return finalize(flow, ctx, pages, steps, start);
        }
      }
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      ctx.onStep?.({
        phase: "end",
        name: "flow-error",
        index: 0,
        total: 1,
        status: "failed",
        durationMs: Date.now() - start,
        note: msg.slice(0, 120),
      });
      return finalize(
        flow,
        ctx,
        [],
        [
          {
            step: 0,
            name: "flow-error",
            side: ctx.side,
            viewport: ctx.viewport,
            status: "failed",
            durationMs: Date.now() - start,
            screenshotPath: "",
            note: msg.slice(0, 200),
            actionDescription: `[flow-error] ${flow}: ${msg.slice(0, 200)}`,
          },
        ],
        start,
      );
    }
  };

  // Run the flow exactly once. If it rejects after the deadline has
  // already won the race (e.g. because we closed its pages), swallow
  // the rejection silently — Promise.race already returned the
  // timeout's FlowCapture and the inner rejection isn't actionable.
  const innerPromise = inner();
  innerPromise.catch(() => undefined);

  let timer: ReturnType<typeof setTimeout> | undefined;
  let cleanup: Promise<unknown> = Promise.resolve();
  const timeoutPromise = new Promise<FlowCapture>((resolve) => {
    timer = setTimeout(() => {
      const pages = ctx.ctx.pages();
      // Seal the timeout result FIRST, synchronously. Closing pages
      // makes any in-flight Playwright op inside `inner()` reject with
      // "Target closed" almost immediately; if we awaited those closes
      // before resolving, Promise.race could pick up the inner
      // rejection first and make runFlow throw instead of returning
      // this timeout FlowCapture.
      resolve(
        finalize(
          flow,
          ctx,
          [],
          [
            {
              step: 0,
              name: "flow-timeout",
              side: ctx.side,
              viewport: ctx.viewport,
              status: "failed",
              durationMs: deadlineMs,
              screenshotPath: "",
              actionDescription: `[flow-timeout] flow "${flow}" excedeu ${deadlineMs}ms — captura abortada pela safety net externa, ${pages.length} page(s) fechada(s) para liberar o contexto.`,
            },
          ],
          start,
        ),
      );
      // Kick off close on every page in the BrowserContext. Cap each
      // close at 5s so the cleanup awaitable always resolves.
      const CLOSE_CAP_MS = 5_000;
      const cappedClose = (p: (typeof pages)[number]): Promise<void> =>
        Promise.race([
          p.close().catch(() => undefined),
          new Promise<void>((resolveClose) => setTimeout(resolveClose, CLOSE_CAP_MS)),
        ]);
      cleanup = Promise.allSettled(pages.map(cappedClose));
    }, deadlineMs);
  });

  try {
    const result = await Promise.race([innerPromise, timeoutPromise]);
    await cleanup;
    return result;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function finalize(
  flow: FlowName,
  ctx: FlowContext,
  pages: PageCapture[],
  steps: StepCapture[],
  start: number,
): FlowCapture {
  return {
    flow,
    side: ctx.side,
    viewport: ctx.viewport,
    pages,
    steps,
    totalDurationMs: Date.now() - start,
  };
}
