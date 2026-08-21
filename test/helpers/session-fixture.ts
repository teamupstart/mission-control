import type {
  Session,
  SessionMeta,
  Task,
  TaskSummary,
} from "../../src/shared/types.ts";
import type { EmulatorHandle, MuxHandle } from "../../src/shared/terminal.ts";
import type { EnsembleSummary, TaskEnsembleLink } from "../../src/shared/ensemble.ts";

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
  const session = over.session ?? "s";
  return {
    kind: "multiplexer",
    backend: "tmux",
    session,
    sessionName: over.sessionName ?? session,
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
    // Pane-backed, which is what every fixture here describes: it carries a tmux handle and
    // a tty. A test about a driver-run session overrides both this and `terminals`.
    runtime: "terminal",
    // A dispatched worktree session, which is what this fixture models (the cwd and branch
    // above say so) - and the default that preserves the meaning of every test written
    // under participate-always semantics. Tests exercising uninvited behavior declare
    // `foremanInvite: null` explicitly.
    foremanInvite: "dispatch",
    name: "App Bugfixes",
    nameSource: "tmux",
    state: "working",
    cwd: "/wt/app-bugfixes",
    gitBranch: "harness/app-bugfixes",
    gitRoot: null,
    repoRoot: null,
    pid: 1,
    tty: "ttys1",
    permissionMode: null,
    terminals: [mkMuxHandle({ session: "s", paneId: "%1" })],
    agentSessionId: "agent-1",
    transcriptPath: null,
    instrumented: true,
    stateConfirmed: true,
    hooksSeen: true,
    activity: "editing SessionCard.tsx",
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
    meta: meta(),
    effortBaselineReady: true,
    pendingEffort: null,
    note: null,
    cost: null,
    goal: { text: "Ensure all worktree changes are in main", source: "model", updatedAt: 0 },
    queue: null,
    pendingTurns: [],
    orphanedQueue: null,
    inspector: null,
    // Uncorrelated, which is what every session on a fleet with no pipeline provider
    // enabled is - and what every test written before pipelines existed assumes.
    pipeline: null,
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
    dependencies: [],
    // The default every task is created with, so a test that says nothing about the
    // autopilot toggle keeps describing a schedulable backlog item.
    enabled: true,
    model: null,
    effort: null,
    source: null,
    pipelineRun: null,
    repoRoot: "/repo",
    baseSha: null,
    extraRepos: [],
    worktreePath: null,
    branch: null,
    provider: null,
    worktreeLeaseId: null,
    homeName: null,
    terminalResourceId: null,
    sessionId: null,
    // Not a scheduled task. Every fixture built here is ordinary work; the schedule
    // tests build their own provenance explicitly rather than inheriting it by default.
    scheduleId: null,
    scheduleOccurrenceId: null,
    scheduledFor: null,
    status: "backlog",
    outcome: null,
    outcomeUrl: null,
    error: null,
    createdAt: now,
    updatedAt: now,
    dispatchedAt: null,
    completedAt: null,
    ...over,
    workflowId: over.workflowId ?? null,
    // Derived from the retention ledger on read, so a hand-built fixture has nothing to say
    // about automatic cleanup unless a test is specifically about it.
    automaticCleanup: over.automaticCleanup ?? null,
  };
}

/**
 * One ensemble member's projection, as it rides on `Session.task.ensemble`.
 *
 * Shared rather than re-literal'd per test for `mkSession`'s reason: `TaskEnsembleLink`
 * gained `needsInput` in the phase before this one, and a copy per file is a copy per file
 * to fix the next time it grows.
 */
export function mkEnsembleLink(over: Partial<TaskEnsembleLink> = {}): TaskEnsembleLink {
  return {
    runId: "run-1",
    strategyId: "best_of_n",
    strategyLabel: "Best of N",
    memberId: "m-1",
    ordinal: 1,
    wave: 1,
    role: "candidate",
    launchedMembers: 3,
    maxMembers: 3,
    status: "active",
    resultLabel: null,
    needsInput: false,
    ...over,
  };
}

/** The nested task summary a session card reads, defaulting to ordinary dispatched work. */
export function mkTaskSummary(over: Partial<TaskSummary> = {}): TaskSummary {
  return {
    id: "task-1",
    title: "Fix the parser",
    fullTitle: "Fix the parser",
    kind: "ship",
    workflowId: null,
    status: "running",
    outcome: null,
    outcomeUrl: null,
    scheduleId: null,
    scheduleOccurrenceId: null,
    scheduledFor: null,
    ensemble: null,
    repoPrs: [],
    ...over,
  };
}

/** A session that is member `ordinal` of an ensemble run - the fixture clusters are built from. */
export function mkMemberSession(
  over: Partial<Session> & { link?: Partial<TaskEnsembleLink> } = {},
): Session {
  const { link, ...rest } = over;
  const ensemble = mkEnsembleLink(link);
  return mkSession({
    id: `s-${ensemble.runId}-${ensemble.ordinal}`,
    name: `${ensemble.runId} candidate ${ensemble.ordinal}`,
    pid: 100 + ensemble.ordinal,
    task: mkTaskSummary({ id: `task-${ensemble.memberId}`, ensemble }),
    ...rest,
  });
}

/**
 * A run's bounded SSE summary, defaulting to three launched members and nothing amiss.
 *
 * Every member count is overridable because the whole of Phase 3's progress rendering is a
 * fold over them, and the states worth pinning (a blocked member, a casualty, a roster only
 * half launched) are exactly the ones a live dashboard does not happen to be showing.
 */
export function mkEnsembleSummary(over: Partial<EnsembleSummary> = {}): EnsembleSummary {
  return {
    id: "run-1",
    title: "Fix the parser",
    repoRoot: "/repo",
    strategyId: "best_of_n",
    strategyKey: "best_of_n@1",
    strategyLabel: "Best of N",
    strategyVersion: 1,
    status: "running",
    activeStageId: "stage-1-work",
    memberCount: 3,
    launchedMembers: 3,
    maxMembers: 3,
    readyArtifacts: 0,
    membersOut: 0,
    membersNeedingInput: 0,
    membersReady: 0,
    selectedMemberId: null,
    outcomeKind: null,
    unreadable: null,
    failureAcknowledgedAt: null,
    attention: false,
    error: null,
    createdAt: 1000,
    updatedAt: 2000,
    completedAt: null,
    ...over,
  };
}
