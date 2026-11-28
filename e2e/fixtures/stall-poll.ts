import type { Page } from "@playwright/test";
import type { Stall } from "../../src/shared/stall.ts";
import type { ServerEvent } from "../../src/shared/types.ts";
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
  let previous = new Set<string>();
  await page.route("**/api/away/stalls", async route => {
    const stalls = read();
    const current = new Set<string>();
    const events: ServerEvent[] = [];
    for (const stall of stalls) {
      if (stall.kind !== "workflow-parked") continue;
      const facts = stall.facts?.kind === "workflow-parked" ? stall.facts : undefined;
      const id = facts?.runId ?? stall.workflowRunId;
      if (!id) continue;
      current.add(id);
      const run = { ...LADDER_SUMMARY, id, sessionId: stall.sessionId, workflowName: facts?.workflowName ?? "Previous review",
        status: facts?.status ?? "waiting_for_session", round: facts?.round ?? 1 };
      events.push({ type: "workflow_run_upsert", run });
    }
    for (const id of previous) {
      if (!current.has(id)) events.push({ type: "workflow_run_remove", id });
    }
    previous = current;
    if (events.length) await page.evaluate(updates => {
      const stream = (window as StreamWindow).stallTestStream;
      for (const event of updates) stream.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) }));
    }, events);
    await route.fulfill({ json: stalls });
  });
}
