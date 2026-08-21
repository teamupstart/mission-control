import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BoardView } from "../src/web/components/layouts/BoardView.tsx";
import type { SessionViewProps } from "../src/web/components/layouts/types.ts";
import type { Session } from "../src/shared/types.ts";
import type { WorkflowRunSummary } from "../src/shared/workflow.ts";
import { mkSession } from "./helpers/session-fixture.ts";
import type { SessionFilesController } from "../src/web/lib/sessionFiles.ts";

// The board tile is meant to be triaged WITHOUT opening it, so what's worth testing is the
// static markup of a tile with nothing selected: it must surface the live activity,
// workflow disclosure, and runtime meta with its context number. Rendered rather than driven through
// a browser - this dashboard's SSE stream blocks Chrome automation, and renderToStaticMarkup
// answers "what's in the tile" with no daemon and no flake. createElement, not JSX, because the
// runner's glob only matches .test.ts.

function props(sessions: Session[]): SessionViewProps {
  return {
    sessions,
    tasks: [],
    backlog: [],
    onEditTask: () => {},
    backlogPlan: null,
    selectedId: null,
    consoleZone: "rail",
    onConsoleZoneChange: () => {},
    onSelect: () => {},
    onCursorTo: () => {},
    onDeselect: () => {},
    detailId: null,
    onOpenReviews: () => {},
    onOpenDiff: () => {},
    onOpenFiles: () => {},
    onOpenFile: () => false,
    onOpenFilePath: () => {},
    fileTabRequest: null,
    conversationTabRequest: null,
    workflowsTabRequest: null,
    diffTabRequest: null,
    files: {} as SessionFilesController,
    onReset: () => {},
    onComplete: () => {},
    onKill: () => {},
    onKilled: () => {},
    resetNonces: {},
    registerEl: () => {},
    registerActions: () => {},
    registerLaunchers: () => {},
    registerFind: () => {},
    registerDetailScroll: () => {},
    registerReaderTab: () => {},
    renamingId: null,
    onRenameStart: () => {},
    onRenameClose: () => {},
    foremanMode: "dry-run",
    foremanEnabled: false,
    foremanAllowlist: [],
    inputReviewBySession: new Map<string, string>(),
    pendingReviewIds: new Set<string>(),
    reviews: [],
  };
}

function render(session: Session): string {
  return renderToStaticMarkup(createElement(BoardView, props([session])));
}

const workflowRun: WorkflowRunSummary = {
  id: "run",
  bindingId: "binding",
  workflowId: "workflow",
  workflowName: "No-Mistakes Review",
  workflowVersion: 4,
  sessionId: "session",
  noteKey: "note",
  status: "waiting_for_session",
  phase: "repair_wait",
  round: 2,
  maxRepairRounds: 5,
  activePersonaNames: [],
  failedPersonaCount: 1,
  bypassedPersonaReview: false,
  gate: "none",
  gatePrNumber: null,
  gateHeadShort: null,
  reviewPosture: null,
  uncertainDeliveryCount: 0,
  refusedDeliveryCount: 0,
  updatedAt: 10,
};

test("the keyboard-selected tile is marked without opening its console detail", () => {
  const session = mkSession();
  const selectedProps = { ...props([session]), selectedId: session.id };
  const html = renderToStaticMarkup(createElement(BoardView, selectedProps));
  assert.match(html, /class="tile [^"]*selected/);
  assert.match(html, /aria-current="true"/);
  assert.doesNotMatch(html, /class="board-col[^"]* is-rail/);
  assert.match(html, /class="board-detail" aria-hidden="true"/);
});

test("the tile shows what the session is doing right now", () => {
  const html = render(mkSession());
  assert.match(html, /tile-activity/);
  assert.match(html, /editing ConsoleDetail\.tsx/);
});

