/**
 * What is at stake: a Stuck row offers only the fixes that can work. A card that drew Mark done
 * over a queue (no task to complete), Resubmit over a run the manager refuses to resubmit, or
 * Tell it to push with nothing unpushed would send the operator into a refusal from the one
 * place meant to unstick the session. And no inbox card offers Cancel.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Stall, StallFacts } from "../src/shared/stall.ts";
import type { Session } from "../src/shared/types.ts";
import { interruptDone, parkedStep, StuckCard, stuckDetail } from "../src/web/components/StuckCard.tsx";
import { mkSession } from "./helpers/session-fixture.ts";

function stall(facts: StallFacts, reason = "idle 21m with work unfinished"): Stall {
  return { sessionId: "s1", kind: facts.kind, forMs: 21 * 60_000, reason, facts, fingerprint: "f" };
}

function draw(st: Stall, session: Session = mkSession({ id: "s1", state: "idle" })): string {
  return renderToStaticMarkup(createElement(StuckCard, {
    session,
    stall: st,
    context: null,
    subject: { name: "Fix the parser", colorId: null },
    onOpenSession: () => undefined,
    onOpenRun: () => undefined,
    onDismiss: () => undefined,
  }));
}

/** The registry action ids a card draws, in order. */
function actions(html: string): string[] {
  return [...html.matchAll(/data-inbox-action="([^"]+)"/g)].map((m) => m[1]!);
}

const task = { id: "t-1", title: "Fix the parser" };

test("a stall with an open task draws Continue and Mark done", () => {
  const html = draw(stall({ kind: "unfinished-work", task, queueOpen: 0 }));
  assert.deepEqual(actions(html), ["open-session", "dismiss", "continue", "mark-done", "message"]);
  assert.match(html, /idle 21m with work unfinished/);
  assert.match(html, /Idle with work open/);
  assert.match(html, /Open: the task &quot;Fix the parser&quot;\./);
});

