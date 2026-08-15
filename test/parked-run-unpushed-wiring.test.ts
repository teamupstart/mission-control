import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session, SessionState, Task } from "../src/shared/types.ts";
import type { WorkflowRunSummary } from "../src/shared/workflow.ts";

// The parked-run stall's unpushed clause, with every link REAL except the registry.
//
// Each layer beneath this is already covered on its own: `unpushed.test.ts` drives the git
// reader against real repositories, `unpushed-observer.test.ts` pins the observer's
// bookkeeping with a fake reader, `stall.test.ts` pins the sentence given an observation, and
// `away-watcher.test.ts` pins the watcher seam with a fake observer. Every one of those
// substitutes at the boundary it is testing, so a build in which they ALL pass can still say
// nothing to an operator - the checkout resolver could return the wrong path, or the observer
// could be handed a reader that never reaches the binding's worktree, and no test above would
// notice.
//
// So this composes them for real: a genuine git repository with a genuine unpushed commit, a
// genuine binding row naming it, `WorkflowManager.bindingCheckout` doing the resolution, and
// the real `readUnpushedCommits` shelling out to git - ending in the sentence the away digest
// prints. What is faked is the registry snapshot, because a live session is not something a
// unit test can have, and the daemon's own wiring of these parts is two lines in
// `src/server/index.ts`.

const home = mkdtempSync(join(tmpdir(), "mission-parked-unpushed-"));
process.env.HARNESS_HOME = join(home, "state");

const { openDb } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { PersonaManager } = await import("../src/server/workflows/personas.ts");
const { WorkflowManager } = await import("../src/server/workflows/manager.ts");
const { WorkflowStore, clearWorkflowTables } = await import("../src/server/workflows/store.ts");
const { startAwayWatcher } = await import("../src/server/away/watcher.ts");
const { createUnpushedObserver } = await import("../src/server/away/unpushed-observer.ts");
const { setAwayConfig } = await import("../src/server/away/config.ts");

const db = openDb();
after(() => rmSync(home, { recursive: true, force: true }));

const MIN = 60_000;

const GRAPH = {
  nodes: [
    { id: "session", kind: "session", position: { x: 0, y: 0 } },
    { id: "end", kind: "end", outcome: "Complete", position: { x: 100, y: 0 } },
  ],
  edges: [],
};
const DEFAULTS = JSON.stringify({
  triggerMode: "manual",
  deliveryMode: "preview",
  maxRepairRounds: 5,
});

function seedWorkflow(): void {
  db.prepare(
    `INSERT INTO workflow_definitions (
       id, name, normalized_name, description, draft_graph_json, completion_policy_json,
       binding_defaults_json, draft_revision, current_version_id, archived_at, created_at, updated_at
     ) VALUES ('w', 'No-Mistakes Review', 'no-mistakes review', '', ?, '{"kind":"none"}', ?, 1, 'v', NULL, 1, 1)`,
  ).run(JSON.stringify(GRAPH), DEFAULTS);
  db.prepare(
    `INSERT INTO workflow_versions (
       id, workflow_id, version, source_draft_revision, graph_json,
       completion_policy_json, binding_defaults_json, published_at
     ) VALUES ('v', 'w', 1, 1, ?, '{"kind":"none"}', ?, 1)`,
  ).run(JSON.stringify(GRAPH), DEFAULTS);
}

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-C", cwd, ...args], {
    stdio: "pipe",
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });

/**
 * A checkout on a branch that TRACKS a remote, holding `ahead` commits the remote lacks.
 *
 * The remote is a local bare repository rather than a stub, because the gate the reader
 * applies is `@{upstream}` and the count is against real remote-tracking refs - neither of
 * which a fabricated `.git/config` reliably reproduces.
 */
function seedCheckout(name: string, ahead: number, withRemote = true): string {
  const root = join(home, name);
  mkdirSync(root, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "work", root], { stdio: "pipe" });
  writeFileSync(join(root, "README.md"), "# base\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "base");

  if (withRemote) {
    const bare = join(home, `${name}-origin.git`);
    execFileSync("git", ["init", "--bare", "-q", bare], { stdio: "pipe" });
    git(root, "remote", "add", "origin", bare);
    git(root, "push", "-q", "-u", "origin", "work");
  }
  for (let i = 0; i < ahead; i++) {
    git(root, "commit", "-q", "--allow-empty", "-m", `fix the findings ${i + 1}`);
  }
  return root;
}

function mkSession(over: Partial<Session> = {}): Session {
  return {
    id: "session",
    agent: "claude",
    name: "sess",
    runtime: "terminal",
    foremanInvite: null,
    nameSource: "process",
    state: "idle" as SessionState,
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
    lastActivity: 0,
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
    pendingTurns: [],
    orphanedQueue: null,
    inspector: null,
    paneDialog: null,
    ...over,
  };
}

function runSummary(over: Partial<WorkflowRunSummary> = {}): WorkflowRunSummary {
  return {
    id: "run",
    bindingId: "b",
    workflowId: "w",
    workflowName: "No-Mistakes Review",
    workflowVersion: 1,
    sessionId: "session",
    noteKey: "note",
    status: "waiting_for_new_head",
    phase: "inspector_findings",
    round: 2,
    maxRepairRounds: 5,
    activePersonaNames: [],
    failedPersonaCount: 1,
    bypassedPersonaReview: false,
    gate: "none",
    gatePrNumber: null,
    gateHeadShort: null,
    reviewPosture: null,
    uncertainDeliveryCount: 0,
    refusedDeliveryCount: 0,
    updatedAt: 0,
    ...over,
  };
}