test("a bound workflow starts as an in-place Board disclosure, not a navigation flag", () => {
  const session = mkSession();
  const viewProps = {
    ...props([session]),
    workflowRunsBySession: new Map([[session.id, [{ ...workflowRun, sessionId: session.id }]]]),
    onOpenWorkflowRun: () => {},
  };
  const html = renderToStaticMarkup(createElement(BoardView, viewProps));

  assert.match(html, /tile-workflow-disclosure/);
  assert.match(html, /No-Mistakes Review/);
  assert.match(html, /Review changes/);
  assert.match(html, /Loading the current stage/);
  assert.match(
    html,
    /aria-label="Open No-Mistakes Review v4 workflow run: Review changes"/,
  );
  assert.match(html, /aria-expanded="false"/);
  // `v`, not the `e` this shipped with: the review queue's badge took `e` when it got a
  // chord of its own, and the disclosure moved rather than resolving to nothing.
  assert.match(html, /<kbd class="kb-hint">v<\/kbd>/);
  assert.match(html, /Show full workflow/);
  assert.doesNotMatch(html, /tf-workflow/);
});

test("a settled session omits the ticker rather than animating over a still session", () => {
  // Once a session settles, `activity` holds a status label ("idle", "ended (logout)"),
  // not a live action - and the ticker's glyph spins, which would misreport it as busy.
  for (const state of ["idle", "awaiting_input", "exited"] as const) {
    const html = render(mkSession({ state, activity: "idle" }));
    assert.doesNotMatch(html, /tile-activity/, `${state} should not carry a live ticker`);
  }
});

test("the runtime row carries the context percentage, not just a bare meter", () => {
  const html = render(mkSession());
  assert.match(html, /card-runtime/);
  assert.match(html, /Opus 4\.8/);
  assert.match(html, /62%/);
});

test("a session with no meta simply omits the runtime row", () => {
  const bare = mkSession({ meta: null, activity: null });
  const html = render(bare);
  assert.doesNotMatch(html, /card-runtime/);
  assert.doesNotMatch(html, /tile-activity/);
  // ...but the tile itself still renders.
  assert.match(html, /App Bugfixes/);
});

test("a lapsed-hook session omits the ticker rather than animating a stale label", () => {
  // When hooks lapse past the overlay TTL the passive poller refreshes `state` from the
  // transcript but leaves `activity` at its stale overlay value, so a session can read
  // working with a settled label. `instrumented` is false in exactly that case.
  const html = render(mkSession({ instrumented: false, state: "working", activity: "idle" }));
  assert.doesNotMatch(html, /tile-activity/);
});

// ---- idle, but held by an open workflow run ----
//
// The board files a session bound to a live run under `idle`, correctly - the agent did finish
// its turn. What it must not do is present it as one of the agents you can dispatch to. These
// pin the three marks that say otherwise: the section rule, the split count, and the tag on the
// tile itself.

/** Two idle sessions, the second of which an open run holds. */
function idlePair(): { free: Session; held: Session } {
  return {
    free: mkSession({ id: "free-1", name: "aaa free", state: "idle", activity: null }),
    held: mkSession({ id: "held-1", name: "bbb held", state: "idle", activity: null }),
  };
}

function heldProps(open: boolean): SessionViewProps {
  const { free, held } = idlePair();
  return {
    ...props([free, held]),
    workflowRunsBySession: new Map([
      [
        held.id,
        [{
          ...workflowRun,
          sessionId: held.id,
          status: open ? ("running" as const) : ("completed" as const),
        }],
      ],
    ]),
    onOpenWorkflowRun: () => {},
  };
}

