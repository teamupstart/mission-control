import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type { InspectorPr } from "../src/shared/types.ts";
import type { WorkflowContextSnapshot, WorkflowInspectorGateState } from "../src/shared/workflow.ts";
import { skillCommand } from "../src/shared/harness-capabilities.ts";
import { mkMuxHandle } from "./helpers/session-fixture.ts";
import { FIXTURE_RUN_INTENT } from "./helpers/workflow-run-intent.ts";
import { tempDir } from "./temp-root.mjs";

// What is at stake: the Inspector sweep stops reading a pull request the moment it reads it
// closed or merged. A gate that opens after that - or loses the signal to a restart - waited for
// a fresh observation nothing would ever supply. It must hold as the ordinary closed-PR block
// instead, and a merge must never pass the gate, waive its review or complete the run.
const home = tempDir("mission-workflow-inspector-retired-");
process.env.MISSION_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

// The pull request read `reobserveInspectorPr` makes, scripted. A missing file is an outage.
const github = join(home, "github-pr.json");
const reads = join(home, "github-reads");
const fakeGh = join(home, "gh");
writeFileSync(fakeGh, `#!${process.execPath}
const fs = require("node:fs");
if (!process.argv.includes("graphql")) process.exit(2);
fs.appendFileSync(${JSON.stringify(reads)}, "read\\n");
try {
  const pr = JSON.parse(fs.readFileSync(${JSON.stringify(github)}, "utf8"));
  process.stdout.write(JSON.stringify({ data: { repository: { pullRequest: {
    state: pr.state, headRefOid: pr.head, headRefName: "feature", baseRefName: "main", isDraft: false,
    title: "Retired fixture",
    reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
    reviews: { nodes: [], pageInfo: { hasPreviousPage: false, startCursor: null } },
  } } } }));
} catch { process.stderr.write("gh: scripted outage\\n"); process.exit(1); }
`);
chmodSync(fakeGh, 0o755);
process.env.MISSION_GH_BIN = fakeGh;

const { adoptInspectorPr, getInspectorPr, loadOpenInspectorPrs, openDb, updateInspectorPr } =
  await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { setInspectorConfig } = await import("../src/server/inspector/config.ts");
const { WorkflowManager } = await import("../src/server/workflows/manager.ts");
const { reobserveInspectorPr } = await import("../src/server/inspector/worker.ts");
const { WorkflowStore, clearWorkflowTables, workflowJson } = await import("../src/server/workflows/store.ts");

const db = openDb();
let serial = 0;

function context(headSha: string): WorkflowContextSnapshot {
  return {
    primaryGoal: { rawPrompt: "Ship the reviewed change", refined: null, sourceNoteKey: "note" },
    humanDecisions: [],
    constraints: [],
    acceptanceCriteria: [],
    priorPersonaFeedback: [],
    session: { agent: "claude", name: "work", cwd: "/repo", branch: "feature" },
    evidence: {
      headSha,
      diffFingerprint: `diff-${headSha}`,
      diff: "diff",
      diffTruncated: false,
      workingTreeDirty: false,
      workingTreeStatus: [],
      workingTreeStatusTruncated: false,
      transcript: [],
      transcriptAnchor: null,
      transcriptTruncated: false,
      standards: [],
      standardsTruncated: false,
    },
    compaction: { status: "fallback", runner: null, model: null, error: null },
  };
}

function inspectorPr(key: string, url: string, sessionId: string, now: number): InspectorPr {
  const [repoKey, numberText] = key.split("#");
  const [owner, repo] = repoKey!.split("/");
  return {
    key, url, owner: owner!, repo: repo!, number: Number(numberText), repoRoot: "/repo", cwd: home,
    sessionId, source: "hook", state: "open", headSha: null, reviewPosture: null, round: 0,
    lastReviewedAt: null, lastError: null, failCount: 0, lastFailKind: null, nextAttemptAt: null,
    lastAttemptSha: null, mergedAt: null, mergeBlock: null, observedHeadSha: null, observedState: null,
    observedAt: null, headRefName: null, title: null, adoptedAt: now, updatedAt: now,
  };
}

