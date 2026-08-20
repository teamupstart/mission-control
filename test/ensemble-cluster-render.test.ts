// What is at stake: the ensemble being legible where the operator already looks, and the two
// halves of that staying honest.
//
// The fleet and the run detail used to disagree about the same agent - the run row said "Active"
// while the card was red with an unanswered question - and the summary's progress counts rode the
// wire with nothing rendering them. These pin the surfaces that close both: the board's cluster
// frame, the rail's cluster header, the ONE progress leaf all three mount, and the Ensembles tab
// badge. The frame is presentational, so what is asserted is that the tiles inside keep their
// order and that the wrapper takes no drag handling - a frame that swallowed a dragover would
// break handing a backlog card to a member with nothing failing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Session } from "../src/shared/types.ts";
import type { EnsembleSummary } from "../src/shared/ensemble.ts";
import type { SessionFilesController } from "../src/web/lib/sessionFiles.ts";
import type { SessionViewProps } from "../src/web/components/layouts/types.ts";
import { BoardView } from "../src/web/components/layouts/BoardView.tsx";
import { ConsoleView } from "../src/web/components/layouts/ConsoleView.tsx";
import { EnsembleRuns } from "../src/web/workflows/EnsembleRuns.tsx";
import { DecideDrawer } from "../src/web/components/line/DecideDrawer.tsx";
import {
  EnsembleProgressDots,
  ensembleClusterHeadline,
  ensembleDotCounts,
  ensembleDotSummary,
} from "../src/web/components/session-bits.tsx";
import { mkEnsembleSummary, mkMemberSession, mkSession } from "./helpers/session-fixture.ts";

function member(ordinal: number, over: Partial<Session> = {}): Session {
  return mkMemberSession({ ...over, link: { ordinal, memberId: `m-${ordinal}`, maxMembers: 3 } });
}

/** A member sitting on an unanswered question: attention tone plus the server-derived flag. */
function blockedMember(ordinal: number): Session {
  return mkMemberSession({
    state: "idle",
    activity: null,
    pendingReviews: 1,
    link: { ordinal, memberId: `m-${ordinal}`, maxMembers: 3, needsInput: true },
  });
}

function view(over: Partial<SessionViewProps> = {}): SessionViewProps {
  return {
    sessions: [],
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
    ...over,
  };
}

function board(over: Partial<SessionViewProps>): string {
  return renderToStaticMarkup(createElement(BoardView, view(over)));
}

function consoleRail(over: Partial<SessionViewProps>): string {
  return renderToStaticMarkup(createElement(ConsoleView, view(over)));
}

const RUN = mkEnsembleSummary({ title: "Fix the parser", status: "evaluating" });
const SUMMARIES = new Map([[RUN.id, RUN]]);

