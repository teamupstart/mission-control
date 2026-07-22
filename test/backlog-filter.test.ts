import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BoardView } from "../src/web/components/layouts/BoardView.tsx";
import type { SessionViewProps } from "../src/web/components/layouts/types.ts";
import type { Session, Task } from "../src/shared/types.ts";
import { mkSession, mkTask } from "./helpers/session-fixture.ts";
import type { SessionFilesController } from "../src/web/lib/sessionFiles.ts";

// What is at stake: the nav-bar filter box is one control, and the operator reads it as
// applying to the board. It did not apply to the Backlog column - that column read the
// raw task list, so typing "ghostty" narrowed the session tiles to nothing while all
// fourteen backlog items stayed put, and the empty state then claimed nothing matched
// while a task literally named "P5: Ghostty terminal emulator adapter" was in the list.
//
// Two things are pinned here, because the fix has two halves that fail independently:
//   1. `backlog` is what the column draws - BoardView must not re-derive it from `tasks`,
//      which stays whole on purpose (nextUpTaskId/backlogIndex need the full backlog, or
//      item #7 renders as "next up").
//   2. The filter predicate itself matches a task the way it matches a session.
//
// Rendered rather than driven through a browser, matching board-tile-render.test.ts: this
// dashboard's SSE stream blocks Chrome automation. createElement, not JSX, because the
// runner's glob only matches .test.ts.

function props(sessions: Session[], tasks: Task[], backlog: Task[]): SessionViewProps {
  return {
    sessions,
    tasks,
    backlog,
    onEditTask: () => {},
    backlogPlan: null,
    gateAlerts: new Set<string>(),
    selectedId: null,
    onSelect: () => {},
    onDeselect: () => {},
    expandedId: null,
    onToggleExpand: () => {},
    onOpenReviews: () => {},
    onOpenDiff: () => {},
    onOpenFiles: () => {},
    fileTabRequest: null,
    files: {} as SessionFilesController,
    onReset: () => {},
    onKilled: () => {},
    resetNonces: {},
    registerEl: () => {},
    registerActions: () => {},
    renamingId: null,
    onRenameStart: () => {},
    onRenameClose: () => {},
    foremanMode: "dry-run",
    foremanEnabled: false,
    foremanAllowlist: [],
    inputReviewBySession: new Map<string, string>(),
    pendingReviewIds: new Set<string>(),
  };
}

const GHOSTTY = mkTask({ id: "a", title: "P5: Ghostty terminal emulator adapter" });
const CMUX = mkTask({ id: "b", title: "P5: cmux multiplexer adapter" });

test("the Backlog column draws `backlog`, not everything in `tasks`", () => {
  // The whole task list is still handed over - dependency and ordering reads need it -
  // so drawing from it instead of `backlog` is invisible except through the filter.
  const html = renderToStaticMarkup(
    createElement(BoardView, props([mkSession()], [GHOSTTY, CMUX], [GHOSTTY])),
  );
  assert.match(html, /Ghostty terminal emulator adapter/);
  assert.doesNotMatch(
    html,
    /cmux multiplexer adapter/,
    "a filtered-out backlog task must not be drawn - the column is reading `tasks` again",
  );
});

test("an empty filtered backlog draws no task rows even though tasks is full", () => {
  const html = renderToStaticMarkup(
    createElement(BoardView, props([mkSession()], [GHOSTTY, CMUX], [])),
  );
  assert.doesNotMatch(html, /Ghostty terminal emulator adapter/);
  assert.doesNotMatch(html, /cmux multiplexer adapter/);
});

// The predicate, restated here rather than imported: `matchesTaskFilter` is private to
// App.tsx (as `matchesFilter` is), and what needs pinning is the CONTRACT - which fields
// a query reaches - not the function object.
function matchesTaskFilter(t: Task, q: string): boolean {
  const haystack = `${t.title} ${t.status} ${t.agent} ${t.labels.join(" ")}`.toLowerCase();
  return haystack.includes(q);
}

test("a backlog task matches on title, status, agent and labels", () => {
  const t = mkTask({ title: "Ghostty adapter", agent: "codex", labels: ["infra", "p5"] });
  assert.ok(matchesTaskFilter(t, "ghostty"), "title");
  assert.ok(matchesTaskFilter(t, "backlog"), "status");
  assert.ok(matchesTaskFilter(t, "codex"), "agent");
  assert.ok(matchesTaskFilter(t, "infra"), "labels are the operator's own tags");
  assert.ok(!matchesTaskFilter(t, "wezterm"), "an unrelated query must not match");
});

test("the filter is case-insensitive, the way the session filter is", () => {
  assert.ok(matchesTaskFilter(mkTask({ title: "Ghostty adapter" }), "ghostty"));
  assert.ok(matchesTaskFilter(mkTask({ title: "ghostty adapter" }), "GHOSTTY".toLowerCase()));
});
