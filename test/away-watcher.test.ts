import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Session, SessionState, Task } from "../src/shared/types.ts";
import type { WorkflowRunRepeatOffender, WorkflowRunSummary } from "../src/shared/workflow.ts";
import type { EnsembleSummary } from "../src/shared/ensemble.ts";
import type { UnpushedCommits } from "../src/shared/unpushed.ts";
import type { ReportItem } from "../src/shared/reports.ts";
import { mkReport } from "./helpers/report-fixture.ts";
import { tempDir } from "./temp-root.mjs";

// The away watcher's buffer lifecycle: when a window opens, what lands in it, and
// how it survives the moment of return. Real db for the config (as
// away-config.test.ts does) and a fake registry, so the poll loop never runs and
// each pass is driven explicitly.

const home = tempDir("mission-away-watch-");
process.env.HARNESS_HOME = join(home, "state");

const { openDb } = await import("../src/server/db.ts");
const { setAwayConfig } = await import("../src/server/away/config.ts");
const { startAwayWatcher } = await import("../src/server/away/watcher.ts");
const { digestLines, rollupLine } = await import("../src/shared/away-buffer.ts");
const { applyFeatureFlagIntent } = await import("../src/server/feature-flags/index.ts");

after(() => rmSync(home, { recursive: true, force: true }));
beforeEach(() => {
  openDb().exec("DELETE FROM app_config");
});

function mkSession(over: Partial<Session> = {}): Session {
  return {
    blocker: null,
    awaiting: null,
    id: "s",
    agent: "claude",
    name: "sess",
    runtime: "terminal",
    // The away digest covers every session on the machine, invited or not.
    foremanInvite: null,
    nameSource: "process",
    state: "working" as SessionState,
    cwd: null,
    gitBranch: null,
    gitRoot: null,
    repoRoot: null,
    pid: 1,
    tty: null,
    permissionMode: null,
    terminals: [],
    agentSessionId: null,
    transcriptPath: null,
    instrumented: true,
    stateConfirmed: true,
    hooksSeen: true,
    activity: null,
    startedAt: null,
    firstSeen: 0,
    lastSeen: 0,
    lastActivity: null,
    pendingReviews: 0, openQuestions: 0,
    task: null,
    prUrl: null,
    prNumber: null,
    prState: null,
    prChecks: null,
    meta: null,
    effortBaselineReady: false,
    pendingEffort: null,
    note: null,
    cost: null,
    goal: null,
    queue: null,
    pendingTurns: [],
    orphanedQueue: null,
    inspector: null,
    pipeline: null,
    paneDialog: null,
    ...over,
  };
}

/** A registry stand-in whose snapshot the test drives. */
function fakeRegistry(
  sessions: Session[] = [],
  tasks: Task[] = [],
  workflowRuns: WorkflowRunSummary[] = [],
  ensembleSummaries: EnsembleSummary[] = [],
) {
  const state = { sessions, tasks, workflowRuns, ensembleSummaries };
  return {
    src: {
      snapshot: () => ({
        sessions: state.sessions,
        tasks: state.tasks,
        workflowRunSummaries: state.workflowRuns,
        ensembleSummaries: state.ensembleSummaries,
      }),
    },
    set(
      next: Session[],
      nextTasks: Task[] = state.tasks,
      nextWorkflowRuns: WorkflowRunSummary[] = state.workflowRuns,
      nextEnsembles: EnsembleSummary[] = state.ensembleSummaries,
    ) {
      state.sessions = next;
      state.tasks = nextTasks;
      state.workflowRuns = nextWorkflowRuns;
      state.ensembleSummaries = nextEnsembles;
    },
  };
}

function ensembleSummary(over: Partial<EnsembleSummary> = {}): EnsembleSummary {
  return {
    id: "ens",
    title: "Compare approaches",
    repoRoot: "/repo",
    strategyId: "best_of_n",
    strategyKey: "best_of_n@1",
    strategyLabel: "Best of N",
    strategyVersion: 1,
    status: "running",
    activeStageId: null,
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
    createdAt: 1,
    updatedAt: 1,
    completedAt: null,
    ...over,
  };
}

function workflowRun(over: Partial<WorkflowRunSummary> = {}): WorkflowRunSummary {
  return {
    id: "run",
    bindingId: "binding",
    workflowId: "workflow",
    workflowName: "Review",
    workflowVersion: 1,
    sessionId: "session",
    noteKey: "note",
    status: "running",
    phase: "persona_review",
    round: 1,
    maxRepairRounds: 5,
    activePersonaNames: [],
    failedPersonaCount: 0,
    bypassedPersonaReview: false,
    gate: "none",
    gatePrNumber: null,
    gateHeadShort: null,
    reviewPosture: null,
    uncertainDeliveryCount: 0,
    refusedDeliveryCount: 0,
    updatedAt: 1,
    ...over,
  };
}

const MIN = 60_000;

test("not away: no buffer is open", () => {
  const reg = fakeRegistry([mkSession()]);
  const w = startAwayWatcher(reg.src, () => 1000);
  assert.equal(w.buffer(), null);
  w.stop();
});

test("going away opens a buffer stamped with the away window", () => {
  const reg = fakeRegistry([mkSession()]);
  const w = startAwayWatcher(reg.src, () => 1000);
  setAwayConfig({ away: true }, 500);
  w.tick();
  assert.equal(w.buffer()?.since, 500);
  w.stop();
});

