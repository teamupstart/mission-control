import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConsoleView } from "../src/web/components/layouts/ConsoleView.tsx";
import type { SessionViewProps } from "../src/web/components/layouts/types.ts";
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
    gateAlerts: new Set<string>(),
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
    fileTabRequest: null,
    diffTabRequest: null,
    files: {} as SessionFilesController,
    onReset: () => {},
    onComplete: () => {},
    onKill: () => {},
    onKilled: () => {},
    resetNonces: {},
    registerEl: () => {},
    registerActions: () => {},
    registerDetailScroll: () => {},
    renamingId: null,
    onRenameStart: () => {},
    onRenameClose: () => {},
    foremanMode: "dry-run",
    foremanEnabled: false,
    foremanAllowlist: [],
    inputReviewBySession: new Map<string, string>(),
    pendingReviewIds: new Set<string>(),
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
  // The reader body is the focusable target - Tab lands on the conversation pane, not the
  // whole section, so its ring frames what is read and a stray Tab does not hit the header.
  assert.match(detailFocused, /class="detail-body" tabindex="-1"/);
});

test("with nothing open the zone is the rail, whatever App last held", () => {
  // No session beside the rail means no reader to hand focus to, so a stale `detail` from
  // a session that just closed must not leave the empty pane wearing the active ring.
  const html = renderToStaticMarkup(
    createElement(ConsoleView, props({ selectedId: null, consoleZone: "detail" })),
  );
  assert.match(html, /data-zone="rail"/);
});

test("App wires Tab and Shift+Tab to the console focus zones", () => {
  const app = source("App.tsx");
  // The `!typing` in the guard is load-bearing: it is what keeps native Tab in the topbar
  // filter and the reply composer instead of hijacking it into a zone switch.
  const start = app.indexOf('if (layout === "console" && selected && !typing)');
  assert.ok(start >= 0, "no typing-guarded Console zone branch in the key handler");
  const body = app.slice(start, app.indexOf("if (typing) return;", start));
  // The handoff is gated on the logical zone, not on which element holds DOM focus, so one
  // Tab enters the reader whatever the last click left focused.
  assert.match(body, /chord === "Tab" && consoleZone === "rail"/);
  assert.match(body, /chord === "shift\+Tab" && consoleZone === "detail"/);
  assert.match(body, /setConsoleZone\("detail"\)/);
  assert.match(body, /setConsoleZone\("rail"\)/);
});

test("Escape peels the reader zone back to the rail before dropping the selection", () => {
  const app = source("App.tsx");
  const escape = app.indexOf('case "Escape":');
  const drop = app.indexOf("setSelectedId(null)", escape);
  const branch = app.slice(escape, drop);
  // The zone step-back sits above the selection-clearing return, so one Escape returns to
  // the rail and only a second clears the selection - the layered peel the grid and board
  // already do.
  assert.match(branch, /selected && consoleZone === "detail"[\s\S]*setConsoleZone\("rail"\)/);
  assert.doesNotMatch(branch, /selected && inConsoleDetail/);
});

test("zone transitions move DOM focus and hidden selections reset to the rail", () => {
  const app = source("App.tsx");
  const consoleView = source("components/layouts/ConsoleView.tsx");
  const railRow = source("components/layouts/RailRow.tsx");
  assert.match(app, /setConsoleZone\("rail"\);[\s\S]*\[visibleSelectedId, layout\]/);
  // Tab lands focus on the reader body (the conversation pane), not the section shell.
  assert.match(app, /querySelector<HTMLElement>\("\.detail-body"\)[\s\S]*\?\.focus\(\{ preventScroll: true \}\)/);
  assert.match(app, /cardEls\.current\.get\(id\)\?\.focus\(\{ preventScroll: true \}\)/);
  assert.match(consoleView, /onFocusCapture=\{\(\) => props\.onConsoleZoneChange\("rail"\)\}/);
  assert.match(consoleView, /onFocusCapture=\{\(\) => props\.onConsoleZoneChange\("detail"\)\}/);
  assert.doesNotMatch(railRow, /focusSelected/);
});

test("Tab enters the reader from the rail zone whatever element holds focus", () => {
  // The regression this pins: gating the handoff on DOM focus (`inConsoleRail`) meant a bare
  // Tab did nothing but native browser tabbing unless focus already sat on a rail row - so
  // opening a session and pressing Tab walked the buttons instead of the conversation. The
  // gate must be the logical zone, and no focus-scoped early return may let Tab escape to
  // the browser while a session is open.
  const app = source("App.tsx");
  assert.match(app, /chord === "Tab" && consoleZone === "rail"/);
  assert.match(app, /chord === "shift\+Tab" && consoleZone === "detail"/);
  assert.doesNotMatch(app, /inConsoleRail/);
  assert.doesNotMatch(app, /inConsoleDetail/);
  // focusConsoleRail still refuses to steal focus from an editor outside the detail (the
  // topbar filter), so arrow-walking the rail never yanks the cursor out of the filter box.
  assert.match(app, /activeEditor && !active\?\.closest\("\.console-detail"\)/);
});
