/**
 * What is at stake: the Conversation tab is the transcript and NOTHING else, and every
 * progress readout a session has is reachable from one tab, on one chord.
 *
 * Two unrelated systems were rendering progress bars directly above the transcript - the
 * Mission Control workflow ladder and the external no-mistakes gate - and between them a
 * gated session on a long workflow could push the first message of the conversation off the
 * bottom of the screen. Both now live in a Workflows tab, which also absorbed the old Gate
 * tab, because two adjacent tabs both answering "is this change allowed to land" was the
 * split that put one of them above the transcript to begin with.
 *
 * That makes this a REMOVAL, which is the kind of change that silently comes back: the
 * strip is rendered from `session.nomistakes`, which almost every fixture in this suite
 * carries, so re-adding one line to the conversation branch would look right in every other
 * test here. So the absence is asserted against a session that has every reason to draw one
 * - a live gate, fix commits, and a bound workflow run.
 *
 * The tab table and the tab body are asserted as units rather than grepped, because this
 * repo renders with `renderToStaticMarkup` and has no jsdom: no test can click a tab or
 * dispatch a keydown, so a table left inline in ConsoleDetail and a body left in a `tab ===`
 * branch could only be checked by matching source strings, which pins spelling and not
 * conduct. `detailTabs` and `SessionWorkflowsPane` are the two pieces that split out to make
 * the real thing assertable - the same move `conversationReveal` makes for the chord that
 * reveals a conversation. What stays a source grep is only the WIRING between App's keydown
 * handler and the detail, which genuinely is a connection rather than a judgement.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { NmFixSummary, Session } from "../src/shared/types.ts";
import type { SessionFilesController } from "../src/web/lib/sessionFiles.ts";
import type { SessionViewProps } from "../src/web/components/layouts/types.ts";
import { ConsoleDetail } from "../src/web/components/layouts/ConsoleDetail.tsx";
import { SessionWorkflowsPane } from "../src/web/components/SessionWorkflowsPane.tsx";
import { detailTabs } from "../src/web/lib/detailTabs.ts";
import { ACTIONS, resolveKeybindings } from "../src/web/lib/keybindings.ts";
import { mkSession, nm } from "./helpers/session-fixture.ts";
import { LADDER_SUMMARY } from "./helpers/workflow-ladder.ts";

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

/** A fix commit, so the fix log has something to roll up. */
const FIX: NmFixSummary = {
  sha: "abc1234",
  step: "lint",
  summary: "drop the unused import",
  committedAt: 1_753_600_000_000,
  filesChanged: 1,
  added: 0,
  removed: 1,
  decision: "auto",
  repliedBy: null,
  findingCount: 1,
};

/**
 * A session with every reason to draw a progress readout: a running gate, a fix commit and
 * (via the view below) a bound workflow run. If any of the three leaks back into the
 * conversation, this is the fixture that catches it.
 */
function gatedSession(over: Partial<Session> = {}): Session {
  return mkSession({ nomistakes: nm(), nomistakesFixes: [FIX], ...over });
}

function view(session: Session, over: Partial<SessionViewProps> = {}): SessionViewProps {
  return {
    sessions: [session],
    tasks: [],
    backlog: [],
    onEditTask: () => {},
    backlogPlan: null,
    gateAlerts: new Set<string>(),
    selectedId: session.id,
    consoleZone: "rail",
    onConsoleZoneChange: () => {},
    onSelect: () => {},
    onDeselect: () => {},
    expandedId: session.id,
    onToggleExpand: () => {},
    onOpenReviews: () => {},
    onOpenDiff: () => {},
    onOpenFiles: () => {},
    onOpenFile: () => false,
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
    workflowRunBySession: new Map([[session.id, { ...LADDER_SUMMARY, sessionId: session.id }]]),
    onOpenWorkflowRun: () => {},
    ...over,
  };
}

/** The detail opens on Conversation, so this is that tab's body plus the chrome around it. */
function detailHtml(session: Session, over: Partial<SessionViewProps> = {}): string {
  return renderToStaticMarkup(
    createElement(ConsoleDetail, { session, view: view(session, over) }),
  );
}

