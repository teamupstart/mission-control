import { before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TranscriptMessage } from "../src/shared/types.ts";
import { TranscriptPanel } from "../src/web/components/TranscriptPanel.tsx";
import { ConversationFindBar, ConversationFindRail } from "../src/web/components/ConversationFind.tsx";
import type { FindHit } from "../src/web/lib/find.ts";
import { resetHistories, seedTail } from "../src/web/lib/transcript-history.ts";
import { assertElectronGuiLaunchAllowed } from "./helpers/electron-gui.ts";
import { mkSession } from "./helpers/session-fixture.ts";

/**
 * Whether you can scroll a conversation.
 *
 * Find-in-conversation gave the log a wrapper - `.find-split > .find-logwrap` - so that
 * the rail could sit beside it. The wrapper became the flex item the log's bounded
 * height had hung off, and a flex item's automatic minimum size is the height of its
 * content. So it refused to shrink to the pane, the log inherited an unbounded height,
 * and `overflow-y: auto` had nothing left to scroll: the conversation froze at its first
 * screenful and the reply box was pushed out of a pane that clips. Measured on the
 * shipped code, the log was 3230px tall inside a 600px pane, and the reply box sat
 * 2770px below the bottom of it.
 *
 * That is a geometry defect, and only laid-out geometry can catch it. Every part of the
 * chain here is the real thing - the panel's own markup, the real stylesheet, the two
 * height-bounded ancestors it mounts under - because the bug lived in the relationship
 * between them and not in any one of them. A markup assertion would have passed
 * throughout: the DOM was correct, its used heights were not.
 *
 * The cases cover the split's two owners in both hosts and at both container widths:
 * find CLOSED (Observed activity owns the secondary column), find OPEN (find owns it,
 * activity withheld), each in the Console detail - and the
 * narrow-container layouts where activity collapses to a disclosure row that opens on
 * request while find still stacks its full rail.
 *
 * The log's in-progress row is measured here for the same reason. Its single line is a
 * correctness requirement, not a preference - the log follows its tail only while the
 * reader is within 48px of the bottom - and whether an activity line wraps or clips is a
 * used-height fact that the identical markup gives no answer to either way.
 */

const require = createRequire(import.meta.url);

/** Same backstop the workflow geometry test uses: a hung browser fails, slowly. */
const ELECTRON_TIMEOUT_MS = 240_000;

/** A conversation comfortably taller than any pane it is measured in. */
const TURNS = 40;

interface Measured {
  boxHeight: number;
  logHeight: number;
  contentHeight: number;
  scrolledTo: number;
  composeBottomOverflow: number;
  composeHeight: number;
  railBottomOverflow: number | null;
  railHeight: number | null;
  railBelowLog: boolean | null;
  activityBelowLog: boolean | null;
  /** The split's right edge against its host's - a column that does not fit leaks here. */
  splitRightOverflow: number;
  activityPresent: boolean;
  activityHeight: number | null;
  activityBottomOverflow: number | null;
  activityToggleVisible: boolean | null;
  activityBodyVisible: boolean | null;
  activityContentHeight: number | null;
  activityViewHeight: number | null;
  activityScrolledTo: number | null;
  progressHeight: number | null;
  progressRightOverflow: number | null;
  progressClipped: boolean | null;
}

/**
 * The window `onScroll` calls "at the bottom" (`TranscriptPanel.onScroll`). Anything that
 * appears under a bottom-pinned reader and is taller than this pushes them out of it, and
 * the log stops following the conversation.
 */
const STICK_TO_BOTTOM_PX = 48;

function hit(i: number): FindHit {
  return {
    key: `k${i}`,
    rowId: `m${i}`,
    toolIndex: null,
    start: 0,
    end: 4,
    scope: "user",
    who: "you",
    pre: "…before ",
    hit: "pane",
    post: " after…",
  };
}