interface SeedOptions {
  /** Runs against the adopted row before the gate opens: the order the live case had. */
  beforeGate?: (key: string, head: string, now: number) => void;
}

/** One run whose successful submission is about to enter an Inspector gate on an adopted PR. */
async function seed(over: SeedOptions = {}) {
  clearWorkflowTables(db);
  serial += 1;
  const suffix = String(serial);
  const ids = {
    workflow: `w-${suffix}`, version: `v-${suffix}`, binding: `b-${suffix}`,
    run: `run-${suffix}`, submission: `sub-${suffix}`, session: `session-${suffix}`,
  };
  const head = `head-${suffix}`;
  const key = `owner/repo#${1700 + serial}`;
  const url = `https://github.com/owner/repo/pull/${1700 + serial}`;
  const completionPolicy = { kind: "inspector", onFindings: "restart_workflow", missingPrAction: "wait" };
  const defaults = { triggerMode: "manual", deliveryMode: "preview", maxRepairRounds: 3 };
  const graph = {
    nodes: [
      { id: "session", kind: "session", position: { x: 0, y: 0 } },
      { id: "end", kind: "end", outcome: "Complete", position: { x: 200, y: 0 } },
    ],
    edges: [],
  };
  db.prepare(
    `INSERT INTO workflow_definitions (
       id, name, normalized_name, description, draft_graph_json, completion_policy_json,
       resumption_policy, binding_defaults_json, draft_revision, current_version_id,
       archived_at, created_at, updated_at
     ) VALUES (?, ?, ?, '', ?, ?, 'auto', ?, 1, ?, NULL, 1, 1)`,
  ).run(ids.workflow, `Workflow ${suffix}`, `workflow ${suffix}`, JSON.stringify(graph),
    JSON.stringify(completionPolicy), JSON.stringify(defaults), ids.version);
  db.prepare(
    `INSERT INTO workflow_versions (
       id, workflow_id, version, source_draft_revision, graph_json,
       completion_policy_json, resumption_policy, binding_defaults_json, published_at
     ) VALUES (?, ?, 1, 1, ?, ?, 'auto', ?, 1)`,
  ).run(ids.version, ids.workflow, JSON.stringify(graph), JSON.stringify(completionPolicy),
    JSON.stringify(defaults));

  setInspectorConfig({ enabled: true, mode: "live", repoAllowlist: ["/repo"] });
  const registry = new Registry();
  registry.applyDiscovery([{
    syntheticId: ids.session, agent: "claude", name: "work", nameSource: "process", cwd: "/repo",
    gitBranch: "feature", gitRoot: "/repo", repoRoot: "/repo", pid: 10 + serial, tty: `ttys${serial}`,
    terminals: [mkMuxHandle({ paneId: `%${serial}` })], startedAt: 1,
  } as DiscoveredSession]);
  registry.applyHook({
    agent: "claude", event: "PostToolUse", sessionId: `agent-${suffix}`, cwd: "/repo",
    transcriptPath: null, env: { tmuxPane: `%${serial}` }, prUrl: url, prCreated: true,
  });
  const now = Date.now() - 1_000;
  adoptInspectorPr(inspectorPr(key, url, ids.session, now - 5_000));

  const store = new WorkflowStore(db);
  const binding = store.insertBinding({
    id: ids.binding, workflowVersionId: ids.version, noteKey: `agent-${suffix}`, sessionId: ids.session,
    sessionAgent: "claude", sessionName: "work", sessionCwd: "/repo", sessionRepoRoot: "/repo",
    triggerMode: "manual", deliveryMode: "preview", maxRepairRounds: 3, now,
  });
  store.createInitialSubmission(
    { id: ids.run, binding, intent: FIXTURE_RUN_INTENT, triggerSource: "manual",
      triggerKey: `manual:${ids.binding}:request`, now },
    { id: ids.submission, triggerSource: "manual", triggerKey: `manual:${ids.binding}:request`,
      context: {}, evidence: {}, now },
  );
  const captured = context(head);
  store.updateSubmissionCapture(ids.submission, {
    context: workflowJson(captured), evidence: workflowJson(captured.evidence),
    fingerprint: `fingerprint-${suffix}`, status: "running",
  }, now);
  store.setRunState(ids.run, "running", "persona_review", null, now);
  const reobserved: string[] = [];
  const managerFor = () => new WorkflowManager(registry, store, {
    resolveCommit: async (_root, sha) => sha,
    reobservePullRequest: (prKey) => {
      reobserved.push(prKey);
      return reobserveInspectorPr(registry, prKey);
    },
    inject: async () => ({ ok: true, pasted: true, submitVerified: true }),
    recordInjection: () => {},
    requireSkill: (session, id) => ({ ok: true, command: skillCommand(session.agent, id)! }),
    readEvidenceProbe: async () => ({ headSha: head, workingTreeStatus: [], diffFingerprint: `diff-${head}` }),
    resumptionSettleMs: 0,
  });
  over.beforeGate?.(key, head, now);
  const seeded = {
    ids, head, key, url, registry, store, now, reobserved, manager: managerFor(),
    /** A daemon restart: a new manager over the same durable store and registry. */
    restart: async () => {
      await seeded.manager.stop();
      seeded.manager = managerFor();
      seeded.manager.start();
      await settle(seeded);
    },
  };
  (seeded.manager as unknown as { enterInspectorGate(id: string, at: number): boolean })
    .enterInspectorGate(ids.submission, now);
  seeded.manager.start();
  await settle(seeded);
  return seeded;
}