/**
 * Stand up the real daemon parts around one checkout and return the stall the watcher reports.
 *
 * Polls because the whole design puts the git read BETWEEN ticks: the first pass starts four
 * subprocesses and returns immediately, so the sentence that quotes them is necessarily built
 * by a later pass. That is the production behaviour, not a testing artifact - which is why
 * this waits for it rather than reaching past it.
 */
async function stallFor(sessionCwd: string | null): Promise<string> {
  clearWorkflowTables(db);
  seedWorkflow();
  setAwayConfig({ detectStalls: true });

  const store = new WorkflowStore(db);
  store.insertBinding({
    id: "b",
    workflowVersionId: "v",
    noteKey: "note",
    sessionId: "session",
    sessionAgent: "claude",
    sessionName: "sess",
    sessionCwd,
    sessionRepoRoot: sessionCwd,
    triggerMode: "manual",
    deliveryMode: "preview",
    maxRepairRounds: 5,
    now: 1,
  });

  const registry = new Registry();
  new PersonaManager(registry, store);
  const workflows = new WorkflowManager(registry, store);

  // Exactly the production wiring from `src/server/index.ts`, including the REAL reader - the
  // one line this file exists to exercise.
  const observer = createUnpushedObserver({
    checkoutFor: (run) => workflows.bindingCheckout(run.bindingId),
  });

  const source = {
    snapshot: () => ({
      sessions: [mkSession()],
      tasks: [] as Task[],
      workflowRunSummaries: [runSummary()],
    }),
  };
  const w = startAwayWatcher(source, () => 30 * MIN, { unpushedObserver: observer });
  try {
    // One tick to START the read - the watcher's own call, which is the wiring under test -
    // then wait on the observation itself rather than ticking again and again. Every outcome
    // this file asserts (ahead, pushed, and each unknown) records an entry, so this is the
    // one signal that means "git answered" for all of them.
    //
    // Deliberately NOT a tick loop: a pass snapshots the registry and re-runs the whole alert
    // engine, and spinning that at 25ms for six tests is real CPU stolen from the
    // timing-sensitive files `npm test` runs alongside this one.
    w.tick();
    for (let i = 0; i < 200 && !observer.snapshot().has("run"); i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(observer.snapshot().has("run"), "git never answered for this checkout");
    // A second pass, so the sentence is built from the observation that just landed.
    w.tick();
    return w.stalls()[0]?.reason ?? "";
  } finally {
    w.stop();
  }
}

// Two git repositories, and deliberately only two.
//
// Every OTHER shape the reader can meet - level with its upstream, a detached HEAD, a path
// that is no repository, a git that failed - is already driven against real repositories by
// `test/unpushed.test.ts`, and every sentence those shapes produce is already pinned by
// `test/stall.test.ts`. Re-seeding a repository per shape here would re-prove both against a
// third copy of the same fixtures, and it is not free: `npm test` runs two files at a time,
// and a file that spawns git in a loop steals the CPU that the process-lifecycle suites
// (SIGTERM grace periods, process-group emptiness, subprocess timeouts) measure their
// deadlines with. So this file seeds exactly the two cases that prove the COMPOSITION works
// in both directions - a claim being made, and a claim being withheld - and leaves the
// shape-by-shape enumeration where it already lives.

test("a real unpushed commit reaches the parked-run stall through the real resolver", async () => {
  const reason = await stallFor(seedCheckout("ahead-two", 2));
  assert.equal(
    reason,
    "idle 30m - No-Mistakes Review is waiting for a pushed head"
      + " and you have 2 commits that are not pushed",
  );
});

test("a branch that tracks NOTHING says nothing, however many commits it holds", async () => {
  // The false accusation this whole tri-state exists to prevent, proved against a real branch
  // with real commits and no upstream rather than against a hand-written `unknown`. Paired
  // with the case above it also rules out the build that simply always appends a clause.
  const reason = await stallFor(seedCheckout("no-remote", 2, false));
  assert.equal(reason, "idle 30m - No-Mistakes Review is waiting for a pushed head");
});

test("bindingCheckout resolves the BINDING's checkout, which is what the observer is given", () => {
  // The resolution the observer depends on, asserted directly so a failure upstream of the
  // sentence names itself instead of arriving as a missing clause.
  clearWorkflowTables(db);
  seedWorkflow();
  const store = new WorkflowStore(db);
  store.insertBinding({
    id: "b",
    workflowVersionId: "v",
    noteKey: "note",
    sessionId: "session",
    sessionAgent: "claude",
    sessionName: "sess",
    sessionCwd: "/work/secondary-repo",
    sessionRepoRoot: "/work/secondary-repo",
    triggerMode: "manual",
    deliveryMode: "preview",
    maxRepairRounds: 5,
    now: 1,
  });
  const registry = new Registry();
  new PersonaManager(registry, store);
  const workflows = new WorkflowManager(registry, store);
  assert.equal(workflows.bindingCheckout("b"), "/work/secondary-repo");
  // A run whose binding is gone resolves to null rather than throwing, which is what keeps a
  // torn-down binding from taking the watcher's tick down with it.
  assert.equal(workflows.bindingCheckout("missing"), null);
});