test("the conversation window draws no progress bar - not the gate, not the workflow", () => {
  const html = detailHtml(gatedSession());

  // The three classes the removed cards are built from. `nm-strip` is the no-mistakes
  // progress card (brand, status badge, elapsed, the row of step dots), `nm-log` its fix
  // rollup, `wf-ladder` the workflow rungs.
  assert.doesNotMatch(html, /nm-strip/, "the no-mistakes strip is back above the transcript");
  assert.doesNotMatch(html, /nm-log|nm-rollup/, "the fix log is back above the transcript");
  assert.doesNotMatch(html, /wf-ladder|tile-workflow/, "the workflow ladder is back");

  // Not because the fixture is empty and not because the pane failed to render: the
  // conversation is still there, and so is the header chip that says a workflow is bound.
  assert.match(html, /detail-conv/, "the conversation body should still render");
  assert.match(html, /workflow-/, "the header's workflow chip is a separate, kept affordance");
});

test("a gated session's progress lives in the Workflows pane, gate and ladder together", () => {
  const session = gatedSession();
  const html = renderToStaticMarkup(
    createElement(SessionWorkflowsPane, {
      session,
      run: { ...LADDER_SUMMARY, sessionId: session.id },
      gateNeedsYou: false,
      onOpenRun: () => {},
      onOpenDiff: () => {},
    }),
  );
  assert.match(html, /nm-strip/, "the gate strip should render here now");
  assert.match(html, /nm-rollup/, "and so should the fix log");
  assert.match(html, /tile-workflow|wf-/, "and the workflow ladder alongside them");
  assert.doesNotMatch(html, /detail-empty/, "with progress to show, there is no empty state");
});

test("a parked gate can still be ANSWERED here - this pane owns the only actions", () => {
  // Moving the strip has to carry its ACTIONS, not just its pixels. It is not a read-only
  // progress bar: Approve / Fix / Skip hang off it, and Console and the Board drill-in have
  // no other copy - Cards keeps one on the card, but these two layouts draw no card. A move
  // that landed the readout here and lost the buttons would make a parked gate unanswerable
  // in both, and leave the attention inbox's "answer this gate" deep link pointing at
  // nothing. That is the half of "moved" a screenshot would not catch.
  const parked = gatedSession({ nomistakes: nm({ gateStep: "review", awaitingAgent: "you" }) });
  const html = renderToStaticMarkup(
    createElement(SessionWorkflowsPane, {
      session: parked,
      run: null,
      gateNeedsYou: true,
      onOpenRun: () => {},
      onOpenDiff: () => {},
    }),
  );
  assert.match(html, /nm-parked/, "a parked gate should read as parked");
  for (const verb of ["Approve", "Fix", "Skip"]) {
    assert.ok(html.includes(verb), `${verb} must be reachable from the Workflows tab`);
  }
});

test("the fix log outlives the run that made the commits", () => {
  // The old Gate tab nested the log inside `session.nomistakes ? … : empty`, so the moment
  // a run retired the record of what it had changed vanished with it. The conversation copy
  // this replaces did not nest them, and that is the reading kept.
  const html = renderToStaticMarkup(
    createElement(SessionWorkflowsPane, {
      session: gatedSession({ nomistakes: null }),
      run: null,
      gateNeedsYou: false,
      onOpenRun: () => {},
      onOpenDiff: () => {},
    }),
  );
  assert.match(html, /nm-rollup/, "fix commits survive their run");
  assert.doesNotMatch(html, /detail-empty/, "and a pane with a fix log is not empty");
});

