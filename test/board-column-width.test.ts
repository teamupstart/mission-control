/**
 * What is at stake: a board column's width - collapsed, normal, expanded - is one behaviour
 * drawn by two different components, and a collapsed column still says what it is.
 *
 * The board builds its tone columns in `BoardView`, and the Backlog builds its own head
 * inside `BacklogColumn`. A width control written twice would agree on the day it was
 * written and drift on the first retune - the mark-vocabulary problem `session-bits.tsx`
 * exists to prevent - so both heads render the SAME `ColumnWidthControl`, and both collapsed
 * columns the same `CollapsedColumnStrip`, and this pins that rather than checking two
 * hand-written copies that happen to match.
 *
 * The rest is what a double-click cannot say for itself. The gesture has no keyboard
 * equivalent, so the control has to exist as real buttons with real state; the drill-in
 * rail is a fixed-width console fixture, so it must neither offer to move nor be drawn as a
 * strip; and the stylesheet has to still answer the classes, which nothing else in this repo
 * would notice going missing.
 *
 * `createElement` rather than JSX because the runner's glob only matches .test.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SessionViewProps } from "../src/web/components/layouts/types.ts";
import type { Session } from "../src/shared/types.ts";
import type { SessionFilesController } from "../src/web/lib/sessionFiles.ts";
import type { ColumnWidth } from "../src/web/lib/column-width.ts";
import { mkSession, mkTask } from "./helpers/session-fixture.ts";
import { containsMarkup } from "./helpers/markup.ts";

// The collapsed set lives in the UI config store, which writes through to the daemon and
// takes a refused write back. An accepting daemon and a scratch cache, installed before the
// store is imported, let a case fold a column exactly the way the head control does.
const cache = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => cache.get(key) ?? null,
    setItem: (key: string, value: string) => void cache.set(key, value),
    removeItem: (key: string) => void cache.delete(key),
  },
});
Object.defineProperty(globalThis, "fetch", {
  configurable: true,
  value: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
});

const { BoardView } = await import("../src/web/components/layouts/BoardView.tsx");
const { BacklogColumn } = await import("../src/web/components/layouts/BacklogColumn.tsx");
const { CollapsedColumnStrip, ColumnWidthControl } = await import(
  "../src/web/components/session-bits.tsx"
);
const { updateUiConfig } = await import("../src/web/lib/uiConfig.ts");

const css = readFileSync(fileURLToPath(new URL("../src/web/styles.css", import.meta.url)), "utf8");
const rules = css.replace(/\/\*[\s\S]*?\*\//g, " ");

const noop = (): void => {};

function props(sessions: Session[]): SessionViewProps {
  return {
    sessions,
    tasks: [],
    backlog: [],
    onEditTask: noop,
    backlogPlan: null,
    selectedId: null,
    consoleZone: "rail",
    onConsoleZoneChange: noop,
    onSelect: noop,
    onCursorTo: noop,
    onDeselect: noop,
    detailId: null,
    onOpenReviews: noop,
    onRequeue: noop,
    onOpenFiles: noop,
    onOpenFile: () => false,
    onOpenFilePath: () => {},
    fileTabRequest: null,
    conversationTabRequest: null,
    workflowsTabRequest: null,
    diffTabRequest: null,
    files: {} as SessionFilesController,
    onReset: noop,
    onComplete: noop,
    onKill: noop,
    onKilled: noop,
    resetNonces: {},
    registerEl: noop,
    registerActions: noop,
    registerLaunchers: noop,
    registerFind: noop,
    registerDetailScroll: noop,
    registerReaderTab: noop,
    renamingId: null,
    onRenameStart: noop,
    onRenameClose: noop,
    foremanMode: "dry-run",
    foremanEnabled: false,
    foremanAllowlist: [],
    inputReviewBySession: new Map<string, string>(),
    pendingReviewIds: new Set<string>(),
    reviews: [],
  };
}

/** The shared control on its own, so each head's output can be checked against it. */
function control(width: ColumnWidth, label: string): string {
  return renderToStaticMarkup(createElement(ColumnWidthControl, { width, label, onChange: noop }));
}

