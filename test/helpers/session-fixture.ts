import type { NmRunSummary, Session, SessionMeta, Task } from "../../src/shared/types.ts";
import type { EmulatorHandle, MuxHandle } from "../../src/shared/terminal.ts";

/**
 * A representative session for the board's render tests, and the one place a required
 * field has to be added when the Session type grows. Every field is overridable, so a
 * test that cares about one of them says so and stays readable about what it is testing.
 */

export function meta(over: Partial<SessionMeta> = {}): SessionMeta {
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

export function nm(over: Partial<NmRunSummary> = {}): NmRunSummary {
  return {
    id: "run1",
    status: "running",
    branch: "harness/app-bugfixes",
    startedAt: 0,
    endedAt: null,
    prUrl: null,
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

/**
 * A multiplexer / emulator handle, with only the fields a test cares about spelled out.
 *
 * Here rather than in each test for the reason `mkSession` is: these are the shapes that
 * grow when a handle learns a field, and a literal per test file is a literal per test file
 * to update. `Session.terminals` is a LIST, so a test that wants both handles passes both
 * and a test that wants none passes `[]` - which is what "this session has no pane" now
 * looks like everywhere.
 */
export function mkMuxHandle(over: Partial<MuxHandle> = {}): MuxHandle {
  return {
    kind: "multiplexer",
    backend: "tmux",
    session: "s",
    windowIndex: 0,
    windowName: "w",
    paneId: "%1",
    ...over,
  };
}

export function mkEmuHandle(over: Partial<EmulatorHandle> = {}): EmulatorHandle {
  return {
    kind: "emulator",
    backend: "wezterm",
    paneId: "12",
    tabId: "4",
    windowId: "1",
    tabTitle: "old",
    isActive: true,
    ...over,
  };
}

export function mkSession(over: Partial<Session> = {}): Session {
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
    terminals: [mkMuxHandle({ session: "s", paneId: "%1" })],
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
    cost: null,
    goal: { text: "Ensure all worktree changes are in main", source: "model", updatedAt: 0 },
    queue: null,
    orphanedQueue: null,
    inspector: null,
    paneDialog: null,
    ...over,
  };
}

/**
 * A representative dispatched task, and - like `mkSession` above - the ONE place a
 * required field has to be added when the `Task` type grows.
 *
 * Six test files kept private copies of this before `priority`/`labels` existed, so
 * adding two required fields broke six fixtures in six places. That is the cost this
 * helper removes: the next field is one edit here, and every test that does not care
 * about it keeps compiling.
 */
export function mkTask(over: Partial<Task> = {}): Task {
  const now = 1000;
  return {
    id: "t1",
    title: "T",
    intent: "do the thing",
    kind: "ship",
    agent: "claude",
    priority: null,
    labels: [],
    model: null,
    source: null,
    repoRoot: "/repo",
    worktreePath: null,
    branch: null,
    provider: null,
    tmuxSession: null,
    sessionId: null,
    status: "backlog",
    outcome: null,
    outcomeUrl: null,
    error: null,
    createdAt: now,
    updatedAt: now,
    dispatchedAt: null,
    completedAt: null,
    ...over,
  };
}