type Seeded = Awaited<ReturnType<typeof seed>>;

async function settle(seeded: Pick<Seeded, "manager">): Promise<void> {
  const tasks = (seeded.manager as unknown as { backgroundTasks: Set<Promise<void>> }).backgroundTasks;
  while (tasks.size > 0) await Promise.allSettled(tasks);
}

const phaseOf = (seeded: Seeded) => {
  const run = seeded.store.getRun(seeded.ids.run)!;
  return `${run.status}/${run.currentPhase}`;
};
const gateOf = (seeded: Seeded) =>
  seeded.store.getRun(seeded.ids.run)!.gateState as unknown as WorkflowInspectorGateState;
const eventsOf = (seeded: Seeded, kind: string) =>
  seeded.store.listEvents(seeded.ids.run).filter((event) => event.kind === kind);

/** The row exactly as the sweep leaves it once a GitHub read said the PR finished. */
function retire(key: string, head: string, at: number, observedState: "MERGED" | "CLOSED" = "MERGED"): void {
  updateInspectorPr(key, { observedState, observedHeadSha: head, observedAt: at, headSha: head,
    lastAttemptSha: head, reviewPosture: "live", reviewComplete: true, cleanReviewHeadSha: head }, at);
  updateInspectorPr(key, { state: "closed", lastError: null, failCount: 0, lastFailKind: null,
    nextAttemptAt: null }, at);
}

function scriptGitHub(state: "OPEN" | "CLOSED" | "MERGED" | null, head = "head"): void {
  if (state === null) rmSync(github, { force: true });
  else writeFileSync(github, JSON.stringify({ state, head }));
}
const githubReads = () => existsSync(reads) ? readFileSync(reads, "utf8").split("\n").filter(Boolean).length : 0;

/** Hold the run as an earlier build left it: awaiting an observation, nothing evaluated since. */
function strandAwaiting(seeded: Seeded): void {
  const gate = gateOf(seeded);
  const stranded = seeded.store.updateInspectorGate({
    runId: seeded.ids.run, expectedState: gate,
    state: { ...gate, lastObservedAt: null, observedHeadSha: null, waitReason: "awaiting_fresh_observation" },
    status: "waiting_for_inspector", phase: "inspector_awaiting_fresh_observation", now: Date.now(),
  });
  assert.ok(stranded, "the fixture could not strand the run");
}