/** The shared strip on its own, for the same comparison. */
function strip(label: string, count: number): string {
  return renderToStaticMarkup(createElement(CollapsedColumnStrip, { label, count, onRestore: noop }));
}

function backlog(over: Partial<Parameters<typeof BacklogColumn>[0]> = {}): string {
  const tasks = [mkTask({ id: "t1", title: "Ship it" })];
  return renderToStaticMarkup(
    createElement(BacklogColumn, {
      tasks,
      allTasks: tasks,
      plan: null,
      onAssignError: noop,
      onDragging: noop,
      onEdit: noop,
      ...over,
    }),
  );
}

/** Render the board with these columns folded, then put the store back. */
async function boardWithCollapsed(
  collapsed: string[],
  view: SessionViewProps,
): Promise<string> {
  await updateUiConfig({ collapsedBoardColumns: collapsed });
  try {
    return renderToStaticMarkup(createElement(BoardView, view));
  } finally {
    await updateUiConfig({ collapsedBoardColumns: [] });
  }
}

test("both kinds of column head draw the shared control, not a private copy", () => {
  const board = renderToStaticMarkup(createElement(BoardView, props([mkSession()])));
  assert.ok(
    containsMarkup(board, control("normal", "working")),
    "a tone column's head must draw the shared control",
  );
  assert.ok(
    containsMarkup(backlog({ width: "normal", onWidthChange: noop }), control("normal", "Backlog")),
    "the Backlog head must draw the same one",
  );
});

test("the control offers all three widths, says which is in force, and names the column", () => {
  const html = control("normal", "Backlog");
  // Three real buttons: double-click has no keyboard equivalent at all, so the control that
  // backs it up cannot be a hover-only decoration.
  assert.equal(html.match(/<button/g)?.length, 3);
  assert.match(html, /role="group" aria-label="Backlog width"/);
  assert.match(html, /aria-label="Collapse Backlog"/);
  assert.match(html, /aria-label="Backlog at normal width"/);
  assert.match(html, /aria-label="Expand Backlog"/);
  // Exactly one stop pressed, and it is the width the column is at.
  for (const width of ["collapsed", "normal", "wide"] as const) {
    const pressed = [...control(width, "Backlog").matchAll(/aria-pressed="true"[^>]*aria-label="([^"]+)"/g)];
    assert.equal(pressed.length, 1, `one stop pressed at ${width}`);
    const expected = { collapsed: "Collapse Backlog", normal: "Backlog at normal width", wide: "Expand Backlog" };
    assert.equal(pressed[0]![1], expected[width]);
  }
  // Not a radio group: its arrow keys would fight the board's own card navigation.
  assert.doesNotMatch(html, /role="radio/);
});

test("the count stays flush right - the control sits in the head's dead space", () => {
  // The count carries `margin-left: auto`. A control placed AFTER it reserves its width
  // even while transparent, which moved every column's count inboard to hold a gap for a
  // control nobody had hovered. Order is the whole fix, so order is what is pinned.
  const html = renderToStaticMarkup(createElement(BoardView, props([mkSession()])));
  const head = /<header class="board-col-head">.*?<\/header>/s.exec(html)?.[0] ?? "";
  assert.ok(head, "a column head must render");
  assert.ok(
    head.indexOf("board-col-width") < head.indexOf("board-col-n"),
    "the control must precede the count",
  );
});

test("a column rendered outside a board offers no width control", () => {
  // Width is a BOARD arrangement. The Sitrep and the tests render this column on its
  // own, and a control there would change a state nothing draws.
  assert.ok(!backlog().includes("board-col-width"));
  assert.ok(!backlog().includes("is-wide"));
  assert.ok(!backlog({ width: "collapsed" }).includes("board-col-strip"));
});

test("a collapsed Backlog is the shared strip, holding its count, with no cards behind it", () => {
  const html = backlog({ width: "collapsed", onWidthChange: noop });
  assert.match(html, /class="board-col board-backlog is-collapsed"/);
  assert.ok(containsMarkup(html, strip("Backlog", 1)), "the Backlog must draw the shared strip");
  assert.match(html, /aria-label="Restore Backlog, 1 card"/);
  assert.ok(!html.includes("Ship it"), "a strip hides its cards");
  assert.ok(!html.includes("board-col-head"), "a strip has no head to hover");
});

test("a collapsed tone column is the shared strip, and the rest of the board is untouched", async () => {
  const working = mkSession({ id: "w1", state: "working" });
  const html = await boardWithCollapsed(["working"], props([working]));
  assert.match(html, /class="board-col tone-working is-collapsed"/);
  assert.ok(containsMarkup(html, strip("working", 1)), "a tone column must draw the shared strip");
  assert.match(html, /aria-label="Restore working, 1 card"/);
  assert.ok(!html.includes('class="tile'), "the strip hides the column's cards");
  // The Backlog beside it keeps its normal head: folding one column folds that column.
  assert.match(html, /aria-label="Backlog width"/);
});

test("an empty Needs you is the all-clear rail with no width control, unless it was collapsed", async () => {
  // Empty and not collapsed: the slim all-clear rail, which has nothing to read wider.
  const working = mkSession({ id: "w1", state: "working" });
  const calm = renderToStaticMarkup(createElement(BoardView, props([working])));
  const rail = /<section class="board-col tone-attention[^"]*">.*?<\/section>/s.exec(calm)?.[0] ?? "";
  assert.match(rail, /is-calm/);
  assert.ok(!rail.includes("board-col-width"), "the all-clear rail must not offer a width");

  // Collapsed wins over calm, so the strip stays mounted to pulse when a session arrives.
  const html = await boardWithCollapsed(["attention"], props([working]));
  assert.match(html, /class="board-col tone-attention is-collapsed"/);
  assert.match(html, /aria-label="Restore needs you, 0 cards"/);
});