test("the FIRST pass after going away seeds silently - no history floods the buffer", () => {
  // Without a baseline every live session reads as a brand-new transition, and you
  // return to a digest describing things that happened before you left.
  const reg = fakeRegistry([mkSession({ id: "a", state: "idle" })]);
  const w = startAwayWatcher(reg.src, () => 1000);
  setAwayConfig({ away: true }, 500);
  w.tick();
  assert.equal(w.buffer()?.events.length, 0);
  w.stop();
});

test("a session finishing while away lands in the buffer", () => {
  const reg = fakeRegistry([mkSession({ id: "a", state: "working" })]);
  const w = startAwayWatcher(reg.src, () => 1000);
  setAwayConfig({ away: true }, 500);
  w.tick(); // baseline

  reg.set([mkSession({ id: "a", state: "idle" })]);
  w.tick();

  const events = w.buffer()?.events ?? [];
  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, "idle");
  w.stop();
});

test("with the inbox flag on, a resident's digest line is named by the one naming rule", (t) => {
  // Restore the flag on every path, so a failed assertion here cannot leave resident naming on
  // for the tests after it.
  t.after(() => { applyFeatureFlagIntent({ kind: "flag", id: "inbox", enabled: false }); });
  const resident = mkSession({ id: "a", name: "watcher-1", task: { id: "t-resident", title: "Watch lint" } as Session["task"] });
  const residentRuns = [{ taskId: "t-resident", settings: { identity: { name: "Linter watcher" }, board: { colorId: "teal" } } }];
  const titleWith = (enabled: boolean): string | undefined => {
    applyFeatureFlagIntent({ kind: "flag", id: "inbox", enabled });
    let sessions = [{ ...resident, state: "working" as SessionState }];
    const src = { snapshot: () => ({ sessions, tasks: [], residentRuns }) } as unknown as Parameters<typeof startAwayWatcher>[0];
    const w = startAwayWatcher(src, () => 1000);
    setAwayConfig({ away: true }, 500);
    w.tick(); // baseline
    sessions = [{ ...resident, state: "idle" as SessionState }];
    w.tick();
    const title = w.buffer()?.events[0]?.title;
    w.stop();
    setAwayConfig({ away: false }, 2000);
    return title;
  };
  assert.equal(titleWith(false), "Watch lint went idle");
  assert.equal(titleWith(true), "Linter watcher went idle");
});

test("a call sign or reference name names a digest line only while voice is on as well as inbox", (t) => {
  t.after(() => {
    applyFeatureFlagIntent({ kind: "flag", id: "inbox", enabled: false });
    applyFeatureFlagIntent({ kind: "flag", id: "voice", enabled: false });
  });
  const named = mkSession({ id: "a", name: "parser-1", task: { id: "t-alice", title: "Fix the parser", callSign: "Alice" } as Session["task"] });
  const resident = mkSession({ id: "b", name: "watcher-1", task: { id: "t-resident", title: "Watch lint" } as Session["task"] });
  const residentRuns = [{ taskId: "t-resident", profileId: "p-lint", settings: { identity: { name: "Linter watcher" }, board: { colorId: "teal" } } }];
  const residentProfiles = [{ id: "p-lint", settings: { identity: { name: "Linter watcher", referenceName: "Sage" } } }];
  const titlesWith = (voice: boolean): (string | undefined)[] => {
    applyFeatureFlagIntent({ kind: "flag", id: "inbox", enabled: true });
    applyFeatureFlagIntent({ kind: "flag", id: "voice", enabled: voice });
    let sessions = [named, resident].map((s) => ({ ...s, state: "working" as SessionState }));
    const src = { snapshot: () => ({ sessions, tasks: [], residentRuns, residentProfiles }) } as unknown as Parameters<typeof startAwayWatcher>[0];
    const w = startAwayWatcher(src, () => 1000);
    setAwayConfig({ away: true }, 500);
    w.tick(); // baseline
    sessions = [named, resident].map((s) => ({ ...s, state: "idle" as SessionState }));
    w.tick();
    const titles = (w.buffer()?.events ?? []).map((event) => event.title).sort();
    // Even after session removal, the read uses the current flag without another poll.
    sessions = [];
    w.flush();
    applyFeatureFlagIntent({ kind: "flag", id: "voice", enabled: !voice });
    assert.deepEqual(w.takePending()?.events.map((event) => event.title).sort(), voice
      ? ["Fix the parser went idle", "Linter watcher went idle"]
      : ['"Sage" went idle', "Alice went idle"]);
    w.stop();
    setAwayConfig({ away: false }, 2000);
    return titles;
  };
  // Voice off: a saved call sign and reference name are kept, and name nothing.
  assert.deepEqual(titlesWith(false), ["Fix the parser went idle", "Linter watcher went idle"]);
  assert.deepEqual(titlesWith(true), ['"Sage" went idle', "Alice went idle"]);
});

test("with the inbox flag on, a report is buffered while away and the digest names who posted", (t) => {
  t.after(() => { applyFeatureFlagIntent({ kind: "flag", id: "inbox", enabled: false }); });
  applyFeatureFlagIntent({ kind: "flag", id: "inbox", enabled: true });
  let clock = 1000;
  const steve = mkReport({ id: "r-1", createdAt: 1500, author: { key: "resident:steve", name: "Steve", residentProfileId: "steve" } });
  let reports: ReportItem[] = [];
  const src = { snapshot: () => ({ sessions: [], tasks: [], reports }) } as unknown as Parameters<typeof startAwayWatcher>[0];
  const w = startAwayWatcher(src, () => clock);
  setAwayConfig({ away: true }, 500);
  w.tick(); // opens the window
  // Posted and stamped between two reads: the watcher never saw it unstamped, and it is still news.
  reports = [{ ...steve, announcedAs: "back", announcedAt: 1600 }];
  clock = 2000;
  w.tick();
  // Posted, read once unstamped, then stamped: news exactly once.
  const carol = mkReport({ id: "r-2", createdAt: 2500, author: { key: "session:s2", name: "Carol", residentProfileId: null } });
  reports = [...reports, carol];
  clock = 3000;
  w.tick();
  reports = [reports[0]!, { ...carol, announcedAs: "working", announcedAt: 3500 }];
  clock = 4000;
  w.tick();
  w.tick();
  const buf = w.buffer()!;
  assert.deepEqual(buf.events.map((e) => [e.key, e.title, e.count]), [
    ["report:r-1", "Steve's back: Report r-1", 1],
    ["report:r-2", "Carol posted a report: Report r-2", 1],
  ]);
  assert.equal(rollupLine(buf), "2 reports waiting: Steve and Carol");
  w.stop();
  setAwayConfig({ away: false }, 5000);
});

