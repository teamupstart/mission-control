import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CompleteModal } from "../src/web/components/CompleteModal.tsx";
import { KillModal } from "../src/web/components/KillModal.tsx";
import type { Session, Task, TaskDependency } from "../src/shared/types.ts";
import { mkSession, mkTask } from "./helpers/session-fixture.ts";
import { withOverlayHost } from "./helpers/overlay-host.ts";

/**
 * The two dialogs that end a session, and the one decision between them.
 *
 * Kill used to be the only way to stop a session, and it settles that session's task as
 * `failed` - which every task declared to wait on it reads as "this did not happen".
 * An operator whose work was FINISHED had no other button, so finishing work was
 * indistinguishable from abandoning it and the dependents deadlocked. That is what these
 * two dialogs exist to separate, so what is pinned here is that each one SAYS so.
 *
 * The checkbox default is the substantive assertion, and the answer is that it is NEVER
 * pre-ticked. A declared dependency is otherwise satisfied only by a merged PR, because a
 * dependent task cuts a fresh worktree from the default branch and would not contain
 * unmerged prerequisite work - so releasing dependents without one is a claim only a
 * human can make. A preselect on `prState === "merged"` was tried and removed: that value
 * is not reachable here after the ordinary merge path, since `reconcileWorkEpisodeMerge`
 * clears the session's PR match as it retires the episode, so it would have fired for
 * nobody while reading as though it sometimes fired. The dialog's job is to say what
 * ticking it costs, which is what the rest of these pin.
 *
 * `createElement` rather than JSX because the runner's glob only matches .test.ts.
 */

function edgeTo(taskId: string): TaskDependency {
  return {
    type: "task",
    taskId,
    title: "Prerequisite",
    sessionId: null,
    episodeId: null,
    agentSessionId: null,
    branch: null,
    prUrl: null,
    selectedAt: 1000,
    satisfiedAt: null,
  };
}

function sessionWithTask(over: Partial<Session> = {}): Session {
  return mkSession({
    task: { id: "root", title: "Phase 1: foundations", kind: "ship", status: "running" },
    ...over,
  } as Partial<Session>);
}

const dependents: Task[] = [
  mkTask({ id: "d1", title: "Phase 2: the runtime", dependencies: [edgeTo("root")] }),
  mkTask({ id: "d2", title: "Phase 3: the dashboard", dependencies: [edgeTo("root")] }),
];

function renderComplete(session: Session, tasks: Task[] = dependents): string {
  return renderToStaticMarkup(
    withOverlayHost(createElement(CompleteModal, { session, tasks, onClose: () => {} })),
  );
}

// ---- complete: the dependent count and the checkbox default ----------------------------

test("it counts the tasks the completion would release, and offers to release them", () => {
  const html = renderComplete(sessionWithTask());
  assert.match(html, /Unblock the/);
  assert.match(html, /<strong>2<\/strong>/);
  assert.match(html, /Phase 2: the runtime/);
  assert.match(html, /Phase 3: the dashboard/);
});

test("an UNKNOWN pr state leaves the box clear - null is 'not polled yet', not 'no PR'", () => {
  // The poller runs seconds behind and clears the field when it fails, so `null` is at
  // its most likely right after an agent opens a pull request - which is exactly when
  // releasing dependents onto a base without its commits does the most damage. Unknown
  // is treated as unmerged, not as safe.
  const html = renderComplete(sessionWithTask({ prState: null }));
  assert.doesNotMatch(html, /type="checkbox"[^>]*checked=""/);
  assert.match(html, /stay blocked until a pull request from this work is merged/);
  // And the tooltip on the box the operator would have to tick says what it costs,
  // rather than describing an unknown state as if it were a safe one.
  assert.match(html, /may not hold its commits/);
});

test("no PR state pre-ticks the box - none of them are evidence of a merge here", () => {
  for (const prState of [null, "open", "merged", "closed"] as const) {
    const html = renderComplete(sessionWithTask({ prState } as never));
    assert.doesNotMatch(html, /type="checkbox"[^>]*checked=""/, String(prState));
  }
});

test("an open PR leaves the box CLEAR, and says what ticking it would cost", () => {
  // The one case where satisfying the edge is a real risk: the dependent is cut from the
  // default branch, which does not have this session's unmerged commits.
  const html = renderComplete(sessionWithTask({ prState: "open" }));
  assert.doesNotMatch(html, /type="checkbox"[^>]*checked=""/);
  assert.match(html, /until a pull request from this work is merged/);
});

test("even a merged PR does not pre-tick - the override is always an explicit act", () => {
  // `prState === "merged"` is not even reachable here after the ordinary merge path:
  // `reconcileWorkEpisodeMerge` clears the session's PR match as it retires the episode.
  // A preselect keyed on it would have fired for nobody while reading as though it fired
  // for someone, so there is no preselect at all.
  const html = renderComplete(sessionWithTask({ prState: "merged" }));
  assert.doesNotMatch(html, /type="checkbox"[^>]*checked=""/);
});

test("with nothing waiting there is no checkbox to answer", () => {
  const html = renderComplete(sessionWithTask(), []);
  assert.doesNotMatch(html, /Unblock the/);
});

test("a session with no task says so instead of offering an empty completion", () => {
  const html = renderComplete(mkSession({ task: null }));
  assert.match(html, /no Mission Control task/);
  assert.doesNotMatch(html, /Unblock the/);
});

test("it states that completing also closes the session", () => {
  // The confirmation the operator asked for: Complete is not just an annotation.
  assert.match(renderComplete(sessionWithTask()), /closes this session/);
});

// ---- kill: naming the consequence, and pointing at the other door -----------------------

test("kill warns that the task will settle as failed, and offers Complete instead", () => {
  const html = renderToStaticMarkup(
    withOverlayHost(
      createElement(KillModal, {
        session: sessionWithTask(),
        onComplete: () => {},
        onClose: () => {},
      }),
    ),
  );
  assert.match(html, /settle as failed/);
  assert.match(html, /blocks any task waiting on it/);
  assert.match(html, /Complete instead/);
});

test("kill keeps the checkout, and says so", () => {
  // `agentWentAway` retains the worktree for a confirmed Clean up precisely so a
  // mis-aimed kill costs nothing git cannot return. The dialog must not imply otherwise.
  const html = renderToStaticMarkup(
    withOverlayHost(createElement(KillModal, { session: sessionWithTask(), onClose: () => {} })),
  );
  assert.match(html, /checkout is kept/);
});

test("with no task, kill neither warns about one nor offers Complete", () => {
  const html = renderToStaticMarkup(
    withOverlayHost(
      createElement(KillModal, {
        session: mkSession({ task: null }),
        onComplete: () => {},
        onClose: () => {},
      }),
    ),
  );
  assert.doesNotMatch(html, /settle as failed/);
  assert.doesNotMatch(html, /Complete instead/);
});