test("the Backlog leaves the tab order during a drill-in, collapsed or not", async () => {
  // The morph folds every non-rail column to zero width. A strip or card nobody can see must
  // not keep its controls reachable by Tab, which the tone columns already guarantee.
  const session = mkSession();
  const drilled = { ...props([session]), detailId: session.id };
  const backlogSection = (html: string): string =>
    /<section class="board-col board-backlog[^"]*"[^>]*>/.exec(html)?.[0] ?? "";

  const normal = backlogSection(renderToStaticMarkup(createElement(BoardView, drilled)));
  assert.ok(normal, "the Backlog must render");
  assert.match(normal, /\binert=""/);

  const collapsed = backlogSection(await boardWithCollapsed(["backlog"], drilled));
  assert.match(collapsed, /is-collapsed/);
  assert.match(collapsed, /\binert=""/);

  // And back on the overview, it is reachable again.
  const overview = backlogSection(renderToStaticMarkup(createElement(BoardView, props([session]))));
  assert.doesNotMatch(overview, /\binert/);
});

test("the drilled-in rail is never a strip and offers no width control", async () => {
  // A session in a collapsed column can still be opened - from the Line, the palette, a
  // notification - and the rail is a fixed-width console fixture that has to show its rows.
  const session = mkSession();
  const html = await boardWithCollapsed(["idle"], { ...props([session]), detailId: session.id });
  const rail = /<section class="board-col[^"]*is-rail[^"]*">.*?<\/header>/s.exec(html)?.[0] ?? "";
  assert.ok(rail, "a drill-in must produce a rail column");
  assert.ok(!rail.includes("is-collapsed"), "the rail must not be drawn as a strip");
  assert.ok(!rail.includes("board-col-width"), "the rail head must not offer to move");
});

