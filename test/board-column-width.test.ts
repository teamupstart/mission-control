/**
 * What is at stake: widening a board column is one behaviour drawn by two different
 * components, and it has one way back.
 *
 * The board builds its tone columns in `BoardView`, and the Backlog builds its own head
 * inside `BacklogColumn`. A widen affordance written twice would agree on the day it was
 * written and drift on the first retune - the mark-vocabulary problem `session-bits.tsx`
 * exists to prevent - so both heads render the SAME `ColumnWidthToggle`, and this pins
 * that rather than checking two hand-written copies that happen to match.
 *
 * The rest is what a double-click cannot say for itself. The gesture has no keyboard
 * equivalent, so the toggle has to exist as a real control with real state; the drill-in
 * rail is a fixed-width console fixture, so it must not offer to widen something that
 * cannot move; and the stylesheet has to still answer the class, which nothing else in
 * this repo would notice going missing.
 *
 * `createElement` rather than JSX because the runner's glob only matches .test.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BoardView } from "../src/web/components/layouts/BoardView.tsx";
import { BacklogColumn } from "../src/web/components/layouts/BacklogColumn.tsx";
import { ColumnWidthToggle } from "../src/web/components/session-bits.tsx";
import type { SessionViewProps } from "../src/web/components/layouts/types.ts";
import type { Session } from "../src/shared/types.ts";
import type { SessionFilesController } from "../src/web/lib/sessionFiles.ts";
import { mkSession, mkTask } from "./helpers/session-fixture.ts";
import { containsMarkup } from "./helpers/markup.ts";

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
    gateAlerts: new Set<string>(),
    selectedId: null,
    consoleZone: "rail",
    onConsoleZoneChange: noop,
    onSelect: noop,
    onDeselect: noop,
    expandedId: null,
    onToggleExpand: noop,
    onOpenReviews: noop,
    onOpenDiff: noop,
    onOpenFiles: noop,
    onOpenFile: () => false,
    fileTabRequest: null,
    conversationTabRequest: null,
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
  };
}

/** The shared toggle on its own, so each head's output can be checked against it. */
function bit(wide: boolean, label: string): string {
  return renderToStaticMarkup(createElement(ColumnWidthToggle, { wide, label, onToggle: noop }));
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

test("both kinds of column head draw the shared toggle, not a private copy", () => {
  const board = renderToStaticMarkup(createElement(BoardView, props([mkSession()])));
  assert.ok(
    containsMarkup(board, bit(false, "working")),
    "a tone column's head must draw the shared toggle",
  );
  assert.ok(
    containsMarkup(backlog({ onToggleWide: noop }), bit(false, "Backlog")),
    "the Backlog head must draw the same one",
  );
});

test("the toggle says which way the column is set, and names the column it moves", () => {
  // `aria-pressed` rather than two buttons or a second glyph: the column is wide or it
  // is not, and one control saying so cannot drift from itself.
  assert.match(bit(false, "Backlog"), /aria-pressed="false"/);
  assert.match(bit(true, "Backlog"), /aria-pressed="true"/);
  assert.match(bit(false, "Backlog"), /aria-label="Widen Backlog"/);
  assert.match(bit(true, "Backlog"), /aria-label="Narrow Backlog"/);
  // Double-click has no keyboard equivalent at all, so the control that backs it up has
  // to be a real button rather than a hover-only decoration.
  assert.match(bit(false, "Backlog"), /^<button/);
});

test("the count stays flush right - the toggle sits in the head's dead space", () => {
  // The count carries `margin-left: auto`. A control placed AFTER it reserves its width
  // even while transparent, which moved every column's count inboard to hold a gap for a
  // button nobody had hovered. Order is the whole fix, so order is what is pinned.
  const html = renderToStaticMarkup(createElement(BoardView, props([mkSession()])));
  const head = /<header class="board-col-head">.*?<\/header>/s.exec(html)?.[0] ?? "";
  assert.ok(head, "a column head must render");
  assert.ok(
    head.indexOf("board-col-width") < head.indexOf("board-col-n"),
    "the toggle must precede the count",
  );
});

test("a column rendered outside a board offers no width control", () => {
  // Width is a BOARD arrangement. The Sitrep and the tests render this column on its
  // own, and a control there would toggle a state nothing draws.
  assert.ok(!backlog().includes("board-col-width"));
  assert.ok(!backlog().includes("is-wide"));
});

test("the drilled-in rail offers no width control - it cannot move", () => {
  const session = mkSession();
  const html = renderToStaticMarkup(
    createElement(BoardView, { ...props([session]), expandedId: session.id }),
  );
  const rail = /<section class="board-col[^"]*is-rail[^"]*">.*?<\/header>/s.exec(html)?.[0] ?? "";
  assert.ok(rail, "a drill-in must produce a rail column");
  assert.ok(!rail.includes("board-col-width"), "the rail head must not offer to widen");
});

test("the stylesheet still answers the class, and only off the drill-in", () => {
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

  // The card has to USE the width rather than be stretched by it - and every one of
  // these rules carries the SAME `[data-focus="none"]` scope as the width itself.
  // `wideCol` survives a drill-in on purpose, so a collapsed column still wears
  // `is-wide`; a reflow rule that forgot the scope kept re-laying-out cards that the
  // morph was squeezing to zero width. Width and layout are one statement about one
  // column, so the test walks every `is-wide` rule rather than naming two of them.
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
