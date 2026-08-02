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
    onDeselect: () => {},
    expandedId: null,
    onToggleExpand: () => {},
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
  assert.match(html, /editing SessionCard\.tsx/);
});

test("a bound workflow starts as an in-place Board disclosure, not a navigation flag", () => {
  const session = mkSession();
  const viewProps = {
    ...props([session]),
    workflowRunBySession: new Map([[session.id, { ...workflowRun, sessionId: session.id }]]),
    onOpenWorkflowRun: () => {},
  };
  const html = renderToStaticMarkup(createElement(BoardView, viewProps));

  assert.match(html, /tile-workflow-disclosure/);
  assert.match(html, /No-Mistakes Review/);
  assert.match(html, /Review changes/);
  assert.match(html, /Loading the current stage/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /<kbd class="kb-hint">e<\/kbd>/);
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