test("a collapsed Needs you pulses when a session arrives, and only then", () => {
  // The count remounts under a new key on each rise, which is what replays the animation.
  // Server rendering never runs the effect, so the first paint is always still.
  const html = renderToStaticMarkup(
    createElement(CollapsedColumnStrip, { label: "needs you", count: 3, announce: true, onRestore: noop }),
  );
  assert.ok(!html.includes("is-pulsing"), "a strip must not pulse on its first paint");
  assert.match(rules, /\.board-col-strip-n\.is-pulsing\s*\{[^}]*animation:\s*board-strip-pulse/);
  assert.match(rules, /@keyframes board-strip-pulse/);
  // Still under reduced motion: the rule lives inside the no-preference query only.
  const pulse = css.indexOf(".board-col-strip-n.is-pulsing");
  const query = css.lastIndexOf("@media (prefers-reduced-motion: no-preference)", pulse);
  assert.ok(query !== -1 && pulse - query < 200, "the pulse must be inside the motion query");
});

test("the stylesheet still answers the classes, and only off the drill-in", () => {
  // The exact defect CLAUDE.md warns about: nothing here notices a class that lost its
  // rule - no linter, no typecheck, no render test.
  const wide = /\.board\[data-focus="none"\]\s+\.board-col\.is-wide\s*\{([^}]*)\}/.exec(rules)?.[1];
  assert.ok(wide, "`.is-wide` needs a rule, scoped so the drill-in morph still wins");
  // A floor plus a bigger share, never a fixed width: pinning the width let the widened
  // column take 799px and clamp `working` - the column with the live agents in it - to
  // its 250px minimum with every tile name ellipsed.
  assert.match(wide, /min-width:\s*var\(--board-col-wide\)/);
  assert.match(wide, /flex-grow:\s*2\b/);
  assert.match(rules, /--board-col-wide:/, "the width is a token, not a number in a rule");

  // Collapsed is a FIXED track in both the basis and the floor: the Backlog and an all-clear
  // column are sized by basis, and would keep 232px / 250px if only one of the two moved.
  const collapsed = /\.board\[data-focus="none"\]\s+\.board-col\.is-collapsed\s*\{([^}]*)\}/.exec(rules)?.[1];
  assert.ok(collapsed, "`.is-collapsed` needs a rule, scoped so the drill-in morph still wins");
  assert.match(collapsed, /flex-grow:\s*0\b/);
  assert.match(collapsed, /flex-basis:\s*var\(--board-col-collapsed\)/);
  assert.match(collapsed, /min-width:\s*var\(--board-col-collapsed\)/);
  assert.match(rules, /--board-col-collapsed:\s*40px/);

  // The card has to USE the width rather than be stretched by it - and every one of
  // these rules carries the SAME `[data-focus="none"]` scope as the width itself.
  // The expanded column survives a drill-in on purpose, so a column the morph has
  // squeezed to zero still wears `is-wide`; a reflow rule that forgot the scope kept
  // re-laying-out cards on their way off screen. The test walks every `is-wide` rule
  // rather than naming two of them.
  const wideSelectors = [...rules.matchAll(/([^{}]*\.is-wide[^{}]*)\{[^}]*\}/g)].map((m) =>
    (m[1] ?? "").trim(),
  );
  assert.ok(wideSelectors.length >= 4, "expected the width rule plus the card reflow rules");
  for (const selector of wideSelectors) {
    assert.match(
      selector,
      /^\.board\[data-focus="none"\]/,
      `every .is-wide rule must be scoped off the drill-in; "${selector}" is not`,
    );
  }
  assert.match(rules, /\.is-wide\s+\.bl-card\s*\{[^}]*flex-flow:\s*row wrap/);
  assert.match(rules, /\.is-wide\s+\.bl-title\s*\{[^}]*flex:\s*0 0 100%/);
  // Double-click must not leave the column name selected behind the move.
  assert.match(rules, /\.board-col-head\s*\{[^}]*user-select:\s*none/);
});
