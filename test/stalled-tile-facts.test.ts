// What is at stake: a Stalled card (`idle-stalled`) replaced the inbox's Stuck row for an idle
// stall, so it has to carry everything that row did and the context it lacked. For each idle rule:
// the open task or queue, or the parked run and its missing step; the last activity line;
// Foreman's note when there is one; the Stuck row's fixes from the same `INBOX_ACTIONS` entries;
// and Dismiss. A card that dropped any of these would send the operator back to the inbox it left.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StalledTileFacts } from "../src/web/components/StalledTileFacts.tsx";
import type { Stall, StallFacts } from "../src/shared/stall.ts";
import type { Session } from "../src/shared/types.ts";
import { mkSession } from "./helpers/session-fixture.ts";

const NOTE = {
  purpose: null,
  brief: "Ended its turn asking in prose whether to update the auth snapshot.",
  recommendation: null,
  disposition: "pending" as const,
  lastAction: null,
  handledMarker: null,
  updatedAt: 1,
};

function card(facts: StallFacts, over: Partial<Session> = {}, dismiss = true): string {
  const session = mkSession({ id: "s1", name: "amber-lynx", state: "idle", activity: "Ran npm test (2 failing)", ...over });
  const stall: Stall = { sessionId: session.id, kind: facts.kind, forMs: 30 * 60_000, reason: "idle 30m", facts, fingerprint: "fp" };
  return renderToStaticMarkup(createElement(StalledTileFacts, {
    session,
    stall,
    onOpenRun: () => {},
    ...(dismiss ? { onDismiss: () => {} } : {}),
  }));
}

/** The fact sheet as label/value pairs, in the order the card prints them. */
function rows(html: string): string[] {
  return [...html.matchAll(/<dt>([^<]*)<\/dt><dd[^>]*>([^<]*)<\/dd>/g)].map((m) => `${m[1]}: ${m[2]!.replaceAll("&#x27;", "'")}`);
}

function actions(html: string): string[] {
  return [...html.matchAll(/data-inbox-action="([^"]+)"/g)].map((m) => m[1]!);
}

const parked = (over: Partial<Extract<StallFacts, { kind: "workflow-parked" }>>): StallFacts => ({
  kind: "workflow-parked", runId: "run-1", workflowName: "No-Mistakes", status: "waiting_for_session", round: 2,
  resubmittable: false, externalSource: null, unpushedCommits: 0, ...over,
});

test("open work: the task, the queue, the last activity, Foreman's note, Continue, Mark done and Dismiss", () => {
  const html = card({ kind: "unfinished-work", task: { id: "t1", title: "Fix login redirect loop" }, queueOpen: 3 }, { note: NOTE });
  assert.deepEqual(rows(html), [
    "Task: Fix login redirect loop",
    "Queue: 3 open items",
    "Last: Ran npm test (2 failing)",
    `Foreman: ${NOTE.brief}`,
  ]);
  assert.deepEqual(actions(html), ["continue", "mark-done", "dismiss"]);
  assert.match(html, /aria-label="Why amber-lynx stalled"/);
});

test("a queue alone: no Mark done, because there is no task to complete", () => {
  const html = card({ kind: "unfinished-work", task: null, queueOpen: 1 }, { activity: null });
  assert.deepEqual(rows(html), ["Queue: 1 open item", "Last: No activity reported"]);
  assert.deepEqual(actions(html), ["continue", "dismiss"]);
});

test("a parked run: what it waits on, the missing step, and the one fix that moves it, plus Open run", () => {
  const resubmit = card(parked({ resubmittable: true }));
  assert.deepEqual(rows(resubmit).slice(0, 2), [
    "Waiting: No-Mistakes round 2 never reopened",
    "Missing: a resubmission to reopen No-Mistakes round 2.",
  ]);
  assert.match(resubmit, /<dd class="is-warn">a resubmission/);
  assert.deepEqual(actions(resubmit), ["resubmit", "open-run", "dismiss"]);

  const push = card(parked({ status: "waiting_for_new_head", unpushedCommits: 2 }));
  assert.deepEqual(rows(push).slice(0, 2), [
    "Waiting: No-Mistakes round 2 waits for a pushed head",
    "Missing: a pushed head. 2 commits on this branch have not been pushed.",
  ]);
  assert.deepEqual(actions(push), ["push", "open-run", "dismiss"]);

  const nextTurn = card(parked({}));
  assert.equal(rows(nextTurn)[1], "Missing: the session's next turn, which reopens No-Mistakes round 2.");
  assert.deepEqual(actions(nextTurn), ["continue", "open-run", "dismiss"]);

  // A run an ensemble started moves only when that ensemble submits again: no fix is offered.
  const source = card(parked({ externalSource: "ensemble" }));
  assert.match(rows(source)[1]!, /^Missing: the ensemble that started No-Mistakes must submit again\./);
  assert.deepEqual(actions(source), ["open-run", "dismiss"]);
});

test("a session that cannot take a message gets no message fixes, and no Dismiss without a recorder", () => {
  const html = card(
    { kind: "unfinished-work", task: { id: "t1", title: "Fix login redirect loop" }, queueOpen: 0 },
    { state: "exited" },
    false,
  );
  assert.deepEqual(actions(html), ["mark-done"]);
});