test("the return digest counts the reports waiting on return, not the announcements buffered", (t) => {
  t.after(() => { applyFeatureFlagIntent({ kind: "flag", id: "inbox", enabled: false }); });
  applyFeatureFlagIntent({ kind: "flag", id: "inbox", enabled: true });
  let clock = 1000;
  const named = (id: string, name: string, createdAt: number) =>
    mkReport({ id, createdAt, author: { key: `session:${name}`, name, residentProfileId: null } });
  let reports: ReportItem[] = [];
  const src = { snapshot: () => ({ sessions: [], tasks: [], reports }) } as unknown as Parameters<typeof startAwayWatcher>[0];
  const counted: string[][] = [];
  const w = startAwayWatcher(src, () => clock, { reportsCountedInDigest: (ids) => { counted.push(ids); } });
  setAwayConfig({ away: true }, 500);
  w.tick();
  // Steve's report is announced and buffered.
  reports = [{ ...named("r-1", "Steve", 1500), announcedAs: "back", announcedAt: 1600 }];
  clock = 2000;
  w.tick();
  assert.equal(rollupLine(w.buffer()!), "1 report waiting: Steve");
  // Carol posts just before you return; her stamp's grace period is still running.
  reports = [...reports, named("r-2", "Carol", 2500)];
  clock = 3000;
  w.tick();
  // Read from the phone while away: Steve's leaves, and the preview stops counting it.
  reports = reports.filter((r) => r.id !== "r-1");
  clock = 4000;
  w.tick();
  assert.equal(rollupLine(w.buffer()!), "");
  setAwayConfig({ away: false }, 4500);
  w.flush();
  const digest = w.takePending()!;
  assert.equal(rollupLine(digest), "1 report waiting: Carol");
  assert.deepEqual(counted, [["r-2"]], "every waiting report it counted is reported, so none notifies afterwards");
  assert.deepEqual(digestLines(digest), ["Carol posted a report: Report r-2 - What I found."]);
  w.stop();
});

test("a report stamped while away is reported as counted too, so a window that missed its stamp stays quiet", (t) => {
  t.after(() => { applyFeatureFlagIntent({ kind: "flag", id: "inbox", enabled: false }); });
  applyFeatureFlagIntent({ kind: "flag", id: "inbox", enabled: true });
  let clock = 1000;
  let reports: ReportItem[] = [];
  const src = { snapshot: () => ({ sessions: [], tasks: [], reports }) } as unknown as Parameters<typeof startAwayWatcher>[0];
  const counted: string[][] = [];
  let claimed = 0;
  const w = startAwayWatcher(src, () => clock, {
    reportsCountedInDigest: (ids) => { counted.push(ids); },
    reportsDigestClaimed: () => { claimed++; },
  });
  setAwayConfig({ away: true }, 500);
  w.tick();
  reports = [mkReport({ id: "r-7", createdAt: 1500, announcedAs: "back", announcedAt: 1600, author: { key: "session:x", name: "Xan", residentProfileId: null } })];
  clock = 2000;
  w.tick();
  setAwayConfig({ away: false }, 2500);
  w.flush();
  // Counted as the window closes, but kept only once a dashboard claims the digest: until then
  // the mark lives and dies with the digest, which is only in memory.
  assert.deepEqual([counted, claimed], [[["r-7"]], 0]);
  assert.equal(rollupLine(w.takePending()!), "1 report waiting: Xan");
  assert.equal(claimed, 1);
  // Nothing left to claim: no second claim.
  assert.equal(w.takePending(), null);
  assert.equal(claimed, 1);
  w.stop();
});

test("turning the inbox flag off while away takes buffered reports out of the digest and keeps everything else", (t) => {
  t.after(() => { applyFeatureFlagIntent({ kind: "flag", id: "inbox", enabled: false }); });
  applyFeatureFlagIntent({ kind: "flag", id: "inbox", enabled: true });
  let clock = 1000;
  let reports: ReportItem[] = [];
  let sessions = [mkSession({ id: "a", name: "auth", state: "working" as SessionState })];
  const src = { snapshot: () => ({ sessions, tasks: [], reports }) } as unknown as Parameters<typeof startAwayWatcher>[0];
  const counted: string[][] = [];
  const w = startAwayWatcher(src, () => clock, { reportsCountedInDigest: (ids) => { counted.push(ids); } });
  setAwayConfig({ away: true }, 500);
  w.tick();
  reports = [mkReport({ id: "r-8", createdAt: 1500, announcedAs: "back", announcedAt: 1600, author: { key: "session:x", name: "Yara", residentProfileId: null } })];
  sessions = [{ ...sessions[0]!, state: "idle" as SessionState }];
  clock = 2000;
  w.tick();
  assert.equal(rollupLine(w.buffer()!), "1 report waiting: Yara · 1 finished");
  // The flag goes off before you return.
  applyFeatureFlagIntent({ kind: "flag", id: "inbox", enabled: false });
  clock = 3000;
  w.tick();
  assert.equal(rollupLine(w.buffer()!), "1 finished", "the open window's preview stops counting it");
  setAwayConfig({ away: false }, 3500);
  w.flush();
  const digest = w.takePending()!;
  assert.equal(rollupLine(digest), "1 finished");
  assert.ok(!digestLines(digest).some((line) => line.includes("Yara")));
  assert.deepEqual(counted, [], "nothing is marked counted while the flag is off");
  w.stop();
});

