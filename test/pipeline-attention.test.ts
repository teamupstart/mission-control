import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  PIPELINE_ACTION_INFO,
  PIPELINE_HALT_ACTIONS,
  PIPELINE_HALT_CLASSES,
  PIPELINE_HALT_CLASS_INFO,
  pipelineHaltRunbookLine,
  type PipelineHaltClass,
  type PipelineRun,
} from "../src/shared/pipeline.ts";
import { foldAttention, type AttentionItem } from "../src/web/lib/attention.ts";
import { AttentionInbox } from "../src/web/components/AttentionInbox.tsx";
import { SessionWorkflowsPane } from "../src/web/components/SessionWorkflowsPane.tsx";
import { mkSession } from "./helpers/session-fixture.ts";
import { withOverlayHost } from "./helpers/overlay-host.ts";

// A halted pipeline as a first-class thing waiting on a person, and the ladder that reads one.
//
// WHY THE INBOX HAS TO CARRY THESE. A halt is the state an external engine stops in when it
// cannot go further without a human, and it is the one obligation on the machine that has no
// session behind it: the engine stops dispatching, so the agent that hit the gate has usually
// exited by the time anyone looks. Before this the most definitively stuck thing an operator
// owned was the one thing the drain could not show them.

const REPO = "/repo/demo";

function mkRun(over: Partial<PipelineRun> = {}): PipelineRun {
  return {
    provider: "ai-conductor",
    repoRoot: REPO,
    slug: "fix-the-thing",
    worktree: `${REPO}/.worktrees/fix-the-thing`,
    tier: "L",
    track: "technical",
    steps: [
      { name: "worktree", state: "done" },
      { name: "build", state: "done" },
      { name: "build_review", state: "failed" },
    ],
    lastStep: "build_review",
    halt: { class: "needs-human", reason: "the build review found two blocking defects" },
    group: "halted",
    prUrl: null,
    costTokens: null,
    updatedAt: 5000,
    ...over,
  };
}

const fold = (runs: PipelineRun[]) =>
  foldAttention({ sessions: [], reviews: [], ensembles: [], pipelineRuns: runs });

const halts = (runs: PipelineRun[]): Extract<AttentionItem, { kind: "pipeline_halt" }>[] =>
  fold(runs).items.filter((item) => item.kind === "pipeline_halt");

test("a halted run becomes one row, carrying class, reason and runbook", () => {
  const result = fold([mkRun()]);
  assert.deepEqual(result.items.map((item) => item.kind), ["pipeline_halt"]);
  const [halt] = halts([mkRun()]);
  assert.equal(halt?.haltClass, "needs-human");
  assert.equal(halt?.reason, "the build review found two blocking defects");
  assert.equal(halt?.runbook, "Stalled or stuck feature - The halt refused a DECIDE entry");
  // The whole run, so the row can address it and phase 4 can attach verbs to it without
  // widening the payload underneath the surfaces already reading it.
  assert.equal(halt?.run.slug, "fix-the-thing");
  assert.equal(halt?.run.repoRoot, REPO);
});

test("a run that has not halted contributes nothing", () => {
  // The whole feature is off for a fleet with nothing stuck, and this is the assertion that
  // "projecting a run" and "owing an answer" are different states.
  assert.deepEqual(fold([mkRun({ halt: null, group: "building" })]).items, []);
  assert.equal(fold([mkRun({ halt: null, group: "building" })]).total, 0);
});

test("a fleet observing no engine folds exactly as it did before pipelines existed", () => {
  // `pipelineRuns` is optional for this reason and not for the caller's convenience: an
  // operator who has consented to nothing must get byte-identical behaviour, and the test
  // that proves it is the one that omits the field entirely.
  const session = mkSession({ id: "s-1", name: "Alpha" });
  const without = foldAttention({ sessions: [session], reviews: [], ensembles: [] });
  const withEmpty = foldAttention({
    sessions: [session],
    reviews: [],
    ensembles: [],
    pipelineRuns: [],
  });
  assert.deepEqual(withEmpty.items.map((i) => i.kind), without.items.map((i) => i.kind));
  assert.equal(withEmpty.total, without.total);
});

