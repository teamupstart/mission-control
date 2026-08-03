import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LineStrip } from "../src/web/components/LineStrip.tsx";
import { ReviewDrawer } from "../src/web/components/line/ReviewDrawer.tsx";
import { DecideDrawer } from "../src/web/components/line/DecideDrawer.tsx";
import { IntakeDrawer } from "../src/web/components/line/IntakeDrawer.tsx";
import {
  LINE_DRAWER_STAGES,
  isLineDrawerStage,
  nextLineDrawer,
  type LineDrawerStage,
} from "../src/web/lib/line-drawer.ts";
import { LINE_STAGE_TARGETS, lineStageHasDrawer } from "../src/web/lib/line-targets.ts";
import {
  blockedPhaseClause,
  runRemedy,
  runRowIdentity,
  runTriageRound,
  runTriageSentence,
  runTriageSteps,
} from "../src/web/workflows/run-model.ts";
import { LINE_STAGES, type LineStageId, type LineSummary } from "../src/shared/line.ts";
import type { WorkflowRunSummary } from "../src/shared/workflow.ts";
import {
  workflowRunAttentionParts,
  workflowRunAttentionSplit,
} from "../src/shared/workflow.ts";
import type { Session } from "../src/shared/types.ts";
import { LADDER_SUMMARY } from "./helpers/workflow-ladder.ts";
import { mkEnsembleSummary, mkSession } from "./helpers/session-fixture.ts";
import { mkSchedule } from "./helpers/schedule-fixture.ts";

/**
 * The Line's drawers: the state machine, the projections, and the markup shape.
 *
 * Split from `line-strip-render.test.ts` because the claims are different in kind. The strip
 * renders a payload; a drawer PROJECTS one - it decides which runs are live, which of them
 * want a person, and what four chips say about a run whose graph it cannot see. Those are
 * rules, and rules spelled inline in JSX can only be checked by rendering markup and reading
 * it back, which is the thing this repository keeps refusing to do.
 *
 * What is NOT here: that a click opens the panel and `esc` closes it, that the board is still
 * below, and that the body scrolls at three rows. The first two are wiring only a browser can
 * see (`e2e/specs/line-drawers.spec.ts`) and the third is used height, which only a laid-out
 * engine can measure (`line-drawer-electron.test.ts`).
 *
 * createElement, not JSX, because the runner's glob only matches .test.ts.
 */

const run = (over: Partial<WorkflowRunSummary> = {}): WorkflowRunSummary => ({
  ...LADDER_SUMMARY,
  ...over,
});

const reviewDrawer = (
  runs: WorkflowRunSummary[],
  sessions: Session[] = [],
): string =>
  renderToStaticMarkup(createElement(ReviewDrawer, {
    runs,
    sessions,
    onClose: () => {},
    onOpenRun: () => {},
    onOpenAllRuns: () => {},
    onBindWorkflow: () => {},
    onOpenEnsemble: () => {},
  }));

// ---------------------------------------------------------------------------
// The state machine
// ---------------------------------------------------------------------------

test("a stage toggles its own drawer and swaps for anyone else's", () => {
  assert.equal(nextLineDrawer(null, "review"), "review");
  // The same stage twice closes. This is the half a "set the open stage" handler gets wrong,
  // and the symptom is a drawer you cannot dismiss from the button that opened it.
  assert.equal(nextLineDrawer("review", "review"), null);
  // A different stage swaps IN PLACE - never close-then-open, which would flash the board up
  // and back down between two panels of the same height.
  assert.equal(nextLineDrawer("review", "decide"), "decide");
  assert.equal(nextLineDrawer("decide", "intake"), "intake");
});

test("exactly the drawer stages own drawers, and the table and the predicate agree", () => {
  // Two sources could disagree here: the list of stages that HAVE a drawer, and the target
  // table that says where a click goes. A stage in the list but routed elsewhere would
  // announce `aria-expanded` on a button that navigates.
  for (const stage of LINE_STAGES) {
    const target = LINE_STAGE_TARGETS[stage];
    const listed = isLineDrawerStage(stage);
    assert.equal(
      lineStageHasDrawer(stage),
      listed && target.kind === "drawer",
      `${stage} disagrees between the drawer list and the target table`,
    );
    if (target.kind === "drawer") {
      assert.equal(target.stage, stage, `${stage} opens ${target.stage}'s drawer`);
      assert.ok(listed, `${stage} routes to a drawer but is not a drawer stage`);
    }
  }
  assert.deepEqual([...LINE_DRAWER_STAGES], ["intake", "review", "decide"]);
  // The other three still GO somewhere. A stage that quietly did nothing would be a button
  // that highlights on hover and answers nothing.
  for (const stage of LINE_STAGES.filter((s) => !isLineDrawerStage(s))) {
    assert.notEqual(LINE_STAGE_TARGETS[stage].kind, "drawer");
  }
});

