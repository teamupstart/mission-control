import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConsoleView } from "../src/web/components/layouts/ConsoleView.tsx";
import type { SessionViewProps } from "../src/web/components/layouts/types.ts";
import type { WorkflowRunSummary } from "../src/shared/workflow.ts";
import { mkSession } from "./helpers/session-fixture.ts";
import type { SessionFilesController } from "../src/web/lib/sessionFiles.ts";

// The Console has two focus zones and one job here: the selected rail row must be
// unmistakable, and the vertical arrows must do the right thing in whichever zone holds
// the keyboard. The zone transition lives in App's global key handler, which can't be
// rendered without a daemon, so its wiring is pinned by scraping the source (the same way
// console-arrow-scroll.test.ts pins the scroll routing); the rail's selection marking and
// the zone attribute the CSS reads are pinned by static render.

const source = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/web/${relative}`, import.meta.url)), "utf8");

function props(over: Partial<SessionViewProps> = {}): SessionViewProps {
  return {
    sessions: [mkSession()],
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
    ...over,
  };
}

test("the selected rail row is marked so the CSS can frame it", () => {
  const session = mkSession();
  const html = renderToStaticMarkup(
    createElement(ConsoleView, props({ sessions: [session], selectedId: session.id })),
  );
  // `selected` is what draws the green selector frame; `aria-current` is the same signal
  // for assistive tech. A row with neither is the "too hard to see" state this fixes.
  assert.match(html, /class="rail-row [^"]*selected/);
  assert.match(html, /aria-current="true"/);
});

test("the rail hands its focus zone to the console via a data attribute", () => {
  const session = mkSession();
  const railFocused = renderToStaticMarkup(
    createElement(ConsoleView, props({ sessions: [session], selectedId: session.id, consoleZone: "rail" })),
  );
  assert.match(railFocused, /class="console" data-zone="rail"/);

  const detailFocused = renderToStaticMarkup(
    createElement(ConsoleView, props({ sessions: [session], selectedId: session.id, consoleZone: "detail" })),
  );
  assert.match(detailFocused, /class="console" data-zone="detail"/);
  // The reader body is the focusable fallback. Files can put focus one level deeper on its
  // preview, while every other tab lands here rather than in the header.
  assert.match(detailFocused, /class="detail-body" tabindex="-1"/);
});

test("the rail group count splits into free and held, like the board head", () => {
  // "idle 5" over three held agents reads as five free ones - the rail is the surface a
  // dispatch glance scans, so its count has to make the same distinction the board's does.
  const free = mkSession({ id: "free-1", name: "free", state: "idle", activity: null });
  const held = mkSession({ id: "held-1", name: "held", state: "idle", activity: null });
  const run: WorkflowRunSummary = {
    id: "run",
    bindingId: "binding",
    workflowId: "workflow",
    workflowName: "Review",
    workflowVersion: 1,
    sessionId: held.id,
    noteKey: "note",
    status: "running",
    phase: "persona_feedback",
    round: 1,
    maxRepairRounds: 5,
    activePersonaNames: [],
    failedPersonaCount: 0,
    bypassedPersonaReview: false,
    gate: "none",
    gatePrNumber: null,
    gateHeadShort: null,
    reviewPosture: null,
    updatedAt: 1,
  };
  const html = renderToStaticMarkup(
    createElement(
      ConsoleView,
      props({
        sessions: [free, held],
        workflowRunsBySession: new Map([[held.id, [run]]]),
      }),
    ),
  );
  assert.match(html, /class="rail-group-n rail-group-split"/);
  assert.match(html, /class="n-free"[^>]*>1 free</);
  assert.match(html, /class="n-held"[^>]*>1 held</);
  // And the held row itself is marked, so the split survives the header scrolling away.
  assert.match(html, /class="rail-row [^"]*is-held/);

  // A group with nothing held keeps its single number - no split to announce.
  const plain = renderToStaticMarkup(
    createElement(ConsoleView, props({ sessions: [free] })),
  );
  assert.match(plain, /class="rail-group-n">1</);
  assert.doesNotMatch(plain, /rail-group-split/);
});

test("with nothing open the zone is the rail, whatever App last held", () => {
  // No session beside the rail means no reader to hand focus to, so a stale `detail` from
  // a session that just closed must not leave the empty pane wearing the active ring.
  const html = renderToStaticMarkup(
    createElement(ConsoleView, props({ selectedId: null, consoleZone: "detail" })),
  );
  assert.match(html, /data-zone="rail"/);
});

test("one reader-nav branch drives Tab and Shift+Tab in both console and board", () => {
  const app = source("App.tsx");
  // readerSession is the open detail's session: the console shows one beside the rail, the
  // board shows one while drilled in. Both mount the same ConsoleDetail, so one branch.
  const rs = app.indexOf("const readerSession =");
  assert.ok(rs >= 0, "no readerSession in the key handler");
  assert.match(
    app.slice(rs, rs + 160),
    /layout === "console" \? selected : layout === "board" && boardOpen \? selected : null/,
  );
  const start = app.indexOf("if (readerSession && !typing)");
  assert.ok(start >= 0, "no typing-guarded reader branch");
  const body = app.slice(start, app.indexOf("if (typing) return;", start));
  // Gated on real DOM focus (`.cdetail`, ConsoleDetail's shared root), not the layout or the
  // lagging zone state. Tab enters the reader from outside, else steps the tab strip forward.
  assert.match(body, /const inReader = Boolean\(target\?\.closest\("\.cdetail"\)\)/);
  assert.match(body, /if \(chord === "Tab"\)[\s\S]*!inReader[\s\S]*focusReaderBody\(\)[\s\S]*readerTabbers\.current\.get\(readerSession\.id\)\?\.\(1\)/);
  // Shift+Tab steps back; running off the front hands focus to the rail.
  assert.match(body, /chord === "shift\+Tab" && inReader/);
  assert.match(body, /readerTabbers\.current\.get\(readerSession\.id\)\?\.\(-1\) !== "moved"[\s\S]*focusReaderRail\(readerSession\.id\)/);
});

test("Escape peels the reader back to the rail before closing or dropping selection", () => {
  const app = source("App.tsx");
  const escape = app.indexOf('case "Escape":');
  const drop = app.indexOf("setSelectedId(null)", escape);
  const branch = app.slice(escape, drop);
  // In-reader Escape (focus in `.cdetail`) hands the keyboard to the rail, and it sits ABOVE
  // the board-close and the selection-drop - so one Escape peels and the next closes.
  assert.match(branch, /readerSession && target\?\.closest\("\.cdetail"\)[\s\S]*setConsoleZone\("rail"\)[\s\S]*focusReaderRail/);
  const peel = branch.indexOf('readerSession && target?.closest(".cdetail")');
  const boardClose = branch.indexOf('layout === "board" && boardOpen');
  assert.ok(peel >= 0 && boardClose > peel, "the reader peel must precede the board drill-in close");
});

test("zone transitions move DOM focus and hidden selections reset to the rail", () => {
  const app = source("App.tsx");
  const consoleView = source("components/layouts/ConsoleView.tsx");
  const railRow = source("components/layouts/RailRow.tsx");
  assert.match(app, /setConsoleZone\("rail"\);[\s\S]*\[visibleSelectedId, layout\]/);
  // Files lands on its preview; every other tab uses the detail body fallback.
  assert.match(app, /querySelector<HTMLElement>\("\.cdetail \.file-preview-reader"\)/);
  assert.match(app, /\?\? document\.querySelector<HTMLElement>\("\.cdetail \.detail-body"\)/);
  assert.match(app, /target\?\.focus\(\{ preventScroll: true \}\)/);
  assert.match(app, /cardEls\.current\.get\(id\)\?\.focus\(\{ preventScroll: true \}\)/);
  assert.match(consoleView, /onFocusCapture=\{\(\) => props\.onConsoleZoneChange\("rail"\)\}/);
  assert.match(consoleView, /onFocusCapture=\{\(\) => props\.onConsoleZoneChange\("detail"\)\}/);
  assert.doesNotMatch(railRow, /focusSelected/);
});

test("Tab enters the reader from anywhere outside it, whatever the zone state says", () => {
  // Two regressions this pins at once. First: gating on `inConsoleRail` (#221) meant Tab did
  // nothing but native browser tabbing unless focus already sat ON a rail row. Then gating on
  // `consoleZone === "rail"` (the state) desynced the other way - a stale "detail" zone with
  // focus still on the rail let Tab walk to the next rail row. The gate that survives both is
  // actual DOM focus: outside the reader Tab always enters, so it can never fall through to
  // the browser while a session is open.
  const app = source("App.tsx");
  assert.match(app, /const inReader = Boolean\(target\?\.closest\("\.cdetail"\)\)/);
  assert.match(app, /chord === "shift\+Tab" && inReader/);
  assert.doesNotMatch(app, /chord === "Tab" && consoleZone/);
  assert.doesNotMatch(app, /inConsoleRail/);
  assert.doesNotMatch(app, /inConsoleDetail/);
  // focusReaderRail still refuses to steal focus from an editor outside the reader (the
  // topbar filter), so arrow-walking the rail never yanks the cursor out of the filter box.
  assert.match(app, /activeEditor && !active\?\.closest\("\.cdetail"\)/);
});
