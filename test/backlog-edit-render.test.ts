import { test } from "node:test";
import { mkTask as baseTask } from "./helpers/session-fixture.ts";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { withOverlayHost } from "./helpers/overlay-host.ts";
import type { Task } from "../src/shared/types.ts";
import { DispatchLayer } from "../src/web/components/DispatchModal.tsx";
import { BacklogColumn } from "../src/web/components/layouts/BacklogColumn.tsx";

// Reopening a shelved task in the form that wrote it. Static markup rather than a
// driven browser: the dashboard's pages don't take script injection from the
// automation extension, and what's at stake here is words and structure, which markup
// answers honestly. createElement, not JSX, because the runner's glob only matches
// .test.ts.
//
// The failure this guards against is a form that LOOKS like the dispatch dialog while
// meaning something else: an editor whose fields come up blank loses the task in front
// of you, and one whose buttons still say "Dispatch" and "Add to backlog" is offering
// to create a second copy of the row it is sitting on.

/** The shared task fixture with this file's defaults on top. */
const mkTask = (over: Partial<Task> = {}): Task =>
  baseTask({ title: "Rip out the legacy poller", intent: "rip out the legacy poller and its dead config",
            kind: "scout", agent: "codex", repoRoot: "/Users/dev/work/harness", ...over });

const editor = (task: Task): string =>
  renderToStaticMarkup(
    withOverlayHost(
      createElement(DispatchLayer, { open: true, editTask: task, onClose: () => {} }),
    ),
  );

test("the editor opens holding the task, not an empty form", () => {
  // Seeded during render for exactly this reason: a frame of blank fields reads as a
  // task that lost its intent, and the operator's next move is to retype it.
  const html = editor(mkTask());
  assert.match(html, /rip out the legacy poller and its dead config/);
  assert.match(html, /value="Rip out the legacy poller"/);
  assert.match(html, /value="\/Users\/dev\/work\/harness"/);
  // The two selects come up on the task's own values, not the dispatch defaults
  // (ship / claude) - a scout silently re-armed as a ship is a different job.
  assert.match(html, /<option value="scout" selected=""/);
  assert.match(html, /<option value="codex" selected=""/);
});

test("the verbs say edit, not create", () => {
  const html = editor(mkTask());
  assert.match(html, /Edit backlog task/);
  assert.match(html, />Save</);
  assert.match(html, />Revert</);
  // "Add to backlog" would offer to shelve a second copy of a task already shelved.
  assert.doesNotMatch(html, /Add to backlog/);
  assert.doesNotMatch(html, />Clear</);
  // The one verb that survives the mode change, because it means the same thing in
  // both: this is ready, start it.
  assert.match(html, /Dispatch now/);
});

test("Revert is dead until something has actually been edited", () => {
  // It restores the stored row, so on an untouched form it has nothing to restore -
  // an enabled button that does nothing teaches the operator to distrust the footer.
  assert.match(editor(mkTask()), /<button[^>]*disabled=""[^>]*>Revert<\/button>/);
  // Save, beside it, is live from the start: an untouched form is still a valid one,
  // and a Save that has to be armed by an edit is a Save that looks broken.
  assert.match(editor(mkTask()), /<button class="btn btn-ghost" title="[^"]*">Save<\/button>/);
});

test("a fresh dispatch is untouched by the edit mode", () => {
  // The same component serves both, and the create path is the one people use daily.
  const html = renderToStaticMarkup(
    withOverlayHost(createElement(DispatchLayer, { open: true, editTask: null, onClose: () => {} })),
  );
  assert.match(html, /Dispatch an agent/);
  assert.match(html, /Add to backlog/);
  assert.doesNotMatch(html, /Edit backlog task/);
});

test("a backlog card carries a focusable way into the editor, not just a click handler", () => {
  // The card-wide click is the gesture; the title is the control. Without a real
  // button the task is reachable by mouse only - and the column is a list of prose
  // with no other route in.
  const html = renderToStaticMarkup(
    createElement(BacklogColumn, {
      tasks: [mkTask()],
      onAssignError: () => {},
      onDragging: () => {},
      onEdit: () => {},
    }),
  );
  assert.match(html, /<button class="bl-title"[^>]*>Rip out the legacy poller<\/button>/);
  // And the launch button is still its own action, sitting inside a card that is now
  // also clickable.
  assert.match(html, /class="bl-launch"/);
});
