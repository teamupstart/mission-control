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
  const start = app.indexOf('case "Tab":');
  assert.ok(start >= 0, "no Tab case in the key handler");
  const body = app.slice(start, app.indexOf('case "Enter":', start));
  // Only meaningful in the Console, and only once a session is open beside the rail.
  assert.match(body, /layout !== "console" \|\| !selectedId/);
  // Plain Tab hands focus to the reader; Shift+Tab hands it back.
  assert.match(body, /setConsoleZone\("detail"\)/);
  assert.match(body, /setConsoleZone\("rail"\)/);
  // Shift+Tab only steps back FROM the reader; in the rail zone it falls through so the
  // `mode` binding on Shift+Tab keeps working in Console like every other layout.
  assert.match(body, /consoleZone !== "detail"\) break/);
});

test("Escape peels the reader zone back to the rail before dropping the selection", () => {
  const app = source("App.tsx");
  const escape = app.indexOf('case "Escape":');
  const drop = app.indexOf("setSelectedId(null)", escape);
  const branch = app.slice(escape, drop);
  // The zone step-back sits above the selection-clearing return, so one Escape returns to
  // the rail and only a second clears the selection - the layered peel the grid and board
  // already do.
  assert.match(branch, /consoleZone === "detail"[\s\S]*setConsoleZone\("rail"\)/);
});
