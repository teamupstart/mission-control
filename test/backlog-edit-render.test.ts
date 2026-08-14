import { test } from "node:test";
import { mkSession, mkTask as baseTask } from "./helpers/session-fixture.ts";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { withOverlayHost } from "./helpers/overlay-host.ts";
import { TASK_KINDS } from "../src/shared/types.ts";
import type { Task } from "../src/shared/types.ts";
import type { TaskSourceInstance } from "../src/shared/task-source.ts";
import { hasTooltip } from "./helpers/markup.ts";

// This file is about the ordinary form's edit and footer contracts, not which composition
// path ships. State that precondition before importing the module-level UI config store, just
// as the e2e dashboard fixture does for specs that use Dispatch as setup. Otherwise a product
// default flip hides the footer under the guided pass and turns these assertions into tests of
// an unrelated preference.
const uiStore = new Map<string, string>([
  ["mission-control.ui", JSON.stringify({ guidedDispatch: false })],
]);
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => uiStore.get(key) ?? null,
    setItem: (key: string, value: string) => void uiStore.set(key, value),
    removeItem: (key: string) => void uiStore.delete(key),
  },
});

const { DispatchLayer, PushToSourceBlock } = await import(
  "../src/web/components/DispatchModal.tsx"
);
const { BacklogColumn } = await import("../src/web/components/layouts/BacklogColumn.tsx");

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

/** A fresh dispatch, which is the same component over no row at all. */
const dispatcher = (): string =>
  renderToStaticMarkup(
    withOverlayHost(createElement(DispatchLayer, { open: true, editTask: null, onClose: () => {} })),
  );

/**
 * The modal's footer alone.
 *
 * Sliced rather than searched whole because "the footer offers it" is the claim: a Delete
 * that rendered among the fields would satisfy a match against the full markup while being
 * somewhere no operator looks for an action.
 */
const foot = (html: string): string => {
  const at = html.indexOf('<footer class="modal-foot">');
  assert.ok(at >= 0, "the modal renders a footer");
  return html.slice(at, html.indexOf("</footer>", at));
};

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

test("the editor reopens a task on whichever kind it was stored with", () => {
  // The whole vocabulary through the round trip a person actually performs: a task is
  // persisted with a kind, the row comes back, and the editor has to open on it.
  //
  // Every kind rather than just the new one, because the failure mode here is not "plan is
  // missing" - it is a control that offers a subset. A `plan` row landing on a form whose
  // Kind select has no `plan` option opens SILENTLY on `ship`, and saving that form writes
  // the wrong kind back over a task nobody meant to change. That is what a hand-written
  // option list did to this form's two siblings until they were folded onto the registry.
  for (const kind of TASK_KINDS) {
    const html = editor(mkTask({ kind }));
    assert.match(
      html,
      new RegExp(`<option value="${kind}" selected=""`),
      `the editor should reopen a ${kind} task on ${kind}`,
    );
  }
});