test("the re-homed routes are what the navigating stages point at", () => {
  // Shipped is the one stage that still carries a route, and it must be the NEW spelling:
  // a stale `#/workflows/runs` here would be a redirect on every click, forever.
  const shipped = LINE_STAGE_TARGETS.shipped;
  assert.equal(shipped.kind, "route");
  if (shipped.kind !== "route") return;
  assert.deepEqual(shipped.route, { page: "runs", filters: { status: "completed" } });
});

// ---------------------------------------------------------------------------
// The strip's disclosure
// ---------------------------------------------------------------------------

const strip = (openStage: LineStageId | null): string =>
  renderToStaticMarkup(createElement(LineStrip, {
    summary: null as LineSummary | null,
    openStage,
    onStage: () => {},
  }));

test("only the stages that open something announce that they can", () => {
  const closed = strip(null);
  // Three expandable, and they say so while closed too - a control that only grows
  // `aria-expanded` once it is open reads as static until you press it.
  assert.equal([...closed.matchAll(/aria-expanded="false"/g)].length, LINE_DRAWER_STAGES.length);
  assert.doesNotMatch(closed, /aria-expanded="true"/);
  // And nothing points at a panel that is not on the page.
  assert.doesNotMatch(closed, /aria-controls/);
});

test("the open stage is expanded, points at the drawer, and is the only one marked", () => {
  const open = strip("review");
  assert.equal([...open.matchAll(/aria-expanded="true"/g)].length, 1);
  assert.match(open, /aria-label="Review[^>]*aria-controls="line-drawer"/);
  assert.equal([...open.matchAll(/line-stage tone-\w+ is-open/g)].length, 1);
  // Working clears the filter rather than opening anything: it must not claim otherwise.
  assert.doesNotMatch(open, /aria-expanded="[^"]*"[^>]*aria-label="Working/);
});

// ---------------------------------------------------------------------------
// Review: the triage projection of a run summary
// ---------------------------------------------------------------------------

test("the compact pipeline is drawn from what a summary can actually prove", () => {
  // Two chips for a plain review: evidence is captured and reviewers are working. No action
  // chip and no Inspector chip, because a SUMMARY does not carry the graph - drawing a grey
  // "Session action" on every run would put a stage on screen that this workflow may not have.
  assert.deepEqual(runTriageSteps(run()).map((s) => [s.key, s.status.label]), [
    ["evidence", "Evidence"],
    ["reviewers", "2 reviewing"],
  ]);
  assert.equal(runTriageSteps(run({ status: "capturing" }))[0]!.status.label, "Capturing");

  // A waiting action earns its chip, and the chip is the wait's own word rather than the
  // run's status - "Needs you" and "Waiting for a session action" are different grains.
  const waiting = runTriageSteps(run({
    status: "waiting_for_action",
    actionWait: "needs_operator",
    activePersonaNames: [],
  }));
  assert.deepEqual(waiting.map((s) => s.key), ["evidence", "reviewers", "action"]);
  assert.equal(waiting.at(-1)!.status.label, "Needs you");

  // An Inspector gate earns the fourth.
  const gated = runTriageSteps(run({ gate: "waiting_inspector", activePersonaNames: [] }));
  assert.deepEqual(gated.map((s) => s.key), ["evidence", "reviewers", "inspector"]);
  assert.equal(gated.at(-1)!.status.label, "Waiting for Inspector");
});

test("a skipped review round is green and degraded, never plain green", () => {
  // `degraded` is the flag that lets a chip be green without claiming the reviewers agreed:
  // an Inspector-repair round advanced without them running at all.
  const skipped = runTriageSteps(run({ bypassedPersonaReview: true }))[1]!.status;
  assert.equal(skipped.tone, "passed");
  assert.equal(skipped.degraded, true);
  assert.match(skipped.tooltip ?? "", /Inspector/);

  const failed = runTriageSteps(run({ failedPersonaCount: 2, activePersonaNames: [] }))[1]!.status;
  assert.deepEqual([failed.tone, failed.label], ["failed", "2 reviewers failed"]);
  assert.equal(
    runTriageSteps(run({ failedPersonaCount: 1, activePersonaNames: [] }))[1]!.status.label,
    "1 reviewer failed",
  );
});