test("a failed write marking reports counted still closes the window, so the digest is not merged twice", (t) => {
  t.after(() => { applyFeatureFlagIntent({ kind: "flag", id: "inbox", enabled: false }); });
  applyFeatureFlagIntent({ kind: "flag", id: "inbox", enabled: true });
  t.mock.method(console, "error", () => undefined);
  let clock = 1000;
  const reports: ReportItem[] = [];
  const src = { snapshot: () => ({ sessions: [], tasks: [], reports }) } as unknown as Parameters<typeof startAwayWatcher>[0];
  let calls = 0;
  const w = startAwayWatcher(src, () => clock, {
    reportsCountedInDigest: () => { calls++; throw new Error("database is locked"); },
  });
  setAwayConfig({ away: true }, 500);
  w.tick();
  reports.push(mkReport({ id: "r-9", createdAt: 1500, announcedAs: "back", announcedAt: 1600, author: { key: "session:z", name: "Zed", residentProfileId: null } }));
  clock = 2000;
  w.tick();
  setAwayConfig({ away: false }, 2500);
  assert.doesNotThrow(() => w.flush(), "the return that closes the window does not fail with the write");
  clock = 3000;
  w.tick(); // a later close finds no window left open
  w.flush();
  const digest = w.takePending()!;
  assert.equal(calls, 1);
  assert.deepEqual(digest.events.map((e) => [e.key, e.count]), [["report:r-9", 1]]);
  assert.equal(rollupLine(digest), "1 report waiting: Zed");
  w.stop();
});

test("a report posted at the desk between two unclaimed away windows is not counted in their merged digest", (t) => {
  t.after(() => { applyFeatureFlagIntent({ kind: "flag", id: "inbox", enabled: false }); });
  applyFeatureFlagIntent({ kind: "flag", id: "inbox", enabled: true });
  let clock = 1000;
  const reports: ReportItem[] = [];
  const src = { snapshot: () => ({ sessions: [], tasks: [], reports }) } as unknown as Parameters<typeof startAwayWatcher>[0];
  const counted: string[][] = [];
  const w = startAwayWatcher(src, () => clock, { reportsCountedInDigest: (ids) => { counted.push(ids); } });
  // First window [1000, 2000], closed and never claimed.
  setAwayConfig({ away: true }, 1000);
  w.tick();
  setAwayConfig({ away: false }, 2000);
  clock = 2000;
  w.flush();
  // At the desk: a report is posted and stays unread.
  reports.push(mkReport({ id: "r-desk", createdAt: 2500, author: { key: "session:d", name: "Desk", residentProfileId: null } }));
  // Second window [3000, 4000], also with nothing posted during it.
  clock = 3000;
  setAwayConfig({ away: true }, 3000);
  w.tick();
  setAwayConfig({ away: false }, 4000);
  clock = 4000;
  w.flush();
  const digest = w.takePending();
  assert.ok(!digest || !digest.events.some((e) => e.key === "report:r-desk"), "a desk-time report is not away activity");
  assert.deepEqual(counted, [], "and it is not marked counted");
  w.stop();
});

test("workflow transitions use the same away window and coalesce stable ids", () => {
  const running = workflowRun();
  const completed = workflowRun({ status: "completed", phase: "complete", updatedAt: 2 });
  const reg = fakeRegistry([], [], [running]);
  const w = startAwayWatcher(reg.src, () => 1_000);
  setAwayConfig({ away: true }, 500);
  w.tick();

  reg.set([], [], [completed]);
  w.tick();
  w.tick();

  const events = w.buffer()?.events ?? [];
  assert.deepEqual(events.map((event) => event.key), ["workflow:run:completed"]);
  assert.equal(events[0]?.count, 1);
  assert.equal(rollupLine(w.buffer()!), "1 workflow update");
  w.stop();
});

test("an ensemble reaching its decision boundary folds into the same away digest", () => {
  const running = ensembleSummary();
  const parked = ensembleSummary({ status: "awaiting_decision", attention: true, updatedAt: 2 });
  const reg = fakeRegistry([], [], [], [running]);
  const w = startAwayWatcher(reg.src, () => 1_000);
  setAwayConfig({ away: true }, 500);
  w.tick(); // baseline

  reg.set([], [], [], [parked]);
  w.tick();
  w.tick(); // a redelivered summary must not re-announce

  const events = w.buffer()?.events ?? [];
  assert.deepEqual(events.map((event) => event.key), ["ensemble:ens:decision"]);
  assert.equal(events[0]?.count, 1);
  assert.equal(rollupLine(w.buffer()!), "1 ensemble update");
  w.stop();
});

test("nothing is buffered while you are AT THE DESK", () => {
  const reg = fakeRegistry([mkSession({ id: "a", state: "working" })]);
  const w = startAwayWatcher(reg.src, () => 1000);
  w.tick();
  reg.set([mkSession({ id: "a", state: "idle" })]);
  w.tick();
  assert.equal(w.buffer(), null);
  w.stop();
});