test("the board frames sibling members under one header naming the run, its stage and its progress", () => {
  const html = board({
    sessions: [member(1), member(2), member(3)],
    ensembleSummaryByRun: SUMMARIES,
  });
  assert.match(html, /class="board-cluster"/);
  assert.match(html, /class="board-cluster-head"/);
  assert.match(html, /bch-title">Fix the parser</);
  // The shared stage vocabulary, not the raw status enum and not a word invented here.
  assert.match(html, /bch-meta">Best of N · reviewing</);
  assert.match(html, /class="ens-dots"/);
  // One frame for three members, not three frames.
  assert.equal(html.match(/class="board-cluster"/g)?.length, 1);
});

test("the frame keeps its tiles in the ordered sequence and takes no drag handling", () => {
  // The tiles are drop targets. The wrapper deliberately carries no dragover/drop handler, so a
  // backlog card dragged onto a clustered tile behaves exactly as it did when the tiles were
  // loose children of the column body.
  const html = board({
    sessions: [member(3), member(1), member(2)],
    ensembleSummaryByRun: SUMMARIES,
  });
  const order = [...html.matchAll(/class="tile-name"[^>]*>([^<]+)</g)].map((m) => m[1]);
  assert.deepEqual(order, ["run-1 candidate 1", "run-1 candidate 2", "run-1 candidate 3"]);
  // Every tile still sits inside the frame that was opened before the first of them.
  assert.ok(html.indexOf('class="board-cluster"') < html.indexOf("run-1 candidate 1"));
});

test("a blocked member's column repeats the header, and each copy says the right thing", () => {
  // The tone-boundary rule made visible: the blocked member is alone in "needs you", its working
  // siblings stay in "working", and BOTH columns carry the run's header. The two copies must NOT
  // say the same thing, though - a solid "1 needs you" over the working column would point at
  // three tiles that need nothing, so only the column holding the blocked member gets the
  // actionable badge and the tone; the others get the quiet "1 elsewhere" pointer.
  const summary = mkEnsembleSummary({
    title: "Fix the parser",
    status: "running",
    membersNeedingInput: 1,
    attention: true,
  });
  const html = board({
    sessions: [member(1), blockedMember(2), member(3)],
    ensembleSummaryByRun: new Map([[summary.id, summary]]),
  });
  assert.equal(html.match(/class="board-cluster"/g)?.length, 1, "the working column's frame");
  assert.equal(html.match(/class="board-cluster needs-you"/g)?.length, 1, "the needs-you frame");
  assert.equal(html.match(/bch-needs">1 needs you</g)?.length, 1);
  assert.equal(html.match(/bch-needs is-elsewhere">1 elsewhere</g)?.length, 1);
  // The actionable badge sits in the same frame as the blocked member's tile, not the other one.
  const actionable = html.indexOf("1 needs you");
  assert.ok(actionable < html.indexOf("candidate 2"));
  assert.ok(actionable > html.indexOf('class="board-col tone-attention'));

  // Singular/plural is spelled, not "1 needs you" for two.
  const two = board({
    sessions: [blockedMember(1), blockedMember(2)],
    ensembleSummaryByRun: new Map([
      [summary.id, { ...summary, membersNeedingInput: 2 } satisfies EnsembleSummary],
    ]),
  });
  assert.match(two, /bch-needs">2 need you</);
  assert.doesNotMatch(two, /is-elsewhere/);
});

test("neither cluster wrapper declares drag handling of its own", () => {
  // Read off the SOURCE, because React drag handlers leave no trace in static HTML: an
  // `onDragOver` added to the frame would render byte-identically while quietly intercepting
  // every drop meant for the tile underneath it, and no markup assertion could tell. The tiles
  // are the drop targets; the frames are drawings.
  const source = readFileSync(
    new URL("../src/web/components/layouts/BoardView.tsx", import.meta.url),
    "utf8",
  );
  for (const wrapper of ["board-cluster", "rail-cluster"]) {
    const open = source.match(new RegExp(`<div[^>]*?${wrapper}[\\s\\S]*?\\n *>`, "m"))?.[0]
      ?? source.match(new RegExp(`<div className="${wrapper}"[^>]*>`))?.[0];
    assert.ok(open, `${wrapper} should be a plain wrapper element in BoardView`);
    assert.doesNotMatch(open, /onDrag|onDrop/, `${wrapper} must carry no drag handling`);
  }
});

test("an ordinary fleet grows no frame at all", () => {
  const html = board({ sessions: [mkSession({ id: "a", name: "alpha" })] });
  assert.doesNotMatch(html, /board-cluster/);
  assert.doesNotMatch(html, /ens-dots/);
});

test("a cluster renders before its run summary arrives, named from the member link", () => {
  // The link rides on the session's own task summary; the run summary is a separate SSE
  // collection that can land a tick later. A header that waited would flicker a frame in and out.
  const html = board({ sessions: [member(1), member(2)] });
  assert.match(html, /class="board-cluster"/);
  assert.match(html, /bch-title">Best of N</);
  assert.doesNotMatch(html, /bch-stage/);
});

test("a blocked cluster header needs no run summary to show its actionable count", () => {
  const html = board({ sessions: [member(1), blockedMember(2)] });
  assert.match(html, /bch-needs">1 needs you</);
  assert.doesNotMatch(html, /bch-meta/);
  assert.doesNotMatch(html, /is-elsewhere/);
});

test("a cluster header's accessible name states everything the header shows", () => {
  // Both densities pass `ensembleClusterHeadline`'s sentence as `aria-label`, which REPLACES the
  // button's whole subtree for assistive tech - so anything the header draws and this sentence
  // omits is invisible to a screen reader, including what a nested child would have said for
  // itself. Three things used to fall out: the run's name during the SSE gap ("Open this
  // ensemble run" while the header read "Best of N"), the attention count (read off the summary
  // though `blockedHere` comes from member links), and every dot state but "submitted" - the
  // dots' own `role="img"` name is exactly what a labelled ancestor discards.
  const gap = ensembleClusterHeadline(null, "Best of N", 1);
  assert.equal(gap.title, "Best of N");
  assert.equal(gap.tooltip, "Open Best of N. Waiting on your answer: 1 in this column.");
  assert.equal(ensembleClusterHeadline(null, "Best of N").tooltip, "Open Best of N.");

  // Every disposition the dots draw is named, from the SAME sentence the dots use.
  const mixed = mkEnsembleSummary({
    title: "Fix the parser",
    status: "evaluating",
    maxMembers: 5,
    launchedMembers: 4,
    membersReady: 1,
    membersNeedingInput: 1,
    membersOut: 1,
  });
  const full = ensembleClusterHeadline(mixed, "Best of N", 1).tooltip;
  assert.equal(
    full,
    "Open Fix the parser - Best of N, reviewing. Roster of 5: 1 waiting on you, 1 submitted, " +
      "1 working, 1 out, 1 not started. Waiting on your answer: 1 in this column.",
  );
  assert.equal(full.includes(ensembleDotSummary(mixed)), true, "the roster clause IS the dot sentence");

  // The attention clause states LOCATION, not a second copy of the count - the header is
  // repeated per tone column, so an unqualified count points at the wrong tiles.
  assert.match(
    ensembleClusterHeadline(mixed, "Best of N", 0).tooltip,
    /Waiting on your answer: 1 in another column\.$/,
  );
  assert.doesNotMatch(
    ensembleClusterHeadline(mkEnsembleSummary({ title: "Calm" }), "Best of N", 0).tooltip,
    /Waiting on your answer/,
  );

  // And it reaches the rendered headers as their name, in both densities.
  const name = "Open Best of N. Waiting on your answer: 1 in this column.";
  assert.match(
    board({ sessions: [member(1), blockedMember(2)] }),
    new RegExp(`class="board-cluster-head[^"]*" aria-label="${name}"`),
  );
  assert.match(
    consoleRail({ sessions: [blockedMember(2)] }),
    new RegExp(`class="rail-ensemble-group[^"]*" aria-label="${name}"`),
  );
});

test("the console rail heads each cluster with a row that is not a session row", () => {
  // Rail navigation walks session ids (`layoutNav.ts`), so the header must not be a `.rail-row`
  // - an arrow key has to step over it rather than select a header.
  const html = consoleRail({
    sessions: [member(1), member(2)],
    ensembleSummaryByRun: SUMMARIES,
  });
  assert.match(html, /class="rail-cluster"/);
  assert.match(html, /class="rail-ensemble-group"/);
  assert.match(html, /reg-title">Fix the parser</);
  assert.match(html, /reg-stage">reviewing</);
  assert.doesNotMatch(html, /class="rail-ensemble-group[^"]*"[^>]*class="rail-row"/);
  // Two members, two rail rows, one header.
  assert.equal(html.match(/class="rail-row[^"]*"/g)?.length, 2);
  assert.equal(html.match(/class="rail-ensemble-group"/g)?.length, 1);
});

test("rail cluster headers distinguish attention here from attention elsewhere", () => {
  const summary = mkEnsembleSummary({
    membersNeedingInput: 1,
    attention: true,
  });
  const html = consoleRail({
    sessions: [member(1), blockedMember(2), member(3)],
    ensembleSummaryByRun: new Map([[summary.id, summary]]),
  });
  assert.equal(html.match(/class="reg-needs">!1</g)?.length, 1);
  assert.equal(html.match(/class="reg-needs is-elsewhere">!1</g)?.length, 1);
});

test("calm cluster headers render no attention mark", () => {
  const sessions = [member(1), member(2)];
  assert.doesNotMatch(
    board({ sessions, ensembleSummaryByRun: SUMMARIES }),
    /(?:bch-needs|reg-needs)/,
  );
  assert.doesNotMatch(
    consoleRail({ sessions, ensembleSummaryByRun: SUMMARIES }),
    /(?:bch-needs|reg-needs)/,
  );
});

test("the board's drilled-in column uses the SAME rail header the console does", () => {
  // The board's drill-in IS the console rail (`RailRow` is shared), so the cluster header has to
  // be too - a second one written for the board is the copy that stops matching.
  const sessions = [member(1), member(2)];
  const html = board({
    sessions,
    ensembleSummaryByRun: SUMMARIES,
    selectedId: sessions[0]!.id,
    expandedId: sessions[0]!.id,
  });
  assert.match(html, /class="rail-cluster"/);
  assert.match(html, /class="rail-ensemble-group"/);
});

// ---- the one progress leaf ----

test("the dots are the disjoint member counts, with working as the remainder", () => {
  // Phase 1's contract: `membersOut` / `membersNeedingInput` / `membersReady` never count the
  // same member twice, so working is what is left of `launchedMembers` and the total is
  // `maxMembers` by construction.
  assert.deepEqual(
    ensembleDotCounts(
      mkEnsembleSummary({
        maxMembers: 5,
        launchedMembers: 4,
        membersOut: 1,
        membersNeedingInput: 1,
        membersReady: 1,
      }),
    ),
    { blocked: 1, done: 1, working: 1, out: 1, pending: 1 },
  );
});

test("a member that submitted and is now blocked draws one dot, not two", () => {
  // The round-7 defect this formula exists to rule out: `readyArtifacts` counts ARTIFACTS, so
  // adding it to the blocked count double-counts a submitted member sitting on a question and
  // could draw more dots than the roster has lanes.
  const counts = ensembleDotCounts(
    mkEnsembleSummary({
      maxMembers: 3,
      launchedMembers: 3,
      readyArtifacts: 3,
      membersNeedingInput: 1,
      membersReady: 2,
    }),
  );
  assert.deepEqual(counts, { blocked: 1, done: 2, working: 0, out: 0, pending: 0 });
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  assert.equal(total, 3);
});

test("a summary whose counts do not add up draws a short row, never a long one", () => {
  // Defensive only - the exclusivity lives on the wire. A row longer than the roster is the one
  // failure a reader cannot interpret at all.
  const counts = ensembleDotCounts(
    mkEnsembleSummary({
      maxMembers: 2,
      launchedMembers: 9,
      membersOut: 4,
      membersNeedingInput: 4,
      membersReady: 4,
    }),
  );
  assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), 2);
  assert.equal(counts.pending, 0);
});

test("the dots say they are counts and never claim a position", () => {
  const html = renderToStaticMarkup(
    createElement(EnsembleProgressDots, {
      summary: mkEnsembleSummary({
        maxMembers: 3,
        launchedMembers: 3,
        membersNeedingInput: 1,
        membersReady: 1,
      }),
    }),
  );
  assert.match(html, /aria-label="1 waiting on you, 1 submitted, 1 working - counts, not positions/);
  assert.equal(html.match(/ens-dot ens-dot-/g)?.length, 3);
  // Each dot is aria-hidden: the row's ONE label is the sentence above, so a screen reader
  // hears the counts rather than three anonymous images.
  assert.equal(html.match(/ens-dot ens-dot-[a-z]+" aria-hidden="true"/g)?.length, 3);
});

test("a run with no roster at all draws nothing rather than an empty strip", () => {
  const html = renderToStaticMarkup(
    createElement(EnsembleProgressDots, {
      summary: mkEnsembleSummary({ maxMembers: 0, launchedMembers: 0 }),
    }),
  );
  assert.equal(html, "");
  assert.equal(renderToStaticMarkup(createElement(EnsembleProgressDots, { summary: null })), "");
});

// ---- the run list and the tab badge ----

test("the Ensembles list row finally renders the counts the wire has always carried", () => {
  const summaries = [
    mkEnsembleSummary({
      id: "run-1",
      title: "Fix the parser",
      launchedMembers: 3,
      maxMembers: 5,
      membersReady: 2,
      membersNeedingInput: 1,
      attention: true,
    }),
  ];
  const html = renderToStaticMarkup(
    createElement(EnsembleRuns, { summaries, selectedId: null, onSelect: () => {} }),
  );
  assert.match(html, /class="ens-dots"/);
  // The dots' denominator and this line's are the same roster, and `launchedMembers` is named
  // only while it is short of it.
  assert.match(html, /ensemble-run-counts">2\/5 in · 3 launched</);
  assert.match(html, /ensemble-run-needs">1 needs you</);

  const full = renderToStaticMarkup(
    createElement(EnsembleRuns, {
      summaries: [mkEnsembleSummary({ maxMembers: 3, launchedMembers: 3, membersReady: 3 })],
      selectedId: null,
      onSelect: () => {},
    }),
  );
  assert.match(full, /ensemble-run-counts">3\/3 in</);
  assert.doesNotMatch(full, /launched/);
  assert.doesNotMatch(full, /ensemble-run-needs/);
});

// The Ensembles TAB used to wear this number, and the tab strip retired with the Workflows
// page. The signal did not: it moved onto the Line, where the Decide stage goes amber off
// the daemon's own fold and the drawer that opens under it states the figure in words. This
// pins the drawer half - that the count it prints is the daemon's `attentionCount` and not a
// recount of the summaries beside it, and that a calm fleet prints no amber phrase at all.
test("the Decide drawer wears the daemon's attention count, and nothing when calm", () => {
  const drawer = (summaries: EnsembleSummary[], count: number): string =>
    renderToStaticMarkup(
      createElement(DecideDrawer, {
        summaries,
        attentionCount: count,
        now: 5000,
        onClose: () => {},
        onOpenEnsemble: () => {},
        onOpenAllEnsembles: () => {},
      }),
    );
  const busy = drawer([mkEnsembleSummary({ attention: true })], 1);
  assert.match(busy, /line-drawer-att">1 needs a look</);
  assert.doesNotMatch(drawer([mkEnsembleSummary({})], 0), /line-drawer-att/);

  // A run actually stopped for an answer outranks the generic count: "needs a look" and
  // "waiting on you" are different asks, and the drawer must make the second one.
  const deciding = drawer([mkEnsembleSummary({ status: "awaiting_decision", attention: true })], 1);
  assert.match(deciding, /line-drawer-att">1 waiting on you</);
  assert.match(deciding, />Decide</, "an ensemble awaiting a decision offers Decide");
});