test("every halt class produces a row, with its own words and its own runbook section", () => {
  // The classes are an append-only tuple the engine's own marker writes into, so this walks
  // all of them rather than sampling: a class added to the vocabulary without a reading is a
  // row that says nothing about what the operator is being asked to do.
  for (const haltClass of PIPELINE_HALT_CLASSES) {
    const [halt] = halts([mkRun({ halt: { class: haltClass, reason: "stopped" } })]);
    assert.equal(halt?.haltClass, haltClass);
    assert.equal(halt?.runbook, pipelineHaltRunbookLine("ai-conductor", haltClass));
    assert.ok(PIPELINE_HALT_CLASS_INFO[haltClass].label.length > 0, haltClass);
    assert.ok(PIPELINE_HALT_CLASS_INFO[haltClass].blurb.length > 0, haltClass);
  }
});

test("halts are derived before the blocked-session backstop can claim anything", () => {
  // Order is the assertion. The backstop's job is to claim whatever no earlier section did,
  // so a halt derived after it would already have been drawn as "waiting on you" - a row
  // naming the agent rather than the run, offering to focus a card that has usually exited.
  const blocked = mkSession({ id: "s-blocked", name: "Beta", state: "awaiting_input" });
  const result = foldAttention({
    sessions: [blocked],
    reviews: [],
    ensembles: [],
    pipelineRuns: [mkRun()],
  });
  assert.deepEqual(result.items.map((item) => item.kind), ["pipeline_halt", "session_blocked"]);
});

test("the oldest halt leads, and the order is total", () => {
  // Draining top-to-bottom answers whoever has been waiting longest, like every other section.
  // Two runs stopped in the same millisecond break on the run key rather than on iteration
  // order, so two renders of one fleet cannot reshuffle the list under the operator.
  const older = mkRun({ slug: "older", updatedAt: 1000 });
  const newer = mkRun({ slug: "newer", updatedAt: 9000 });
  assert.deepEqual(halts([newer, older]).map((h) => h.run.slug), ["older", "newer"]);

  const tieA = mkRun({ slug: "aaa", updatedAt: 4000 });
  const tieB = mkRun({ slug: "bbb", updatedAt: 4000 });
  assert.deepEqual(halts([tieB, tieA]).map((h) => h.run.slug), ["aaa", "bbb"]);
  assert.deepEqual(halts([tieA, tieB]).map((h) => h.run.slug), ["aaa", "bbb"]);
});

test("each halt raises `to answer` by exactly one", () => {
  // The count is ANSWERS OWED, and a halt is one thing to go and do. Asserted because the
  // topbar segment and this list have to agree: a figure that counted rows differently from
  // the panel behind it is the disagreement this fold exists to prevent.
  assert.equal(fold([mkRun({ slug: "a" }), mkRun({ slug: "b" })]).total, 2);
});

test("the inbox row states the class, the reason, the runbook and a link to the run", () => {
  const html = renderToStaticMarkup(
    withOverlayHost(
      createElement(AttentionInbox, {
        fold: fold([mkRun()]),
        onClose: () => {},
        onOpenEnsemble: () => {},
        onOpenSession: () => {},
      }),
    ),
  );
  assert.match(html, /Pipeline halts/);
  assert.match(html, /fix-the-thing/);
  assert.match(html, /Needs a human/);
  assert.match(html, /the build review found two blocking defects/);
  assert.match(html, /Stalled or stuck feature/);
  // The deep link is an ADDRESS, so it survives a middle click into a second window - and it
  // is the phase 2 route rather than a hand-built hash.
  assert.match(html, /href="#\/runs\/pipeline\/[^"]+\/fix-the-thing"/);
});

test("a halt row offers the verbs its own class calls for, and no repository-wide ones", () => {
  // The inverse of what this file asserted through phase 3, when the row deliberately had no
  // controls at all. What replaced "no buttons" is not "every button": the verbs come from
  // `PIPELINE_HALT_ACTIONS`, so a row about one feature can never carry a verb that stops
  // every feature in the checkout.
  const row = (haltClass: PipelineHaltClass): string => {
    const html = renderToStaticMarkup(
      withOverlayHost(
        createElement(AttentionInbox, {
          fold: fold([mkRun({ halt: { class: haltClass, reason: "stopped" } })]),
          onClose: () => {},
          onOpenEnsemble: () => {},
          onOpenSession: () => {},
        }),
      ),
    );
    return html.slice(html.indexOf("inbox-halt"));
  };

  for (const haltClass of PIPELINE_HALT_CLASSES) {
    const html = row(haltClass);
    for (const action of PIPELINE_HALT_ACTIONS[haltClass]) {
      assert.match(html, new RegExp(PIPELINE_ACTION_INFO[action].label), `${haltClass}/${action}`);
    }
    // Never the daemon verbs, whatever the class. They act on the whole repository, and a
    // repository-wide stop reached from a row about one feature is the mis-click this list
    // must not offer.
    assert.doesNotMatch(html, /Start daemon|Stop daemon|Pause daemon|Resume daemon/, haltClass);
  }

  // A protected artifact is cleared by a ceremony rather than a verb, so its row carries the
  // console instead - and it is the only class that does.
  assert.match(row("protected-artifact"), /Reseal an artifact/);
  assert.doesNotMatch(row("needs-human"), /Reseal an artifact/);
});