test("returning CLOSES the window into a pending digest rather than dropping it", () => {
  // The read that renders the summary necessarily happens after you are back, so
  // discarding on return would mean the digest never had anything to show.
  const reg = fakeRegistry([mkSession({ id: "a", state: "working" })]);
  const w = startAwayWatcher(reg.src, () => 1000);
  setAwayConfig({ away: true }, 500);
  w.tick();
  reg.set([mkSession({ id: "a", state: "idle" })]);
  w.tick();

  setAwayConfig({ away: false }, 2000);
  w.tick();

  assert.equal(w.buffer(), null);
  const pending = w.takePending();
  assert.equal(pending?.events.length, 1);
  w.stop();
});

test("flush closes the window immediately, without waiting for a tick", () => {
  // The route that flips away off calls this; the poll tick is up to 5s behind and
  // the client's follow-up digest read would otherwise beat it.
  const reg = fakeRegistry([mkSession({ id: "a", state: "working" })]);
  const w = startAwayWatcher(reg.src, () => 1000);
  setAwayConfig({ away: true }, 500);
  w.tick();
  reg.set([mkSession({ id: "a", state: "idle" })]);
  w.tick();

  w.flush();
  assert.equal(w.takePending()?.events.length, 1);
  w.stop();
});

test("the pending digest is read ONCE - a refresh doesn't re-announce it", () => {
  const reg = fakeRegistry([mkSession({ id: "a", state: "working" })]);
  const w = startAwayWatcher(reg.src, () => 1000);
  setAwayConfig({ away: true }, 500);
  w.tick();
  reg.set([mkSession({ id: "a", state: "idle" })]);
  w.tick();
  w.flush();

  assert.notEqual(w.takePending(), null);
  assert.equal(w.takePending(), null);
  w.stop();
});

test("a SECOND away window starts empty rather than inheriting the first", () => {
  const reg = fakeRegistry([mkSession({ id: "a", state: "working" })]);
  const w = startAwayWatcher(reg.src, () => 1000);
  setAwayConfig({ away: true }, 500);
  w.tick();
  reg.set([mkSession({ id: "a", state: "idle" })]);
  w.tick();
  setAwayConfig({ away: false }, 2000);
  w.tick();

  setAwayConfig({ away: true }, 3000);
  w.tick();
  assert.equal(w.buffer()?.since, 3000);
  assert.equal(w.buffer()?.events.length, 0);
  w.stop();
});

test("stalls are detected even at the desk - being told an agent is wedged always helps", () => {
  const reg = fakeRegistry([mkSession({ id: "a", state: "working", lastActivity: 0 })]);
  const w = startAwayWatcher(reg.src, () => 30 * MIN);
  w.tick();
  assert.deepEqual(w.stalls().map((s) => s.kind), ["silent-working"]);
  w.stop();
});

test("a session parked on a workflow run stalls, and the digest names the run", () => {
  // The stranded-session bug, at the seam where it was actually invisible. The watcher holds
  // both halves of one snapshot - the sessions and the run summaries - and until it handed
  // the runs to the detector, an idle session with a parked run reported no outstanding work
  // at all: a review session's task has usually already reached `done` and its queue is
  // empty, so nothing else in `workOutstanding` could see it either.
  const reg = fakeRegistry(
    [mkSession({ id: "session", state: "idle", lastActivity: 0 })],
    [],
    [workflowRun({ status: "waiting_for_session", round: 2 })],
  );
  const w = startAwayWatcher(reg.src, () => 30 * MIN);
  w.tick();

  const stalls = w.stalls();
  assert.deepEqual(stalls.map((s) => s.kind), ["workflow-parked"]);
  assert.equal(stalls[0]?.workflowRunId, "run");
  assert.match(stalls[0]!.reason, /Review repair round 2 never reopened/);
  w.stop();
});

// ---- naming the unpushed head ----
//
// The watcher is where the async git read meets a synchronous tick, so these cover the SEAM
// rather than the sentence (`test/stall.test.ts`) or the bookkeeping
// (`test/unpushed-observer.test.ts`): that the observer is asked, that what it returns reaches
// the stall reason, and that a watcher wired without one behaves exactly as it did before.

/** A stand-in observer whose map the test sets directly. */
function fakeObserver(map: Map<string, UnpushedCommits> = new Map()) {
  const observed: string[][] = [];
  return {
    observed,
    map,
    observer: {
      observe: (runs: readonly WorkflowRunSummary[]) => observed.push(runs.map((r) => r.id)),
      snapshot: () => map,
    },
  };
}

const AHEAD: UnpushedCommits = {
  state: "ahead",
  commits: 2,
  branch: "fix/thing",
  upstream: "origin/fix/thing",
};

test("an unpushed count reaches the parked-run stall reason", async () => {
  const reg = fakeRegistry(
    [mkSession({ id: "session", state: "idle", lastActivity: 0 })],
    [],
    [workflowRun({ status: "waiting_for_new_head", round: 2 })],
  );
  const fake = fakeObserver(new Map([["run", AHEAD]]));
  const w = startAwayWatcher(reg.src, () => 30 * MIN, { unpushedObserver: fake.observer });
  w.tick();

  const stalls = w.stalls();
  assert.deepEqual(stalls.map((s) => s.kind), ["workflow-parked"]);
  assert.match(stalls[0]!.reason, /waiting for a pushed head and you have 2 commits that are not pushed/);
  // The runs it was handed, so the observer can scope its reads to what is actually parked.
  // Asserted per pass rather than by count: the watcher runs one pass on start and another on
  // `tick`, and how many passes have happened is not what this test is about.
  assert.ok(fake.observed.length > 0);
  for (const seen of fake.observed) assert.deepEqual(seen, ["run"]);
  w.stop();
});