test("the row's sentence says only what the chips beside it cannot", () => {
  assert.equal(
    runTriageSentence(run()),
    "Reviewing · Test Evidence Auditor, Documentation Steward running",
  );
  // The chip has the count; the names are what a narrow row's tooltip cannot be reached for.
  assert.equal(runTriageSentence(run({ activePersonaNames: [] })), "Reviewing");
  // An uncertain delivery is the one state where doing nothing is the wrong answer, and no
  // chip above owns it.
  assert.match(
    runTriageSentence(run({ activePersonaNames: [], uncertainDeliveryCount: 1 })),
    /1 uncertain delivery$/,
  );
  assert.match(
    runTriageSentence(run({ activePersonaNames: [], uncertainDeliveryCount: 2 })),
    /2 uncertain deliveries$/,
  );
});

test("the round line prints a budget only once one has been spent", () => {
  // The denominator is the budget itself: the manager blocks at `round > maxRepairRounds`,
  // so that number IS the last round a run can spend.
  assert.equal(runTriageRound(run({ round: 3, maxRepairRounds: 5 })), "round 3/5");
  assert.equal(runTriageRound(run({ round: 1, maxRepairRounds: 5 })), "round 1");
});

test("the Review drawer lists live runs, tones stopped apart from your turn, and orders by both", () => {
  const html = reviewDrawer([
    run({ id: "quiet", noteKey: "quiet-note", status: "running", updatedAt: 900 }),
    run({ id: "stuck", noteKey: "stuck-note", status: "blocked", updatedAt: 100 }),
    run({
      id: "yours",
      noteKey: "yours-note",
      status: "waiting_for_action",
      actionWait: "needs_operator",
      activePersonaNames: [],
      updatedAt: 50,
    }),
    run({ id: "done", noteKey: "done-note", status: "completed", updatedAt: 999 }),
  ]);
  // Terminal runs are not "in flight" and the header counts what it lists.
  assert.match(html, /3 runs live/);
  assert.doesNotMatch(html, /done-note/);
  // Your turn first even though it is the oldest of the three, then the stopped one, then the
  // one that is nobody's problem yet. The drawer answers "is any of this mine" before it
  // answers "is any of this dead".
  assert.ok(
    html.indexOf("yours-note") < html.indexOf("stuck-note"),
    "a run waiting on a decision sorts above one that has already stopped",
  );
  assert.ok(
    html.indexOf("stuck-note") < html.indexOf("quiet-note"),
    "a stopped run sorts above a newer one that is running fine",
  );
  // Two edges, two meanings. Amber used to carry both, which on a fleet of blocked runs is a
  // colour that means nothing.
  assert.match(html, /line-run-row is-waiting[\s\S]*?yours-note/);
  assert.match(html, /line-run-row is-blocked[\s\S]*?stuck-note/);
  // And the header says the same two meanings as two numbers. The shared predicate still
  // counts both tiers - one plus one is the two it always was - but "2 waiting on you" over
  // one dead run and one live question was the aggregation that made the figure worthless.
  assert.match(html, /1 needs you · 1 stalled/);
  assert.doesNotMatch(html, /waiting on you/);
});

test("the header's split is the strip's split, to the word", () => {
  // `foldReview`'s doc comment legislates it: a strip that says one thing over a drawer that
  // says another is the surface arguing with itself. Both read
  // `workflowRunAttentionParts`, so this pins the drawer's half of that contract - the fold's
  // half is `line-summary-fold.test.ts`.
  const runs = [
    run({ id: "a", status: "blocked", phase: "session_disappeared", activePersonaNames: [] }),
    run({ id: "b", status: "blocked", phase: "round_limit", activePersonaNames: [] }),
    run({
      id: "c",
      status: "waiting_for_action",
      actionWait: "needs_operator",
      activePersonaNames: [],
    }),
  ];
  assert.equal(
    workflowRunAttentionParts(workflowRunAttentionSplit(runs)).join(" · "),
    "1 needs you · 2 stalled",
  );
  assert.match(reviewDrawer(runs), /1 needs you · 2 stalled/);

  // A fleet with nothing stopped says neither half rather than "0 stalled".
  const quiet = reviewDrawer([run({ id: "q", status: "running" })]);
  assert.doesNotMatch(quiet, /stalled|needs you/);
  assert.doesNotMatch(quiet, /line-drawer-att/);
});