/** The panel's real markup, hydrated with a real conversation through the history map. */
function panelMarkup(): string {
  resetHistories();
  // Assistant turns carry tools BESIDE their prose - the mixed shape the Observed
  // activity projection must not miss - and enough of them (two per assistant turn)
  // that the activity rail's own list overflows every pane it is measured in, which is
  // what makes "the rail scrolls independently" a checkable fact rather than a hope.
  const messages: TranscriptMessage[] = Array.from({ length: TURNS }, (_, i) => ({
    id: `m${i}`,
    role: i % 2 === 0 ? "user" : "assistant",
    text: `turn ${i} - a line of conversation long enough to wrap inside the pane, so the log is taller than any box it is measured in.`,
    tools: i % 2 === 0
      ? []
      : [
          { name: "Bash", input: `{"command":"ls -la /repo/turn-${i}"}` },
          { name: "Read", input: `{"file_path":"/repo/src/web/components/TranscriptPanel.tsx"}` },
        ],
    ts: i,
  }));
  seedTail("s1", { messages, start: 0, atStart: true, pos: 1000 });
  return renderToStaticMarkup(
    createElement(TranscriptPanel, {
      session: mkSession({
        id: "s1",
        // A working session, so the log carries its in-progress row - and an activity line
        // far wider than any pane here, because the row's whole correctness argument is
        // that it clips instead of wrapping. A comfortable string would measure one line
        // whether or not the clip works.
        state: "working",
        activity:
          "running Bash · git worktree list --porcelain and then the reaper sweep over every pooled checkout this daemon still owns",
        pendingTurns: [
          {
            id: "pending-editable",
            noteKey: "agent-1",
            seq: 0,
            text: "A queued follow-up remains visible and editable below the live conversation.",
            state: "queued",
            revision: 0,
            createdAt: 1,
            updatedAt: 1,
            claimedAt: null,
            lastError: null,
          },
          {
            id: "pending-uncertain",
            noteKey: "agent-1",
            seq: 1,
            text: "A terminal message whose pickup could not be confirmed.",
            state: "uncertain",
            revision: 2,
            createdAt: 2,
            updatedAt: 3,
            claimedAt: 2,
            lastError: "Mission Control could not confirm terminal pickup.",
          },
        ],
      }),
      canSend: true,
    }),
  );
}

/** The find surfaces' real markup, for the fixture to mount into an opened split. */
function findMarkup(): { bar: string; rail: string } {
  const hits = Array.from({ length: 30 }, (_, i) => hit(i));
  return {
    bar: renderToStaticMarkup(
      createElement(ConversationFindBar, {
        query: "pane",
        onQuery: () => {},
        caseSensitive: false,
        onCaseSensitive: () => {},
        hits,
        index: 0,
        onStep: () => {},
        onClose: () => {},
      }),
    ),
    rail: renderToStaticMarkup(
      createElement(ConversationFindRail, {
        query: "pane",
        scope: "all",
        onScope: () => {},
        hits,
        index: 0,
        onJump: () => {},
        loadedOnly: false,
        onLoadOlder: () => {},
      }),
    ),
  };
}

/**
 * The Console detail gives the conversation a bounded height, as it nests in the app.
 *
 * Each host appears at two widths, because the split is a container query and the
 * PANEL's width is what decides the layout: 640/900px puts `.find-split` above the
 * 560px breakpoint (activity is a side rail), 480/500px puts it below (activity is a
 * stacked disclosure). The `-expanded` cases flip that disclosure open; the `-open`
 * cases open find instead.
 */
function page(panel: string, styles: string): string {
  const detail = (width: number): string =>
    `<div class="detail-body" style="height:600px;width:${width}px"><div class="detail-conv">${panel}</div></div>`;
  const cases = [
    ["detail-closed", detail(640)],
    ["detail-open", detail(640)],
    ["detail-narrow", detail(480)],
    ["detail-narrow-expanded", detail(480)],
    ["detail-narrow-open", detail(480)],
  ];
  return `<!doctype html><meta charset="utf-8"><style>${styles}</style>
    <script type="application/json" id="find-markup">${JSON.stringify(findMarkup())}</script>
    <div style="display:flex;flex-wrap:wrap;gap:24px;align-items:flex-start">${
      cases.map(([name, host]) => `<div data-case="${name}">${host}</div>`).join("")
    }</div>`;
}

let measured: Record<string, Measured>;

before(() => {
  assertElectronGuiLaunchAllowed();
  const electron = require("electron") as string;
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const dir = mkdtempSync(join(tmpdir(), "mission-transcript-scroll-"));
  const userData = mkdtempSync(join(tmpdir(), "mission-transcript-scroll-profile-"));
  try {
    const htmlPath = join(dir, "transcript.html");
    const styles = readFileSync(fileURLToPath(new URL("../src/web/styles.css", import.meta.url)), "utf8");
    writeFileSync(htmlPath, page(panelMarkup(), styles));
    const output = execFileSync(electron, [
      ...(process.platform === "linux" ? ["--no-sandbox"] : []),
      `--user-data-dir=${userData}`,
      fileURLToPath(new URL("fixtures/transcript-scroll-browser.cjs", import.meta.url)),
      htmlPath,
    ], { encoding: "utf8", env, timeout: ELECTRON_TIMEOUT_MS });
    measured = JSON.parse(output.trim()) as Record<string, Measured>;
  } finally {
    rmSync(dir, { force: true, recursive: true });
    rmSync(userData, { force: true, recursive: true });
  }
});