function assertHeldClosed(seeded: Seeded, closedBeforeGateEntry: boolean): void {
  assert.equal(phaseOf(seeded), "blocked/inspector_pr_closed");
  const gate = gateOf(seeded);
  assert.equal(gate.waitReason, "pr_closed");
  assert.equal(gate.prKey, seeded.key, "the gate keeps its pinned pull request");
  const closed = eventsOf(seeded, "inspector_pr_closed");
  assert.equal(closed.length, 1, "exactly one closed-PR block is recorded");
  const payload = closed[0]!.payload as Record<string, unknown>;
  assert.equal(payload.prKey, seeded.key);
  assert.equal(payload.source, "retired_ledger");
  assert.equal(payload.closedBeforeGateEntry, closedBeforeGateEntry);
  // A merge is never a pass: no clean verdict, no completion, no round spent.
  assert.equal(eventsOf(seeded, "inspector_gate_clean").length, 0);
  assert.notEqual(seeded.store.getRun(seeded.ids.run)?.status, "completed");
  assert.equal(seeded.store.listSubmissions(seeded.ids.run).length, 1);
}

test("a pull request merged before the gate opened holds the run as closed instead of waiting forever", async () => {
  const seeded = await seed({ beforeGate: (key, head, now) => retire(key, head, now - 1) });
  try {
    assert.equal(loadOpenInspectorPrs().some((pr) => pr.key === seeded.key), false,
      "the sweep no longer reads the retired row");
    assertHeldClosed(seeded, true);
    assert.equal(gateOf(seeded).lastObservedAt, null, "no fresh observation is invented");
    const payload = eventsOf(seeded, "inspector_pr_closed")[0]!.payload as Record<string, unknown>;
    assert.equal(payload.observedState, "MERGED");
    assert.equal(payload.closedAt, seeded.now - 1);
    // Repeated wakeups and a restart change nothing and record nothing twice.
    seeded.registry.inspectionUpdated(seeded.key, null, null);
    seeded.registry.inspectorConfigChanged();
    await settle(seeded);
    await seeded.restart();
    assertHeldClosed(seeded, true);
    assert.equal(seeded.reobserved.length, 0, "holding the run reads nothing from GitHub on its own");
  } finally {
    await seeded.manager.stop();
  }
});

test("a run an earlier build left waiting on a retired row recovers at the next daemon start", async () => {
  const seeded = await seed();
  try {
    assert.equal(phaseOf(seeded), "waiting_for_inspector/inspector_awaiting_fresh_observation");
    // The closure that reached the row before entry, with no evaluation since: the live shape.
    retire(seeded.key, seeded.head, gateOf(seeded).enteredAt - 1);
    strandAwaiting(seeded);
    await seeded.restart();
    assertHeldClosed(seeded, true);
  } finally {
    await seeded.manager.stop();
  }
});

test("a closure observed after entry whose signal a restart lost is still held as closed", async () => {
  const seeded = await seed();
  try {
    const entered = gateOf(seeded).enteredAt;
    // The sweep read MERGED and retired the row, but the daemon stopped before the gate heard it.
    await seeded.manager.stop();
    retire(seeded.key, seeded.head, entered + 5);
    await seeded.restart();
    assertHeldClosed(seeded, false);
  } finally {
    await seeded.manager.stop();
  }
});