test("a watcher wired with NO observer says exactly what it said before", () => {
  // Every existing caller, every embedder, and the first tick of a real one. The clause is an
  // addition to a sentence that has to stand without it.
  const reg = fakeRegistry(
    [mkSession({ id: "session", state: "idle", lastActivity: 0 })],
    [],
    [workflowRun({ status: "waiting_for_new_head", round: 2 })],
  );
  const w = startAwayWatcher(reg.src, () => 30 * MIN);
  w.tick();
  assert.equal(w.stalls()[0]?.reason, "idle 30m - Review is waiting for a pushed head");
  w.stop();
});

test("an observer that has not answered yet adds nothing", () => {
  // The real first tick: `observe` has started a git read that has not come back, so the
  // snapshot is empty. An empty map must read as no claim rather than as nothing unpushed.
  const reg = fakeRegistry(
    [mkSession({ id: "session", state: "idle", lastActivity: 0 })],
    [],
    [workflowRun({ status: "waiting_for_new_head", round: 2 })],
  );
  const fake = fakeObserver();
  const w = startAwayWatcher(reg.src, () => 30 * MIN, { unpushedObserver: fake.observer });
  w.tick();
  assert.equal(w.stalls()[0]?.reason, "idle 30m - Review is waiting for a pushed head");
  assert.doesNotMatch(w.stalls()[0]!.reason, /not pushed/);
  w.stop();
});

test("the observer is asked on every tick, so a push that lands is picked up", () => {
  const reg = fakeRegistry(
    [mkSession({ id: "session", state: "idle", lastActivity: 0 })],
    [],
    [workflowRun({ status: "waiting_for_new_head", round: 2 })],
  );
  const fake = fakeObserver(new Map([["run", AHEAD]]));
  const w = startAwayWatcher(reg.src, () => 30 * MIN, { unpushedObserver: fake.observer });
  w.tick();
  assert.match(w.stalls()[0]!.reason, /not pushed/);

  // The session pushed. The next tick's snapshot says so, and the accusation has to stop.
  const before = fake.observed.length;
  fake.map.set("run", { state: "pushed", branch: "fix/thing", upstream: "origin/fix/thing" });
  w.tick();
  assert.equal(w.stalls()[0]?.reason, "idle 30m - Review is waiting for a pushed head");
  // Re-asked rather than answered once and cached forever - the reason the wording can change.
  assert.equal(fake.observed.length, before + 1);
  w.stop();
});

test("stall detection OFF asks the observer nothing - no git for an answer nobody wants", () => {
  // The read exists to word a stall sentence. With sentences turned off it is a subprocess a
  // minute, for ever, against every parked checkout in the fleet.
  setAwayConfig({ detectStalls: false });
  const reg = fakeRegistry(
    [mkSession({ id: "session", state: "idle", lastActivity: 0 })],
    [],
    [workflowRun({ status: "waiting_for_new_head", round: 2 })],
  );
  const fake = fakeObserver(new Map([["run", AHEAD]]));
  const w = startAwayWatcher(reg.src, () => 30 * MIN, { unpushedObserver: fake.observer });
  w.tick();
  assert.deepEqual(w.stalls(), []);
  assert.deepEqual(fake.observed, []);
  w.stop();
});

test("a parked run whose session is still WORKING is not stalled", () => {
  // The signal is the silence after the repair, not the repair itself.
  const reg = fakeRegistry(
    [mkSession({ id: "session", state: "working", lastActivity: 29 * MIN })],
    [],
    [workflowRun({ status: "waiting_for_session" })],
  );
  const w = startAwayWatcher(reg.src, () => 30 * MIN);
  w.tick();
  assert.deepEqual(w.stalls(), []);
  w.stop();
});

test("turning stall detection off silences it", () => {
  const reg = fakeRegistry([mkSession({ id: "a", state: "working", lastActivity: 0 })]);
  const w = startAwayWatcher(reg.src, () => 30 * MIN);
  setAwayConfig({ detectStalls: false });
  w.tick();
  assert.deepEqual(w.stalls(), []);
  w.stop();
});

test("a session going stuck while away is buffered as attention-worthy", () => {
  const reg = fakeRegistry([mkSession({ id: "a", state: "working", lastActivity: 0 })]);
  let clock = 1000;
  const w = startAwayWatcher(reg.src, () => clock);
  setAwayConfig({ away: true }, 500);
  w.tick(); // baseline, not yet stalled

  clock = 30 * MIN; // now well past the working threshold
  w.tick();

  const events = w.buffer()?.events ?? [];
  assert.deepEqual(events.map((e) => e.kind), ["stuck"]);
  assert.match(rollupLine(w.buffer()!), /1 stuck/);
  w.stop();
});

test("a session ALREADY stuck when you leave still makes the digest", () => {
  // The one you most want reported, and the one a plain edge-trigger is silent
  // about: the stall predates the window, so it is already in the baseline.
  const reg = fakeRegistry([mkSession({ id: "a", state: "working", lastActivity: 0 })]);
  let clock = 30 * MIN;
  const w = startAwayWatcher(reg.src, () => clock);
  w.tick(); // at the desk: the stall is detected and becomes the baseline
  assert.equal(w.stalls().length, 1);

  clock = 31 * MIN;
  setAwayConfig({ away: true }, 31 * MIN);
  w.tick();

  const events = w.buffer()?.events ?? [];
  assert.deepEqual(events.map((e) => e.kind), ["stuck"]);
  w.stop();
});