test("a run's row is named in three steps, and the GUID is the last of them", () => {
  const durable = { sessionName: "Fix Busy State for Diff Link" };
  // 1. The live session, so a renamed session reads under its current name.
  assert.match(
    reviewDrawer(
      [run({ sessionId: "s1", noteKey: "note-key", ...durable })],
      [mkSession({ id: "s1", name: "pane-fix" })],
    ),
    /<strong>pane-fix<\/strong>/,
  );
  // 2. The binding's captured title, which is the step that was missing. A run outlives the
  // session it reviewed, so this is the ONLY human name a blocked run has left - and falling
  // past it to the conversation key is why the drawer used to show thirty GUIDs.
  const orphaned = reviewDrawer([run({
    sessionId: null,
    noteKey: "claude:9f1c-4d2a",
    status: "blocked",
    phase: "session_disappeared",
    activePersonaNames: [],
    ...durable,
  })]);
  assert.match(orphaned, /<strong>Fix Busy State for Diff Link<\/strong>/);
  assert.doesNotMatch(orphaned, /9f1c-4d2a/);
  // 3. The conversation key, only when there is genuinely nothing else - and drawn as the
  // identifier it is rather than bold in the slot a title goes in.
  const nameless = reviewDrawer([run({ sessionId: null, noteKey: "claude:9f1c-4d2a" })]);
  assert.match(nameless, /<span class="line-run-id">claude:9f1c-4d2a<\/span>/);
  assert.doesNotMatch(nameless, /<strong>claude:9f1c-4d2a<\/strong>/);

  // And the same three steps, decided without rendering anything.
  const id = { sessionId: "s1", sessionName: "captured", noteKey: "note" };
  assert.deepEqual(runRowIdentity(id, "live"), { name: "live", isIdentifier: false });
  assert.deepEqual(runRowIdentity(id, null), { name: "captured", isIdentifier: false });
  assert.deepEqual(
    runRowIdentity({ ...id, sessionName: undefined }, null),
    { name: "note", isIdentifier: true },
  );
  // A live name is only reachable through a session id. A run whose binding was orphaned has
  // none, so a stale entry under some other key must not name it.
  assert.deepEqual(
    runRowIdentity({ ...id, sessionId: null }, "live"),
    { name: "captured", isIdentifier: false },
  );
});

test("a stopped run's sentence states its cause, and an unmapped cause is still readable", () => {
  assert.equal(blockedPhaseClause("session_disappeared"), "session gone");
  assert.equal(blockedPhaseClause("round_limit"), "out of rounds");
  assert.equal(blockedPhaseClause("infrastructure_error"), "provider call failed");
  // `phase` is a free string, not a union - `orphanBinding` and every `setRunState` caller
  // write their own code into it. An unmapped one has to degrade to readable text, using the
  // same fallback `alerts.ts` prints reasons with, or two surfaces disagree about one field.
  assert.equal(blockedPhaseClause("some_future_reason"), "some future reason");

  const stopped = run({ status: "blocked", phase: "session_disappeared", activePersonaNames: [] });
  assert.equal(runTriageSentence(stopped), "Blocked · session gone");
  // The one parked state that is not a block: reattach leaves the run waiting deliberately,
  // because re-sending into a fresh pane unasked is what the delivery model refuses to do.
  assert.equal(
    runTriageSentence(run({
      status: "waiting_for_session",
      phase: "reattached_resubmit_required",
      activePersonaNames: [],
    })),
    "Waiting for the session · reattached",
  );
  // Every other status is byte-for-byte what it was: a run that is still moving has no cause
  // to state, and a reason printed on every row is furniture rather than information.
  assert.equal(
    runTriageSentence(run({ status: "waiting_for_pr", activePersonaNames: [] })),
    "Waiting for a pull request",
  );
});

test("an orphaned run's reviewers read as stopped, not as a queue that is about to move", () => {
  // `orphanBinding` cancels every queued and retrying attempt on its way past, which is
  // exactly why `activePersonaNames` is empty here. Amber "Reviewers" on that row promised a
  // queue that will never move; grey says what happened.
  const chip = runTriageSteps(run({
    status: "blocked",
    phase: "session_disappeared",
    activePersonaNames: [],
  }))[1]!.status;
  assert.deepEqual([chip.tone, chip.label], ["stopped", "Reviewers stopped"]);
  // A reviewer that genuinely returned a failing verdict still gets the blame it earned.
  assert.equal(
    runTriageSteps(run({ status: "blocked", failedPersonaCount: 1, activePersonaNames: [] }))[1]!
      .status.label,
    "1 reviewer failed",
  );
  // And a live run's waiting chip is untouched.
  assert.equal(
    runTriageSteps(run({ status: "running", activePersonaNames: [] }))[1]!.status.label,
    "Reviewers",
  );
});