test("Recheck on a stranded wait holds it as closed and asks GitHub, so a reopened PR resumes", async () => {
  scriptGitHub(null);
  const seeded = await seed();
  try {
    retire(seeded.key, seeded.head, gateOf(seeded).enteredAt - 1, "CLOSED");
    // Closed before Inspector finished reviewing this head.
    updateInspectorPr(seeded.key, { reviewComplete: false, cleanReviewHeadSha: null }, Date.now());
    strandAwaiting(seeded);
    const before = githubReads();

    // GitHub unreachable: the run is held as closed and says why the read failed.
    assert.equal(seeded.manager.recheckInspector(seeded.ids.run, "outage").ok, true);
    await settle(seeded);
    assertHeldClosed(seeded, true);
    assert.equal(seeded.reobserved.length, 1);
    assert.equal(eventsOf(seeded, "inspector_pr_reobserve_failed").length, 1);

    // GitHub says still closed: still held, the row stays retired.
    scriptGitHub("CLOSED", seeded.head);
    assert.equal(seeded.manager.recheckInspector(seeded.ids.run, "closed").ok, true);
    await settle(seeded);
    assertHeldClosed(seeded, true);
    assert.equal(getInspectorPr(seeded.key)?.state, "closed");
    assert.equal(eventsOf(seeded, "inspector_pr_seen_open").length, 0);

    // Reopened on GitHub: the existing reopen path lifts the block and the run waits for review.
    scriptGitHub("OPEN", seeded.head);
    assert.equal(seeded.manager.recheckInspector(seeded.ids.run, "open").ok, true);
    await settle(seeded);
    assert.equal(getInspectorPr(seeded.key)?.state, "open", "an open answer hands the row back to the sweep");
    assert.equal(eventsOf(seeded, "inspector_pr_seen_open").length, 1);
    assert.equal(seeded.store.getRun(seeded.ids.run)?.status, "waiting_for_inspector");
    assert.equal(eventsOf(seeded, "inspector_gate_clean").length, 0, "reopening is not a clean review");
    assert.equal(githubReads() - before, 3);

    // Only Inspector's clean review of that exact head, read open, completes it.
    const at = Date.now() + 1;
    updateInspectorPr(seeded.key, { observedState: "OPEN", observedAt: at, observedHeadSha: seeded.head,
      headSha: seeded.head, lastAttemptSha: seeded.head, reviewPosture: "live", reviewComplete: true,
      cleanReviewHeadSha: seeded.head }, at);
    seeded.registry.inspectionUpdated(seeded.key, seeded.head, "OPEN", at);
    await settle(seeded);
    assert.equal(seeded.store.getRun(seeded.ids.run)?.status, "completed");
  } finally {
    scriptGitHub(null);
    await seeded.manager.stop();
  }
});

test("a merged PR reported by a fresh read after entry blocks through the ordinary path", async () => {
  const seeded = await seed();
  try {
    const at = Date.now() + 1;
    retire(seeded.key, seeded.head, at);
    seeded.registry.inspectionUpdated(seeded.key, seeded.head, "MERGED", at);
    await settle(seeded);
    assert.equal(phaseOf(seeded), "blocked/inspector_pr_closed");
    const closed = eventsOf(seeded, "inspector_pr_closed");
    assert.equal(closed.length, 1);
    assert.deepEqual(closed[0]!.payload, { prKey: seeded.key }, "the fresh-read block is unchanged");
    assert.equal(gateOf(seeded).lastObservedAt, at);
  } finally {
    await seeded.manager.stop();
  }
});

test("Shipping's own merge retires the row without a closed read and still holds the gate", async () => {
  const seeded = await seed({
    beforeGate: (key, head, now) => {
      updateInspectorPr(key, { observedState: "OPEN", observedHeadSha: head, observedAt: now - 10 }, now - 10);
      updateInspectorPr(key, { state: "closed", mergedAt: now - 2, mergeBlock: null, lastError: null,
        nextAttemptAt: null }, now - 2);
    },
  });
  try {
    assertHeldClosed(seeded, true);
    const payload = eventsOf(seeded, "inspector_pr_closed")[0]!.payload as Record<string, unknown>;
    assert.equal(payload.closedAt, seeded.now - 2);
  } finally {
    await seeded.manager.stop();
  }
});

