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
  assert.match(detailFocused, /class="console-detail" tabindex="-1"/);
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
  const start = app.indexOf('if (layout === "console" && selected)');
  assert.ok(start >= 0, "no Console zone branch in the key handler");
  const body = app.slice(start, app.indexOf("if (typing) return;", start));
  assert.match(body, /chord === "Tab" && consoleZone === "rail"/);
  assert.match(body, /chord === "shift\+Tab" && consoleZone === "detail"/);
  assert.match(body, /setConsoleZone\("detail"\)/);
  assert.match(body, /setConsoleZone\("rail"\)/);
  assert.ok(
    app.indexOf("if (typing) return;", start) > app.indexOf('chord === "shift+Tab"', start),
    "Shift+Tab from a detail composer does not return focus to the rail",
  );
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
});

test("zone transitions move DOM focus and hidden selections reset to the rail", () => {
  const app = source("App.tsx");
  const consoleView = source("components/layouts/ConsoleView.tsx");
  const railRow = source("components/layouts/RailRow.tsx");
  assert.match(app, /setConsoleZone\("rail"\);[\s\S]*\[visibleSelectedId, layout\]/);
  assert.match(consoleView, /zone === "detail"[\s\S]*detailRef\.current\?\.focus\(\{ preventScroll: true \}\)/);
  assert.match(consoleView, /focusSelected=\{s\.id === props\.selectedId && zone === "rail"\}/);
  assert.match(railRow, /if \(focusSelected\) ref\.current\?\.focus\(\{ preventScroll: true \}\)/);
});
