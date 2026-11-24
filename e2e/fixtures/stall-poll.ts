import type { Page } from "@playwright/test";
import type { Stall } from "../../src/shared/stall.ts";
import { LADDER_SUMMARY } from "../../test/helpers/workflow-ladder.ts";

/** Script the stall response and matching live run summaries for action tests without a real parked run. */
export async function serveStallPoll(page: Page, read: () => Stall[]): Promise<void> {
  type StreamWindow = Window & { stallTestStream: EventSource };
  await page.addInitScript(() => {
    const Native = window.EventSource;
    window.EventSource = class extends Native {
      constructor(url: string | URL, options?: EventSourceInit) {
        super(url, options);
        if (String(url) === "/events") (window as StreamWindow).stallTestStream = this;
      }
    };
  });
  await page.reload();
  await page.route("**/api/away/stalls", async route => {
    const stalls = read();
    for (const stall of stalls) {
      if (stall.kind !== "workflow-parked") continue;
      const facts = stall.facts?.kind === "workflow-parked" ? stall.facts : undefined;
      const id = facts?.runId ?? stall.workflowRunId;
      if (!id) continue;
      const run = { ...LADDER_SUMMARY, id, sessionId: stall.sessionId, workflowName: facts?.workflowName ?? "Previous review",
        status: facts?.status ?? "waiting_for_session", round: facts?.round ?? 1 };
      await page.evaluate(summary => {
        (window as StreamWindow).stallTestStream.dispatchEvent(new MessageEvent("message", {
          data: JSON.stringify({ type: "workflow_run_upsert", run: summary }),
        }));
      }, run);
    }
    await route.fulfill({ json: stalls });
  });
}