test("the idle column splits into free and held, with the held ones last", () => {
  const html = renderToStaticMarkup(createElement(BoardView, heldProps(true)));
  assert.match(html, /fleet-section-free/);
  assert.match(html, /fleet-section-held/);
  assert.match(html, /held by a workflow/);
  // The rule carries the explanation once, so no tile below it has to.
  assert.match(html, /it sends the next round on its own/);
  // Free rule before held rule, and the held tile after both.
  assert.ok(
    html.indexOf("fleet-section-free") < html.indexOf("fleet-section-held"),
    "the free rule must come first",
  );
  assert.ok(
    html.indexOf("fleet-section-held") < html.indexOf("bbb held"),
    "the held session must sit under the held rule",
  );
  assert.ok(
    html.indexOf("aaa free") < html.indexOf("fleet-section-held"),
    "the free session must sit above the held rule",
  );
});

test("the idle column head reports free and held rather than one number that means neither", () => {
  const html = renderToStaticMarkup(createElement(BoardView, heldProps(true)));
  assert.match(html, /class="board-col-n n-free"[^>]*>1 free</);
  assert.match(html, /class="board-col-n n-held"[^>]*>1 held</);
  assert.match(html, /1 of 2 idle agents can take work/);
});

test("a held tile carries its own tag, since the section rule scrolls away", () => {
  const html = renderToStaticMarkup(createElement(BoardView, heldProps(true)));
  assert.match(html, /class="tile [^"]*is-held/);
  // `aria-describedby` sits between the class and the text: the tag is Tooltip-wrapped, which
  // is the point - the tag is two words and the tooltip is where the run is named.
  assert.match(html, /class="tile-held"[^>]*>held</);
  assert.match(html, /Held by No-Mistakes Review - the run owns this session/);
});

test("a column where everything is held drops the free pill rather than counting zero", () => {
  // Matches `fleetRows` dropping the free RULE in the same case. "0 free · 1 held" counts a
  // side of the split that is not there, and disagreed with the single rule below it about
  // whether the column had two halves at all.
  const held = mkSession({ id: "held-only", name: "held", state: "idle", activity: null });
  const viewProps = {
    ...props([held]),
    workflowRunsBySession: new Map([
      [held.id, [{ ...workflowRun, sessionId: held.id, status: "running" as const }]],
    ]),
    onOpenWorkflowRun: () => {},
  };
  const html = renderToStaticMarkup(createElement(BoardView, viewProps));
  assert.doesNotMatch(html, /n-free/);
  assert.doesNotMatch(html, /0 free/);
  assert.match(html, /class="board-col-n n-held"[^>]*>1 held</);
  assert.doesNotMatch(html, /fleet-section-free/);
  assert.match(html, /fleet-section-held/);
});

test("a CLOSED run holds nothing: the column goes back to one count and no rules", () => {
  // The regression this guards is a session pinned under "held by a workflow" forever because
  // the run it was bound to finished. `workflowRunIsOpen` is the only thing keeping the two
  // apart, and it reads an append-only status union.
  const html = renderToStaticMarkup(createElement(BoardView, heldProps(false)));
  assert.doesNotMatch(html, /fleet-section-held/);
  assert.doesNotMatch(html, /class="tile [^"]*is-held/);
  assert.doesNotMatch(html, /n-free/);
  assert.match(html, /class="board-col-n">2</);
});

test("a held session that needs you is not tagged, and does not leave needs-you", () => {
  // Held-ness is scoped to `idle` in BOTH the ordering and the tile, and this is where the two
  // have to agree: a session parked on a question is the most actionable row on the board, and
  // a "held" tag there would say the run will handle it when only a human can.
  const asking = mkSession({
    id: "asking-1",
    name: "asking",
    state: "awaiting_input",
    stateConfirmed: true,
    activity: null,
  });
  const viewProps = {
    ...props([asking]),
    workflowRunsBySession: new Map([
      [asking.id, [{ ...workflowRun, sessionId: asking.id, status: "running" as const }]],
    ]),
    onOpenWorkflowRun: () => {},
  };
  const html = renderToStaticMarkup(createElement(BoardView, viewProps));
  assert.doesNotMatch(html, /class="tile-held"/);
  assert.doesNotMatch(html, /fleet-section-held/);
});
