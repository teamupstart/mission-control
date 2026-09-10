import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkflowLadder } from "../src/web/workflows/WorkflowLadder.tsx";
import { WorkflowRunView } from "../src/web/workflows/WorkflowRuns.tsx";
import {
  deliveryResolutionActions,
} from "../src/web/workflows/run-actions.ts";
import { ladderDetail } from "./helpers/workflow-ladder.ts";

const PHRASE = "DISCARD AND SEND A NEW REPAIR ROUND";

function buttonFor(html: string, label: string): string {
  const end = html.indexOf(`>${label}</button>`);
  assert.notEqual(end, -1, `${label} button is present`);
  const start = html.lastIndexOf("<button", end);
  return html.slice(start, end + label.length + 10);
}

test("discard keeps the live-session and exact typed-phrase guards", () => {
  const delivery = ladderDetail("uncertain").deliveries[0]!;
  const discard = deliveryResolutionActions(delivery, false)
    .find((action) => action.resolution === "discard_and_new_round");
  assert.ok(discard);
  assert.equal(discard.disabled, true);
  assert.equal(discard.confirm.requirePhrase, PHRASE);
  assert.equal(
    discard.tooltip,
    "The bound session is gone, so no replacement round can be prepared",
  );
});

test("the Runs reader renders the shared delivery descriptors", () => {
  const detail = ladderDetail("uncertain");
  const actions = deliveryResolutionActions(detail.deliveries[0]!, true);
  // Named: the run record's panes are tabs now, and this fixture's worklist blocks too, so it
  // wins the initial selection. The claim here is about the ledger's own markup.
  const html = renderToStaticMarkup(createElement(WorkflowRunView, {
    detail,
    pane: "deliveries" as const,
    onCancel: async () => {},
  }));
  for (const action of actions) {
    assert.ok(html.includes(action.label));
    assert.ok(html.includes(action.tooltip));
  }
});

test("a disappeared binding disables discard even when the summary still names a session", () => {
  const detail = ladderDetail("uncertain");
  detail.binding = { ...detail.binding, sessionId: null, state: "orphaned" };
  assert.equal(detail.summary.sessionId, "session");
  const html = renderToStaticMarkup(createElement(WorkflowLadder, {
    summary: detail.summary,
    detail,
    onOpenRun: () => {},
    onResolveDelivery: () => {},
    sessionBound: detail.binding.sessionId !== null,
  }));
  assert.match(buttonFor(html, "Discard and send new round"), /disabled/);
  assert.ok(html.includes("The bound session is gone, so no replacement round can be prepared"));
});
