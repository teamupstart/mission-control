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
  runTriageRound,
  runTriageSentence,
  runTriageSteps,
} from "../src/web/workflows/run-model.ts";
import { LINE_STAGES, type LineStageId, type LineSummary } from "../src/shared/line.ts";
import type { WorkflowRunSummary } from "../src/shared/workflow.ts";
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

test("the Review drawer lists live runs, marks the ones stopped on a person, and orders by both", () => {
  const html = reviewDrawer([
    run({ id: "quiet", noteKey: "quiet-note", status: "running", updatedAt: 900 }),
    run({ id: "stuck", noteKey: "stuck-note", status: "blocked", updatedAt: 100 }),
    run({ id: "done", noteKey: "done-note", status: "completed", updatedAt: 999 }),
  ]);
  // Terminal runs are not "in flight" and the header counts what it lists.
  assert.match(html, /2 runs live/);
  assert.doesNotMatch(html, /done-note/);
  // Amber first even though it is the oldest: the drawer answers "is any of this mine".
  assert.ok(
    html.indexOf("stuck-note") < html.indexOf("quiet-note"),
    "a run waiting on a person sorts above a newer one that is not",
  );
  assert.match(html, /line-run-row is-waiting[\s\S]*?stuck-note/);
  assert.match(html, /1 waiting on you/);
});

test("a run's row names the live session, and falls back to the durable conversation key", () => {
  const named = reviewDrawer(
    [run({ sessionId: "s1", noteKey: "note-key" })],
    [mkSession({ id: "s1", name: "pane-fix" })],
  );
  assert.match(named, /<strong>pane-fix<\/strong>/);
  // A run outlives the session it reviewed. `noteKey` is the identity the run page itself
  // falls back to, so this is not a degraded case - it is the durable one.
  assert.match(reviewDrawer([run({ sessionId: null, noteKey: "note-key" })]), /note-key/);
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

test("the Review drawer offers escalation and never a mutation", () => {
  const html = reviewDrawer([run()]);
  for (const control of ["Bind a workflow…", "All runs", "Open run", "Close the Review drawer"]) {
    assert.ok(html.includes(control), `the drawer should offer ${control}`);
  }
  // Everything that CHANGES a run stays on the run page. A drawer that grew one of these
  // would be a second, smaller run controller with none of the confirmations.
  for (const mutation of ["Recheck", "Reset", "Cancel run", "Retry", "Disable"]) {
    assert.ok(!html.includes(mutation), `the drawer must not offer ${mutation}`);
  }
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

test("an intake with nothing configured teaches what the two machineries are", () => {
  const html = intakeDrawer([]);
  // Under `renderToStaticMarkup` no effect runs, so the sources read has not happened - which
  // is exactly the pre-fetch frame a person sees for one tick, and it must still read.
  assert.match(html, /0 sources · 0 missions/);
  assert.match(html, /files a task on a cadence/);
  assert.match(html, /Neither ever launches an agent/);
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