test("a retired row with no closed read, or another pull request's identity, proves nothing", async () => {
  // Retired, but the last recorded read never said the pull request finished.
  const unread = await seed({
    beforeGate: (key, _head, now) => updateInspectorPr(key, { state: "closed" }, now - 1),
  });
  try {
    assert.equal(phaseOf(unread), "waiting_for_inspector/inspector_awaiting_fresh_observation");
    assert.equal(eventsOf(unread, "inspector_pr_closed").length, 0);
    // Its supported way forward is Recheck, which reads GitHub itself.
    scriptGitHub("OPEN", unread.head);
    assert.equal(unread.manager.recheckInspector(unread.ids.run, "unread").ok, true);
    await settle(unread);
    assert.equal(unread.reobserved.length, 1);
    assert.equal(getInspectorPr(unread.key)?.state, "open");
    assert.equal(eventsOf(unread, "inspector_pr_closed").length, 0);
  } finally {
    scriptGitHub(null);
    await unread.manager.stop();
  }

  // Retired and merged, but not the pull request this gate pinned.
  const other = await seed();
  try {
    const gate = gateOf(other);
    assert.ok(other.store.updateInspectorGate({
      runId: other.ids.run, expectedState: gate, state: { ...gate, prUrl: `${other.url}-replaced` },
      status: "waiting_for_inspector", phase: "inspector_awaiting_fresh_observation", now: Date.now(),
    }));
    retire(other.key, other.head, gate.enteredAt - 1);
    await other.restart();
    assert.equal(phaseOf(other), "waiting_for_inspector/inspector_awaiting_fresh_observation");
    assert.equal(eventsOf(other, "inspector_pr_closed").length, 0);
  } finally {
    await other.manager.stop();
  }
});

test("an open pull request still waits for, and completes on, a fresh exact-head clean review", async () => {
  const seeded = await seed();
  try {
    // An open row at entry schedules nothing: the sweep's next read is the wakeup.
    assert.equal(phaseOf(seeded), "waiting_for_inspector/inspector_awaiting_fresh_observation");
    await seeded.restart();
    assert.equal(phaseOf(seeded), "waiting_for_inspector/inspector_awaiting_fresh_observation");
    assert.equal(seeded.reobserved.length, 0);
    const at = Date.now() + 1;
    updateInspectorPr(seeded.key, { observedState: "OPEN", observedAt: at, observedHeadSha: seeded.head,
      headSha: seeded.head, lastAttemptSha: seeded.head, reviewPosture: "live", reviewComplete: true,
      cleanReviewHeadSha: seeded.head }, at);
    seeded.registry.inspectionUpdated(seeded.key, seeded.head, "OPEN", at);
    await settle(seeded);
    assert.equal(seeded.store.getRun(seeded.ids.run)?.status, "completed");
    assert.equal(eventsOf(seeded, "inspector_pr_closed").length, 0);
  } finally {
    await seeded.manager.stop();
  }
});

/**
 * Hold the run in the repair-push wait an earlier build could leave: findings on the pinned head,
 * waiting for the session's push, with the observation cleared as restart recovery clears it.
 */
function strandRepairWait(seeded: Seeded): void {
  const gate = gateOf(seeded);
  const stranded = seeded.store.updateInspectorGate({
    runId: seeded.ids.run, expectedState: gate,
    state: { ...gate, targetHeadSha: seeded.head, failedHeadSha: seeded.head, lastObservedAt: null,
      observedHeadSha: null, reviewPosture: "live", waitReason: "findings",
      findingFingerprints: ["repair-finding"] },
    status: "waiting_for_new_head", phase: "inspector_findings", now: Date.now(),
  });
  assert.ok(stranded, "the fixture could not strand the repair wait");
}

/** The repair wait's PR merged, and the sweep retired it, with Inspector's findings still unresolved. */
function retireUnderFindings(seeded: Seeded): void {
  retire(seeded.key, seeded.head, Date.now(), "MERGED");
  updateInspectorPr(seeded.key, { reviewComplete: true, cleanReviewHeadSha: null }, Date.now());
}