test("an empty pane says which nothing it is, and does not contradict the gated chip", () => {
  const empty = (over: Partial<Session>): string =>
    renderToStaticMarkup(
      createElement(SessionWorkflowsPane, {
        session: mkSession({ nomistakes: null, nomistakesFixes: [], ...over }),
        run: null,
        gateNeedsYou: false,
        onOpenRun: () => {},
        onOpenDiff: () => {},
      }),
    );

  // A gated repo between runs. The old Gate tab said "this repo isn't gated by
  // no-mistakes" here, three lines above a footer showing the ◇ gated chip.
  const gated = empty({ nomistakesGated: true });
  assert.match(gated, /detail-empty/);
  assert.match(gated, /no-mistakes hasn&#x27;t run on it yet/);
  assert.doesNotMatch(gated, /isn&#x27;t gated by no-mistakes/);

  // A repo that genuinely is not gated still gets the sentence that was always true of it.
  const ungated = empty({ nomistakesGated: false });
  assert.match(ungated, /isn&#x27;t gated by no-mistakes/);
});

test("Workflows sits between Work queue and Diff, and Gate is gone from the strip", () => {
  const tabs = detailTabs({ queueCount: 0, gateNeedsYou: false });
  assert.deepEqual(
    tabs.map((t) => t.id),
    ["conversation", "queue", "workflows", "diff", "files"],
    "this order is the strip, the Tab walk and the keycaps, all three",
  );
  assert.deepEqual(
    tabs.map((t) => t.label),
    ["Conversation", "Work queue", "Workflows", "Diff", "Files"],
  );
  assert.equal(tabs.some((t) => t.id === ("gate" as string)), false);

  // Rendered, the strip agrees - a tab table nothing draws would pass the check above.
  const html = detailHtml(mkSession());
  assert.match(html, /role="tab"[^>]*>(?:(?!<\/button>).)*Workflows/s);
  assert.doesNotMatch(html, /role="tab"[^>]*>(?:(?!<\/button>).)*>Gate</s);
});

test("Gate's pip moves with it, so a parked gate is still loud on the tab that replaced it", () => {
  // Folding a tab in must not quietly silence its alarm: this count is the only thing on
  // the strip that says the operator is being WAITED on.
  assert.equal(detailTabs({ queueCount: 0, gateNeedsYou: true })[2]?.pip, 1);
  assert.equal(detailTabs({ queueCount: 0, gateNeedsYou: false })[2]?.pip, 0);
  // And the work queue's own count is untouched by the insertion.
  assert.equal(detailTabs({ queueCount: 4, gateNeedsYou: false })[1]?.pip, 4);
});

test("every tab carries a chord now, including the one Gate could only be walked to", () => {
  // Gate was the single tab with `action: null`: no keycap on its face and no way to it but
  // the mouse or stepping the whole strip. Its replacement is bound.
  const ids = new Set(ACTIONS.map((a) => a.id));
  for (const tab of detailTabs({ queueCount: 0, gateNeedsYou: false })) {
    assert.ok(ids.has(tab.action), `${tab.id} points at an action that is not in the registry`);
  }
});

test("the Workflows tab is bound to y on the selected session", () => {
  const action = ACTIONS.find((a) => a.id === "sessionWorkflows");
  assert.ok(action, "sessionWorkflows missing from the customizable registry");
  assert.equal(action.defaultBinding, "y");
  // "selection", not "global": it reveals ONE session's run. `workflows` (w) is the separate
  // global chord for the fleet-wide Workflows page, and the two must not be confused.
  assert.equal(action.group, "selection");
  assert.equal(ACTIONS.find((a) => a.id === "workflows")?.group, "global");

  const resolved = resolveKeybindings({});
  assert.equal(resolved.sessionWorkflows, "y");
  assert.equal(resolved.workflows, "w");
});

test("App's chord and the detail's tab are actually wired to each other", () => {
  const app = read("../src/web/App.tsx");
  const detail = read("../src/web/components/layouts/ConsoleDetail.tsx");
  assert.match(app, /chord === bindings\.sessionWorkflows/);
  assert.match(app, /requestWorkflowsTab\(sel\.id\)/);
  // Cards draws no tab strip and never mounted the ladder, so the chord stays unclaimed
  // there rather than being swallowed to no effect.
  assert.match(app, /if \(!sel \|\| layout === "grid"\) return;/);
  assert.match(detail, /view\.workflowsTabRequest\?\.sessionId === session\.id/);

  // The inbox's parked-gate deep link exists to say "come and answer this", so it has to
  // land on the surface that answers it. In Cards that is still the card; everywhere else
  // the gate moved behind a tab, and a link to the transcript would be a link to the wrong
  // half. Grepped because it is a connection between three files, not a judgement.
  const inbox = read("../src/web/components/AttentionInbox.tsx");
  assert.match(inbox, /onOpenSession\(item\.session\.id, "workflows"\)/);
  assert.match(app, /reveal === "workflows" && layout !== "grid"/);
  // The conversation branch owns the transcript alone. Neither card may be re-added there.
  const conversation = detail.slice(
    detail.indexOf('tab === "conversation"'),
    detail.indexOf('tab === "queue"'),
  );
  assert.doesNotMatch(conversation, /Nomistakes|WorkflowLadder|SessionWorkflowsPane/);
});