test("effort is selectable immediately after model for both harnesses", () => {
  for (const agent of ["claude", "codex"] as const) {
    const html = editor(mkTask({ agent, effort: "xhigh" }));
    const modelAt = html.indexOf("Model");
    const effortAt = html.indexOf(`aria-label="Effort for dispatched ${agent === "claude" ? "Claude Code" : "Codex"} session"`);
    assert.ok(modelAt >= 0 && effortAt > modelAt, `${agent}: effort follows model`);
    assert.match(html, /<option value="xhigh" selected=""/);
  }
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

test("only the editor offers to delete, and only from the footer", () => {
  // The one destructive action in a form whose other verbs all keep the task, so it is
  // asserted from both sides at once. Present in the editor: without it the only way to
  // throw a shelved task away is the Sitrep row, which an operator reading the task in
  // front of them has no reason to know exists.
  const editing = foot(editor(mkTask()));
  // The exact pair the Sitrep's Delete wears, pinned rather than matched loosely: "looks like
  // the other Delete" is the claim, and a class list that drifts is how two surfaces offering
  // the same action stop looking like the same action.
  assert.match(editing, /<button class="btn btn-danger-ghost"[^>]*>Delete<\/button>/);
  assert.ok(
    hasTooltip(editor(mkTask()), "Delete this task from the backlog"),
    "Delete must say what it deletes - 'Delete' alone, beside Revert, could read as the draft",
  );

  // Absent from a fresh dispatch, which is the half that would rot silently. There is no
  // row behind a create, so a Delete there deletes nothing and reads as "discard the form"
  // - the job "Clear" already has, one button away.
  const fresh = dispatcher();
  assert.doesNotMatch(foot(fresh), /btn-danger-ghost/);
  assert.doesNotMatch(fresh, />Delete</);
});

test("Revert is dead until something has actually been edited", () => {
  // It restores the stored row, so on an untouched form it has nothing to restore -
  // an enabled button that does nothing teaches the operator to distrust the footer.
  assert.match(editor(mkTask()), /<button[^>]*disabled=""[^>]*>Revert<\/button>/);
  // Save, beside it, is live from the start: an untouched form is still a valid one,
  // and a Save that has to be armed by an edit is a Save that looks broken.
  assert.match(editor(mkTask()), /<button class="btn btn-ghost"[^>]*>Save<\/button>/);
  assert.ok(hasTooltip(editor(mkTask()), "Keep it in the backlog"), "Save must say what it does");
});

test("a fresh dispatch is untouched by the edit mode", () => {
  // The same component serves both, and the create path is the one people use daily.
  const html = dispatcher();
  assert.match(html, /Dispatch an agent/);
  assert.match(html, /Add to backlog/);
  assert.doesNotMatch(html, /Edit backlog task/);
});

test("the dependency picker offers both backlog tasks and active sessions", () => {
  // Through the editor rather than a fresh dispatch: the backlog-details fold opens on an
  // edit, and a fresh form keeps it collapsed behind the summary line.
  const prerequisite = mkTask({ id: "pre", title: "Create the schema", kind: "ship" });
  const html = renderToStaticMarkup(
    withOverlayHost(
      createElement(DispatchLayer, {
        open: true,
        editTask: mkTask(),
        tasks: [prerequisite],
        sessions: [mkSession({ id: "active", name: "Manual investigation", task: null })],
        onClose: () => {},
      }),
    ),
  );
  assert.match(html, /<optgroup label="Backlog tasks">/);
  assert.match(html, /Create the schema \(ship\)/);
  assert.match(html, /<optgroup label="Active sessions">/);
  assert.match(html, /Manual investigation/);
  assert.match(html, /each waits for its merged PR/);
});

// ---- Where a task meets the world outside Mission Control ----
//
// `Task.source` has been persisted and swept into since task sources shipped and rendered
// nowhere at all, so every case below is the first assertion that any of it reaches a reader.
// The block is exercised from both sides: through the whole editor, which is what proves a
// swept-in task shows its link with no fetch and no click, and directly, which is the only way
// to reach the states an effect-less render can never produce (a landed sources list, a push
// in flight, a refusal, an unknown outcome).

/** A configured source, as the modal reads one off `GET /api/task-sources/config`. */
const mkSource = (over: Partial<TaskSourceInstance> = {}): TaskSourceInstance =>
  ({
    id: "src-1",
    kind: "github-issues",
    label: "mission-control bugs",
    enabled: true,
    repoRoot: "/Users/dev/work/harness",
    intervalMs: 900_000,
    defaults: { kind: "ship", agent: "claude", priority: null, labels: [] },
    maxPerSweep: 25,
    config: {},
    ...over,
  }) as TaskSourceInstance;

const REF = {
  sourceId: "src-1",
  externalId: "acme/demo-repo#123",
  url: "https://github.com/acme/demo-repo/issues/123",
};

/** The push block on its own, in a state the editor's own effects cannot reach. */
const block = (props: Parameters<typeof PushToSourceBlock>[0]): string =>
  renderToStaticMarkup(createElement(PushToSourceBlock, props));

test("a swept-in task shows what it came from, without asking the daemon anything", () => {
  // The headline of this whole surface: `renderToStaticMarkup` runs no effects, so nothing
  // here has fetched a source list - and the link still renders, because it is a pure read of
  // the row. A task filed by a sweep is legible the instant its editor opens.
  const html = editor(mkTask({ source: REF }));
  assert.match(
    html,
    /<a class="source-provenance-link" href="https:\/\/github\.com\/acme\/demo-repo\/issues\/123" target="_blank" rel="noreferrer"[^>]*>acme\/demo-repo#123<\/a>/,
  );
  // And it is a link OUT: a target-less anchor would replace the dashboard - and the modal,
  // and any unsaved edit in it - with GitHub.
  assert.match(html, /Filed upstream as/);
  assert.ok(
    hasTooltip(html, "Open acme/demo-repo#123 in a new tab"),
    "a link that leaves the app should say where it goes and that it opens a tab",
  );
  // The action is not also offered. The daemon refuses a second push on a linked task, and an
  // operator should not have to learn that by pressing a button that was there.
  assert.doesNotMatch(html, /Create GitHub issue/);
});

test("a scheduled task that is also filed upstream reads as two origins, not a conflict", () => {
  // Both banners at once, which used to be impossible on purpose: a task could only carry a
  // schedule AND a source through a bug, so the schedule note called it a "(conflict)". Filing
  // a scheduled task upstream is now something an operator does deliberately, and the note has
  // to say where the second origin is rather than accuse it of being one.
  const html = editor(mkTask({ scheduleId: "sched-1", source: REF }));
  assert.match(html, /Scheduled by a recurring mission/);
  assert.match(html, /This task is also linked to an external item below\./);
  assert.doesNotMatch(html, /conflict/);
  // And the thing it points at is really below it.
  const noteAt = html.indexOf("also linked to an external item");
  const linkAt = html.indexOf("Filed upstream as");
  assert.ok(noteAt >= 0 && linkAt > noteAt, "the note must precede the link it refers to");
});

test("the editor offers no push at all until it knows what sources exist", () => {
  // The pre-fetch state, which is what a static render IS. A button drawn now and corrected a
  // beat later is a button the cursor is already moving toward - and the Settings hint printed
  // now would tell an operator to go and configure something they may already have.
  const html = editor(mkTask());
  assert.doesNotMatch(html, /Create GitHub issue/);
  assert.doesNotMatch(html, /add a GitHub\s*Issues task source/);
  assert.doesNotMatch(html, /source-provenance-note/);
});

test("one eligible source is a button that names it, and no picker", () => {
  const html = block({
    link: null,
    sources: [mkSource()],
    repoRoot: "/Users/dev/work/harness",
  });
  assert.match(html, /<button class="btn"[^>]*>Create GitHub issue<\/button>/);
  assert.ok(
    hasTooltip(
      html,
      'File this task as a GitHub issue through "mission-control bugs" - it carries the task\'s title, its text, and any labels that source filters on',
    ),
    "the tooltip must name the source the issue is filed through",
  );
  // A select of one is a control that cannot be used.
  assert.doesNotMatch(html, /<select/);
});

test("two eligible sources are picked between, defaulting to the first", () => {
  const html = block({
    link: null,
    sources: [mkSource(), mkSource({ id: "src-2", label: "triage inbox" })],
    repoRoot: "/Users/dev/work/harness",
  });
  assert.match(html, /<select class="field-input source-provenance-pick" aria-label="GitHub issue source"/);
  assert.match(html, /<option value="src-1" selected="">mission-control bugs<\/option>/);
  assert.match(html, /<option value="src-2">triage inbox<\/option>/);
  assert.match(html, /Create GitHub issue/);
});

test("a source for another repo, or of a kind that cannot receive one, is not eligible", () => {
  // Both halves of the daemon's own refusal, asserted together because either one alone would
  // let the modal offer an action `pushTask` would reject: a Jira source implements no outward
  // verb at all, and a GitHub one bound elsewhere files against a repo this task is not on.
  const html = block({
    link: null,
    sources: [
      mkSource({ id: "jira", kind: "jira", label: "platform queue" }),
      mkSource({ id: "elsewhere", repoRoot: "/Users/dev/work/other" }),
    ],
    repoRoot: "/Users/dev/work/harness",
  });
  assert.doesNotMatch(html, /Create GitHub issue/);
  assert.match(html, /add a GitHub\s*Issues task source for this repo in Settings/);
});

test("unsaved edits disable the push and say which order to do it in", () => {
  const html = block({
    link: null,
    sources: [mkSource()],
    repoRoot: "/Users/dev/work/harness",
    dirty: true,
  });
  // The issue is composed by the daemon from the STORED row, so pushing over an unsaved title
  // publishes the old one to a place this form cannot edit.
  assert.match(html, /<button class="btn"[^>]*disabled=""[^>]*>Create GitHub issue<\/button>/);
  assert.ok(
    hasTooltip(
      html,
      "Save your changes first - the issue carries the task's saved title and intent",
    ),
    "a disabled button that does not say why reads as broken",
  );
});

test("a push in flight says so on the button it disabled", () => {
  const html = block({
    link: null,
    sources: [mkSource()],
    repoRoot: "/Users/dev/work/harness",
    pushing: true,
  });
  assert.match(html, /<button class="btn"[^>]*disabled=""[^>]*>Creating issue…<\/button>/);
});

test("a refusal keeps the button, because nothing was published", () => {
  // The 502 half of the contract. `gh` ran and said no - most often a label that does not
  // exist on the repo - so the fix is a minute away and the retry cannot duplicate anything.
  const html = block({
    link: null,
    sources: [mkSource()],
    repoRoot: "/Users/dev/work/harness",
    error: "could not add label: 'triage' not found",
  });
  // `dispatch-error` beside its own layout class, pinned rather than matched loosely: the red a
  // failed push is printed in is the red a failed SAVE is printed in, and the two live in the
  // same dialog. Restating the colour instead of sharing the class is how they drift apart.
  assert.match(html, /class="dispatch-error source-provenance-error"/);
  assert.match(html, /could not add label: &#x27;triage&#x27; not found/);
  assert.match(html, /<button class="btn"[^>]*>Create GitHub issue<\/button>/);
  assert.doesNotMatch(html, /<button class="btn"[^>]*disabled=""/);
});

test("an unknown outcome withdraws the button rather than disabling it", () => {
  // The 504, and the one place in this app where removing a control is safer than offering
  // it: the issue may already exist, and pressing again is what files the duplicate. A
  // disabled button would promise that something is coming to re-enable it; nothing is.
  const html = block({
    link: null,
    sources: [mkSource()],
    repoRoot: "/Users/dev/work/harness",
    error: "gh issue create did not report back - the issue may exist; check GitHub before retrying",
    outcomeUnknown: true,
  });
  assert.match(html, /class="source-provenance-warn"/);
  assert.match(html, /check GitHub before retrying/);
  assert.doesNotMatch(html, /Create GitHub issue/);
});

test("an item with no URL is still named, rather than linked to nowhere", () => {
  const html = block({
    link: { sourceId: "src-1", externalId: "MC-14", url: null },
    sources: null,
    repoRoot: "/Users/dev/work/harness",
  });
  assert.match(html, /<strong>MC-14<\/strong>/);
  assert.doesNotMatch(html, /<a /);
});

test("a backlog card carries a focusable way into the editor, not just a click handler", () => {
  // The card-wide click is the gesture; the title is the control. Without a real
  // button the task is reachable by mouse only - and the column is a list of prose
  // with no other route in.
  const html = renderToStaticMarkup(
    createElement(BacklogColumn, {
      tasks: [mkTask()],
      allTasks: [mkTask()],
      plan: null,
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

test("a declared dependency disables both dragging and manual launch", () => {
  const dependency = mkTask({ id: "pre", title: "Merge this first", status: "running" });
  const blocked = mkTask({
    id: "blocked",
    dependencies: [
      {
        type: "task",
        taskId: dependency.id,
        title: dependency.title,
        sessionId: null,
        episodeId: null,
        agentSessionId: null,
        branch: null,
        prUrl: null,
        selectedAt: null,
        satisfiedAt: null,
      },
    ],
  });
  const html = renderToStaticMarkup(
    createElement(BacklogColumn, {
      tasks: [blocked],
      allTasks: [dependency, blocked],
      plan: null,
      onAssignError: () => {},
      onDragging: () => {},
      onEdit: () => {},
    }),
  );
  assert.match(html, /draggable="false"/);
  // The class list carries the waiting state as well - what this pins is the refusal.
  // See `backlog-blocked-legibility.test.ts` for what that state is for.
  assert.match(html, /<button class="bl-launch[^"]*"[^>]*disabled=""/);
  assert.match(html, /waiting for dependencies/);
});