test("a remedy is offered only where the summary proves the daemon would accept it", () => {
  const blocked = (phase: string, over = {}) =>
    runRemedy(run({ status: "blocked", phase, activePersonaNames: [], ...over }));

  // The two blocks nothing argument-free revives: reattaching needs a session picker and a
  // bigger repair budget is a binding edit, so what the row offers is the other honest move.
  assert.equal(blocked("session_disappeared")?.kind, "dismiss");
  assert.equal(blocked("round_limit")?.kind, "dismiss");
  assert.match(blocked("session_disappeared")!.path, /\/cancel$/);
  // Destructive, so it confirms - and it confirms in the run page's own words rather than in
  // a second wording for the same act.
  assert.equal(blocked("session_disappeared")!.confirm?.title, "Cancel this run");
  assert.equal(blocked("session_disappeared")!.confirm?.danger, true);
  assert.match(
    runRemedy(run({ status: "blocked", phase: "round_limit" }), "Durable task completion")!
      .confirm!.body,
    /Durable task completion/,
  );

  // Retry is available for exactly the phase `manager.retry` accepts, and it sends no
  // `nodeAttemptId` - that comes off run detail, and omitting it makes the daemon pick the
  // newest errored attempt, which is the run page's own default.
  const retry = blocked("infrastructure_error");
  assert.equal(retry?.kind, "retry");
  assert.deepEqual(retry?.body, {});
  assert.equal(retry?.confirm, null);

  // Blocked on a DECISION is not blocked on a button. The row still says why.
  for (const phase of ["inspector_findings", "delivery_uncertain", "inspector_pr_closed"]) {
    assert.equal(blocked(phase), null, `${phase} has no argument-free remedy`);
  }

  // Reattached and parked: resubmit, and only while the summary proves the binding is still
  // attached, the budget is unspent, and nobody else owns the round.
  const reattached = (over = {}) => runRemedy(run({
    status: "waiting_for_session",
    phase: "reattached_resubmit_required",
    sessionId: "s1",
    round: 2,
    maxRepairRounds: 5,
    ...over,
  }));
  assert.equal(reattached()?.kind, "resubmit");
  assert.equal(reattached({ sessionId: null }), null);
  assert.equal(reattached({ round: 6 }), null);
  assert.equal(
    reattached({ externalSource: { kind: "ensemble", sourceId: "e1", createdAt: 1 } }),
    null,
  );

  // Restart is offered for the one state `manager.restartFull` genuinely accepts from a
  // summary. It is deliberately NOT offered on a round-limit block: `restartFull` refuses
  // when `round > maxRepairRounds`, and that inequality IS the definition of that block, so
  // the button could never once have succeeded there.
  const restart = runRemedy(run({ status: "waiting_for_new_head", round: 2, maxRepairRounds: 5 }));
  assert.equal(restart?.kind, "restart-full");
  assert.equal(restart?.confirm?.requirePhrase, "RESTART FULL WORKFLOW");
  assert.deepEqual(restart?.body, { confirmation: "RESTART FULL WORKFLOW" });
  assert.match(restart!.label, /…$/, "the ellipsis is the promise that a dialog follows");
  assert.equal(runRemedy(run({ status: "waiting_for_new_head", round: 6, maxRepairRounds: 5 })), null);

  // A run that is simply working owes nobody anything.
  assert.equal(runRemedy(run({ status: "running" })), null);
});

test("an ensemble handoff wears its provenance, and an operator's own run does not", () => {
  const handoff = reviewDrawer([run({
    externalSource: { kind: "ensemble", sourceId: "ens-42", createdAt: 5 },
  })]);
  assert.match(handoff, /class="line-run-prov"/);
  assert.match(handoff, /from an ensemble/);
  // Provenance LEADS the line: "this is not a run you started" changes how the rest reads.
  assert.ok(
    handoff.indexOf("from an ensemble") < handoff.indexOf("No-Mistakes Review"),
    "provenance comes before the workflow name",
  );
  assert.doesNotMatch(reviewDrawer([run()]), /line-run-prov/);
});