test("a stall carried into a window is reported ONCE, not once per tick", () => {
  const reg = fakeRegistry([mkSession({ id: "a", state: "working", lastActivity: 0 })]);
  let clock = 30 * MIN;
  const w = startAwayWatcher(reg.src, () => clock);
  w.tick();
  setAwayConfig({ away: true }, 31 * MIN);
  clock = 31 * MIN;
  w.tick();
  clock = 32 * MIN;
  w.tick();

  const events = w.buffer()?.events ?? [];
  assert.equal(events.length, 1);
  assert.equal(events[0]?.count, 1);
  w.stop();
});

test("a stall's digest line ages with it - you read how long it has been stuck NOW", () => {
  // The whole point of the refresh: trip the threshold at 09:12, come back at
  // 10:00, and the line must not still claim the ten minutes it had when it fired.
  const reg = fakeRegistry([mkSession({ id: "a", state: "working", lastActivity: 0 })]);
  let clock = 1000;
  const w = startAwayWatcher(reg.src, () => clock);
  setAwayConfig({ away: true }, 500);
  w.tick(); // baseline, not yet stalled

  clock = 10 * MIN; // trips the working threshold
  w.tick();
  assert.match(w.buffer()?.events[0]?.body ?? "", /silent for 10m/);

  clock = 58 * MIN; // still silent, and you are only now back at the desk
  w.tick();
  const events = w.buffer()?.events ?? [];
  assert.equal(events.length, 1);
  assert.match(events[0]?.body ?? "", /silent for 58m/);
  w.stop();
});

test("ageing a stall's wording is not a second occurrence - no x2 in the digest", () => {
  // A refresh describes one continuous stall more accurately. Counting it would
  // have the card claim the session went stuck once per poll.
  const reg = fakeRegistry([mkSession({ id: "a", state: "working", lastActivity: 0 })]);
  let clock = 1000;
  const w = startAwayWatcher(reg.src, () => clock);
  setAwayConfig({ away: true }, 500);
  w.tick();

  for (const t of [10 * MIN, 20 * MIN, 30 * MIN, 58 * MIN]) {
    clock = t;
    w.tick();
  }

  const buf = w.buffer()!;
  assert.equal(buf.events.length, 1);
  assert.equal(buf.events[0]?.count, 1);
  assert.match(rollupLine(buf), /^1 stuck$/);
  assert.deepEqual(
    digestLines(buf).map((l) => /\(x\d+\)/.test(l)),
    [false],
  );
  w.stop();
});

test("a stall that CLEARS keeps its last real wording and is not refreshed onward", () => {
  // It genuinely happened, so it stays in the digest - but frozen at the moment it
  // resolved, never re-worded from a stall that no longer exists.
  const reg = fakeRegistry([mkSession({ id: "a", state: "working", lastActivity: 0 })]);
  let clock = 1000;
  const w = startAwayWatcher(reg.src, () => clock);
  setAwayConfig({ away: true }, 500);
  w.tick();

  clock = 10 * MIN;
  w.tick();
  assert.equal(w.stalls().length, 1);

  // The agent wakes up: a fresh hook event, so nothing is silent any more.
  clock = 58 * MIN;
  reg.set([mkSession({ id: "a", state: "working", lastActivity: 58 * MIN })]);
  w.tick();

  assert.deepEqual(w.stalls(), []);
  const events = w.buffer()?.events ?? [];
  assert.equal(events.length, 1);
  assert.match(events[0]?.body ?? "", /silent for 10m/);
  w.stop();
});

test("a stall that changes KIND is genuinely new information, and alerts again", () => {
  const reg = fakeRegistry([mkSession({ id: "a", state: "working", lastActivity: 0 })]);
  let clock = 1000;
  const w = startAwayWatcher(reg.src, () => clock);
  setAwayConfig({ away: true }, 500);
  w.tick();

  clock = 10 * MIN;
  w.tick();
  assert.deepEqual(w.stalls().map((s) => s.kind), ["silent-working"]);

  // Foreman escalates: the same session, stuck for a different and more urgent
  // reason, which outranks the silence rule.
  clock = 20 * MIN;
  reg.set([
    mkSession({
      id: "a",
      state: "working",
      lastActivity: 0,
      note: {
        purpose: null,
        brief: null,
        recommendation: null,
        disposition: "escalated",
        lastAction: null,
        handledMarker: null,
        updatedAt: 0,
      },
    }),
  ]);
  w.tick();

  assert.deepEqual(w.stalls().map((s) => s.kind), ["escalated"]);
  const stuck = (w.buffer()?.events ?? []).filter((e) => e.kind === "stuck");
  assert.deepEqual(stuck.map((e) => e.key).sort(), [
    "stuck:a:escalated",
    "stuck:a:silent-working",
  ]);
  assert.deepEqual(stuck.map((e) => e.count), [1, 1]);
  w.stop();
});

test("seeding known stalls does not re-open the history gate for sessions and tasks", () => {
  // The stall seed strips only `stalls` from the baseline; a session that went idle
  // before you left is still pre-existing history and must stay out of the buffer.
  const reg = fakeRegistry([mkSession({ id: "a", state: "working" })]);
  const w = startAwayWatcher(reg.src, () => 1000);
  w.tick(); // at the desk
  reg.set([mkSession({ id: "a", state: "idle" })]);
  w.tick(); // still at the desk: it finished before you stood up

  setAwayConfig({ away: true }, 2000);
  w.tick();
  assert.equal(w.buffer()?.events.length, 0);
  w.stop();
});