test("a repair-push wait on a retired PR is held as closed at the next daemon start, and a reopened PR restores it", async () => {
  scriptGitHub(null);
  const seeded = await seed();
  try {
    strandRepairWait(seeded);
    retireUnderFindings(seeded);
    assert.equal(phaseOf(seeded), "waiting_for_new_head/inspector_findings");

    await seeded.restart();
    assert.equal(phaseOf(seeded), "blocked/inspector_pr_closed");
    assert.equal(gateOf(seeded).waitReason, "pr_closed");
    assert.equal(gateOf(seeded).failedHeadSha, seeded.head, "the findings' failed head is kept");
    assert.deepEqual(gateOf(seeded).findingFingerprints, ["repair-finding"], "no finding is cleared");
    assert.equal(eventsOf(seeded, "inspector_pr_closed").length, 1);
    assert.equal(seeded.reobserved.length, 0, "a restart reads nothing from GitHub on its own");

    // A second restart neither releases nor repeats the hold.
    await seeded.restart();
    assert.equal(phaseOf(seeded), "blocked/inspector_pr_closed");
    assert.equal(eventsOf(seeded, "inspector_pr_closed").length, 1);

    // Recheck while GitHub still says merged: still held.
    scriptGitHub("MERGED", seeded.head);
    assert.equal(seeded.manager.recheckInspector(seeded.ids.run, "repair-merged").ok, true);
    await settle(seeded);
    assert.equal(phaseOf(seeded), "blocked/inspector_pr_closed");
    assert.equal(seeded.reobserved.length, 1);
    assert.equal(eventsOf(seeded, "inspector_pr_closed").length, 1);

    // Reopened on GitHub at the same head: the repair-push wait comes back, findings intact,
    // and a merge or reopen never stands in for the repair.
    scriptGitHub("OPEN", seeded.head);
    assert.equal(seeded.manager.recheckInspector(seeded.ids.run, "repair-open").ok, true);
    await settle(seeded);
    assert.equal(phaseOf(seeded), "waiting_for_new_head/inspector_findings");
    assert.equal(gateOf(seeded).waitReason, "findings");
    assert.deepEqual(gateOf(seeded).findingFingerprints, ["repair-finding"]);
    assert.equal(eventsOf(seeded, "inspector_pr_seen_open").length, 1);
    assert.equal(eventsOf(seeded, "inspector_pr_closed").length, 1);
    assert.equal(eventsOf(seeded, "inspector_gate_clean").length, 0);
    assert.equal(seeded.store.listSubmissions(seeded.ids.run).length, 1, "no repair round was spent");
  } finally {
    scriptGitHub(null);
    await seeded.manager.stop();
  }
});

test("Recheck on a repair-push wait whose PR is retired holds it as closed and reads GitHub", async () => {
  scriptGitHub(null);
  const seeded = await seed();
  try {
    strandRepairWait(seeded);
    retireUnderFindings(seeded);
    scriptGitHub("MERGED", seeded.head);
    // No restart: the wait is still `waiting_for_new_head` when the operator asks.
    assert.equal(phaseOf(seeded), "waiting_for_new_head/inspector_findings");
    const before = githubReads();
    assert.equal(seeded.manager.recheckInspector(seeded.ids.run, "repair-wait").ok, true);
    await settle(seeded);
    assert.equal(phaseOf(seeded), "blocked/inspector_pr_closed");
    assert.equal(eventsOf(seeded, "inspector_pr_closed").length, 1);
    assert.equal(seeded.reobserved.length, 1, "Recheck asked GitHub about the retired pull request");
    assert.equal(githubReads() - before, 1);
    assert.equal(getInspectorPr(seeded.key)?.state, "closed");
    assert.equal(eventsOf(seeded, "inspector_gate_clean").length, 0);
  } finally {
    scriptGitHub(null);
    await seeded.manager.stop();
  }
});