test("the Review drawer acts only where the summary proves a run is stopped", () => {
  // THE REVISED RULE, and this is the test that codifies it. It replaces "never a mutation",
  // which was written when every row was a live run making progress and the honest answer to
  // "what do I do about this" was "read it on the run page". That does not survive thirty
  // rows whose sessions were removed: a triage surface that can only describe a dead run is
  // not triage. What is asserted now is the BOUNDARY, because the boundary is the point.
  const escalation = reviewDrawer([run()]);
  for (const control of ["Bind a workflow…", "All runs", "Open run", "Close the Review drawer"]) {
    assert.ok(escalation.includes(control), `the drawer should offer ${control}`);
  }
  // A run that is working is offered nothing, so no row grew a control by default.
  for (const mutation of ["Dismiss", "Retry", "Resubmit", "Restart"]) {
    assert.ok(!escalation.includes(mutation), `a live run must not be offered ${mutation}`);
  }

  const stopped = reviewDrawer([
    run({
      id: "gone",
      sessionId: null,
      sessionName: "Fix Busy State for Diff Link",
      status: "blocked",
      phase: "session_disappeared",
      activePersonaNames: [],
    }),
    run({
      id: "provider",
      sessionName: "Add E Keybinding",
      status: "blocked",
      phase: "infrastructure_error",
      activePersonaNames: [],
    }),
  ]);
  assert.match(stopped, /class="btn btn-remedy"[^>]*>Dismiss</);
  assert.match(stopped, /class="btn btn-remedy"[^>]*>Retry</);
  // The remedy leads and "Open run" follows it: reading the whole run is the slower answer
  // once a faster correct one is on the row.
  assert.ok(stopped.indexOf(">Dismiss<") < stopped.indexOf(">Open run<"));

  // The picker-shaped actions stay out, and they stay out for the reason they always did -
  // each needs an argument the summary does not carry and a form the row has no room for.
  // An assertion that the drawer still REFUSES these is what stops the next change eroding
  // the rule into "the run page, but smaller".
  for (const excluded of ["Reattach", "Resolve", "Disable", "Recheck", "Mark delivered"]) {
    assert.ok(!stopped.includes(excluded), `the drawer must not offer ${excluded}`);
  }
});