test("a second window does not destroy a digest nobody has read yet", () => {
  // Read-once means there is nowhere to recover it from: go away, come back with no
  // dashboard open to claim it, go away again, and the first window would be gone.
  const reg = fakeRegistry([mkSession({ id: "a", state: "working" })]);
  let clock = 1000;
  const w = startAwayWatcher(reg.src, () => clock);
  setAwayConfig({ away: true }, 500);
  w.tick();
  reg.set([mkSession({ id: "a", state: "idle" })]);
  w.tick();
  setAwayConfig({ away: false }, 2000);
  clock = 2000;
  w.tick(); // first digest is pending, unread

  clock = 60_000;
  setAwayConfig({ away: true }, 60_000);
  reg.set([mkSession({ id: "b", state: "working" })]);
  w.tick();
  reg.set([mkSession({ id: "b", state: "idle" })]);
  w.tick();
  setAwayConfig({ away: false }, 61_000);
  clock = 61_000;
  w.tick();

  const pending = w.takePending();
  assert.deepEqual(pending?.events.map((e) => e.sessionId).sort(), ["a", "b"]);
  assert.equal(pending?.since, 500); // the merged window covers from the first exit
  // 1.5s away, then 1s away - NOT the 60.5s between leaving the first time and
  // coming back the second, most of which was spent at the desk.
  assert.equal(pending?.awayMs, 2500);
  w.stop();
});

test("stop() halts the loop", () => {
  const reg = fakeRegistry([mkSession()]);
  const w = startAwayWatcher(reg.src, () => 1000);
  // The unref'd timeout is cleared, so this test process can exit, which is itself the
  // check; stopping must also be safe to repeat.
  assert.doesNotThrow(() => {
    w.stop();
    w.stop();
  });
});

test("the daemon's repeat-offender channel reaches the buffer", () => {
  // The derivation walks a run's submissions and attempts, so it is detail-only and never
  // travels on the SSE summary - which is why the watcher takes it as an injected reader
  // rather than off the registry snapshot, the same shape `stalls` has.
  const reg = fakeRegistry([mkSession({ id: "a", state: "idle" })]);
  const offenders: WorkflowRunRepeatOffender[] = [];
  const w = startAwayWatcher(reg.src, () => 1000, {
    // A fresh array per call, exactly as the daemon's `repeatOffenderSignals()` returns:
    // handing the watcher the same mutable reference would alias its own baseline.
    workflowRepeatOffenders: () => offenders.map((offender) => ({ ...offender })),
  });
  setAwayConfig({ away: true }, 500);
  w.tick(); // baseline: no offenders yet

  offenders.push({
    runId: "run-1",
    workflowName: "No-Mistakes Review",
    sessionId: "a",
    round: 4,
    maxRepairRounds: 5,
    nodeId: "nmr-code-risk",
    personaName: "Code Risk Reviewer",
    rounds: 3,
  });
  w.tick();
  const events = w.buffer()?.events ?? [];
  assert.equal(events.filter((event) => event.kind === "workflow-repeat").length, 1);
  assert.match(
    events.find((event) => event.kind === "workflow-repeat")?.title ?? "",
    /failed 3 rounds running/,
  );

  // Edge-triggered: the same loop on the next pass is not news again.
  w.tick();
  assert.equal(
    (w.buffer()?.events ?? []).filter((event) => event.kind === "workflow-repeat").length,
    1,
  );
  w.stop();
});

test("a muted author's reports are never buffered, one muted after buffering leaves, and the digest neither counts nor marks them", (t) => {
  t.after(() => { applyFeatureFlagIntent({ kind: "flag", id: "inbox", enabled: false }); });
  applyFeatureFlagIntent({ kind: "flag", id: "inbox", enabled: true });
  let clock = 1000;
  const author = (key: string, name: string) => ({ key, name, residentProfileId: null });
  let reports: ReportItem[] = [];
  let reportMutes: { authorKey: string; authorName: string; mutedAt: number }[] = [{ authorKey: "session:loud", authorName: "Loud", mutedAt: 900 }];
  const src = { snapshot: () => ({ sessions: [], tasks: [], reports, reportMutes }) } as unknown as Parameters<typeof startAwayWatcher>[0];
  const counted: string[][] = [];
  const w = startAwayWatcher(src, () => clock, { reportsCountedInDigest: (ids) => { counted.push(ids); } });
  setAwayConfig({ away: true }, 500);
  w.tick();
  // Loud is muted: its stamped report is never buffered. Quiet's is.
  reports = [
    mkReport({ id: "r-1", createdAt: 1500, announcedAs: "back", announcedAt: 1600, author: author("session:loud", "Loud") }),
    mkReport({ id: "r-2", createdAt: 1500, announcedAs: "back", announcedAt: 1600, author: author("session:quiet", "Quiet") }),
  ];
  clock = 2000;
  w.tick();
  assert.deepEqual(w.buffer()!.events.map((e) => e.key), ["report:r-2"]);
  assert.equal(rollupLine(w.buffer()!), "1 report waiting: Quiet");
  // Quiet is muted too, after its report was buffered: it leaves at the next read.
  reportMutes = [...reportMutes, { authorKey: "session:quiet", authorName: "Quiet", mutedAt: 2500 }];
  clock = 3000;
  w.tick();
  assert.deepEqual(w.buffer()!.events.map((e) => e.key), []);
  // An unannounced report posted while away from a muted author is not added when the window closes.
  reports = [...reports, mkReport({ id: "r-3", createdAt: 3500, author: author("session:loud", "Loud") })];
  setAwayConfig({ away: false }, 4000);
  w.flush();
  const digest = w.takePending();
  assert.equal(digest ? rollupLine(digest) : "", "");
  assert.deepEqual(counted, [], "a report the digest did not count is not marked counted, so it would still notify once unmuted");
  w.stop();
});