// ---- the conversation window's ladder -----------------------------------------------------

const linked = mkSession({
  id: "s-driven",
  name: "driven",
  pipeline: { provider: "ai-conductor", repoRoot: REPO, slug: "fix-the-thing", step: "build" },
});

test("a correlated session's Workflows tab draws the pipeline ladder", () => {
  const html = renderToStaticMarkup(
    createElement(SessionWorkflowsPane, {
      run: null,
      session: linked,
      pipelineRun: mkRun({ halt: null, group: "building", lastStep: "build" }),
      onOpenRun: () => {},
      onOpenPipelineRun: () => {},
    }),
  );
  // The shared ladder grammar, not a lookalike: same panel, same rungs as the workflow ladder.
  assert.match(html, /wf-ladder-panel/);
  assert.match(html, /wf-ladder-rung/);
  assert.match(html, /fix-the-thing/);
  // Every phase of the engine's sequence, so a reader can see what has not started.
  for (const phase of ["SETUP", "UNDERSTAND", "DECIDE", "BUILD", "SHIP"]) {
    assert.match(html, new RegExp(phase), `${phase} is missing from the ladder`);
  }
  // The one fact this pane exists to deliver, in a word rather than only in styling.
  assert.match(html, /pipeline-ladder-current/);
  assert.match(html, /current/);
  assert.match(html, /Open in Runs/);
  // And the ordinary empty state is NOT what a correlated session gets.
  assert.doesNotMatch(html, /No workflow is bound to this session/);
});

test("a halted run says so above its rungs", () => {
  const html = renderToStaticMarkup(
    createElement(SessionWorkflowsPane, {
      run: null,
      session: linked,
      pipelineRun: mkRun(),
      onOpenRun: () => {},
      onOpenPipelineRun: () => {},
    }),
  );
  assert.match(html, /Needs a human/);
  assert.match(html, /the build review found two blocking defects/);
});

test("a correlated session whose run has not arrived still draws, and still links", () => {
  // The link rides the session's own frame and the projection is a separate collection, so a
  // card can know its slug a tick before the run does. A pane that waited would blink an
  // empty state at the operator on every reconnect.
  const html = renderToStaticMarkup(
    createElement(SessionWorkflowsPane, {
      run: null,
      session: linked,
      pipelineRun: null,
      onOpenRun: () => {},
      onOpenPipelineRun: () => {},
    }),
  );
  assert.match(html, /fix-the-thing/);
  assert.match(html, /has not reached this dashboard yet/);
  assert.match(html, /Open in Runs/);
});

test("an uncorrelated session's Workflows tab is exactly what it was", () => {
  // The regression that matters most on this pane: every session on a fleet observing no
  // engine has to render the workflow arm, empty state included.
  const html = renderToStaticMarkup(
    createElement(SessionWorkflowsPane, {
      run: null,
      session: mkSession({ id: "s-plain" }),
      onOpenRun: () => {},
    }),
  );
  assert.match(html, /No workflow is bound to this session/);
  assert.doesNotMatch(html, /pipeline-ladder/);
});

test("the runbook line names a document and the section that owns each class", () => {
  // Copied from ai-conductor's own `docs/runbooks/` rather than paraphrased, so a reader can
  // find the headings. One document owns every HALT there; the classes differ by section.
  assert.equal(
    pipelineHaltRunbookLine("ai-conductor", "protected-artifact"),
    "Stalled or stuck feature - The halt is a protected-artifact violation",
  );
  for (const haltClass of PIPELINE_HALT_CLASSES) {
    assert.match(
      pipelineHaltRunbookLine("ai-conductor", haltClass as PipelineHaltClass),
      /^Stalled or stuck feature/,
    );
  }
});
