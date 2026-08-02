import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionCard } from "../src/web/components/SessionCard.tsx";
import { GOAL_UNSUPPORTED } from "../src/shared/goal.ts";
import type { Session, SessionGoalSummary } from "../src/shared/types.ts";
import { mkMuxHandle } from "./helpers/session-fixture.ts";

// The Goal's whole premise is that it is readable WITHOUT clicking - Foreman's Purpose
// already failed at this job by living behind the expand gate. So the thing worth testing is
// the markup of a COLLAPSED card.
//
// Rendered rather than driven through a browser: this dashboard's SSE stream blocks Chrome
// automation, and `renderToStaticMarkup` answers the actual question (what is in a collapsed
// card) with no daemon, no network, and no flake. `createElement` rather than JSX because the
// test runner's glob only matches .test.ts.

function mkSession(over: Partial<Session> = {}): Session {
  return {
    id: "s1",
    agent: "claude",
    name: "goal-feature",
    runtime: "terminal",
    nameSource: "tmux",
    state: "working",
    cwd: "/wt/goal",
    gitBranch: "harness/goal",
    gitRoot: null,
    repoRoot: null,
    pid: 1,
    tty: "ttys1",
    permissionMode: null,
    terminals: [mkMuxHandle({ session: "s", windowName: "w", windowIndex: 0, paneId: "%1" })],
    agentSessionId: "agent-1",
    transcriptPath: null,
    instrumented: true,
    stateConfirmed: true,
    hooksSeen: true,
    activity: "running Bash",
    startedAt: null,
    firstSeen: 0,
    lastSeen: 0,
    lastActivity: null,
    pendingReviews: 0,
    task: null,
    prUrl: null,
    prNumber: null,
    prState: null,
    prChecks: null,
    meta: null,
    effortBaselineReady: false,
    note: null,
    cost: null,
    goal: null,
    queue: null,
    orphanedQueue: null,
    inspector: null,
    paneDialog: null,
    ...over,
  };
}

const goal = (over: Partial<SessionGoalSummary> = {}): SessionGoalSummary => ({
  text: "Fix the flaky worktree cleanup on Reset",
  source: "model",
  updatedAt: 1000,
  ...over,
});

/** A COLLAPSED card's markup - the only place a status line counts. */
function render(session: Session): string {
  return renderToStaticMarkup(createElement(SessionCard, { session, expanded: false }));
}

test("a collapsed card shows its goal without being expanded", () => {
  const html = render(mkSession({ goal: goal() }));
  assert.match(html, /Fix the flaky worktree cleanup on Reset/);
  assert.match(html, /class="goal goal-model"/);
});

test("a steering prompt keeps the durable objective on the card while intent resolves", () => {
  const html = render(
    mkSession({
      goal: goal({
        text: "Implement durable session objectives",
        focus: "Add one focused regression test",
        relationship: undefined,
        objectiveVersion: 1,
        promptRevision: 2,
        resolvedPromptRevision: 1,
      }),
    }),
  );
  assert.match(html, /Implement durable session objectives/);
  assert.doesNotMatch(html, /Add one focused regression test/);
  assert.match(html, /goal-resolving/);
});

test("an unclear relationship keeps the objective visible and marks automation paused", () => {
  const html = render(
    mkSession({
      goal: goal({
        text: "Implement durable session objectives",
        relationship: "unclear",
        objectiveVersion: 1,
        promptRevision: 2,
        resolvedPromptRevision: 2,
      }),
    }),
  );
  assert.match(html, /Implement durable session objectives/);
  assert.match(html, /goal-unclear/);
  assert.match(html, /automatic wrap-up is paused/);
});

test("the goal is a separate line from the activity ticker", () => {
  // The two are orthogonal facts - what it is FOR vs what it is doing this second - and an
  // earlier draft of the plan was wrong about exactly this, proposing the goal take the
  // activity slot.
  const html = render(mkSession({ goal: goal(), activity: "running Bash" }));
  assert.match(html, /Fix the flaky worktree cleanup on Reset/);
  assert.match(html, /class="activity">running Bash/);
});

test("a Tier 1 goal is marked as provisional", () => {
  // So a raw prompt reads as being on its way to a sentence, rather than as a bad summary.
  const html = render(mkSession({ goal: goal({ text: "fix the reset bug", source: "heuristic" }) }));
  assert.match(html, /class="goal goal-heuristic"/);
  assert.match(html, /fix the reset bug/);
});

test("a session with no goal yet renders no goal line at all", () => {
  // A session discovered before its first prompt. A placeholder here would flash on every
  // new card.
  const html = render(mkSession({ goal: null }));
  assert.doesNotMatch(html, /class="goal/);
});

test("a harness that can never carry a goal explains itself instead of looking broken", () => {
  // Codex used to be the live case; it reads its rollout as turns now and reports its
  // prompt over a hook, so `GOAL_UNSUPPORTED.codex` is null and a goal-less Codex card is
  // an ordinary pre-first-prompt card. The empty state is still reachable - it is what a
  // harness with no message reader renders - so it is driven by a fixture rather than
  // deleted along with the last agent that needed it.
  const why = "Test Harness sessions report no prompts.";
  const prior = GOAL_UNSUPPORTED.codex;
  GOAL_UNSUPPORTED.codex = why;
  try {
    const html = render(mkSession({ agent: "codex", goal: null }));
    assert.match(html, /class="goal goal-none"/);
    assert.match(html, /No goal/);
    assert.match(html, new RegExp(why.replace(/'/g, "&#x27;")));
  } finally {
    GOAL_UNSUPPORTED.codex = prior;
  }
});

test("a Codex card with no goal yet renders no goal line - it CAN carry one", () => {
  // The regression that fixture could hide: leave `GOAL_UNSUPPORTED.codex` as a sentence
  // and every Codex card permanently reads "No goal", however many prompts it has taken.
  assert.equal(GOAL_UNSUPPORTED.codex, null);
  const html = render(mkSession({ agent: "codex", goal: null }));
  assert.doesNotMatch(html, /class="goal/);
});

test("goal text is escaped, not injected", () => {
  // A goal is the human's own prompt at Tier 1 and a model's words at Tier 2 - neither is
  // trusted markup.
  const html = render(mkSession({ goal: goal({ text: "<img src=x onerror=alert(1)>" }) }));
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img/);
});