test("a queue-only stall draws Continue and Open session and no Mark done", () => {
  const html = draw(stall({ kind: "unfinished-work", task: null, queueOpen: 3 }));
  assert.deepEqual(actions(html), ["open-session", "dismiss", "continue", "message"]);
  assert.match(html, /Open: 3 open queue items\. A queue&#x27;s items are handled in the session\./);
  assert.doesNotMatch(html, />Mark done</);
});

test("a parked run draws Resubmit only when it can be resubmitted, and push only with unpushed commits", () => {
  const parked = (over: Partial<Extract<StallFacts, { kind: "workflow-parked" }>>): StallFacts => ({
    kind: "workflow-parked", runId: "run-1", workflowName: "No-Mistakes Review",
    status: "waiting_for_session", round: 2, resubmittable: false, unpushedCommits: 0, externalSource: null, ...over,
  });
  // A self-resuming round that stalled: nothing to resubmit or push, so the next turn is asked for.
  const auto = draw(stall(parked({})));
  assert.deepEqual(actions(auto), ["open-session", "dismiss", "continue", "open-run", "message"]);
  assert.match(auto, /Missing step: the session&#x27;s next turn, which reopens No-Mistakes Review round 2\./);
  assert.deepEqual(
    actions(draw(stall(parked({ resubmittable: true })))),
    ["open-session", "dismiss", "resubmit", "open-run", "message"],
  );
  const head = draw(stall(parked({ status: "waiting_for_new_head", unpushedCommits: 2 })));
  assert.deepEqual(actions(head), ["open-session", "dismiss", "push", "open-run", "message"]);
  assert.match(head, />Tell it to push</);
  assert.match(head, /2 commits on this branch have not been pushed/);
  // A run an ensemble started: only its source can submit again, so the row offers neither
  // Resubmit nor Continue, says so, and keeps Open run.
  const external = draw(stall(parked({ externalSource: "ensemble" })));
  assert.deepEqual(actions(external), ["open-session", "dismiss", "open-run", "message"]);
  assert.match(external, /Missing step: the ensemble that started No-Mistakes Review must submit again\./);
  assert.doesNotMatch(external, /next turn, which reopens/);
  // The same run with unpushed commits: a push does not move a run waiting for the session, and
  // only the ensemble can submit it again, so the row says that and offers no push either.
  const externalUnpushed = draw(stall(parked({ externalSource: "ensemble", unpushedCommits: 3 })));
  assert.deepEqual(actions(externalUnpushed), ["open-session", "dismiss", "open-run", "message"]);
  assert.match(externalUnpushed, /Missing step: the ensemble that started No-Mistakes Review must submit again\./);
  assert.doesNotMatch(externalUnpushed, /Tell it to push|next turn, which reopens/);
  // An operator-started run waiting for the session with commits unpushed: its next turn is the
  // step, not a push.
  assert.deepEqual(
    actions(draw(stall(parked({ unpushedCommits: 3 })))),
    ["open-session", "dismiss", "continue", "open-run", "message"],
  );
  // Waiting for a head with nothing unpushed: new work has to be made, so Continue again.
  assert.deepEqual(
    actions(draw(stall(parked({ status: "waiting_for_new_head" })))),
    ["open-session", "dismiss", "continue", "open-run", "message"],
  );
});

test("a silent session draws Nudge and Interrupt; an escalation draws its note and a reply box", () => {
  const silent = draw(
    stall({ kind: "silent-working", activity: "Running npm test", quietSince: 0 }, "working but silent for 12m"),
    mkSession({ id: "s1", state: "working" }),
  );
  assert.deepEqual(actions(silent), ["open-session", "dismiss", "nudge", "stop", "message"]);
  assert.match(silent, />Interrupt</);
  assert.match(silent, /Last activity: Running npm test/);
  const escalated = draw(stall({ kind: "escalated", text: "Approve the migration?" }, "escalated to you 6m ago, still unanswered"));
  assert.deepEqual(actions(escalated), ["open-session", "dismiss", "message"]);
  assert.match(escalated, /Foreman escalated: Approve the migration\?/);
  assert.match(escalated, /aria-label="Reply to Fix the parser"/);
  assert.match(escalated, />Reply</);
});

test("a session that cannot take messages draws no message controls", () => {
  const html = draw(
    stall({ kind: "unfinished-work", task, queueOpen: 0 }),
    mkSession({ id: "s1", state: "idle", runtime: "terminal", terminals: [], tty: null }),
  );
  assert.deepEqual(actions(html), ["open-session", "dismiss", "mark-done"]);
});

test("a session that cannot take messages draws none of its rule's message controls", () => {
  // No pane and not embedded: `canMessage` is false, so every control that sends a message goes.
  const silentSession = mkSession({ id: "s1", state: "working", runtime: "terminal", terminals: [], tty: null });
  const idleSession = mkSession({ id: "s1", state: "idle", runtime: "terminal", terminals: [], tty: null });
  const silent = draw(stall({ kind: "silent-working", activity: "Running npm test", quietSince: 0 }, "working but silent for 12m"), silentSession);
  assert.doesNotMatch(silent, />Nudge</);
  assert.doesNotMatch(silent, /data-inbox-action="message"|<textarea/);
  const push = draw(stall({
    kind: "workflow-parked", runId: "r", workflowName: "W", status: "waiting_for_new_head",
    round: 1, resubmittable: false, unpushedCommits: 2, externalSource: null,
  }), idleSession);
  assert.deepEqual(actions(push), ["open-session", "dismiss", "open-run"]);
  assert.doesNotMatch(push, />Tell it to push</);
  const nextTurn = draw(stall({
    kind: "workflow-parked", runId: "r", workflowName: "W", status: "waiting_for_session",
    round: 1, resubmittable: false, unpushedCommits: 0, externalSource: null,
  }), idleSession);
  assert.deepEqual(actions(nextTurn), ["open-session", "dismiss", "open-run"]);
  const escalated = draw(stall({ kind: "escalated", text: "Approve the migration?" }, "escalated to you 6m ago, still unanswered"), idleSession);
  assert.deepEqual(actions(escalated), ["open-session", "dismiss"]);
  assert.doesNotMatch(escalated, />Reply<|<textarea/);
  // What does not send a message stays: the escalation still says what Foreman escalated.
  assert.match(escalated, /Foreman escalated: Approve the migration\?/);
});

test("no Stuck card offers Cancel", () => {
  for (const facts of [
    { kind: "unfinished-work", task, queueOpen: 1 },
    { kind: "silent-working", activity: null, quietSince: 0 },
    { kind: "escalated", text: null },
    { kind: "workflow-parked", runId: "r", workflowName: "W", status: "waiting_for_new_head", round: 1, resubmittable: true, unpushedCommits: 1, externalSource: null },
  ] satisfies StallFacts[]) {
    assert.doesNotMatch(draw(stall(facts), mkSession({ id: "s1", state: "working" })), /Cancel/i);
  }
});

test("a stall from a daemon without facts still names its reason and offers only safe controls", () => {
  const html = draw({ sessionId: "s1", kind: "unfinished-work", forMs: 1, reason: "idle 20m with work unfinished" });
  assert.match(html, /idle 20m with work unfinished/);
  assert.deepEqual(actions(html), ["open-session", "dismiss", "message"]);
});

test("each rule's detail line says what is open or missing", () => {
  assert.equal(stuckDetail({ kind: "unfinished-work", task, queueOpen: 1 }), 'Open: the task "Fix the parser" and 1 open queue item.');
  assert.equal(stuckDetail({ kind: "silent-working", activity: null, quietSince: 0 }), "It has reported no activity since it went quiet.");
  assert.equal(stuckDetail({ kind: "escalated", text: null }), "Foreman escalated a decision to you.");
  assert.equal(
    stuckDetail({ kind: "workflow-parked", runId: "r", workflowName: "W", status: "waiting_for_session", round: 2, resubmittable: true, unpushedCommits: 0, externalSource: null }),
    "Missing step: a resubmission to reopen W round 2.",
  );
});

test("a parked run's step is decided once, from its status, source and commits", () => {
  const base = {
    kind: "workflow-parked", runId: "r", workflowName: "W", round: 1,
    resubmittable: false, unpushedCommits: 0, externalSource: null,
  } as const;
  assert.equal(parkedStep({ ...base, status: "waiting_for_session", resubmittable: true }), "resubmit");
  assert.equal(parkedStep({ ...base, status: "waiting_for_new_head", unpushedCommits: 2 }), "push");
  assert.equal(parkedStep({ ...base, status: "waiting_for_new_head", unpushedCommits: 2, externalSource: "ensemble" }), "push");
  assert.equal(parkedStep({ ...base, status: "waiting_for_new_head" }), "next-turn");
  assert.equal(parkedStep({ ...base, status: "waiting_for_session", externalSource: "ensemble", unpushedCommits: 2 }), "source");
  assert.equal(parkedStep({ ...base, status: "waiting_for_session", unpushedCommits: 2 }), "next-turn");
});

test("Interrupt reports what the daemon actually did, and its tooltip says queued messages are dropped", () => {
  assert.equal(interruptDone({ ok: true, stoppedTurn: true, droppedQueued: 0 }), "Interrupted.");
  assert.equal(interruptDone({ ok: true, stoppedTurn: true, droppedQueued: 2 }), "Stopped, and dropped 2 queued messages.");
  assert.match(interruptDone({ ok: true, stoppedTurn: false }), /^That turn had already finished, so nothing was stopped/);
  const html = draw(
    stall({ kind: "silent-working", activity: null, quietSince: 0 }, "working but silent for 12m"),
    mkSession({ id: "s1", state: "working" }),
  );
  assert.doesNotMatch(html, /Queued messages stay queued/);
});