const ALL_CASES = [
  "detail-closed",
  "detail-open",
  "detail-narrow",
  "detail-narrow-expanded",
  "detail-narrow-open",
];

for (const name of ALL_CASES) {
  test(`the conversation log scrolls inside its pane (${name})`, () => {
    const m = measured[name];
    assert.ok(m, `no geometry for ${name}`);

    // The log yields to the pane instead of growing to its content. This is the
    // assertion the shipped defect failed, and it fails LOUDLY: the log was more than
    // five times the height of the pane holding it.
    assert.ok(
      m.logHeight < m.boxHeight,
      `log must fit its pane, got ${m.logHeight}px inside ${m.boxHeight}px`,
    );
    // The conversation is genuinely longer than the view, so there is something to
    // scroll - without this the check above would pass on an empty log.
    assert.ok(
      m.contentHeight > m.logHeight,
      `fixture must overflow the log, got ${m.contentHeight}px of content in ${m.logHeight}px`,
    );
    // And it scrolls. Asked for the bottom, a clipped log answers 0.
    assert.ok(m.scrolledTo > 0, "log must scroll when asked to");

    // The reply box is the other half of the same failure: with the log unbounded it was
    // pushed below a pane that clips, so the session could be neither read nor answered.
    assert.ok(m.composeHeight > 0, "reply box must be rendered");
    assert.ok(
      m.composeBottomOverflow <= 1,
      `reply box must stay inside the pane, got ${m.composeBottomOverflow}px past its bottom`,
    );

    // No host-page sideways overflow at any width or state: a second column that does
    // not fit would poke past the pane's right edge before it ever broke a height.
    assert.ok(
      m.splitRightOverflow <= 1,
      `the conversation frame must fit its host's width, got ${m.splitRightOverflow}px past its right edge`,
    );
  });
}

for (const name of ALL_CASES) {
  test(`the in-progress row costs the log one line at most (${name})`, () => {
    const m = measured[name];
    assert.ok(m, `no geometry for ${name}`);

    // Present in every case: the fixture session is working with something to report, and
    // an assertion about a row that never rendered would pass on nothing.
    assert.ok((m.progressHeight ?? 0) > 0, "a working session draws its in-progress row");

    // The claim. `onScroll` treats a reader within 48px of the bottom as pinned there, so
    // a row that wrapped to two or three lines would appear underneath them, push them out
    // of that window, and stop the pane following the tail - a defect nothing in the DOM
    // can show, because the markup is identical either way. Held to half the threshold:
    // Terminal's one-line row is 24px, while a wrapped row is taller.
    assert.ok(
      (m.progressHeight ?? 0) <= STICK_TO_BOTTOM_PX / 2,
      `the in-progress row must stay on one line, got ${m.progressHeight}px`,
    );

    // And it got there by clipping, not by having short text: the fixture's activity line
    // is wider than any pane measured here, so an un-clipped row would have wrapped.
    assert.equal(m.progressClipped, true, "a long activity line must be clipped, not wrapped");

    // Sideways, the same discipline the split gets: a nowrap row that did not clip would
    // widen the log rather than growing it, and the overflow would leave through the right
    // edge instead of the bottom.
    assert.ok(
      (m.progressRightOverflow ?? 0) <= 1,
      `the in-progress row must fit the log's width, got ${m.progressRightOverflow}px past it`,
    );
  });
}

