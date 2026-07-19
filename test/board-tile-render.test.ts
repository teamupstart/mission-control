import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BoardView } from "../src/web/components/layouts/BoardView.tsx";
import type { SessionViewProps } from "../src/web/components/layouts/types.ts";
import type { NmRunSummary, Session, SessionMeta } from "../src/shared/types.ts";

// The board tile is meant to be triaged WITHOUT opening it, so what's worth testing is the
// static markup of a tile with nothing selected: it must surface the live activity, the named
// gate step, and the runtime meta with its context number. Rendered rather than driven through
// a browser - this dashboard's SSE stream blocks Chrome automation, and renderToStaticMarkup
// answers "what's in the tile" with no daemon and no flake. createElement, not JSX, because the
// runner's glob only matches .test.ts.

function meta(over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    model: "Opus 4.8",
    modelId: "claude-opus-4-8[1m]",
    longContext: true,
    thinkingLevel: "high",
    thinkingEnabled: true,
    contextPct: 62,
    contextTokens: 124000,
    contextWindow: 200000,
    source: "statusline",
    updatedAt: 0,
    ...over,
  };
}

function nm(over: Partial<NmRunSummary> = {}): NmRunSummary {
  return {
    id: "run1",
    status: "running",
    branch: "harness/app-bugfixes",
    startedAt: 0,
    endedAt: null,
    awaitingAgent: null,
    findingsSummary: null,
    gateStep: null,
    gateSummary: null,
    gateRisk: null,
    steps: [
      { step: "review", status: "completed", findings: 0 },
      { step: "test", status: "running", findings: 0 },
      { step: "lint", status: "pending", findings: 0 },
    ],
    activeSteps: [],
    findings: [],
    outcome: null,
    ...over,
  };
}

function mkSession(over: Partial<Session> = {}): Session {
  return {
    id: "s1",
    agent: "claude",
    name: "App Bugfixes",
    nameSource: "tmux",
    state: "working",
    cwd: "/wt/app-bugfixes",
    gitBranch: "harness/app-bugfixes",
    gitRoot: null,
    repoRoot: null,
    nomistakesGated: true,
    pid: 1,
    tty: "ttys1",
    permissionMode: null,
    wezterm: null,
    tmux: { session: "s", window: "w", windowIndex: 0, paneId: "%1" },
    agentSessionId: "agent-1",
    transcriptPath: null,
    instrumented: true,
    hooksSeen: true,
    activity: "editing SessionCard.tsx",
    startedAt: null,
    firstSeen: 0,
    lastSeen: 0,
    lastActivity: null,
    pendingReviews: 0,
    nomistakes: nm(),
    nomistakesFixes: [],
    task: null,
    nomistakesNarration: null,
    prUrl: null,
    prNumber: null,
    prState: null,
    prChecks: null,
    meta: meta(),
    note: null,
    goal: { text: "Ensure all worktree changes are in main", source: "model", updatedAt: 0 },
    queue: null,
    orphanedQueue: null,
    ...over,
  };
}

function props(sessions: Session[]): SessionViewProps {
  return {
    sessions,
    tasks: [],
    gateAlerts: new Set<string>(),
    selectedId: null,
    onSelect: () => {},
    onDeselect: () => {},
    expandedId: null,
    onToggleExpand: () => {},
    onOpenReviews: () => {},
    onOpenDiff: () => {},
    onReset: () => {},
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

function render(session: Session): string {
  return renderToStaticMarkup(createElement(BoardView, props([session])));
}

test("the tile shows what the session is doing right now", () => {
  const html = render(mkSession());
  assert.match(html, /tile-activity/);
  assert.match(html, /editing SessionCard\.tsx/);
});

test("a settled session omits the ticker rather than animating over a still session", () => {
  // Once a session settles, `activity` holds a status label ("idle", "ended (logout)"),
  // not a live action - and the ticker's glyph spins, which would misreport it as busy.
  for (const state of ["idle", "awaiting_input", "exited"] as const) {
    const html = render(mkSession({ state, activity: "idle" }));
    assert.doesNotMatch(html, /tile-activity/, `${state} should not carry a live ticker`);
  }
});

test("exactly one gate diamond, whether or not a run has started", () => {
  // Gating is a property of the repo, so a gated session shows the mark before its first
  // run - but once the gate line exists it carries the diamond, and two would be noise.
  const withRun = render(mkSession());
  assert.doesNotMatch(withRun, /class="gated"/);
  assert.match(withRun, /gate-brand/);

  const noRun = render(mkSession({ nomistakes: null }));
  assert.match(noRun, /class="gated"/);
  assert.doesNotMatch(noRun, /gate-brand/);

  const ungated = render(mkSession({ nomistakes: null, nomistakesGated: false }));
  assert.doesNotMatch(ungated, /class="gated"/);
  assert.doesNotMatch(ungated, /gate-brand/);
});

test("the gate hairline carries a named, positioned step", () => {
  const html = render(mkSession());
  assert.match(html, /gate-step gate-working/); // "test" is running
  assert.match(html, /step 2 \/ 3/);
  // The hairline segments are still there under the label.
  assert.match(html, /tr-completed/);
  assert.match(html, /tr-running/);
});

test("a parked gate reads in attention tone", () => {
  const parked = nm({
    gateStep: "review",
    steps: [
      { step: "review", status: "awaiting_approval", findings: 1 },
      { step: "test", status: "pending", findings: 0 },
    ],
  });
  const html = render(mkSession({ nomistakes: parked }));
  assert.match(html, /gate-step gate-attention/);
  assert.match(html, /step 1 \/ 2/);
});

test("a landed gate names its outcome and drops the step position", () => {
  const passed = nm({
    status: "completed",
    outcome: "passed",
    steps: [
      { step: "review", status: "completed", findings: 0 },
      { step: "test", status: "completed", findings: 0 },
    ],
  });
  const html = render(mkSession({ nomistakes: passed }));
  assert.match(html, /gate-step gate-idle/);
  assert.doesNotMatch(html, /step \d+ \//);
});

test("the runtime row carries the context percentage, not just a bare meter", () => {
  const html = render(mkSession());
  assert.match(html, /card-runtime/);
  assert.match(html, /Opus 4\.8/);
  assert.match(html, /62%/);
});

test("a session with no meta and no gate simply omits those rows", () => {
  const bare = mkSession({ meta: null, nomistakes: null, nomistakesGated: false, activity: null });
  const html = render(bare);
  assert.doesNotMatch(html, /card-runtime/);
  assert.doesNotMatch(html, /tile-gate/);
  assert.doesNotMatch(html, /tile-activity/);
  // ...but the tile itself still renders.
  assert.match(html, /App Bugfixes/);
});

test("a lapsed-hook session omits the ticker rather than animating a stale label", () => {
  // When hooks lapse past the overlay TTL the passive poller refreshes `state` from the
  // transcript but leaves `activity` at its stale overlay value, so a session can read
  // working with a settled label. `instrumented` is false in exactly that case.
  const html = render(mkSession({ instrumented: false, state: "working", activity: "idle" }));
  assert.doesNotMatch(html, /tile-activity/);
});