test("three runs stopped for one reason draw one bar; two draw two rows", () => {
  const gone = (id: string, name: string) => run({
    id,
    noteKey: `${id}-note`,
    sessionId: null,
    sessionName: name,
    status: "blocked",
    phase: "session_disappeared",
    activePersonaNames: [],
  });

  // Two is two rows, with their chips, their round counters and a `Dismiss` each. A bar here
  // would save one line and cost the reader all six of those facts.
  const pair = reviewDrawer([gone("a", "Fix Busy State"), gone("b", "Add E Keybinding")]);
  assert.doesNotMatch(pair, /line-group/);
  assert.equal([...pair.matchAll(/class="line-run-row/g)].length, 2);

  const pile = reviewDrawer([
    gone("a", "Fix Busy State"),
    gone("b", "Add E Keybinding"),
    gone("c", "Review a UI Component"),
  ]);
  // One bar. The reason once, the count once, and - collapsed - not one of the three rows.
  assert.equal([...pile.matchAll(/<li class="line-group /g)].length, 1);
  assert.doesNotMatch(pile, /class="line-run-row/);
  assert.match(pile, /<strong>3 runs · session gone<\/strong>/);
  // The members are named, by the same three steps a row names itself by, so the bar can
  // never list GUIDs where its rows would have listed titles.
  assert.match(pile, /Fix Busy State · Add E Keybinding · Review a UI Component/);
  assert.doesNotMatch(pile, /a-note|b-note|c-note/);
  // The whole pile is stopped, so the bar wears the row's own red edge rather than a fourth
  // treatment a reader has to learn.
  assert.match(pile, /class="line-group is-blocked"/);
});

test("the bar's disclosure and its batch are both reachable by name", () => {
  const pile = reviewDrawer(Array.from({ length: 30 }, (_, i) => run({
    id: `r${i}`,
    noteKey: `r${i}-note`,
    sessionId: null,
    sessionName: `Run ${i}`,
    status: "blocked",
    phase: "session_disappeared",
    activePersonaNames: [],
    updatedAt: 1000 - i,
  })));
  // The disclosure is icon-only, which is the one shape free to carry a spelled-out
  // accessible name without contradicting a visible label - and it says what is behind it.
  assert.match(pile, /aria-expanded="false" aria-label="30 runs blocked, session gone"/);
  // The bar counts thirty and names three of them, so the row is one line whatever the pile.
  assert.match(pile, /<strong>30 runs · session gone<\/strong>/);
  assert.match(pile, /Run 0 · Run 1 · Run 2 · \+27/);
  // The batch's name is unique per bar: two piles on one fleet would otherwise offer two
  // controls a person - or a spec - cannot tell apart.
  assert.match(pile, /aria-label="Dismiss all 30 runs blocked, session gone"/);
  assert.match(pile, /class="btn btn-remedy"[^>]*>Dismiss all</);
});

test("a bar with no argument-free remedy carries no control, and still says why", () => {
  // Blocked on a DECISION is not blocked on a button, at the pile's grain exactly as at the
  // row's. The bar still earns its place: it says the reason once instead of five times.
  const findings = reviewDrawer(Array.from({ length: 5 }, (_, i) => run({
    id: `r${i}`,
    noteKey: `r${i}-note`,
    sessionName: `Run ${i}`,
    status: "blocked",
    phase: "inspector_findings",
    activePersonaNames: [],
  })));
  assert.match(findings, /<strong>5 runs · Inspector findings<\/strong>/);
  assert.doesNotMatch(findings, /Dismiss all/);
});

test("a live run and a run waiting on you are never folded away", () => {
  const html = reviewDrawer([
    run({
      id: "yours",
      noteKey: "yours-note",
      status: "waiting_for_action",
      actionWait: "needs_operator",
      activePersonaNames: [],
      updatedAt: 5,
    }),
    ...Array.from({ length: 3 }, (_, i) => run({
      id: `gone${i}`,
      noteKey: `gone${i}-note`,
      sessionName: `Gone ${i}`,
      status: "blocked",
      phase: "session_disappeared",
      activePersonaNames: [],
      updatedAt: 100 + i,
    })),
  ]);
  // The row a person came here for is still a row, still first, still amber.
  assert.match(html, /line-run-row is-waiting[\s\S]*?yours-note/);
  assert.equal([...html.matchAll(/class="line-run-row/g)].length, 1);
  assert.equal([...html.matchAll(/<li class="line-group /g)].length, 1);
  // And the header counts the two jobs apart - one to answer, three that are simply dead.
  assert.match(html, /1 needs you · 3 stalled/);
});

test("an empty Review drawer says what would fill it", () => {
  const html = reviewDrawer([]);
  assert.match(html, /0 runs live/);
  assert.match(html, /line-drawer-empty/);
  assert.match(html, /Bind a workflow/);
  assert.doesNotMatch(html, /line-drawer-att/);
});

// ---------------------------------------------------------------------------
// Decide: the condensed dossier
// ---------------------------------------------------------------------------

const decideDrawer = (summaries: Parameters<typeof mkEnsembleSummary>[0][]): string =>
  renderToStaticMarkup(createElement(DecideDrawer, {
    summaries: summaries.map((over) => mkEnsembleSummary(over)),
    attentionCount: 0,
    now: 601_000,
    onClose: () => {},
    onOpenEnsemble: () => {},
    onOpenAllEnsembles: () => {},
  }));

test("the Decide drawer states what each run wants next, in the operator's terms", () => {
  const html = decideDrawer([
    { id: "a", title: "Racing", membersReady: 1, maxMembers: 3, createdAt: 1000 },
    { id: "b", title: "Blocked", membersNeedingInput: 2, attention: true, createdAt: 1000 },
  ]);
  // The status chip prints the engine's word; the state column says what it means for you.
  assert.match(html, /1\/3 candidates in/);
  assert.match(html, /2 candidates need you/);
  // Elapsed comes from the injected clock, so this is a fact about the render and not the day.
  assert.match(html, /10m 0s elapsed/);
});

test("an ensemble awaiting an answer sorts first and wears the decisive verb", () => {
  const html = decideDrawer([
    { id: "racing", title: "Still racing", updatedAt: 9000 },
    { id: "answer", title: "Wants an answer", status: "awaiting_decision", updatedAt: 10 },
  ]);
  assert.ok(
    html.indexOf("Wants an answer") < html.indexOf("Still racing"),
    "the run that stopped for you comes first, whatever the timestamps say",
  );
  assert.match(html, />Decide</);
  assert.match(html, />Open full dossier</);
  assert.match(html, /waiting for your decision/);
});

test("the Decide drawer lists only live runs and escalates rather than deciding", () => {
  const html = decideDrawer([
    { id: "live", title: "Live one" },
    { id: "done", title: "Finished one", status: "completed" },
  ]);
  assert.match(html, /1 ensemble live/);
  assert.doesNotMatch(html, /Finished one/);
  // The decision itself is one-shot and lives on the full page with its confirmation. The
  // drawer carries the verb and the link, never the form.
  assert.doesNotMatch(html, /<textarea/);
  assert.doesNotMatch(html, /rationale/i);
});

// ---------------------------------------------------------------------------
// Intake: missions and sources
// ---------------------------------------------------------------------------

const intakeDrawer = (schedules: Parameters<typeof mkSchedule>[0][]): string =>
  renderToStaticMarkup(createElement(IntakeDrawer, {
    schedules: schedules.map((over) => mkSchedule(over)),
    now: 1_000_000,
    onClose: () => {},
    onOpenMissions: () => {},
    onOpenTaskSources: () => {},
  }));

test("the Intake drawer reads a mission's cadence, its next firing, and its health", () => {
  const html = intakeDrawer([
    { id: "m1", name: "Nightly sweep", expression: "0 3 * * *", nextRunAt: 1_000_000 + 3 * 3600_000 },
    { id: "m2", name: "Paused one", enabled: false },
    { id: "m3", name: "Ill one", health: "attention" },
  ]);
  assert.match(html, /0 3 \* \* \* · next in 3h/);
  assert.match(html, /paused/);
  assert.match(html, /needs attention/);
  // Health is the daemon's derivation, and the row that carries it is the amber one.
  assert.match(html, /line-intake-row is-waiting[\s\S]*?Ill one/);
  assert.match(html, /1 needs a look/);
});

test("the Intake drawer links out rather than editing, and archived missions are gone", () => {
  const html = intakeDrawer([
    { id: "m1", name: "Live one" },
    { id: "m2", name: "Archived one", archivedAt: 5 },
  ]);
  assert.doesNotMatch(html, /Archived one/);
  assert.match(html, /Open recurring missions/);
  assert.match(html, /Open task sources in Settings/);
  assert.doesNotMatch(html, /<input/, "nothing is edited in the drawer");
});

// Under `renderToStaticMarkup` no effect runs, so every case in this file sees the drawer's
// PRE-FETCH frame - which is a real frame a person sees for a tick, and the one the three
// source states are easiest to get wrong in.
test("before the sources read lands, the drawer counts no sources and claims no absence", () => {
  const html = intakeDrawer([]);
  // Not "0 sources". A zero an operator cannot tell from a real zero is worse than no figure:
  // this drawer's whole job is to say whether anything feeding the backlog is broken, and a
  // tidy "0" is the one answer it must never give while it does not know.
  assert.match(html, /sources loading… · 0 missions/);
  assert.doesNotMatch(html, /0 sources/);
  // And it must not assert the absence either - that sentence is a claim, and nothing has
  // come back to support it yet.
  assert.doesNotMatch(html, /Neither ever launches an agent/);
  assert.match(html, /Reading task sources…/);
});

test("a mission renders while the sources read is still out", () => {
  // One half being unknown is no reason to withhold the other.
  const html = intakeDrawer([{ id: "m1", name: "Nightly audit" }]);
  assert.match(html, /Nightly audit/);
  assert.match(html, /sources loading… · 1 mission/);
  assert.doesNotMatch(html, /Reading task sources…/);
});

// ---------------------------------------------------------------------------
// The frame every drawer wears
// ---------------------------------------------------------------------------

test("every drawer is one named region with one body and three ways out", () => {
  const frames: [LineDrawerStage, string][] = [
    ["review", reviewDrawer([run()])],
    ["decide", decideDrawer([{ id: "a" }])],
    ["intake", intakeDrawer([{ id: "m1" }])],
  ];
  for (const [stage, html] of frames) {
    const title = stage[0]!.toUpperCase() + stage.slice(1);
    assert.match(html, new RegExp(`aria-label="${title} drawer"`), `${stage} names its region`);
    // One id, because there is only ever one drawer - the strip's `aria-controls` is a
    // constant rather than a lookup, and two open drawers would break the three-row cap.
    assert.equal([...html.matchAll(/id="line-drawer"/g)].length, 1);
    assert.equal([...html.matchAll(/class="line-drawer-body"/g)].length, 1);
    assert.match(html, new RegExp(`aria-label="Close the ${title} drawer"`));
    // The keycap is on the button, so the third way out is discoverable from the first.
    assert.match(html, /<kbd>esc<\/kbd>/);
    // It takes focus as it opens, so it has to be focusable without joining the tab order.
    assert.match(html, /class="line-drawer" id="line-drawer" tabindex="-1"/);
  }
});