for (const name of ["detail-open", "detail-narrow-open"]) {
  test(`an open find owns the secondary slot and keeps its rail inside the pane (${name})`, () => {
    const m = measured[name];
    assert.ok(m, `no geometry for ${name}`);
    // The rail is visible exactly when find is open - the feature's stated invariant -
    // which means it has to fit as well as exist. Sized to its content it would hang out
    // of the same clipping pane the log did.
    assert.ok((m.railHeight ?? 0) > 0, "an open find renders its rail");
    assert.ok(
      (m.railBottomOverflow ?? 0) <= 1,
      `rail must stay inside the pane, got ${m.railBottomOverflow}px past its bottom`,
    );
    // Exclusive ownership, measured rather than argued: while find is open there is no
    // activity rail competing for the same column.
    assert.equal(m.activityPresent, false, "find open must withhold the activity rail");
    // Where the rail sits is the container query's doing, and it is measured rather
    // than trusted because it HAS failed silently: with `container-type` on the split
    // itself, the query could not restyle its own container and the stacked layout
    // never engaged at any width.
    assert.equal(
      m.railBelowLog,
      name.includes("narrow"),
      name.includes("narrow")
        ? "a narrow pane must stack the find rail under the log"
        : "a wide pane must keep the find rail beside the log",
    );
  });
}

for (const name of ["detail-closed"]) {
  test(`observed activity rides its own overflow region beside the log (${name})`, () => {
    const m = measured[name];
    assert.ok(m, `no geometry for ${name}`);
    assert.ok(m.activityPresent, "find closed must render the activity rail");
    // A side rail at these widths: the list shows, the narrow disclosure does not.
    assert.equal(m.activityBodyVisible, true, "the wide rail shows its list");
    assert.equal(m.activityToggleVisible, false, "the wide rail hides the narrow toggle");
    assert.equal(m.activityBelowLog, false, "a wide pane keeps activity beside the log");
    assert.ok(
      (m.activityBottomOverflow ?? 0) <= 1,
      `activity must stay inside the pane, got ${m.activityBottomOverflow}px past its bottom`,
    );
    // Independent overflow: the fixture holds more invocations than the rail's height,
    // and the rail answers a scroll itself instead of growing or handing it to the log.
    assert.ok(
      (m.activityContentHeight ?? 0) > (m.activityViewHeight ?? 0),
      `fixture must overflow the rail, got ${m.activityContentHeight}px of rows in ${m.activityViewHeight}px`,
    );
    assert.ok((m.activityScrolledTo ?? 0) > 0, "the activity list must scroll when asked to");
  });
}

for (const name of ["detail-narrow"]) {
  test(`narrow activity collapses to a reachable disclosure row (${name})`, () => {
    const m = measured[name];
    assert.ok(m, `no geometry for ${name}`);
    assert.ok(m.activityPresent, "the narrow layout keeps activity reachable");
    // Collapsed by default: one toggle row, no list - the transcript keeps its height
    // until the reader asks. The toggle must be laid out to be clickable at all.
    assert.equal(m.activityToggleVisible, true, "the narrow layout shows the disclosure toggle");
    assert.equal(m.activityBodyVisible, false, "collapsed activity holds no list open");
    assert.equal(m.activityBelowLog, true, "a narrow pane stacks activity under the log");
    // The whole collapsed section is a sliver, not a stacked pane.
    assert.ok(
      (m.activityHeight ?? 0) < 48,
      `collapsed activity should cost the transcript almost nothing, got ${m.activityHeight}px`,
    );
    assert.ok((m.activityBottomOverflow ?? 0) <= 1, "collapsed activity stays inside the pane");
  });
}

for (const name of ["detail-narrow-expanded"]) {
  test(`expanded narrow activity is bounded and scrolls without evicting the composer (${name})`, () => {
    const m = measured[name];
    assert.ok(m, `no geometry for ${name}`);
    assert.ok(m.activityPresent, `no activity rail in ${name}`);
    assert.equal(m.activityBodyVisible, true, "expanded activity shows its list");
    // Bounded: the stacked section is capped (33% of the split plus the toggle row),
    // so the transcript keeps the larger share of a narrow pane. 40% of the host is a
    // generous ceiling that still fails loudly if the cap ever stops resolving.
    assert.ok(
      (m.activityHeight ?? 0) <= m.boxHeight * 0.4,
      `expanded activity must stay bounded, got ${m.activityHeight}px of ${m.boxHeight}px`,
    );
    // And it scrolls its own overflow rather than growing past the cap.
    assert.ok(
      (m.activityContentHeight ?? 0) > (m.activityViewHeight ?? 0),
      "fixture must overflow the expanded activity list",
    );
    assert.ok((m.activityScrolledTo ?? 0) > 0, "the expanded activity list must scroll");
    assert.ok((m.activityBottomOverflow ?? 0) <= 1, "expanded activity stays inside the pane");
  });
}
