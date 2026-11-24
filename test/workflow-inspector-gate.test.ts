import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type {
  AgentType,
  InspectorComment,
  InspectorPr,
} from "../src/shared/types.ts";
import { skillCommand } from "../src/shared/harness-capabilities.ts";
import type {
  WorkflowContextSnapshot,
  WorkflowInspectorGateState,
} from "../src/shared/workflow.ts";
import { mkMuxHandle } from "./helpers/session-fixture.ts";
import type { InspectorReobservation } from "../src/server/inspector/worker.ts";
import {
  WORKFLOW_RUN_TERMINAL_STATUSES,
  workflowRunIsOpen,
} from "../src/shared/workflow.ts";
import { FIXTURE_RUN_INTENT } from "./helpers/workflow-run-intent.ts";

// What is at stake: a successful Persona End is not completion when the published
// version owns an Inspector gate. Every conclusion must be about an adopted PR and a
// fresh observation of the exact clean, committed head.
const home = mkdtempSync(join(tmpdir(), "mission-workflow-inspector-gate-"));
process.env.MISSION_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

// Recovery reads use scripted PR and branch activity responses. Missing fixtures simulate an outage.
const ghSnapshot = join(home, "gh-pull-request.json");
const branchActivity = join(home, "branch-activity.json");
const recoveryPr = join(home, "recovery-pr.json");
const holdActivity = join(home, "hold-activity");
const activityPending = join(home, "activity-pending");
const holdRecoveryPull = join(home, "hold-recovery-pull");
const pullPending = join(home, "recovery-pull-pending");
const fakeGh = join(home, "gh");
writeFileSync(fakeGh, `#!${process.execPath}
const fs = require("node:fs");
const target = process.argv.find(arg => arg.startsWith("repos/"));
const recoveryGraph = process.argv.some(arg => arg.startsWith("query=query RecoveryPull("));
const activityQuery = "repos/author/fork/activity?ref=refs%2Fheads%2Ffeature&direction=desc&per_page=";
if (target?.includes("/activity?") && ![activityQuery + "1", activityQuery + "100"].includes(target)) process.exit(1);
const fixture = target?.includes("/activity?") ? ${JSON.stringify(branchActivity)}
  : target?.includes("/pulls/") || recoveryGraph ? ${JSON.stringify(recoveryPr)} : ${JSON.stringify(ghSnapshot)};
try {
  if (fixture === ${JSON.stringify(recoveryPr)} && fs.existsSync(${JSON.stringify(holdRecoveryPull)})) {
    if (fs.readFileSync(${JSON.stringify(holdRecoveryPull)}, "utf8") === "hold second read") {
      fs.writeFileSync(${JSON.stringify(holdRecoveryPull)}, "");
    } else {
      fs.writeFileSync(${JSON.stringify(pullPending)}, "");
      while (fs.existsSync(${JSON.stringify(holdRecoveryPull)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  const contents = fs.readFileSync(fixture, "utf8");
  if (recoveryGraph) {
    const pull = JSON.parse(contents);
    if (pull.graphExitCode) process.exitCode = pull.graphExitCode;
    const query = process.argv.find(arg => arg.startsWith("query=query RecoveryPull("));
    if (!["HEAD_REF_FORCE_PUSHED_EVENT","HEAD_REF_DELETED_EVENT","HEAD_REF_RESTORED_EVENT","CLOSED_EVENT","REOPENED_EVENT"].every(type => query.includes(type))
        || !process.argv.some(arg => arg.startsWith("since="))) process.exit(1);
    process.stdout.write(JSON.stringify({ errors: pull.graphErrors, data: { repository: { nameWithOwner: pull.base.repo.full_name,
      pullRequest: { number: pull.number, state: pull.state.toUpperCase(), headRefName: pull.head.ref, headRefOid: pull.head.sha,
        headRepository: pull.head.repo ? { nameWithOwner: pull.head.repo.full_name } : null, timelineItems: { nodes: (pull.rewrites ?? []).slice(0, 1),
          pageInfo: { hasNextPage: (pull.rewrites ?? []).length > 1 } } } } } }), () => {
      if (pull.graphInterrupted) process.kill(process.pid, "SIGTERM");
    });
    return;
  }
  const response = target === activityQuery + "1" ? JSON.stringify(JSON.parse(contents).slice(0, 1)) : contents;
  if (fixture === ${JSON.stringify(branchActivity)} && fs.existsSync(${JSON.stringify(holdActivity)})) {
    if (fs.readFileSync(${JSON.stringify(holdActivity)}, "utf8") === "hold second read") {
      fs.writeFileSync(${JSON.stringify(holdActivity)}, "");
      process.stdout.write(response);
      return;
    }
    fs.writeFileSync(${JSON.stringify(activityPending)}, "");
    const timer = setInterval(() => {
      if (fs.existsSync(${JSON.stringify(holdActivity)})) return;
      clearInterval(timer);
      process.stdout.write(response);
    }, 10);
  } else process.stdout.write(response);
}
catch { process.stderr.write("gh: scripted outage\\n"); process.exit(1); }
`);
chmodSync(fakeGh, 0o755);
process.env.MISSION_GH_BIN = fakeGh;

const {
  adoptInspectorPr,
  getInspectorPr,
  readCodeRabbit,
  recordCodeRabbit,
  claimCodeRabbit,
  openDb,
  updateInspectorPr,
  upsertInspectorComment,
} = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { setInspectorConfig } = await import("../src/server/inspector/config.ts");
const { setWorkflowPolicy } = await import("../src/server/workflows/config.ts");
const { WorkflowManager } = await import("../src/server/workflows/manager.ts");
const { reobserveInspectorPr } = await import("../src/server/inspector/worker.ts");
const { renderInspectorFeedback } = await import("../src/server/workflows/feedback.ts");
const {
  WorkflowStore,
  clearWorkflowTables,
  workflowJson } = await import("../src/server/workflows/store.ts");

const db = openDb();
let serial = 0;

function context(
  headSha: string,
  workingTreeDirty = false,
  agent: AgentType = "claude",
): WorkflowContextSnapshot {
  return {
    primaryGoal: { rawPrompt: "Ship the reviewed change", refined: null, sourceNoteKey: "note" },
    humanDecisions: [],
    constraints: [],
    acceptanceCriteria: [],
    priorPersonaFeedback: [],
    session: { agent, name: "work", cwd: "/repo", branch: "feature" },
    evidence: {
      headSha,
      diffFingerprint: `diff-${headSha}`,
      diff: "diff",
      diffTruncated: false,
      workingTreeDirty,
      workingTreeStatus: workingTreeDirty ? [" M src/file.ts"] : [],
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
    key,
    url,
    owner: owner!,
    repo: repo!,
    number: Number(numberText),
    repoRoot: "/repo",
    cwd: "/repo",
    sessionId,
    source: "hook",
    state: "open",
    headSha: null,
    reviewPosture: null,
    round: 0,
    lastReviewedAt: null,
    lastError: null,
    failCount: 0,
    lastFailKind: null,
    nextAttemptAt: null,
    lastAttemptSha: null,
    mergedAt: null,
    mergeBlock: null,
    observedHeadSha: null,
    observedState: null,
    observedAt: null,
    headRefName: null,
    title: null,
    adoptedAt: now,
    updatedAt: now,
  };
}

interface SeedOptions {
  captureHead?: () => string;
  policy?: "none" | "restart_workflow" | "inspector_only";
  missingPrAction?: "wait" | "offer_prepare_pr" | "prepare_pr";
  deliveryMode?: "preview" | "live";
  adopted?: boolean;
  withHint?: boolean;
  dirty?: boolean;
  evidence?: Partial<WorkflowContextSnapshot["evidence"]>;
  resolveCommitTree?: (root: string, commit: string) => Promise<string>;
  enabled?: boolean;
  head?: string;
  skillAvailable?: boolean;
  agent?: AgentType;
  startBeforeGate?: boolean;
  resolveCommit?: (root: string, head: string) => Promise<string>;
  bindingRepoRoot?: string | null;
  inspectorRepoRoot?: string | null;
  /** Replaces the real GitHub re-read a closed-PR recheck makes. */
  reobservePullRequest?: (prKey: string) => Promise<InspectorReobservation>;
}

async function seed(over: SeedOptions = {}) {
  clearWorkflowTables(db);
  serial += 1;
  const suffix = String(serial);
  const ids = {
    workflow: `w-${suffix}`,
    version: `v-${suffix}`,
    binding: `b-${suffix}`,
    run: `run-${suffix}`,
    submission: `sub-${suffix}`,
    session: `session-${suffix}`,
  };
  const head = over.head ?? `head-${suffix}`;
  const agent = over.agent ?? "claude";
  const key = `owner/repo#${100 + serial}`;
  const url = `https://github.com/owner/repo/pull/${100 + serial}`;
  const policy = over.policy ?? "restart_workflow";
  const completionPolicy = policy === "none"
    ? { kind: "none" as const }
    : {
        kind: "inspector" as const,
        onFindings: policy,
        missingPrAction: over.missingPrAction ?? "offer_prepare_pr",
      };
  const defaults = {
    triggerMode: "manual" as const,
    deliveryMode: over.deliveryMode ?? "preview",
    maxRepairRounds: 3,
  };
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
  ).run(
    ids.workflow,
    `Workflow ${suffix}`,
    `workflow ${suffix}`,
    JSON.stringify(graph),
    JSON.stringify(completionPolicy),
    JSON.stringify(defaults),
    ids.version,
  );
  db.prepare(
    `INSERT INTO workflow_versions (
       id, workflow_id, version, source_draft_revision, graph_json,
       completion_policy_json, resumption_policy, binding_defaults_json, published_at
     ) VALUES (?, ?, 1, 1, ?, ?, 'auto', ?, 1)`,
  ).run(
    ids.version,
    ids.workflow,
    JSON.stringify(graph),
    JSON.stringify(completionPolicy),
    JSON.stringify(defaults),
  );

  setInspectorConfig({
    enabled: over.enabled ?? true,
    mode: "live",
    repoAllowlist: ["/repo"],
  });
  const registry = new Registry();
  registry.applyDiscovery([{
    syntheticId: ids.session,
    agent,
    name: "work",
    nameSource: "process",
    cwd: "/repo",
    gitBranch: "feature",
    gitRoot: "/repo",
    repoRoot: "/repo",
    pid: 10 + serial,
    tty: `ttys${serial}`,
    terminals: [mkMuxHandle({ paneId: `%${serial}` })],
    startedAt: 1,
  } as DiscoveredSession]);
  if (over.withHint ?? true) {
    registry.applyHook({
      agent: "claude",
      event: "PostToolUse",
      sessionId: `agent-${suffix}`,
      cwd: "/repo",
      transcriptPath: null,
      env: { tmuxPane: `%${serial}` },
      prUrl: url,
      prCreated: true,
    });
  }
  const now = Date.now() - 1_000;
  if (over.adopted ?? true) adoptInspectorPr({
    ...inspectorPr(key, url, ids.session, now),
    repoRoot: over.inspectorRepoRoot === undefined ? "/repo" : over.inspectorRepoRoot,
  });

  const store = new WorkflowStore(db);
  const binding = store.insertBinding({
    id: ids.binding,
    workflowVersionId: ids.version,
    noteKey: (over.withHint ?? true) ? `agent-${suffix}` : ids.session,
    sessionId: ids.session,
    sessionAgent: agent,
    sessionName: "work",
    sessionCwd: "/repo",
    sessionRepoRoot: over.bindingRepoRoot === undefined ? "/repo" : over.bindingRepoRoot,
    triggerMode: "manual",
    deliveryMode: over.deliveryMode ?? "preview",
    maxRepairRounds: 3,
    now,
  });
  store.createInitialSubmission(
    {
      id: ids.run,
      binding,
      intent: FIXTURE_RUN_INTENT,
      triggerSource: "manual",
      triggerKey: `manual:${ids.binding}:request`,
      now,
    },
    {
      id: ids.submission,
      triggerSource: "manual",
      triggerKey: `manual:${ids.binding}:request`,
      context: {},
      evidence: {},
      now,
    },
  );
  const captured = context(head, over.dirty ?? false, agent);
  Object.assign(captured.evidence, over.evidence);
  store.updateSubmissionCapture(ids.submission, {
    context: workflowJson(captured),
    evidence: workflowJson(captured.evidence),
    fingerprint: `fingerprint-${suffix}`,
    status: "running",
  }, now);
  store.setRunState(ids.run, "running", "persona_review", null, now);
  const injected: string[] = [];
  if (over.deliveryMode === "live") {
    setWorkflowPolicy({ liveEnabled: true, repoAllowlist: ["/repo"] });
  }
  const manager = new WorkflowManager(registry, store, {
    ...(over.captureHead ? {
      readContextRaw: async () => {
        const next = context(over.captureHead!());
        return {
          raw: next, context: next,
          boundary: { noteKey: binding.noteKey, sessionId: ids.session,
            headSha: next.evidence.headSha, transcriptPath: null, transcriptSize: 0,
            repositoryFingerprint: `repo-${next.evidence.headSha}` },
        };
      },
      boundaryChanged: async () => false,
      compactContext: async () => context(over.captureHead!()),
    } : {}),
    resolveCommit: over.resolveCommit ?? (async (_root, head) => head),
    resolveCommitTree: over.resolveCommitTree,
    reobservePullRequest: over.reobservePullRequest
      ?? ((prKey) => reobserveInspectorPr(registry, prKey)),
    inject: async (_session, payload) => {
      injected.push(payload);
      return { ok: true, pasted: true, submitVerified: true };
    },
    recordInjection: () => {},
    requireSkill: (session, id) => over.skillAvailable === false
      ? { ok: false, message: `${id} is not ready` }
      : { ok: true, command: skillCommand(session.agent, id)! },
    readEvidenceProbe: async () => ({
      headSha: over.captureHead?.() ?? head,
      workingTreeStatus: over.dirty ? [" M src/file.ts"] : [],
      diffFingerprint: `diff-${head}`,
    }),
    resumptionSettleMs: 0,
  });
  if (over.startBeforeGate) manager.start();
  const claimed = (manager as unknown as {
    enterInspectorGate(id: string, at: number): boolean;
  }).enterInspectorGate(ids.submission, now);
  if (!over.startBeforeGate) manager.start();
  return { ids, head, key, url, manager, registry, store, claimed, now, injected };
}

/**
 * Polls until `check` holds, so a healthy run returns as soon as the gate moves. The bound is
 * generous on purpose: the abbreviated-commit cases resolve heads through real `git rev-parse`
 * subprocesses, several per gate evaluation, and under the full suite's file concurrency one
 * evaluation took over two seconds while the same case settles in a few hundred milliseconds on
 * its own. The bound only decides how long a genuinely stuck gate takes to report.
 */
const WAIT_FOR_MS = 15_000;

async function waitFor(check: () => boolean, message: string): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > WAIT_FOR_MS) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function signal(
  seeded: Awaited<ReturnType<typeof seed>>,
  observedHead: string,
  at = Date.now(),
): void {
  seeded.registry.inspectionUpdated(seeded.key, observedHead, "OPEN", at);
}

for (const rootSource of ["binding", "empty-binding", "null-binding"] as const) {
  test(`an abbreviated captured commit recovers after restart and waits for clean publication: ${rootSource}`, async () => {
    const { execFileSync } = await import("node:child_process");
    const { resolveCapturedCommit } = await import("../src/server/workflows/commit-id.ts");
    const repo = mkdtempSync(join(tmpdir(), "mission-inspector-head-"));
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
    git("init", "-q");
    git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "test commit");
    const full = git("rev-parse", "HEAD");
    const abbreviated = git("rev-parse", "--short", "HEAD");
    const seeded = await seed({ head: abbreviated, resolveCommit: resolveCapturedCommit,
      bindingRepoRoot: rootSource === "binding" ? repo : rootSource === "empty-binding" ? "" : null,
      inspectorRepoRoot: repo });
    try {
      updateInspectorPr(seeded.key, { headSha: full, reviewPosture: "live", round: 1,
        lastAttemptSha: full, reviewComplete: true, cleanReviewHeadSha: null }, Date.now());
      signal(seeded, full);
      await waitFor(() => seeded.store.getRun(seeded.ids.run)?.currentPhase === "inspector_clean_review",
        "an equivalent full head did not reach the publication wait");
      assert.equal((seeded.store.getRun(seeded.ids.run)!.gateState as unknown as WorkflowInspectorGateState).targetHeadSha, full);
      assert.equal(seeded.store.latestSubmission(seeded.ids.run)?.prHeadSha, abbreviated,
        "normalization must not rewrite immutable submission evidence");
      await seeded.manager.stop();
      seeded.manager.start();
      updateInspectorPr(seeded.key, { cleanReviewHeadSha: full }, Date.now());
      signal(seeded, full);
      await waitFor(() => seeded.store.getRun(seeded.ids.run)?.status === "completed",
        "publication confirmation did not release the recovered gate");
    } finally {
      await seeded.manager.stop();
      rmSync(repo, { recursive: true, force: true });
    }
  });
}

test("commit recovery still fails closed when neither binding nor adopted PR has a repository root", async () => {
  const seeded = await seed({ head: "1234abcd", bindingRepoRoot: null, inspectorRepoRoot: null,
    resolveCommit: async () => { assert.fail("resolution without repository provenance"); } });
  try {
    signal(seeded, "1234abcd" + "0".repeat(32));
    await waitFor(() => seeded.store.getRun(seeded.ids.run)?.status === "blocked", "missing provenance was accepted");
    assert.equal(seeded.store.getRun(seeded.ids.run)?.currentPhase, "inspector_gate_context_invalid");
  } finally { await seeded.manager.stop(); }
});

test("an unresolvable captured commit fails closed instead of accepting its prefix", async () => {
  const seeded = await seed({ head: "1234abcd", resolveCommit: async () => { throw new Error("ambiguous commit"); } });
  try {
    signal(seeded, "1234abcd" + "0".repeat(32));
    await waitFor(() => seeded.store.getRun(seeded.ids.run)?.status === "blocked", "ambiguous commit was accepted");
    assert.equal(seeded.store.getRun(seeded.ids.run)?.currentPhase, "inspector_gate_context_invalid");
    assert.deepEqual(seeded.store.listDeliveries(seeded.ids.run), []);
  } finally { await seeded.manager.stop(); }
});

test("Inspector withdrawing its last finding completes an Inspector-only repair without another commit", async () => {
  const seeded = await seed({ policy: "inspector_only", deliveryMode: "live" });
  const now = Date.now();
  const finding: InspectorComment = {
    id: "withdrawn-finding", prKey: seeded.key, fingerprint: "withdrawn", path: "src/file.ts",
    line: 1, title: "Questioned finding", body: "The author explains why this is already handled.",
    severity: "minor", round: 1, status: "open", replies: 0, answeredCommentId: null,
    createdAt: now, updatedAt: now,
  };
  try {
    updateInspectorPr(seeded.key, { headSha: seeded.head, lastAttemptSha: seeded.head,
      reviewPosture: "live", reviewComplete: true, round: 1 }, now);
    upsertInspectorComment(finding);
    signal(seeded, seeded.head);
    await waitFor(() => seeded.store.getRun(seeded.ids.run)?.status === "waiting_for_new_head", "repair was not delivered");
    const count = seeded.store.listSubmissions(seeded.ids.run).length;
    upsertInspectorComment({ ...finding, status: "resolved" });
    updateInspectorPr(seeded.key, { cleanReviewHeadSha: seeded.head }, Date.now());
    signal(seeded, seeded.head);
    await waitFor(() => seeded.store.getRun(seeded.ids.run)?.status === "completed", "withdrawn finding required an empty commit");
    assert.equal(seeded.store.listSubmissions(seeded.ids.run).length, count);
    assert.equal(seeded.store.listDeliveries(seeded.ids.run).length, 1);
  } finally { await seeded.manager.stop(); }
});

test("no final-gate policy keeps the Phase 4 completion path unclaimed", async () => {
  const seeded = await seed({ policy: "none" });
  assert.equal(seeded.claimed, false);
  assert.equal(seeded.store.getRun(seeded.ids.run)?.status, "running");
  assert.equal(seeded.store.getRun(seeded.ids.run)?.gateState, null);
  await seeded.manager.stop();
});

test("a `wait` policy neither prepares a handoff nor offers to, and still waits honestly", async () => {
  // The version 8 posture. Its own last stage opens the pull request before End, so a gate
  // that finds none has met a state its own preparation would not fix - typing a handoff would
  // ask for a pull request the run already has, and the operator's remedy is to look at why
  // the action's proof went missing rather than to open a second one.
  //
  // The run still parks in `waiting_for_pr` rather than blocking: the Inspector poller may
  // simply not have looked yet, and a gate that gave up on a race would end a run for it.
  const waiting = await seed({ withHint: false, adopted: false, missingPrAction: "wait" });
  try {
    assert.equal(waiting.store.getRun(waiting.ids.run)?.status, "waiting_for_pr");
    assert.equal(
      (waiting.store.getRun(waiting.ids.run)?.gateState as { waitReason?: string })?.waitReason,
      "missing_pr",
    );
    // Nothing was typed, and nothing offers to. `preparePr` is the route the Prepare PR button
    // calls, and it refuses for this published policy rather than 500-ing behind a lit control.
    const refused = await waiting.manager.preparePr(waiting.ids.run, "prepare-request");
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.reason, "run_not_waiting");
    assert.deepEqual(waiting.store.listDeliveries(waiting.ids.run), []);
  } finally {
    await waiting.manager.stop();
  }
});

test("missing and unadopted PR hints wait without creating Inspector provenance", async () => {
  const missing = await seed({ withHint: false, adopted: false });
  assert.equal(missing.store.getRun(missing.ids.run)?.status, "waiting_for_pr");
  assert.equal((missing.store.getRun(missing.ids.run)?.gateState as { waitReason?: string })?.waitReason, "missing_pr");
  const handoff = await missing.manager.preparePr(missing.ids.run, "prepare-request");
  assert.equal(handoff.ok, true);
  if (handoff.ok) {
    assert.equal(handoff.value.kind, "pr_handoff");
    assert.match(handoff.value.payload, /^\/pull-request\n/);
    assert.match(handoff.value.payload, /Use the invoked pull-request skill/);
  }
  const repeatedHandoff = await missing.manager.preparePr(missing.ids.run, "prepare-request");
  assert.equal(repeatedHandoff.ok && repeatedHandoff.idempotent, true);
  assert.equal(missing.store.getRun(missing.ids.run)?.status, "waiting_for_session");
  await missing.manager.stop();

  const unadopted = await seed({ withHint: true, adopted: false });
  assert.equal(unadopted.store.getRun(unadopted.ids.run)?.status, "waiting_for_pr");
  assert.equal((unadopted.store.getRun(unadopted.ids.run)?.gateState as { waitReason?: string })?.waitReason, "unadopted_pr");
  assert.equal(
    (openDb().prepare(`SELECT COUNT(*) AS n FROM inspector_prs WHERE key = ?`).get(unadopted.key) as { n: number }).n,
    0,
    "session.prUrl is a lookup hint and cannot adopt",
  );
  await unadopted.manager.stop();
});

test("preparePr emits each harness's native pull-request invocation in the real handoff", async () => {
  const expected: Record<AgentType, string> = {
    claude: "/pull-request",
    codex: "$pull-request - run this skill now.",
    pi: "/skill:pull-request",
  };

  for (const agent of Object.keys(expected) as AgentType[]) {
    const seeded = await seed({
      agent,
      withHint: false,
      adopted: false,
    });
    const handoff = await seeded.manager.preparePr(
      seeded.ids.run,
      `prepare-${agent}`,
    );
    assert.equal(handoff.ok, true, agent);
    if (handoff.ok) {
      assert.equal(handoff.value.kind, "pr_handoff", agent);
      assert.match(
        handoff.value.payload,
        new RegExp(`^${expected[agent].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n`),
        agent,
      );
      assert.equal(
        seeded.store.getDelivery(handoff.value.id)?.payload,
        handoff.value.payload,
        `${agent} persisted a different handoff`,
      );
    }
    await seeded.manager.stop();
  }
});

test("PR preparation refuses an unavailable skill without advancing or creating a delivery", async () => {
  const seeded = await seed({ withHint: false, adopted: false, skillAvailable: false });
  const before = seeded.store.getRun(seeded.ids.run);
  const handoff = await seeded.manager.preparePr(seeded.ids.run, "skill-not-ready");

  assert.equal(handoff.ok, false);
  if (!handoff.ok) {
    assert.equal(handoff.reason, "unsupported_mode");
    assert.match(handoff.message, /pull-request is not ready/);
  }
  assert.equal(seeded.store.listDeliveries(seeded.ids.run).length, 0);
  assert.equal(seeded.store.getRun(seeded.ids.run)?.status, before?.status);
  assert.equal(seeded.store.getRun(seeded.ids.run)?.currentPhase, before?.currentPhase);
  await seeded.manager.stop();
});

test("a persisted PR handoff rechecks the required skill before replay", async () => {
  const parked = await seed({ withHint: false, adopted: false });
  const handoff = await parked.manager.preparePr(parked.ids.run, "prepare-before-restart");
  assert.equal(handoff.ok, true);
  if (!handoff.ok) {
    await parked.manager.stop();
    return;
  }
  assert.equal(handoff.value.state, "prepared");
  await parked.manager.stop();

  setWorkflowPolicy({ liveEnabled: true, repoAllowlist: ["/repo"] });
  const injected: string[] = [];
  const recovered = new WorkflowManager(parked.registry, parked.store, {
    inject: async (_session, payload) => {
      injected.push(payload);
      return { ok: true, pasted: true, submitVerified: true };
    },
    recordInjection: () => {},
    requireSkill: () => ({ ok: false, message: "pull-request is no longer ready" }),
  });
  try {
    await (recovered as unknown as {
      deliverPrepared(deliveryId: string, explicitRetry: boolean): Promise<void>;
    }).deliverPrepared(handoff.value.id, false);
    assert.equal(injected.length, 0);
    assert.equal(parked.store.getDelivery(handoff.value.id)?.state, "refused");
    assert.equal(parked.store.getDelivery(handoff.value.id)?.error, "required_skill_unavailable");
    assert.equal(parked.store.getRun(parked.ids.run)?.status, "blocked");
  } finally {
    await recovered.stop();
    setWorkflowPolicy({ liveEnabled: false, repoAllowlist: ["/repo"] });
  }
});

test("the automatic missing-PR policy sends one shipping handoff after a passed review", async () => {
  const automatic = await seed({
    withHint: false,
    adopted: false,
    missingPrAction: "prepare_pr",
    deliveryMode: "live",
    startBeforeGate: true,
  });
  try {
    await waitFor(
      () => automatic.store.listDeliveries(automatic.ids.run)
        .some((delivery) =>
          delivery.kind === "pr_handoff"
          && ["delivered", "refused", "uncertain"].includes(delivery.state)),
      "the passed review did not automatically attempt its PR handoff",
    );
    const handoff = automatic.store.listDeliveries(automatic.ids.run)
      .find((delivery) => delivery.kind === "pr_handoff");
    assert.equal(handoff?.state, "delivered", handoff?.error ?? "PR handoff was not delivered");
    assert.equal(automatic.store.getRun(automatic.ids.run)?.status, "waiting_for_session");
    assert.equal(automatic.store.getRun(automatic.ids.run)?.currentPhase, "pr_handoff");
    assert.equal(
      automatic.store.listDeliveries(automatic.ids.run)
        .filter((delivery) => delivery.kind === "pr_handoff").length,
      1,
    );
    assert.equal(automatic.injected.length, 1);
    assert.match(automatic.injected[0]!, /^\/pull-request\n/);
    assert.match(automatic.injected[0]!, /commit all reviewed work, push it, and open the pull request/);
  } finally {
    await automatic.manager.stop();
    setWorkflowPolicy({ liveEnabled: false, repoAllowlist: ["/repo"] });
  }
});

test("durable PR adoption advances a clean handoff without another workflow round", async () => {
  const seeded = await seed({
    withHint: false,
    adopted: false,
    deliveryMode: "live",
  });
  try {
    const handoff = await seeded.manager.preparePr(seeded.ids.run, "clean-handoff");
    assert.equal(handoff.ok, true);
    await waitFor(
      () => seeded.store.listDeliveries(seeded.ids.run)
        .some((delivery) => delivery.kind === "pr_handoff" && delivery.state === "delivered"),
      "the clean PR handoff was not delivered",
    );
    assert.equal(seeded.store.getRun(seeded.ids.run)?.currentPhase, "pr_handoff");

    // Opening an already-committed PR changes no repository evidence. The durable Inspector
    // row, not a new Git commit or a transient Session.prUrl, completes the handoff's job.
    const adoptedAt = Date.now();
    adoptInspectorPr(inspectorPr(seeded.key, seeded.url, seeded.ids.session, adoptedAt));
    seeded.registry.inspectionUpdated(seeded.key, null, null, adoptedAt);
    await waitFor(
      () => (seeded.store.getRun(seeded.ids.run)?.gateState as { prKey?: string | null })?.prKey
        === seeded.key,
      "durable adoption did not pin the handed-off PR",
    );
    assert.equal(seeded.store.getRun(seeded.ids.run)?.status, "waiting_for_session");
    assert.equal(seeded.store.getRun(seeded.ids.run)?.currentPhase, "pr_handoff");

    updateInspectorPr(seeded.key, {
      headSha: seeded.head,
    cleanReviewHeadSha: seeded.head,
      lastAttemptSha: seeded.head,
      reviewPosture: "live",
      round: 1,
      lastReviewedAt: adoptedAt + 1,
    }, adoptedAt + 1);
    seeded.registry.inspectionUpdated(seeded.key, seeded.head, "OPEN", adoptedAt + 1);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      seeded.store.getRun(seeded.ids.run)?.status,
      "waiting_for_session",
      "Inspector completed the gate before the PR handoff turn settled",
    );

    seeded.registry.applyHook({
      agent: "claude",
      event: "Stop",
      sessionId: seeded.ids.session,
      cwd: "/repo",
      transcriptPath: null,
      env: { tmuxPane: `%${serial}` },
      prCreated: false,
    });
    await seeded.manager.sweepResumptions(Date.now() + 1);
    await waitFor(
      () => seeded.store.getRun(seeded.ids.run)?.status === "waiting_for_inspector",
      "the unchanged settled handoff did not advance to Inspector",
    );
    const afterSettle = seeded.store.getRun(seeded.ids.run)?.gateState as {
      lastObservedAt?: number | null;
    };
    assert.equal(afterSettle.lastObservedAt, null, "a pre-settle observation was reused");

    seeded.registry.inspectionUpdated(seeded.key, seeded.head, "OPEN", Date.now() + 2);
    await waitFor(
      () => seeded.store.getRun(seeded.ids.run)?.status === "completed",
      "a fresh clean observation did not complete the adopted handoff",
    );
    assert.equal(
      seeded.store.listSubmissions(seeded.ids.run).length,
      1,
      "opening the PR reran Personas despite unchanged reviewed work",
    );
  } finally {
    await seeded.manager.stop();
    setWorkflowPolicy({ liveEnabled: false, repoAllowlist: ["/repo"] });
  }
});

test("a PR handoff that changes the remote head still requires a workflow resubmission", async () => {
  const seeded = await seed({
    withHint: false,
    adopted: false,
    deliveryMode: "live",
  });
  try {
    const handoff = await seeded.manager.preparePr(seeded.ids.run, "changed-head-handoff");
    assert.equal(handoff.ok, true);
    await waitFor(
      () => seeded.store.listDeliveries(seeded.ids.run)
        .some((delivery) => delivery.kind === "pr_handoff" && delivery.state === "delivered"),
      "the changed-head PR handoff was not delivered",
    );

    const adoptedAt = Date.now();
    adoptInspectorPr(inspectorPr(seeded.key, seeded.url, seeded.ids.session, adoptedAt));
    seeded.registry.inspectionUpdated(seeded.key, null, null, adoptedAt);
    await waitFor(
      () => (seeded.store.getRun(seeded.ids.run)?.gateState as { prKey?: string | null })?.prKey
        === seeded.key,
      "durable adoption did not pin the changed-head PR",
    );
    assert.equal(seeded.store.getRun(seeded.ids.run)?.status, "waiting_for_session");

    const changedHead = `${seeded.head}-after-handoff`;
    updateInspectorPr(seeded.key, {
      headSha: changedHead,
      lastAttemptSha: changedHead,
      reviewPosture: "live",
      round: 1,
      lastReviewedAt: adoptedAt + 1,
    }, adoptedAt + 1);
    seeded.registry.inspectionUpdated(seeded.key, changedHead, "OPEN", adoptedAt + 1);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(seeded.store.getRun(seeded.ids.run)?.currentPhase, "pr_handoff");

    seeded.registry.applyHook({
      agent: "claude",
      event: "Stop",
      sessionId: seeded.ids.session,
      cwd: "/repo",
      transcriptPath: null,
      env: { tmuxPane: `%${serial}` },
      prCreated: false,
    });
    await seeded.manager.sweepResumptions(Date.now() + 1);
    await waitFor(
      () => seeded.store.getRun(seeded.ids.run)?.status === "waiting_for_inspector",
      "the settled handoff did not request a fresh Inspector observation",
    );
    seeded.registry.inspectionUpdated(seeded.key, changedHead, "OPEN", Date.now() + 2);
    await waitFor(
      () => seeded.store.getRun(seeded.ids.run)?.currentPhase === "inspector_head_mismatch",
      "the changed handoff head was not rejected",
    );
    assert.equal(seeded.store.getRun(seeded.ids.run)?.status, "waiting_for_session");
    assert.equal(seeded.store.listSubmissions(seeded.ids.run).length, 1);
  } finally {
    await seeded.manager.stop();
    setWorkflowPolicy({ liveEnabled: false, repoAllowlist: ["/repo"] });
  }
});

test("an unpinned durable handoff keeps vetoing Shipping across restart", async () => {
  const seeded = await seed({
    withHint: false,
    adopted: false,
    deliveryMode: "live",
  });
  try {
    const staleKey = `owner/repo#${900 + serial}`;
    const staleUrl = `https://github.com/owner/repo/pull/${900 + serial}`;
    adoptInspectorPr(inspectorPr(staleKey, staleUrl, seeded.ids.session, seeded.now - 1));
    assert.equal(
      seeded.manager.mergeGate(staleKey),
      "none",
      "an older PR from the same long-lived session was claimed by the new gate",
    );

    const handoff = await seeded.manager.preparePr(seeded.ids.run, "restart-handoff");
    assert.equal(handoff.ok, true);
    await waitFor(
      () => seeded.store.listDeliveries(seeded.ids.run)
        .some((delivery) => delivery.kind === "pr_handoff" && delivery.state === "delivered"),
      "the restart PR handoff was not delivered",
    );
    const adoptedAt = Date.now();
    adoptInspectorPr(inspectorPr(seeded.key, seeded.url, seeded.ids.session, adoptedAt));
    assert.equal(
      (seeded.store.getRun(seeded.ids.run)?.gateState as { prKey?: string | null })?.prKey,
      null,
      "the test requires the restart window before the gate pins its PR",
    );
    assert.equal(seeded.manager.mergeGate(seeded.key), "pending");

    await seeded.manager.stop();
    const recovered = new WorkflowManager(seeded.registry, seeded.store);
    try {
      // No Inspector event and no Session.prUrl has been restored. The persisted adoption row
      // alone must fail closed until normal Inspector reconciliation pins and evaluates it.
      assert.equal(recovered.mergeGate(seeded.key), "pending");
    } finally {
      await recovered.stop();
    }
  } finally {
    await seeded.manager.stop();
    setWorkflowPolicy({ liveEnabled: false, repoAllowlist: ["/repo"] });
  }
});

test("durable handoff provenance requires an exact known repository identity", async () => {
  for (const [label, repoRoot] of [
    ["nested", "/repo/nested"],
    ["missing", null],
  ] as const) {
    const seeded = await seed({
      withHint: false,
      adopted: false,
      deliveryMode: "live",
    });
    try {
      const handoff = await seeded.manager.preparePr(seeded.ids.run, `${label}-repo-handoff`);
      assert.equal(handoff.ok, true);
      await waitFor(
        () => seeded.store.listDeliveries(seeded.ids.run)
          .some((delivery) => delivery.kind === "pr_handoff" && delivery.state === "delivered"),
        `the ${label} repository handoff was not delivered`,
      );

      const adoptedAt = Date.now();
      adoptInspectorPr({
        ...inspectorPr(seeded.key, seeded.url, seeded.ids.session, adoptedAt),
        cwd: repoRoot ?? "/repo",
        repoRoot,
      });
      assert.equal(seeded.manager.mergeGate(seeded.key), "none");

      seeded.registry.applyHook({
        agent: "claude",
        event: "PostToolUse",
        sessionId: seeded.ids.session,
        cwd: repoRoot ?? "/repo",
        transcriptPath: null,
        env: { tmuxPane: `%${serial}` },
        prUrl: seeded.url,
        prCreated: true,
      });
      seeded.registry.inspectionUpdated(seeded.key, null, null, adoptedAt);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(
        (seeded.store.getRun(seeded.ids.run)?.gateState as { prKey?: string | null })?.prKey,
        null,
      );
    } finally {
      await seeded.manager.stop();
      setWorkflowPolicy({ liveEnabled: false, repoAllowlist: ["/repo"] });
    }
  }
});

test("a Preview binding RECORDS the automatic PR handoff it withheld", async () => {
  // Automatic PR preparation is Live-only and stays that way: preparing a pull request is
  // done by TYPING the skill into the pane, which is the terminal write Preview exists to
  // withhold. Silently doing nothing left a run sitting in `waiting_for_pr` under a published
  // policy that says `prepare_pr`, with no trace of why - which reads as a wedged daemon
  // rather than as the consent boundary working.
  const deferred = await seed({
    withHint: false,
    adopted: false,
    missingPrAction: "prepare_pr",
    deliveryMode: "preview",
    startBeforeGate: true,
  });
  try {
    await waitFor(
      () => deferred.store.listEvents(deferred.ids.run)
        .some((event) => event.kind === "pr_handoff_automatic_deferred"),
      "the withheld PR handoff was not recorded",
    );
    const event = deferred.store.listEvents(deferred.ids.run)
      .find((item) => item.kind === "pr_handoff_automatic_deferred");
    const payload = event?.payload as { reason?: string; message?: string } | null;
    assert.equal(payload?.reason, "preview_delivery");
    assert.match(payload?.message ?? "", /Switch it to Live/);
    assert.equal(deferred.injected.length, 0, "Preview delivery typed into the pane");
    assert.equal(
      deferred.store.listDeliveries(deferred.ids.run)
        .filter((delivery) => delivery.kind === "pr_handoff").length,
      0,
    );
    assert.equal(deferred.store.getRun(deferred.ids.run)?.status, "waiting_for_pr");
  } finally {
    await deferred.manager.stop();
    setWorkflowPolicy({ liveEnabled: false, repoAllowlist: ["/repo"] });
  }
});

test("restart recovers an automatic PR handoff that was still parked at its gate", async () => {
  const parked = await seed({
    withHint: false,
    adopted: false,
    missingPrAction: "prepare_pr",
  });
  await parked.manager.stop();
  parked.store.updateBinding(parked.ids.binding, { deliveryMode: "live" }, parked.now + 1);
  setWorkflowPolicy({ liveEnabled: true, repoAllowlist: ["/repo"] });
  const injected: string[] = [];
  const recovered = new WorkflowManager(parked.registry, parked.store, {
    inject: async (_session, payload) => {
      injected.push(payload);
      return { ok: true, pasted: true, submitVerified: true };
    },
    recordInjection: () => {},
    requireSkill: (session, id) => ({
      ok: true,
      command: skillCommand(session.agent, id)!,
    }),
  });
  recovered.start();
  try {
    await waitFor(
      () => parked.store.listDeliveries(parked.ids.run)
        .some((delivery) => delivery.kind === "pr_handoff" && delivery.state === "delivered"),
      "restart did not recover the automatic PR handoff",
    );
    assert.equal(injected.length, 1);
    assert.equal(
      parked.store.listDeliveries(parked.ids.run)
        .filter((delivery) => delivery.kind === "pr_handoff").length,
      1,
    );
  } finally {
    await recovered.stop();
    setWorkflowPolicy({ liveEnabled: false, repoAllowlist: ["/repo"] });
  }
});

test("disabled Inspector blocks honestly and a post-entry observation is required", async () => {
  const disabled = await seed({ enabled: false });
  assert.equal(disabled.store.getRun(disabled.ids.run)?.status, "blocked");
  assert.equal((disabled.store.getRun(disabled.ids.run)?.gateState as { waitReason?: string })?.waitReason, "inspector_disabled");
  await disabled.manager.stop();

  const waiting = await seed();
  assert.equal(waiting.store.getRun(waiting.ids.run)?.status, "waiting_for_inspector");
  assert.equal(
    (waiting.store.getRun(waiting.ids.run)?.gateState as { lastObservedAt?: number | null })
      ?.lastObservedAt,
    null,
  );
  await waiting.manager.stop();
});

test("dirty work, head mismatch, pending review, and error/backoff never read as clean", async () => {
  const dirty = await seed({ dirty: true });
  signal(dirty, dirty.head);
  await waitFor(
    () => (dirty.store.getRun(dirty.ids.run)?.gateState as { waitReason?: string })?.waitReason === "working_tree_not_pushed",
    "dirty worktree did not block head pinning",
  );
  assert.equal(dirty.store.getRun(dirty.ids.run)?.status, "waiting_for_session");
  await dirty.manager.stop();

  const mismatch = await seed();
  signal(mismatch, "different-head");
  await waitFor(
    () => (mismatch.store.getRun(mismatch.ids.run)?.gateState as { waitReason?: string })?.waitReason === "head_mismatch",
    "mismatched head did not remain waiting",
  );
  assert.equal(mismatch.store.getRun(mismatch.ids.run)?.status, "waiting_for_session");
  await mismatch.manager.stop();

  const pending = await seed();
  updateInspectorPr(pending.key, { lastAttemptSha: pending.head }, Date.now());
  signal(pending, pending.head);
  await waitFor(
    () => (pending.store.getRun(pending.ids.run)?.gateState as { waitReason?: string })?.waitReason === "review_pending",
    "unreviewed current head did not remain pending",
  );
  signal(pending, "pushed-after-pin");
  await waitFor(
    () => pending.store.getRun(pending.ids.run)?.status === "waiting_for_session",
    "a changed pinned head did not require a fresh full submission",
  );
  await pending.manager.stop();

  const error = await seed();
  updateInspectorPr(error.key, {
    lastAttemptSha: error.head,
    lastError: "provider unavailable",
    failCount: 2,
    nextAttemptAt: Date.now() + 60_000,
  }, Date.now());
  signal(error, error.head);
  await waitFor(
    () => (error.store.getRun(error.ids.run)?.gateState as { waitReason?: string })?.waitReason === "review_backoff",
    "backed-off failure did not remain waiting",
  );
  await error.manager.stop();
});

test("current-head findings prepare one frozen packet and zero findings complete", async () => {
  const findings = await seed();
  updateInspectorPr(findings.key, {
    headSha: findings.head,
    cleanReviewHeadSha: findings.head,
    lastAttemptSha: findings.head,
    reviewPosture: "live",
    round: 1,
    lastReviewedAt: Date.now(),
  }, Date.now());
  const row: InspectorComment = {
    id: `comment-${serial}`,
    prKey: findings.key,
    fingerprint: `finding-${serial}`,
    path: "src/file.ts",
    line: 10,
    title: "Fix the edge",
    body: "The edge loses the durable state.",
    severity: "major",
    round: 1,
    status: "open",
    replies: 0,
    answeredCommentId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  upsertInspectorComment(row);
  signal(findings, findings.head);
  await waitFor(
    () => findings.store.getRun(findings.ids.run)?.status === "waiting_for_session",
    "findings did not enter the published repair policy",
  );
  assert.equal(findings.store.listDeliveries(findings.ids.run).length, 1);
  assert.match(findings.store.listDeliveries(findings.ids.run)[0]!.payload, /Fix the edge/);
  await findings.manager.stop();

  const clean = await seed();
  updateInspectorPr(clean.key, {
    headSha: clean.head,
    cleanReviewHeadSha: clean.head,
    lastAttemptSha: clean.head,
    reviewPosture: "live",
    round: 1,
    lastReviewedAt: Date.now(),
  }, Date.now());
  signal(clean, clean.head);
  await waitFor(
    () => clean.store.getRun(clean.ids.run)?.status === "completed",
    "clean current head did not complete",
  );
  const state = clean.store.getRun(clean.ids.run)?.gateState as unknown as WorkflowInspectorGateState;
  assert.equal(state.targetHeadSha, clean.head);
  assert.equal(state.observedHeadSha, clean.head);
  assert.equal(state.waitReason, null);
  await clean.manager.stop();
});

test("every unresolved Inspector ledger status blocks completion, including older findings", async () => {
  for (const status of ["drafted", "posting", "open", "resolved"] as const) {
    const seeded = await seed();
    try {
      updateInspectorPr(seeded.key, {
        headSha: seeded.head,
    cleanReviewHeadSha: seeded.head,
        lastAttemptSha: seeded.head,
        reviewPosture: "live",
        round: 2,
        lastReviewedAt: Date.now(),
      }, Date.now());
      for (const [index, findingStatus] of (["resolved", status] as const).entries()) {
        upsertInspectorComment({
          id: `all-findings-${serial}-${index}`,
          prKey: seeded.key,
          fingerprint: `all-findings-${serial}-${index}`,
          path: "src/file.ts",
          line: index + 1,
          title: `Finding ${index + 1}`,
          body: "A prior review's finding still needs resolution.",
          severity: "nit",
          round: 1,
          status: findingStatus,
          replies: 0,
          answeredCommentId: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }
      signal(seeded, seeded.head);
      await waitFor(
        () => seeded.store.getRun(seeded.ids.run)?.status === (
          status === "resolved" ? "completed" : "waiting_for_session"
        ),
        `${status}: the gate did not account for every finding on the PR`,
      );
      const gate = seeded.store.getRun(seeded.ids.run)?.gateState as unknown as WorkflowInspectorGateState;
      assert.equal(gate.waitReason, status === "resolved" ? null : "findings");
      assert.equal(gate.findingFingerprints.length, status === "resolved" ? 0 : 1);
    } finally {
      await seeded.manager.stop();
    }
  }
});

test("sessionless Inspector-only findings still wait for a new head", async () => {
  const seeded = await seed({ policy: "inspector_only" });
  updateInspectorPr(seeded.key, {
    headSha: seeded.head,
    cleanReviewHeadSha: seeded.head,
    lastAttemptSha: seeded.head,
    reviewPosture: "live",
    round: 1,
    lastReviewedAt: Date.now(),
  }, Date.now());
  upsertInspectorComment({
    id: `sessionless-comment-${serial}`,
    prKey: seeded.key,
    fingerprint: `sessionless-finding-${serial}`,
    path: "src/file.ts",
    line: 10,
    title: "Wait for the repair head",
    body: "The bound session is no longer available.",
    severity: "major",
    round: 1,
    status: "open",
    replies: 0,
    answeredCommentId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  db.prepare(`UPDATE workflow_bindings SET session_id = NULL WHERE id = ?`).run(seeded.ids.binding);

  signal(seeded, seeded.head);
  await waitFor(
    () => seeded.store.getRun(seeded.ids.run)?.status === "waiting_for_new_head",
    "sessionless Inspector-only findings did not preserve the new-head policy",
  );
  const state = seeded.store.getRun(seeded.ids.run)?.gateState as unknown as WorkflowInspectorGateState;
  assert.equal(state.waitReason, "findings");
  assert.deepEqual(state.findingFingerprints, [`sessionless-finding-${serial}`]);
  assert.equal(seeded.store.listDeliveries(seeded.ids.run).length, 0);
  assert.equal(
    seeded.store.listEvents(seeded.ids.run).filter((event) => event.kind === "inspector_findings").length,
    1,
  );
  await seeded.manager.stop();
});

// The decision recorded beside `WORKFLOW_RUN_TERMINAL_STATUSES`, asserted rather than
// only written down. Making `blocked` terminal is the one-line change that would end the
// permanent veto by turning "the reviewer gave up" into "the reviewer approved it", and
// both halves of the codebase have to keep refusing it: the shared predicate the browser
// reads, and the SQL literal the Shipping veto actually runs.
test("a blocked run stays open on both sides of the wire, so its gate keeps vetoing", () => {
  assert.equal(
    WORKFLOW_RUN_TERMINAL_STATUSES.includes("blocked" as never),
    false,
    "blocked became terminal - a gate that gave up would now auto-merge",
  );
  assert.equal(workflowRunIsOpen("blocked"), true);
  const store = readFileSync(new URL("../src/server/workflows/store.ts", import.meta.url), "utf8");
  assert.doesNotMatch(
    store,
    /status NOT IN \('completed', 'cancelled', 'failed', 'blocked'\)/,
    "the store stopped counting a blocked run as active, which silently releases the veto",
  );
});

test("a live Inspector wait accepts an idempotent recheck request", async () => {
  const seeded = await seed({ policy: "inspector_only" });
  try {
    assert.equal(seeded.store.getRun(seeded.ids.run)?.status, "waiting_for_inspector");
    const requestId = `recheck-live-${serial}`;
    const first = seeded.manager.recheckInspector(seeded.ids.run, requestId);
    assert.equal(first.ok, true);
    const replay = seeded.manager.recheckInspector(seeded.ids.run, requestId);
    assert.equal(replay.ok, true);
    assert.equal(replay.ok && replay.idempotent, true);
    assert.equal(
      seeded.store.listEvents(seeded.ids.run)
        .filter((event) => event.kind === "inspector_recheck_requested").length,
      1,
      "an idempotent recheck wrote more than one audit event",
    );
  } finally {
    await seeded.manager.stop();
  }
});

// A run that exhausts its repair budget vetoes its pull request FOREVER, and until this
// test existed nothing pinned any part of that story. The veto itself is correct and stays
// - a gate that gave up did not pass, and auto-merging it is the bypass the veto exists to
// stop - so what is pinned here is that the daemon says WHICH veto it is, that the remedy
// the dashboard used to advertise genuinely does not work, that no amount of pushing clears
// it, and that the grant does.
test("a spent repair budget vetoes under its own reason, survives new heads, and clears only on a grant", async () => {
  const seeded = await seed({ policy: "inspector_only" });
  // One round, so the second new head exhausts the budget through the real gate path
  // rather than a hand-written `blocked` row.
  db.prepare(`UPDATE workflow_runs SET max_repair_rounds = 1 WHERE id = ?`).run(seeded.ids.run);
  db.prepare(`UPDATE workflow_bindings SET session_id = NULL WHERE id = ?`).run(seeded.ids.binding);

  const findOn = (round: number, head: string): void => {
    updateInspectorPr(seeded.key, {
      headSha: head,
      lastAttemptSha: head,
      reviewPosture: "live",
      round,
      lastReviewedAt: Date.now(),
    }, Date.now());
    upsertInspectorComment({
      id: `round-limit-comment-${serial}-${round}`,
      prKey: seeded.key,
      fingerprint: `round-limit-finding-${serial}-${round}`,
      path: "src/file.ts",
      line: 10,
      title: "Still not fixed",
      body: "The repair did not land.",
      severity: "major",
      round,
      status: "open",
      replies: 0,
      answeredCommentId: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  };
  const parkOnFindings = async (round: number, head: string, why: string): Promise<void> => {
    findOn(round, head);
    signal(seeded, head);
    await waitFor(
      () => seeded.store.getRun(seeded.ids.run)?.status === "waiting_for_new_head",
      why,
    );
  };

  // Round 1 fails, the operator pushes a fix, round 2 fails too. That second push is what
  // spends the budget: the gate re-tests it on the NEXT head, not on this one.
  await parkOnFindings(1, seeded.head, "the first findings did not park on a new head");
  const secondHead = `head-${serial}-two`;
  signal(seeded, secondHead);
  await waitFor(
    () => seeded.store.latestSubmission(seeded.ids.run)?.round === 2,
    "the new head did not open the second repair round",
  );
  assert.equal(
    seeded.manager.mergeGate(seeded.key),
    "pending",
    "a run still inside its budget is not a run that gave up",
  );

  await parkOnFindings(2, secondHead, "the second findings did not park on a new head");
  const acceptedRecheckId = `recheck-before-spent-${serial}`;
  const acceptedRecheck = seeded.manager.recheckInspector(
    seeded.ids.run,
    acceptedRecheckId,
  );
  assert.equal(acceptedRecheck.ok, true);
  signal(seeded, `head-${serial}-three`);
  await waitFor(
    () => seeded.store.getRun(seeded.ids.run)?.currentPhase === "round_limit",
    "the exhausted budget did not block the run",
  );

  // 1. The veto stands, and now it names itself. `pending` here would be the daemon
  //    telling the operator to wait for a review that will never run again.
  assert.equal(seeded.manager.mergeGate(seeded.key), "spent");
  const acceptedReplay = seeded.manager.recheckInspector(
    seeded.ids.run,
    acceptedRecheckId,
  );
  assert.equal(acceptedReplay.ok, true);
  assert.equal(acceptedReplay.ok && acceptedReplay.idempotent, true);
  const recheckEventsBeforeDeadRequest = seeded.store.listEvents(seeded.ids.run)
    .filter((event) => event.kind === "inspector_recheck_requested").length;
  assert.equal(
    recheckEventsBeforeDeadRequest,
    1,
    "replaying an accepted recheck after the run changed state wrote another audit event",
  );
  const deadRecheck = seeded.manager.recheckInspector(
    seeded.ids.run,
    `recheck-spent-${serial}`,
  );
  assert.equal(deadRecheck.ok, false);
  if (!deadRecheck.ok) assert.equal(deadRecheck.reason, "run_not_waiting");
  assert.equal(
    seeded.store.listEvents(seeded.ids.run)
      .filter((event) => event.kind === "inspector_recheck_requested").length,
    recheckEventsBeforeDeadRequest,
    "a spent recheck left an audit event even though the evaluator cannot advance it",
  );

  // 2. The remedy run detail used to advertise - "a larger repair budget is a change to
  //    the binding" - does not work, because every guard reads the RUN's snapshot and
  //    `updateBinding` never touched it. Pinned as a fact so nobody re-advertises it.
  seeded.store.updateBinding(seeded.ids.binding, { maxRepairRounds: 10 });
  assert.equal(
    seeded.store.getRun(seeded.ids.run)?.maxRepairRounds,
    1,
    "raising the binding budget silently rewrote the run's snapshot",
  );
  assert.equal(
    seeded.manager.mergeGate(seeded.key),
    "spent",
    "raising the binding budget appeared to revive a run it cannot reach",
  );

  // 3. The operator cannot push their way out: the gate re-tests the budget on every new
  //    head, so more commits re-enter the same refusal.
  signal(seeded, `head-${serial}-four`);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(seeded.store.getRun(seeded.ids.run)?.currentPhase, "round_limit");
  assert.equal(seeded.manager.mergeGate(seeded.key), "spent");

  // 4. The grant is the way out, and it reaches the number the guards actually read.
  const granted = seeded.manager.grantRepairRounds(seeded.ids.run, { requestId: `grant-${serial}`, rounds: 2 });
  assert.equal(granted.ok, true);
  assert.equal(seeded.store.getRun(seeded.ids.run)?.maxRepairRounds, 3);
  assert.equal(
    seeded.manager.mergeGate(seeded.key),
    "pending",
    "the grant did not lift the permanent veto",
  );
  assert.equal(
    seeded.store.listEvents(seeded.ids.run).filter((event) => event.kind === "repair_rounds_granted").length,
    1,
    "the grant left no audit trail",
  );

  /*
   * 5. And the run is actually GOING again, which the budget alone does not achieve here.
   *
   * Nothing polls a blocked run - `evaluateInspectorGate` returns early on one - so a grant
   * that moved only the number would leave this gate exactly as stopped as it was while
   * reporting `pending` to Shipping. That trade, a true "gave up" for a false "still
   * working", is worse than the dead end. So the grant restores the state its own gate
   * re-enters, and the proof is that the next head opens a round instead of being ignored.
   */
  assert.equal(seeded.store.getRun(seeded.ids.run)?.status, "waiting_for_new_head");
  signal(seeded, `head-${serial}-five`);
  await waitFor(
    () => seeded.store.latestSubmission(seeded.ids.run)?.round === 3,
    "the granted gate ignored the next head, so the grant revived nothing",
  );

  /*
   * 6. And a replay of the same intent is that grant, not a second one.
   *
   * The run-action store retains its request id across a failed response, so a network error
   * on a grant that actually committed comes back with the same id. Answered as the refusal
   * below it, that would tell the operator their run could not be granted rounds it already
   * holds - and the budget would read one grant short of what the timeline says.
   */
  const replay = seeded.manager.grantRepairRounds(seeded.ids.run, {
    requestId: `grant-${serial}`,
    rounds: 2,
  });
  assert.equal(replay.ok, true, "a retried grant was refused as a new one");
  assert.equal(seeded.store.getRun(seeded.ids.run)?.maxRepairRounds, 3, "the replay granted twice");
  assert.equal(
    seeded.store.listEvents(seeded.ids.run).filter((event) => event.kind === "repair_rounds_granted").length,
    1,
    "the replay wrote a second grant into the run's history",
  );

  /*
   * 7. The granted path can adopt a clean exact current head, but only after the daemon's
   * ordinary evaluator sees the current Inspector ledger. Granting did not complete the run,
   * rewrite its historical gate observation, or create a browser-owned shortcut.
   */
  const currentHead = `head-${serial}-five`;
  const resolvedAt = Date.now();
  db.prepare(
    `UPDATE inspector_comments SET status = 'resolved', updated_at = ? WHERE pr_key = ?`,
  ).run(resolvedAt, seeded.key);
  updateInspectorPr(seeded.key, {
    state: "open",
    headSha: currentHead,
    cleanReviewHeadSha: currentHead,
    lastAttemptSha: currentHead,
    observedHeadSha: currentHead,
    observedState: "OPEN",
    observedAt: resolvedAt,
    reviewPosture: "live",
    round: 3,
    lastReviewedAt: resolvedAt,
    lastError: null,
    nextAttemptAt: null,
  }, resolvedAt);
  signal(seeded, currentHead, resolvedAt);
  await waitFor(
    () => seeded.store.getRun(seeded.ids.run)?.status === "completed",
    "the granted evaluator path did not adopt the clean exact Inspector head",
  );
  const adoptedSubmission = seeded.store.latestSubmission(seeded.ids.run);
  assert.equal(adoptedSubmission?.mode, "inspector_only");
  assert.equal(adoptedSubmission?.prHeadSha, currentHead);
  const adoptedContext = adoptedSubmission?.context as
    | { priorFindingFingerprints?: string[] }
    | undefined;
  assert.deepEqual(
    adoptedContext?.priorFindingFingerprints,
    [
      `round-limit-finding-${serial}-1`,
      `round-limit-finding-${serial}-2`,
    ],
    "the immutable Inspector-only submission lost its prior finding audit",
  );
  assert.equal(
    seeded.store.listEvents(seeded.ids.run).filter((event) => event.kind === "inspector_gate_clean").length,
    1,
  );
  assert.equal(
    seeded.manager.mergeGate(seeded.key),
    "none",
    "the completed workflow still held a Shipping veto",
  );
  await seeded.manager.stop();
});

/*
 * The grant refuses a run that is not stuck, which is what keeps it from becoming a general
 * "raise the budget" control. The budget is a BINDING setting; this route exists only to
 * open the one dead end the binding cannot reach, so a run with rounds left is told no.
 */
test("a grant is refused for a run that has not spent its budget", async () => {
  const seeded = await seed({ policy: "inspector_only" });
  const refused = seeded.manager.grantRepairRounds(seeded.ids.run, {
    requestId: `grant-live-${serial}`,
    rounds: 2,
  });
  assert.equal(refused.ok, false);
  assert.equal(seeded.store.getRun(seeded.ids.run)?.maxRepairRounds, 3, "a live run took a grant");
  await seeded.manager.stop();
});

test("sessionless full-workflow findings remain visible and blocked", async () => {
  const seeded = await seed();
  updateInspectorPr(seeded.key, {
    headSha: seeded.head,
    cleanReviewHeadSha: seeded.head,
    lastAttemptSha: seeded.head,
    reviewPosture: "live",
    round: 1,
    lastReviewedAt: Date.now(),
  }, Date.now());
  upsertInspectorComment({
    id: `sessionless-full-comment-${serial}`,
    prKey: seeded.key,
    fingerprint: `sessionless-full-finding-${serial}`,
    path: "src/file.ts",
    line: 10,
    title: "Keep the finding visible",
    body: "The normal repair path has no bound session.",
    severity: "major",
    round: 1,
    status: "open",
    replies: 0,
    answeredCommentId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  db.prepare(`UPDATE workflow_bindings SET session_id = NULL WHERE id = ?`).run(seeded.ids.binding);

  signal(seeded, seeded.head);
  await waitFor(
    () => seeded.store.getRun(seeded.ids.run)?.status === "blocked",
    "sessionless full-workflow findings did not block visibly",
  );
  const state = seeded.store.getRun(seeded.ids.run)?.gateState as unknown as WorkflowInspectorGateState;
  assert.equal(state.waitReason, "findings");
  assert.deepEqual(state.findingFingerprints, [`sessionless-full-finding-${serial}`]);
  assert.equal(seeded.store.listDeliveries(seeded.ids.run).length, 0);
  assert.equal(
    seeded.store.listEvents(seeded.ids.run).filter((event) => event.kind === "inspector_findings").length,
    1,
  );
  await seeded.manager.stop();
});

test("atomic repair-packet failure leaves the manager's prior gate untouched", async () => {
  const seeded = await seed();
  updateInspectorPr(seeded.key, {
    headSha: seeded.head,
    cleanReviewHeadSha: seeded.head,
    lastAttemptSha: seeded.head,
    reviewPosture: "live",
    round: 1,
    lastReviewedAt: Date.now(),
  }, Date.now());
  upsertInspectorComment({
    id: `atomic-manager-comment-${serial}`,
    prKey: seeded.key,
    fingerprint: `atomic-manager-finding-${serial}`,
    path: "src/file.ts",
    line: 10,
    title: "Keep the prior gate",
    body: "Packet insertion failed.",
    severity: "major",
    round: 1,
    status: "open",
    replies: 0,
    answeredCommentId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  const collisionId = `atomic-manager-collision-${serial}`;
  seeded.store.prepareDelivery({
    id: collisionId,
    runId: seeded.ids.run,
    submissionId: seeded.ids.submission,
    kind: "persona_feedback",
    sessionId: seeded.ids.session,
    noteKey: `agent-${serial}`,
    payload: "existing packet",
    payloadSha256: `existing-manager-packet-${serial}`,
  }, seeded.now);

  const transition = seeded.store.transitionInspectorFindingsWithDelivery.bind(seeded.store);
  let attempted = false;
  let prior = seeded.store.getRun(seeded.ids.run)!;
  seeded.store.transitionInspectorFindingsWithDelivery = (input) => {
    attempted = true;
    prior = seeded.store.getRun(seeded.ids.run)!;
    return transition({
      ...input,
      delivery: { ...input.delivery, id: collisionId },
    });
  };

  signal(seeded, seeded.head);
  await waitFor(() => attempted, "the manager never attempted atomic finding delivery");
  await new Promise((resolve) => setImmediate(resolve));
  const after = seeded.store.getRun(seeded.ids.run)!;
  assert.equal(after.status, prior.status);
  assert.equal(after.currentPhase, prior.currentPhase);
  assert.deepEqual(after.gateState, prior.gateState);
  assert.equal(
    seeded.store.listEvents(seeded.ids.run).some((event) =>
      ["inspector_findings", "inspector_feedback_prepared", "inspector_adapter_error"].includes(event.kind)),
    false,
  );
  assert.equal(
    seeded.store.listDeliveries(seeded.ids.run).some((delivery) => delivery.kind === "inspector_feedback"),
    false,
  );
  await seeded.manager.stop();
});

test("finding state and its immutable repair packet survive insertion failure and restart", async () => {
  const seeded = await seed();
  await seeded.manager.stop();
  const before = seeded.store.getRun(seeded.ids.run)!;
  const state = before.gateState as unknown as WorkflowInspectorGateState;
  const nextState: WorkflowInspectorGateState = {
    ...state,
    targetHeadSha: seeded.head,
    failedHeadSha: seeded.head,
    waitReason: "findings",
    findingFingerprints: ["atomic-finding"],
  };
  seeded.store.prepareDelivery({
    id: "atomic-delivery-collision",
    runId: seeded.ids.run,
    submissionId: seeded.ids.submission,
    kind: "persona_feedback",
    sessionId: seeded.ids.session,
    noteKey: `agent-${serial}`,
    payload: "existing packet",
    payloadSha256: "existing-packet",
  }, seeded.now);

  assert.throws(() => seeded.store.transitionInspectorFindingsWithDelivery({
    runId: seeded.ids.run,
    expectedState: state,
    state: nextState,
    status: "waiting_for_session",
    findingEvent: { findingFingerprints: ["atomic-finding"] },
    delivery: {
      id: "atomic-delivery-collision",
      runId: seeded.ids.run,
      submissionId: seeded.ids.submission,
      kind: "inspector_feedback",
      sessionId: seeded.ids.session,
      noteKey: `agent-${serial}`,
      payload: "repair packet",
      payloadSha256: "repair-packet",
    },
    deliveryEvent: {
      deliveryId: "atomic-delivery-collision",
      payloadSha256: "repair-packet",
    },
    now: seeded.now + 1,
  }), /UNIQUE constraint failed/);
  assert.equal(seeded.store.getRun(seeded.ids.run)?.status, before.status);
  assert.deepEqual(seeded.store.getRun(seeded.ids.run)?.gateState, before.gateState);
  assert.equal(
    seeded.store.listEvents(seeded.ids.run).some((event) => event.kind === "inspector_findings"),
    false,
  );
  assert.equal(
    seeded.store.listDeliveries(seeded.ids.run).some((delivery) => delivery.kind === "inspector_feedback"),
    false,
  );

  const committed = seeded.store.transitionInspectorFindingsWithDelivery({
    runId: seeded.ids.run,
    expectedState: state,
    state: nextState,
    status: "waiting_for_session",
    findingEvent: { findingFingerprints: ["atomic-finding"] },
    delivery: {
      id: "atomic-inspector-delivery",
      runId: seeded.ids.run,
      submissionId: seeded.ids.submission,
      kind: "inspector_feedback",
      sessionId: seeded.ids.session,
      noteKey: `agent-${serial}`,
      payload: "repair packet",
      payloadSha256: "repair-packet",
    },
    deliveryEvent: {
      deliveryId: "atomic-inspector-delivery",
      payloadSha256: "repair-packet",
    },
    now: seeded.now + 2,
  });
  assert.ok(committed);
  assert.equal(committed.run.status, "waiting_for_session");
  assert.equal(committed.delivery.kind, "inspector_feedback");
  assert.deepEqual(committed.run.gateState, nextState);
  assert.deepEqual(
    seeded.store.listEvents(seeded.ids.run)
      .filter((event) => event.kind.startsWith("inspector_"))
      .slice(-2)
      .map((event) => event.kind),
    ["inspector_findings", "inspector_feedback_prepared"],
  );

  seeded.store.updateBinding(seeded.ids.binding, { deliveryMode: "live" }, seeded.now + 3);
  setWorkflowPolicy({ liveEnabled: true, repoAllowlist: ["/repo"] });
  const injected: string[] = [];
  const recoveredManager = new WorkflowManager(seeded.registry, seeded.store, {
    inject: async (_session, payload) => {
      injected.push(payload);
      return { ok: true, pasted: true, submitVerified: true };
    },
    recordInjection: () => {},
  });
  recoveredManager.start();
  await waitFor(
    () => seeded.store.getDelivery(committed.delivery.id)?.state === "delivered",
    "prepared Inspector feedback did not resume after restart",
  );
  const recovered = seeded.store.getDelivery(committed.delivery.id);
  assert.equal(recovered?.payload, "repair packet");
  assert.equal(recovered?.payloadSha256, "repair-packet");
  assert.equal(
    injected.filter((payload) => payload === "repair packet").length,
    1,
    "the immutable Inspector repair packet was not recovered exactly once",
  );
  await recoveredManager.stop();
  setWorkflowPolicy({ liveEnabled: false, repoAllowlist: ["/repo"] });
});

// The findings text changes between builds (posted markers, whole-finding truncation). A
// delivery is keyed on its payload hash, so a build that rendered a prepared packet again
// would mint a second delivery beside the frozen one, or type different bytes than the hash
// the run recorded. Neither restart recovery nor a fresh observation of the same head may
// render it: the stored bytes are what reach the pane.
for (const policy of ["restart_workflow", "inspector_only"] as const) {
  test(`a packet frozen by an older build is delivered as stored and never rendered again: ${policy}`, async () => {
    const seeded = await seed({ policy });
    await seeded.manager.stop();
    updateInspectorPr(seeded.key, {
      headSha: seeded.head,
      lastAttemptSha: seeded.head,
      reviewPosture: "live",
      round: 1,
      lastReviewedAt: Date.now(),
    }, Date.now());
    const row: InspectorComment = {
      id: `frozen-comment-${serial}`,
      prKey: seeded.key,
      fingerprint: `frozen-finding-${serial}`,
      path: "src/file.ts",
      line: 10,
      title: "Fix the edge",
      body: "The edge loses the durable state.",
      severity: "major",
      round: 1,
      status: "open",
      replies: 0,
      answeredCommentId: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    upsertInspectorComment(row);
    const state = seeded.store.getRun(seeded.ids.run)!.gateState as unknown as WorkflowInspectorGateState;
    const findingsState: WorkflowInspectorGateState = {
      ...state,
      targetHeadSha: seeded.head,
      failedHeadSha: seeded.head,
      waitReason: "findings",
      findingFingerprints: [row.fingerprint],
    };
    // What the previous build typed: the same finding, without a posted marker.
    const frozen = [
      "GitHub Inspector reviewed the pinned pull request head and found changes that are required.",
      "",
      "## MAJOR - Fix the edge",
      "Location: src/file.ts:10",
      "The edge loses the durable state.",
      `Fingerprint: ${row.fingerprint}`,
    ].join("\n");
    const frozenSha = createHash("sha256").update(frozen).digest("hex");
    const current = renderInspectorFeedback({
      workflowName: `Workflow ${serial}`,
      workflowVersion: 1,
      runId: seeded.ids.run,
      submissionRound: 1,
      originalGoal: "Ship the reviewed change",
      prUrl: seeded.url,
      targetHeadSha: seeded.head,
      inspectorRound: 1,
      reviewPosture: "live",
      policy,
      findings: [row],
      workflowEvidence: false,
    });
    assert.notEqual(current.payloadSha256, frozenSha, "this build would render different bytes");
    const prepared = seeded.store.transitionInspectorFindingsWithDelivery({
      runId: seeded.ids.run,
      expectedState: state,
      state: findingsState,
      status: policy === "inspector_only" ? "waiting_for_new_head" : "waiting_for_session",
      findingEvent: { findingFingerprints: [row.fingerprint] },
      delivery: {
        id: `frozen-delivery-${serial}`,
        runId: seeded.ids.run,
        submissionId: seeded.ids.submission,
        kind: "inspector_feedback",
        sessionId: seeded.ids.session,
        noteKey: `agent-${serial}`,
        payload: frozen,
        payloadSha256: frozenSha,
      },
      deliveryEvent: { deliveryId: `frozen-delivery-${serial}`, payloadSha256: frozenSha },
      now: seeded.now + 1,
    });
    assert.ok(prepared);

    seeded.store.updateBinding(seeded.ids.binding, { deliveryMode: "live" }, seeded.now + 2);
    setWorkflowPolicy({ liveEnabled: true, repoAllowlist: ["/repo"] });
    const injected: string[] = [];
    const recovered = new WorkflowManager(seeded.registry, seeded.store, {
      resolveCommit: async (_root, head) => head,
      inject: async (_session, payload) => {
        injected.push(payload);
        return { ok: true, pasted: true, submitVerified: true };
      },
      recordInjection: () => {},
      resumptionSettleMs: 0,
    });
    // Count gate evaluations of an observation as they FINISH. Under `restart_workflow` the
    // gate records nothing when it re-enters (the run is parked in `waiting_for_session`), so
    // there is no state to wait on; waiting for the evaluation itself is what makes the
    // delivery count below an assertion about this observation rather than about a timer.
    const gate = recovered as unknown as {
      evaluateInspectorGate(runId: string, event: unknown): Promise<void>;
    };
    const evaluate = gate.evaluateInspectorGate.bind(recovered);
    let observationsEvaluated = 0;
    gate.evaluateInspectorGate = async (runId, event) => {
      await evaluate(runId, event);
      if (event && runId === seeded.ids.run) observationsEvaluated += 1;
    };
    try {
      recovered.start();
      await waitFor(
        () => seeded.store.getDelivery(prepared.delivery.id)?.state === "delivered",
        "the frozen Inspector packet did not resume after restart",
      );
      // The same head observed again, findings still open: the gate re-enters and must
      // leave the prepared packet alone.
      const before = observationsEvaluated;
      const observedAt = Date.now();
      signal(seeded, seeded.head, observedAt);
      await waitFor(
        () => observationsEvaluated > before,
        "the gate never evaluated the fresh observation",
      );
      if (policy === "inspector_only") {
        const state = seeded.store.getRun(seeded.ids.run)?.gateState as unknown as WorkflowInspectorGateState;
        assert.ok((state.lastObservedAt ?? 0) >= observedAt, "the Inspector-only gate did not take the observation");
      }
      const packets = seeded.store.listDeliveries(seeded.ids.run)
        .filter((delivery) => delivery.kind === "inspector_feedback");
      assert.equal(packets.length, 1, "a second Inspector packet was prepared for the same submission");
      assert.equal(packets[0]!.payload, frozen);
      assert.equal(packets[0]!.payloadSha256, frozenSha);
      assert.deepEqual(injected, [frozen]);
    } finally {
      await recovered.stop();
      setWorkflowPolicy({ liveEnabled: false, repoAllowlist: ["/repo"] });
    }
  });
}

test("restart recovery never sends a prepared packet from an older submission", async () => {
  const seeded = await seed({ policy: "inspector_only" });
  await seeded.manager.stop();
  const before = seeded.store.getRun(seeded.ids.run)!;
  const state = before.gateState as unknown as WorkflowInspectorGateState;
  const findingsState: WorkflowInspectorGateState = {
    ...state,
    targetHeadSha: seeded.head,
    failedHeadSha: seeded.head,
    observedHeadSha: seeded.head,
    waitReason: "findings",
    findingFingerprints: ["stale-finding"],
  };
  const prepared = seeded.store.transitionInspectorFindingsWithDelivery({
    runId: seeded.ids.run,
    expectedState: state,
    state: findingsState,
    status: "waiting_for_new_head",
    findingEvent: { findingFingerprints: ["stale-finding"] },
    delivery: {
      id: `stale-inspector-delivery-${serial}`,
      runId: seeded.ids.run,
      submissionId: seeded.ids.submission,
      kind: "inspector_feedback",
      sessionId: seeded.ids.session,
      noteKey: `agent-${serial}`,
      payload: "stale repair packet",
      payloadSha256: `stale-repair-packet-${serial}`,
    },
    deliveryEvent: {
      deliveryId: `stale-inspector-delivery-${serial}`,
      payloadSha256: `stale-repair-packet-${serial}`,
    },
    now: seeded.now + 1,
  });
  assert.ok(prepared);
  const newerHead = `newer-head-${serial}`;
  const currentState: WorkflowInspectorGateState = {
    ...findingsState,
    targetHeadSha: newerHead,
    observedHeadSha: newerHead,
    waitReason: "review_pending",
  };
  const newer = seeded.store.createInspectorOnlySubmission({
    id: `newer-inspector-submission-${serial}`,
    runId: seeded.ids.run,
    triggerKey: `inspector-head:${seeded.ids.run}:${newerHead}`,
    newHeadSha: newerHead,
    failedHeadSha: seeded.head,
    priorFindingFingerprints: findingsState.findingFingerprints,
    bypassReason: "Published Inspector-only findings policy",
    expectedState: findingsState,
    state: currentState,
    now: seeded.now + 2,
  });
  assert.ok(newer);

  seeded.store.updateBinding(seeded.ids.binding, { deliveryMode: "live" }, seeded.now + 3);
  setWorkflowPolicy({ liveEnabled: true, repoAllowlist: ["/repo"] });
  const injected: string[] = [];
  const recoveredManager = new WorkflowManager(seeded.registry, seeded.store, {
    inject: async (_session, payload) => {
      injected.push(payload);
      return { ok: true, pasted: true, submitVerified: true };
    },
    recordInjection: () => {},
  });
  recoveredManager.start();
  await recoveredManager.stop();
  assert.equal(seeded.store.getDelivery(prepared.delivery.id)?.state, "prepared");
  assert.deepEqual(injected, []);
  setWorkflowPolicy({ liveEnabled: false, repoAllowlist: ["/repo"] });
});

test("restart recovery skips packets after the current submission advances past its findings", async () => {
  const seeded = await seed();
  await seeded.manager.stop();
  const before = seeded.store.getRun(seeded.ids.run)!;
  const state = before.gateState as unknown as WorkflowInspectorGateState;
  const findingsState: WorkflowInspectorGateState = {
    ...state,
    targetHeadSha: seeded.head,
    failedHeadSha: seeded.head,
    observedHeadSha: seeded.head,
    waitReason: "findings",
    findingFingerprints: ["superseded-finding"],
  };
  const prepared = seeded.store.transitionInspectorFindingsWithDelivery({
    runId: seeded.ids.run,
    expectedState: state,
    state: findingsState,
    status: "waiting_for_session",
    findingEvent: { findingFingerprints: ["superseded-finding"] },
    delivery: {
      id: `superseded-inspector-delivery-${serial}`,
      runId: seeded.ids.run,
      submissionId: seeded.ids.submission,
      kind: "inspector_feedback",
      sessionId: seeded.ids.session,
      noteKey: `agent-${serial}`,
      payload: "superseded repair packet",
      payloadSha256: `superseded-repair-packet-${serial}`,
    },
    deliveryEvent: {
      deliveryId: `superseded-inspector-delivery-${serial}`,
      payloadSha256: `superseded-repair-packet-${serial}`,
    },
    now: seeded.now + 1,
  });
  assert.ok(prepared);
  const newerHead = `same-submission-head-${serial}`;
  const advancedState: WorkflowInspectorGateState = {
    ...findingsState,
    targetHeadSha: newerHead,
    observedHeadSha: newerHead,
    waitReason: "review_pending",
  };
  assert.ok(seeded.store.updateInspectorGate({
    runId: seeded.ids.run,
    expectedState: findingsState,
    state: advancedState,
    status: "waiting_for_inspector",
    phase: "inspector_review",
    now: seeded.now + 2,
  }));
  const handoff = seeded.store.prepareDelivery({
    id: `unrelated-handoff-${serial}`,
    runId: seeded.ids.run,
    submissionId: seeded.ids.submission,
    kind: "pr_handoff",
    sessionId: seeded.ids.session,
    noteKey: `agent-${serial}`,
    payload: "unrelated handoff",
    payloadSha256: `unrelated-handoff-packet-${serial}`,
  }, seeded.now + 2);

  seeded.store.updateBinding(seeded.ids.binding, { deliveryMode: "live" }, seeded.now + 3);
  setWorkflowPolicy({ liveEnabled: true, repoAllowlist: ["/repo"] });
  const injected: string[] = [];
  const recoveredManager = new WorkflowManager(seeded.registry, seeded.store, {
    inject: async (_session, payload) => {
      injected.push(payload);
      return { ok: true, pasted: true, submitVerified: true };
    },
    recordInjection: () => {},
  });
  recoveredManager.start();
  await recoveredManager.stop();
  assert.equal(seeded.store.getDelivery(prepared.delivery.id)?.state, "prepared");
  assert.equal(seeded.store.getDelivery(handoff.delivery.id)?.state, "prepared");
  assert.deepEqual(injected, []);
  setWorkflowPolicy({ liveEnabled: false, repoAllowlist: ["/repo"] });
});

test("Inspector completes with retained local artifacts but refuses missing or extra publication", async () => {
  const treeOid = "a".repeat(40);
  const path = "docs/reports/result/report.html";
  const sha256 = "b".repeat(64);
  for (const scenario of ["retained", "missing-receipt", "uncommitted-source", "extra-published", "unreadable-tree", "missing-root"] as const) {
    const seeded = await seed({
      dirty: true,
      ...(scenario === "missing-root" ? { bindingRepoRoot: null, inspectorRepoRoot: null } : {}),
      evidence: {
        contentTreeOid: "c".repeat(40),
        publication: {
          version: 1, treeOid, pathsTruncated: false,
          unpublishedPaths: scenario === "uncommitted-source" ? ["src/required.ts"] : [],
          localArtifacts: [{ path, sha256, bytes: 6 }],
        },
        artifacts: scenario === "missing-receipt" ? [] : [{
          id: "report", ordinal: 0, displayName: path, caption: "Local report",
          repositoryScope: "all", mimeType: "text/plain", bytes: 6, sha256,
          content: "report", availability: "retained", prunedAt: null, createdAt: Date.now(),
        }],
      },
      resolveCommitTree: async () => {
        assert.notEqual(scenario, "missing-root", "a missing root must be refused before tree resolution");
        if (scenario === "unreadable-tree") throw new Error("missing commit");
        return scenario === "extra-published" ? "d".repeat(40) : treeOid;
      },
    });
    try {
      updateInspectorPr(seeded.key, {
        headSha: seeded.head, cleanReviewHeadSha: seeded.head, lastAttemptSha: seeded.head,
        reviewPosture: "live", round: 1, lastReviewedAt: Date.now(),
      }, Date.now());
      signal(seeded, seeded.head);
      await waitFor(() => seeded.store.getRun(seeded.ids.run)?.status ===
        (scenario === "retained" ? "completed" : scenario === "missing-root" ? "blocked" : "waiting_for_session"), scenario);
      if (scenario !== "retained") assert.equal(
        (seeded.store.getRun(seeded.ids.run)?.gateState as unknown as WorkflowInspectorGateState | undefined)?.waitReason,
        scenario === "missing-root" ? "head_mismatch" : "working_tree_not_pushed",
      );
    } finally {
      await seeded.manager.stop();
    }
  }
});

// ---- An open pull request is never blocked as closed on a signal that observed nothing ----
//
// Reported three times in one day: a run waiting on the session's repair push flipped to
// `blocked`/`inspector_pr_closed` while the pull request stayed open with an unchanged head.
// Every Inspector signal that reads nothing from GitHub - a failed or rate-limited poll, a
// settings save, an adoption - carries a null state, and the gate read `null !== "OPEN"` as
// closed. The block then offered only cancel and a full restart, and refused a recheck.

type Seeded = Awaited<ReturnType<typeof seed>>;

/** Wait until every gate evaluation the manager has scheduled has finished. */
async function settleGate(seeded: Seeded): Promise<void> {
  const tasks = (seeded.manager as unknown as { backgroundTasks: Set<Promise<void>> }).backgroundTasks;
  while (tasks.size > 0) await Promise.allSettled(tasks);
}

/** Drive an Inspector-only run to where the reports found it: waiting on a repair push. */
async function awaitRepairPush(seeded: Seeded): Promise<void> {
  const now = Date.now();
  updateInspectorPr(seeded.key, { headSha: seeded.head, lastAttemptSha: seeded.head,
    reviewPosture: "live", reviewComplete: true, round: 1 }, now);
  upsertInspectorComment({
    id: `repair-finding-${serial}`, prKey: seeded.key, fingerprint: `repair-${serial}`,
    path: "src/file.ts", line: 1, title: "Repair the edge", body: "The edge drops durable state.",
    severity: "major", round: 1, status: "open", replies: 0, answeredCommentId: null,
    createdAt: now, updatedAt: now,
  });
  signal(seeded, seeded.head);
  await waitFor(() => seeded.store.getRun(seeded.ids.run)?.status === "waiting_for_new_head",
    "the findings did not leave the run waiting on a repair push");
}

/** Put the run exactly where the earlier build stranded it. */
function strandAsClosed(seeded: Seeded): void {
  const run = seeded.store.getRun(seeded.ids.run)!;
  const gate = run.gateState as unknown as WorkflowInspectorGateState;
  const blocked = seeded.store.updateInspectorGate({
    runId: run.id,
    expectedState: gate,
    state: { ...gate, waitReason: "pr_closed" },
    status: "blocked",
    phase: "inspector_pr_closed",
    now: Date.now(),
  });
  assert.ok(blocked, "the fixture could not strand the run");
}

const phaseOf = (seeded: Seeded) => {
  const run = seeded.store.getRun(seeded.ids.run)!;
  return `${run.status}/${run.currentPhase}`;
};
const eventCount = (seeded: Seeded, kind: string) =>
  seeded.store.listEvents(seeded.ids.run).filter((event) => event.kind === kind).length;
const inspectorOnlyRounds = (seeded: Seeded) =>
  seeded.store.listSubmissions(seeded.ids.run).filter((item) => item.mode === "inspector_only").length;

test("a signal that observed nothing never blocks an open pull request as closed", async () => {
  const seeded = await seed({ policy: "inspector_only", deliveryMode: "live" });
  try {
    await awaitRepairPush(seeded);
    // What the poller sends after a GitHub read that failed or was rate limited...
    seeded.registry.inspectionUpdated(seeded.key, null, null);
    await settleGate(seeded);
    assert.equal(phaseOf(seeded), "waiting_for_new_head/inspector_findings", "a failed read");
    // ...and what an Inspector settings save sends to every adopted pull request.
    seeded.registry.inspectorConfigChanged();
    await settleGate(seeded);
    assert.equal(phaseOf(seeded), "waiting_for_new_head/inspector_findings", "a settings save");
    assert.equal(eventCount(seeded, "inspector_pr_closed"), 0);

    // The repair push the run was waiting for is still seen and still costs no full round.
    signal(seeded, "repair-head");
    await waitFor(() => inspectorOnlyRounds(seeded) === 1, "the repair push was not seen");

    // A read that DID say closed still blocks.
    seeded.registry.inspectionUpdated(seeded.key, "repair-head", "CLOSED");
    await waitFor(() => phaseOf(seeded) === "blocked/inspector_pr_closed",
      "a pull request GitHub reported closed did not block the gate");
  } finally {
    await seeded.manager.stop();
  }
});

test("after a restart, a repair wait stays a repair wait until GitHub is actually read", async () => {
  const seeded = await seed({ policy: "inspector_only", deliveryMode: "live" });
  try {
    await awaitRepairPush(seeded);
    // Restart recovery clears the observation and deliberately keeps the repair wait.
    (seeded.manager as unknown as { resetRecoveredGateObservations(): void })
      .resetRecoveredGateObservations();
    assert.equal(phaseOf(seeded), "waiting_for_new_head/inspector_findings");
    // A failed first read used to demote the run to `waiting_for_inspector`, from which the
    // session's repair push was refused as a head mismatch instead of reviewed.
    seeded.registry.inspectionUpdated(seeded.key, null, null);
    await settleGate(seeded);
    assert.equal(phaseOf(seeded), "waiting_for_new_head/inspector_findings");

    signal(seeded, "repair-head");
    await waitFor(() => inspectorOnlyRounds(seeded) === 1, "the repair push was not seen after restart");
    assert.equal(seeded.store.getRun(seeded.ids.run)?.status, "waiting_for_inspector");
  } finally {
    await seeded.manager.stop();
  }
});

/** Script what GitHub answers for the pull request read. `null` scripts an outage. */
function scriptGitHub(state: "OPEN" | "CLOSED" | "MERGED" | null, headRefOid = "head"): void {
  if (state === null) {
    rmSync(ghSnapshot, { force: true });
    return;
  }
  writeFileSync(ghSnapshot, JSON.stringify({ data: { repository: { pullRequest: {
    state, headRefOid, headRefName: "feature", isDraft: false, title: "Gate fixture",
    reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
    reviews: { nodes: [], pageInfo: { hasPreviousPage: false, startCursor: null } },
  } } } }));
}

/** The ledger row as the sweep leaves it once it read the pull request closed. */
function retireAsClosed(seeded: Seeded): void {
  updateInspectorPr(seeded.key, {
    state: "closed", observedState: "CLOSED", observedHeadSha: seeded.head, observedAt: Date.now(),
  }, Date.now());
}

function recheck(seeded: Seeded, requestId: string): void {
  const result = seeded.manager.recheckInspector(seeded.ids.run, `${requestId}-${serial}`);
  assert.equal(result.ok, true, result.ok ? "" : result.message);
}

// The sweep stops reading a row the moment it reads it closed, so a recheck that consulted only
// the stored row could never lift a block whose row was retired - whatever GitHub says now.
test("a recheck reads GitHub again, so a block on a retired row lifts once the pull request is open", async () => {
  scriptGitHub(null);
  const seeded = await seed({ policy: "inspector_only", deliveryMode: "live" });
  try {
    await awaitRepairPush(seeded);
    strandAsClosed(seeded);
    retireAsClosed(seeded);
    const recovery = seeded.store.runSummary(seeded.ids.run)?.recovery;
    assert.ok(recovery?.operations.includes("recheck-inspector"), "recheck was not offered");
    assert.equal(recovery?.primary, "recheck-inspector");

    // GitHub unreachable: the block stays, and the run says why.
    recheck(seeded, "outage");
    await settleGate(seeded);
    assert.equal(phaseOf(seeded), "blocked/inspector_pr_closed");
    assert.equal(eventCount(seeded, "inspector_pr_reobserve_failed"), 1);

    // GitHub says closed: still blocked, the row stays retired, and a stray signal claiming
    // OPEN cannot reopen a row GitHub's own answer retired.
    scriptGitHub("CLOSED", seeded.head);
    recheck(seeded, "closed");
    await settleGate(seeded);
    signal(seeded, seeded.head);
    seeded.registry.inspectionUpdated(seeded.key, null, null);
    await settleGate(seeded);
    assert.equal(phaseOf(seeded), "blocked/inspector_pr_closed");
    assert.equal(getInspectorPr(seeded.key)?.state, "closed");
    assert.equal(eventCount(seeded, "inspector_pr_seen_open"), 0);

    // GitHub says open: the row is the sweep's again, and the repair wait the block
    // interrupted comes back without a restart.
    scriptGitHub("OPEN", seeded.head);
    recheck(seeded, "open");
    await waitFor(() => phaseOf(seeded) === "waiting_for_new_head/inspector_findings",
      "an open pull request on GitHub did not lift the closed block");
    const row = getInspectorPr(seeded.key);
    assert.equal(row?.state, "open");
    assert.equal(row?.observedState, "OPEN");
    assert.equal(
      (seeded.store.getRun(seeded.ids.run)!.gateState as unknown as WorkflowInspectorGateState).waitReason,
      "findings",
    );
    assert.equal(eventCount(seeded, "inspector_pr_seen_open"), 1);

    // And the repair push it was waiting for goes through as an Inspector-only round.
    signal(seeded, "repair-head");
    await waitFor(() => inspectorOnlyRounds(seeded) === 1, "the repair push was not seen after recovery");
  } finally {
    scriptGitHub(null);
    await seeded.manager.stop();
  }
});

test("with GitHub unreachable, a recheck still lifts a block whose row last read the pull request open", async () => {
  scriptGitHub(null);
  const seeded = await seed({ policy: "inspector_only", deliveryMode: "live" });
  try {
    await awaitRepairPush(seeded);
    strandAsClosed(seeded);
    // Nothing that observed nothing lifts it, and a recheck with no recorded read changes nothing.
    seeded.registry.inspectionUpdated(seeded.key, null, null);
    recheck(seeded, "unread");
    await settleGate(seeded);
    assert.equal(phaseOf(seeded), "blocked/inspector_pr_closed");

    // The sweep's last read said OPEN - the false close this issue reported. The stored read
    // is enough, even while GitHub cannot be reached for a fresh one.
    updateInspectorPr(seeded.key, {
      observedState: "OPEN", observedHeadSha: seeded.head, observedAt: Date.now(),
    }, Date.now());
    recheck(seeded, "ledger-open");
    await waitFor(() => phaseOf(seeded) === "waiting_for_new_head/inspector_findings",
      "an open ledger read did not lift the closed block");
    await settleGate(seeded);
    assert.equal(eventCount(seeded, "inspector_pr_reobserve_failed"), 2);
  } finally {
    await seeded.manager.stop();
  }
});

test("the poller's next open read lifts a stranded block without anyone pressing recheck", async () => {
  const seeded = await seed({ policy: "inspector_only", deliveryMode: "live" });
  try {
    await awaitRepairPush(seeded);
    strandAsClosed(seeded);
    updateInspectorPr(seeded.key, {
      observedState: "OPEN", observedHeadSha: seeded.head, observedAt: Date.now(),
    }, Date.now());
    signal(seeded, seeded.head);
    await waitFor(() => phaseOf(seeded) === "waiting_for_new_head/inspector_findings",
      "the poller's open read did not lift the closed block");
  } finally {
    await seeded.manager.stop();
  }
});

// The reported correlation: the bound sessions had been frozen by the operator about thirty
// minutes before their runs flipped, and Mission Control had restarted around the pause. A
// freeze and a restart each wake the gate without reading GitHub, and so does a poll that fails
// afterwards - none of them is evidence the pull request closed.
test("a frozen bound session, across a Mission Control restart, never gets its open pull request reported closed", async () => {
  const seeded = await seed({ policy: "inspector_only", deliveryMode: "live" });
  const frozen = (at: number) => ({
    reason: "operator" as const, phase: "frozen" as const, mode: "now" as const,
    since: at, frozenAt: at, interrupted: null, stopped: true,
  });
  try {
    await awaitRepairPush(seeded);
    // The operator freezes the bound session: its upsert re-evaluates the gate.
    assert.equal(seeded.registry.setSessionPause(seeded.ids.session, frozen(Date.now())), true);
    await settleGate(seeded);
    assert.equal(phaseOf(seeded), "waiting_for_new_head/inspector_findings", "the freeze");

    // Mission Control restarts with the session still frozen: a fresh manager over the same
    // store runs restart recovery, and the pause is adopted again.
    await seeded.manager.stop();
    seeded.manager = new WorkflowManager(seeded.registry, seeded.store, {
      resolveCommit: async (_root, head) => head,
      reobservePullRequest: (prKey) => reobserveInspectorPr(seeded.registry, prKey),
      inject: async () => ({ ok: true, pasted: true, submitVerified: true }),
      recordInjection: () => {},
      requireSkill: (session, id) => ({ ok: true, command: skillCommand(session.agent, id)! }),
      readEvidenceProbe: async () => ({
        headSha: seeded.head, workingTreeStatus: [], diffFingerprint: `diff-${seeded.head}`,
      }),
      resumptionSettleMs: 0,
    });
    seeded.manager.start();
    assert.equal(seeded.registry.setSessionPause(seeded.ids.session, frozen(Date.now())), true);
    await settleGate(seeded);
    assert.equal(phaseOf(seeded), "waiting_for_new_head/inspector_findings", "the restart");

    // The first poll after the restart reads the open pull request at its unchanged head...
    signal(seeded, seeded.head);
    await settleGate(seeded);
    assert.equal(phaseOf(seeded), "waiting_for_new_head/inspector_findings", "an open read");
    // ...and a later poll fails, while the session is still frozen.
    seeded.registry.inspectionUpdated(seeded.key, null, null);
    seeded.registry.inspectorConfigChanged();
    await settleGate(seeded);
    assert.equal(phaseOf(seeded), "waiting_for_new_head/inspector_findings", "a failed read");
    assert.equal(eventCount(seeded, "inspector_pr_closed"), 0);

    // Unfrozen, the session's repair push is still seen as an Inspector-only round.
    assert.equal(seeded.registry.setSessionPause(seeded.ids.session, null), true);
    signal(seeded, "repair-head");
    await waitFor(() => inspectorOnlyRounds(seeded) === 1, "the repair push was not seen after the freeze");
  } finally {
    await seeded.manager.stop();
  }
});

// The closed predicate takes both of GitHub's finished states as evidence. A merged pull request
// is as gone as a closed one, and a predicate that knew only CLOSED would leave a merged run
// waiting for a push that can never land.
test("a read that says CLOSED or MERGED still blocks the gate as closed", async () => {
  for (const state of ["CLOSED", "MERGED"] as const) {
    const seeded = await seed({ policy: "inspector_only", deliveryMode: "live" });
    try {
      await awaitRepairPush(seeded);
      seeded.registry.inspectionUpdated(seeded.key, seeded.head, state);
      await waitFor(() => phaseOf(seeded) === "blocked/inspector_pr_closed",
        `a ${state} read did not block the gate`);
      assert.equal(eventCount(seeded, "inspector_pr_closed"), 1, state);
      assert.equal(
        (seeded.store.getRun(seeded.ids.run)!.gateState as unknown as WorkflowInspectorGateState).waitReason,
        "pr_closed",
        state,
      );
    } finally {
      await seeded.manager.stop();
    }
  }
});

// A re-read that throws rather than answering - a broken `gh` spawn, a ledger write that fails -
// takes its own path through the recheck. It must end where a failed answer ends: blocked, with
// the reason on the run, and never as an unhandled rejection that leaves no trace.
test("a GitHub re-read that rejects leaves the closed block in place and records why", async () => {
  const seeded = await seed({
    policy: "inspector_only",
    deliveryMode: "live",
    reobservePullRequest: async () => {
      throw new Error("gh could not be started");
    },
  });
  try {
    await awaitRepairPush(seeded);
    strandAsClosed(seeded);
    retireAsClosed(seeded);
    recheck(seeded, "rejected");
    await settleGate(seeded);
    assert.equal(phaseOf(seeded), "blocked/inspector_pr_closed");
    const failures = seeded.store.listEvents(seeded.ids.run)
      .filter((event) => event.kind === "inspector_pr_reobserve_failed");
    assert.equal(failures.length, 1);
    assert.deepEqual(failures[0]!.payload, { prKey: seeded.key, error: "gh could not be started" });
    assert.equal(eventCount(seeded, "inspector_pr_seen_open"), 0);
  } finally {
    await seeded.manager.stop();
  }
});

// Recovery rebuilds the wait the block overwrote, and the repair-push wait is only one of them.
// A run blocked while its head was still waiting for Inspector's review has no failed head, and
// must come back to that review - not to waiting for a push nobody owes it.
test("a recovered closed block that was not waiting on a repair push resumes the Inspector wait", async () => {
  scriptGitHub(null);
  const seeded = await seed({ policy: "inspector_only", deliveryMode: "live" });
  try {
    // Pinned and under review: no findings yet, so no failed head.
    signal(seeded, seeded.head);
    await waitFor(() => phaseOf(seeded) === "waiting_for_inspector/inspector_review",
      "the head was not pinned for review");
    const pinned = seeded.store.getRun(seeded.ids.run)!.gateState as unknown as WorkflowInspectorGateState;
    assert.equal(pinned.failedHeadSha, null);
    assert.equal(pinned.targetHeadSha, seeded.head);

    strandAsClosed(seeded);
    retireAsClosed(seeded);
    scriptGitHub("OPEN", seeded.head);
    recheck(seeded, "review-wait");
    await waitFor(() => phaseOf(seeded) === "waiting_for_inspector/inspector_review",
      "the review wait was not restored");
    await settleGate(seeded);

    const reopened = seeded.store.listEvents(seeded.ids.run)
      .filter((event) => event.kind === "inspector_pr_seen_open");
    assert.equal(reopened.length, 1);
    assert.deepEqual(reopened[0]!.payload, { prKey: seeded.key, status: "waiting_for_inspector" });
    const gate = seeded.store.getRun(seeded.ids.run)!.gateState as unknown as WorkflowInspectorGateState;
    assert.equal(gate.failedHeadSha, null);
    assert.equal(gate.targetHeadSha, seeded.head);
    assert.equal(gate.waitReason, "review_pending");
    assert.equal(phaseOf(seeded), "waiting_for_inspector/inspector_review");
  } finally {
    scriptGitHub(null);
    await seeded.manager.stop();
  }
});

async function blockUnsentFeedback(seeded: Seeded) {
  await settleGate(seeded);
  const session = seeded.registry.getSession(seeded.ids.session)!;
  session.state = "exited";
  const now = Date.now();
  updateInspectorPr(seeded.key, { headSha: seeded.head, reviewPosture: "live",
    reviewComplete: true, round: 1 }, now);
  signal(seeded, seeded.head);
  // Seed the finding before the scheduled evaluation executes.
  upsertInspectorComment({
    id: `unavailable-${serial}`, prKey: seeded.key, fingerprint: `unavailable-${serial}`,
    path: "src/file.ts", line: 1, title: "Repair", body: "Repair the edge",
    severity: "major", round: 1, status: "open", replies: 0, answeredCommentId: null,
    createdAt: now, updatedAt: now,
  });
  await settleGate(seeded);
  assert.equal(phaseOf(seeded), "blocked/delivery_blocked");
  const packet = seeded.store.listDeliveries(seeded.ids.run)[0]!;
  assert.equal(packet.state, "prepared");
  assert.equal(packet.deliveredAt, null);
  assert.deepEqual(seeded.injected, []);
  return { packet, session };
}

for (const policy of ["inspector_only", "restart_workflow"] as const) {
  for (const current of ["unchanged", "clean", "pending"] as const) {
    test(`session return refreshes unsent Inspector feedback: ${policy}, ${current}`, async () => {
      let captureHead = "before-session-return";
      let reads = 0;
      const seeded = await seed({ policy, deliveryMode: "live", head: captureHead,
        captureHead: () => captureHead,
        reobservePullRequest: async (prKey) => {
          reads += 1;
          return reobserveInspectorPr(seeded.registry, prKey);
        },
      });
      try {
        const { packet, session } = await blockUnsentFeedback(seeded);
        captureHead = current === "unchanged" ? seeded.head : "after-session-return";
        if (current === "clean") {
          db.prepare("UPDATE inspector_comments SET status = 'resolved' WHERE pr_key = ?").run(seeded.key);
        }
        updateInspectorPr(seeded.key, {
          observedHeadSha: seeded.head, observedState: "OPEN", observedAt: seeded.now - 1,
          headSha: current === "clean" ? captureHead : seeded.head,
          cleanReviewHeadSha: current === "clean" ? captureHead : null,
        }, Date.now());
        scriptGitHub("OPEN", captureHead);
        session.state = "idle";
        seeded.registry.setSessionPause(session.id, null);
        await settleGate(seeded);
        assert.equal(reads, 1, "session return must request a fresh observation without a manual recheck");
        assert.equal(eventCount(seeded, "inspector_recheck_requested"), 0);
        assert.ok(getInspectorPr(seeded.key)!.observedAt! >= seeded.now);
        const recovered = seeded.store.getDelivery(packet.id)!;
        if (current === "unchanged") {
          assert.equal(recovered.state, "delivered");
          assert.deepEqual(seeded.injected, [packet.payload]);
        } else {
          assert.equal(recovered.state, "cancelled");
          assert.equal(recovered.deliveredAt, null);
          assert.deepEqual(seeded.injected, []);
          const latest = seeded.store.latestSubmission(seeded.ids.run)!;
          if (policy === "restart_workflow") {
            assert.equal(latest.mode, "full_workflow");
            assert.equal((latest.context as unknown as WorkflowContextSnapshot).evidence.headSha, captureHead);
            assert.equal(inspectorOnlyRounds(seeded), 0);
            assert.notEqual(seeded.store.getRun(seeded.ids.run)!.status, "completed");
          } else {
            assert.equal(latest.prHeadSha, captureHead);
            assert.equal(phaseOf(seeded), current === "clean"
              ? "completed/complete" : "waiting_for_inspector/inspector_review");
          }
        }
      } finally {
        scriptGitHub(null);
        await seeded.manager.stop();
      }
    });
  }
}

for (const answer of [null, "CLOSED", "MERGED"] as const) {
  test(`session return refreshes unsent Inspector feedback safely on ${answer ?? "outage"}`, async () => {
    const seeded = await seed({ policy: "inspector_only", deliveryMode: "live" });
    try {
      const { packet, session } = await blockUnsentFeedback(seeded);
      updateInspectorPr(seeded.key, {
        observedHeadSha: seeded.head, observedState: "OPEN", observedAt: seeded.now - 1,
      }, Date.now());
      scriptGitHub(answer, seeded.head);
      session.state = "idle";
      seeded.registry.setSessionPause(session.id, null);
      await settleGate(seeded);
      assert.equal(phaseOf(seeded), "blocked/delivery_blocked");
      assert.equal(seeded.store.getDelivery(packet.id)!.state, "prepared");
      assert.equal(seeded.store.getDelivery(packet.id)!.deliveredAt, null);
      assert.deepEqual(seeded.injected, []);
      if (answer === null) assert.equal(eventCount(seeded, "inspector_pr_reobserve_failed"), 1);
      else assert.equal(getInspectorPr(seeded.key)!.observedState, answer);
    } finally {
      scriptGitHub(null);
      await seeded.manager.stop();
    }
  });
}

test("session return refreshes unsent Inspector feedback once and holds queued signals while reading", async () => {
  let release!: () => void;
  const reading = new Promise<void>((resolve) => { release = resolve; });
  let reads = 0;
  const seeded = await seed({ policy: "inspector_only", deliveryMode: "live",
    reobservePullRequest: async (prKey) => {
      reads += 1;
      if (reads === 1) await reading;
      return reobserveInspectorPr(seeded.registry, prKey);
    },
  });
  try {
    const { packet, session } = await blockUnsentFeedback(seeded);
    db.prepare("UPDATE inspector_comments SET status = 'resolved' WHERE pr_key = ?").run(seeded.key);
    updateInspectorPr(seeded.key, {
      observedHeadSha: seeded.head, observedState: "OPEN", observedAt: Date.now(),
      headSha: "fresh-return-head", cleanReviewHeadSha: "fresh-return-head",
    }, Date.now());
    scriptGitHub("OPEN", "fresh-return-head");
    // Even a previously fresh queued signal must not send A while the return reads B.
    signal(seeded, seeded.head);
    session.state = "idle";
    for (let i = 0; i < 3; i += 1) seeded.registry.setSessionPause(session.id, null);
    await waitFor(() => reads === 1, "session return did not begin its observation");
    assert.equal(seeded.store.getDelivery(packet.id)!.state, "prepared");
    assert.deepEqual(seeded.injected, []);
    seeded.registry.setSessionPause(session.id, {
      phase: "frozen", reason: "operator", since: Date.now(), frozenAt: Date.now(),
      interrupted: null, stopped: true,
    });
    release();
    await settleGate(seeded);
    assert.equal(reads, 1, "concurrent session updates must share one refresh");
    assert.equal(phaseOf(seeded), "blocked/delivery_blocked", "a pause during the read must be respected");
    assert.deepEqual(seeded.injected, []);
    seeded.registry.setSessionPause(session.id, null);
    await settleGate(seeded);
    assert.equal(reads, 2);
    assert.equal(phaseOf(seeded), "completed/complete");
    assert.equal(seeded.store.getDelivery(packet.id)!.state, "cancelled");
    assert.equal(seeded.store.getDelivery(packet.id)!.deliveredAt, null);
  } finally {
    release();
    scriptGitHub(null);
    await seeded.manager.stop();
  }
});

for (const ending of ["cancelled", "completed", "failed", "reset"] as const) {
  test(`failed feedback refresh releases its hold when the run is ${ending}`, async () => {
    const seeded = await seed({ policy: "inspector_only", deliveryMode: "live",
      reobservePullRequest: async () => ({ ok: false, error: "scripted failure" }),
    });
    try {
      const { session } = await blockUnsentFeedback(seeded);
      session.state = "idle";
      recheck(seeded, "failed-refresh-cleanup");
      await settleGate(seeded);
      const manager = seeded.manager as unknown as {
        inspectorFeedbackRefreshes: Map<string, { pending: boolean }>;
        publishRun(id: string): void;
      };
      assert.equal(manager.inspectorFeedbackRefreshes.get(seeded.ids.run)?.pending, false);
      manager.publishRun(seeded.ids.run);
      assert.equal(manager.inspectorFeedbackRefreshes.has(seeded.ids.run), true,
        "publishing a blocked run must retain the failed-read hold");
      if (ending === "cancelled") {
        assert.equal(seeded.manager.cancel(seeded.ids.run, "cancel-held-refresh").ok, true);
      } else if (ending === "reset") {
        const noteKey = seeded.store.getBinding(seeded.ids.binding)!.noteKey;
        seeded.registry.clearWorkflowState(noteKey);
        assert.equal(seeded.store.getRun(seeded.ids.run), null);
      } else {
        seeded.store.setRunState(seeded.ids.run, ending,
          ending === "completed" ? "complete" : "missing_workflow_version", null);
        manager.publishRun(seeded.ids.run);
      }
      assert.equal(manager.inspectorFeedbackRefreshes.has(seeded.ids.run), false);
    } finally {
      await seeded.manager.stop();
    }
  });
}

for (const failedFirst of [false, true]) {
  for (const newerHead of [false, true]) {
    test(`successful feedback refresh accepts the same millisecond: failedFirst=${failedFirst}, newer=${newerHead}`, async (t) => {
      let reads = 0;
      let observedAt = 0;
      const seeded = await seed({ policy: "inspector_only", deliveryMode: "live",
        reobservePullRequest: async (prKey) => {
          reads += 1;
          if (failedFirst && reads === 1) return { ok: false, error: "scripted failure" };
          return reobserveInspectorPr(seeded.registry, prKey, observedAt);
        },
      });
      try {
        const { packet, session } = await blockUnsentFeedback(seeded);
        observedAt = Date.now();
        // The request boundary, cached observation and successful read share one tick.
        t.mock.method(Date, "now", () => observedAt);
        const head = newerHead ? "same-tick-new-head" : seeded.head;
        if (newerHead) {
          db.prepare("UPDATE inspector_comments SET status = 'resolved' WHERE pr_key = ?").run(seeded.key);
        }
        updateInspectorPr(seeded.key, {
          observedHeadSha: seeded.head, observedState: "OPEN", observedAt,
          headSha: head, cleanReviewHeadSha: newerHead ? head : null,
        }, observedAt);
        scriptGitHub("OPEN", head);
        session.state = "idle";
        if (failedFirst) {
          recheck(seeded, "same-tick-failure");
          await settleGate(seeded);
          signal(seeded, seeded.head, observedAt);
          await settleGate(seeded);
          assert.equal(phaseOf(seeded), "blocked/delivery_blocked");
          assert.equal(seeded.store.getDelivery(packet.id)!.state, "prepared");
          assert.deepEqual(seeded.injected, []);
        }
        recheck(seeded, "same-tick-success");
        await settleGate(seeded);
        assert.equal(reads, failedFirst ? 2 : 1);
        assert.equal(getInspectorPr(seeded.key)!.observedAt, observedAt);
        if (newerHead) {
          assert.equal(phaseOf(seeded), "completed/complete");
          assert.equal(seeded.store.getDelivery(packet.id)!.state, "cancelled");
          assert.equal(seeded.store.getDelivery(packet.id)!.deliveredAt, null);
          assert.deepEqual(seeded.injected, []);
        } else {
          assert.equal(seeded.store.getDelivery(packet.id)!.state, "delivered");
          assert.deepEqual(seeded.injected, [packet.payload]);
        }
      } finally {
        t.mock.restoreAll();
        scriptGitHub(null);
        await seeded.manager.stop();
      }
    });
  }
}

for (const trigger of ["session", "recheck"] as const) {
  for (const recovery of ["retry-same-head", "poll-new-head"] as const) {
    test(`failed feedback refresh holds queued signals: ${trigger}, ${recovery}`, async () => {
      let release!: () => void;
      const reading = new Promise<void>((resolve) => { release = resolve; });
      let reads = 0;
      const seeded = await seed({ policy: "inspector_only", deliveryMode: "live",
        reobservePullRequest: async (prKey) => {
          reads += 1;
          if (reads === 1) {
            await reading;
            return { ok: false, error: "scripted read failure" };
          }
          return reobserveInspectorPr(seeded.registry, prKey);
        },
      });
      try {
        const { packet, session } = await blockUnsentFeedback(seeded);
        const oldAt = Date.now();
        updateInspectorPr(seeded.key, {
          observedHeadSha: seeded.head, observedState: "OPEN", observedAt: oldAt,
        }, oldAt);
        session.state = "idle";
        if (trigger === "session") seeded.registry.setSessionPause(session.id, null);
        else recheck(seeded, "hold-on-failure");
        await waitFor(() => reads === 1, "fresh read did not start");
        signal(seeded, seeded.head, oldAt);
        release();
        await settleGate(seeded);
        assert.equal(phaseOf(seeded), "blocked/delivery_blocked");
        assert.equal(seeded.store.getDelivery(packet.id)!.state, "prepared");
        assert.equal(seeded.store.getDelivery(packet.id)!.deliveredAt, null);
        assert.deepEqual(seeded.injected, []);
        // Clearing the scheduling marker must not authorize another cached observation.
        signal(seeded, seeded.head, oldAt);
        await settleGate(seeded);
        assert.equal(phaseOf(seeded), "blocked/delivery_blocked");
        if (recovery === "retry-same-head") {
          scriptGitHub("OPEN", seeded.head);
          recheck(seeded, "retry-success");
          await settleGate(seeded);
          assert.equal(reads, 2, "failure must still allow another refresh");
          assert.equal(seeded.store.getDelivery(packet.id)!.state, "delivered");
          assert.deepEqual(seeded.injected, [packet.payload]);
        } else {
          db.prepare("UPDATE inspector_comments SET status = 'resolved' WHERE pr_key = ?").run(seeded.key);
          const freshAt = Date.now() + 1;
          updateInspectorPr(seeded.key, {
            observedHeadSha: "polled-new-head", observedState: "OPEN", observedAt: freshAt,
            headSha: "polled-new-head", cleanReviewHeadSha: "polled-new-head",
          }, freshAt);
          signal(seeded, "polled-new-head", freshAt);
          await settleGate(seeded);
          assert.equal(phaseOf(seeded), "completed/complete");
          assert.equal(seeded.store.getDelivery(packet.id)!.state, "cancelled");
          assert.equal(seeded.store.getDelivery(packet.id)!.deliveredAt, null);
          assert.deepEqual(seeded.injected, []);
        }
      } finally {
        release();
        scriptGitHub(null);
        await seeded.manager.stop();
      }
    });
  }
}

for (const policy of ["inspector_only", "restart_workflow"] as const) {
  for (const answer of ["unchanged", "clean", "pending", "outage"] as const) {
    test(`explicit feedback recheck waits for fresh facts: ${policy}, ${answer}`, async () => {
      let release!: () => void;
      const reading = new Promise<void>((resolve) => { release = resolve; });
      let reads = 0;
      let captureHead = "explicit-recheck-old-head";
      const seeded = await seed({ policy, deliveryMode: "live", head: captureHead,
        captureHead: () => captureHead,
        reobservePullRequest: async (prKey) => {
          reads += 1;
          await reading;
          return reobserveInspectorPr(seeded.registry, prKey);
        },
      });
      try {
        const { packet, session } = await blockUnsentFeedback(seeded);
        captureHead = answer === "unchanged" ? seeded.head : "explicit-recheck-new-head";
        if (answer === "clean") {
          db.prepare("UPDATE inspector_comments SET status = 'resolved' WHERE pr_key = ?").run(seeded.key);
        }
        updateInspectorPr(seeded.key, {
          observedHeadSha: seeded.head, observedState: "OPEN", observedAt: Date.now(),
          headSha: answer === "clean" ? captureHead : seeded.head,
          cleanReviewHeadSha: answer === "clean" ? captureHead : null,
        }, Date.now());
        scriptGitHub(answer === "outage" ? null : "OPEN", captureHead);
        // Reachable already, with no session-upsert wakeup: Check again owns this recovery.
        session.state = "idle";
        recheck(seeded, "fresh-feedback");
        await waitFor(() => reads === 1, "explicit recheck did not begin its observation");
        assert.equal(seeded.store.getDelivery(packet.id)!.state, "prepared");
        assert.deepEqual(seeded.injected, []);
        // Repeated clicks share the read and never release the cached old-head bytes.
        recheck(seeded, "fresh-feedback-again");
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(seeded.store.getDelivery(packet.id)!.state, "prepared");
        assert.deepEqual(seeded.injected, []);
        release();
        await settleGate(seeded);
        assert.equal(reads, 1);
        const recovered = seeded.store.getDelivery(packet.id)!;
        if (answer === "unchanged") {
          assert.equal(recovered.state, "delivered");
          assert.deepEqual(seeded.injected, [packet.payload]);
        } else if (answer === "outage") {
          assert.equal(recovered.state, "prepared");
          assert.equal(recovered.deliveredAt, null);
          assert.equal(phaseOf(seeded), "blocked/delivery_blocked");
          assert.deepEqual(seeded.injected, []);
        } else {
          assert.equal(recovered.state, "cancelled");
          assert.equal(recovered.deliveredAt, null);
          assert.deepEqual(seeded.injected, []);
          const latest = seeded.store.latestSubmission(seeded.ids.run)!;
          if (policy === "restart_workflow") {
            assert.equal(latest.mode, "full_workflow");
            assert.equal((latest.context as unknown as WorkflowContextSnapshot).evidence.headSha, captureHead);
            assert.equal(inspectorOnlyRounds(seeded), 0);
            assert.notEqual(seeded.store.getRun(seeded.ids.run)!.status, "completed");
          } else {
            assert.equal(latest.prHeadSha, captureHead);
            assert.equal(phaseOf(seeded), answer === "clean"
              ? "completed/complete" : "waiting_for_inspector/inspector_review");
          }
        }
      } finally {
        release();
        scriptGitHub(null);
        await seeded.manager.stop();
      }
    });
  }
}

for (const policy of ["inspector_only", "restart_workflow"] as const) {
  for (const newerHead of [false, true]) {
    test(`unsent Inspector feedback recovers after session return: ${policy}, newer=${newerHead}`, async () => {
      let captureHead = "initial-head";
      const seeded = await seed({ policy, deliveryMode: "live", head: captureHead, captureHead: () => captureHead });
      try {
        const { packet, session } = await blockUnsentFeedback(seeded);
        const head = newerHead ? "repaired-head" : seeded.head;
        if (newerHead) {
          db.prepare("UPDATE inspector_comments SET status = 'resolved' WHERE pr_key = ?").run(seeded.key);
          updateInspectorPr(seeded.key, { headSha: head, cleanReviewHeadSha: head,
            reviewComplete: true, observedHeadSha: head, observedState: "OPEN",
            observedAt: Date.now() }, Date.now());
        }
        session.state = "idle";
        captureHead = head;
        scriptGitHub("OPEN", head);
        if (newerHead) seeded.registry.setSessionPause(session.id, null);
        else {
          updateInspectorPr(seeded.key, { observedHeadSha: head, observedState: "OPEN", observedAt: Date.now() }, Date.now());
          assert.ok(seeded.store.runSummary(seeded.ids.run)?.recovery?.operations.includes("recheck-inspector"));
          assert.equal(seeded.manager.recheckInspector(seeded.ids.run, "recover-unsent").ok, true);
        }
        await settleGate(seeded);
        const recovered = seeded.store.getDelivery(packet.id)!;
        if (!newerHead) {
          assert.equal(recovered.state, "delivered");
          assert.deepEqual(seeded.injected, [packet.payload]);
        } else {
          assert.equal(recovered.state, "cancelled");
          assert.equal(recovered.deliveredAt, null);
          assert.deepEqual(seeded.injected, []);
          if (policy === "inspector_only") {
            assert.equal(phaseOf(seeded), "completed/complete");
            assert.equal(inspectorOnlyRounds(seeded), 1);
          } else {
            const submissions = seeded.store.listSubmissions(seeded.ids.run);
            assert.equal(submissions.length, 2);
            assert.equal(submissions[1]!.mode, "full_workflow");
            assert.equal((submissions[1]!.context as unknown as WorkflowContextSnapshot).evidence.headSha, head);
            assert.equal(inspectorOnlyRounds(seeded), 0);
            assert.notEqual(seeded.store.getRun(seeded.ids.run)?.status, "completed");
          }
        }
        signal(seeded, head);
        await settleGate(seeded);
        assert.equal(seeded.injected.length, newerHead ? 0 : 1);
      } finally {
        scriptGitHub(null);
        await seeded.manager.stop();
      }
    });
  }
}

for (const policy of ["restart_workflow", "inspector_only"] as const) {
  for (const review of ["pending", "open-findings", "publication-pending"] as const) {
    test(`unsent Inspector recovery does not approve a newer non-clean head: ${policy}, ${review}`, async () => {
      let captureHead = "non-clean-initial-head";
      const seeded = await seed({ policy, deliveryMode: "live", head: captureHead, captureHead: () => captureHead });
      try {
        const { packet, session } = await blockUnsentFeedback(seeded);
        captureHead = "non-clean-new-head";
        if (review === "publication-pending") {
          db.prepare("UPDATE inspector_comments SET status = 'resolved' WHERE pr_key = ?").run(seeded.key);
        }
        updateInspectorPr(seeded.key, {
          observedHeadSha: captureHead, observedState: "OPEN", observedAt: Date.now(),
          headSha: review === "pending" ? seeded.head : captureHead,
          lastAttemptSha: captureHead, reviewComplete: review !== "pending",
          cleanReviewHeadSha: null, round: review === "pending" ? 1 : 2,
        }, Date.now());
        scriptGitHub("OPEN", captureHead);
        session.state = "idle";
        seeded.registry.setSessionPause(session.id, null);
        await settleGate(seeded);

        const recovered = seeded.store.getDelivery(packet.id)!;
        assert.equal(recovered.state, "cancelled");
        assert.equal(recovered.deliveredAt, null);
        assert.equal(seeded.injected.includes(packet.payload), false, "obsolete findings must never be sent");
        assert.notEqual(seeded.store.getRun(seeded.ids.run)?.status, "completed");
        assert.equal(eventCount(seeded, "inspector_gate_clean"), 0);
        const latest = seeded.store.latestSubmission(seeded.ids.run)!;
        if (policy === "restart_workflow") {
          assert.equal(latest.mode, "full_workflow");
          assert.equal((latest.context as unknown as WorkflowContextSnapshot).evidence.headSha, captureHead);
          assert.equal(inspectorOnlyRounds(seeded), 0, "recovery must not bypass the published full review");
          assert.equal(eventCount(seeded, "inspector_persona_bypass_used"), 0);
          assert.deepEqual(seeded.injected, []);
        } else {
          // This policy expressly permits skipping Personas, never skipping Inspector's
          // current-head review. Its audited submission is a review target, not approval.
          assert.equal(latest.mode, "inspector_only");
          assert.equal(latest.prHeadSha, captureHead);
          assert.equal(inspectorOnlyRounds(seeded), 1);
          const gate = seeded.store.getRun(seeded.ids.run)!.gateState as unknown as WorkflowInspectorGateState;
          assert.equal(gate.targetHeadSha, captureHead);
          assert.equal(gate.waitReason, review === "pending" ? "review_pending"
            : review === "open-findings" ? "findings" : "clean_review_pending");
          if (review === "open-findings") {
            const replacement = seeded.store.listDeliveries(seeded.ids.run).find((item) => item.id !== packet.id)!;
            assert.equal(replacement.submissionId, latest.id);
            assert.equal(replacement.state, "delivered");
            assert.match(replacement.payload, /Pinned head: non-clean-new-head/);
            assert.deepEqual(seeded.injected, [replacement.payload]);
          } else {
            assert.equal(seeded.store.getRun(seeded.ids.run)?.status, "waiting_for_inspector");
            assert.deepEqual(seeded.injected, []);
          }
        }
        // Repeated observations must not turn either an unfinished review or open findings
        // into approval, nor resurrect the cancelled packet.
        signal(seeded, captureHead);
        await settleGate(seeded);
        assert.notEqual(seeded.store.getRun(seeded.ids.run)?.status, "completed");
        assert.equal(eventCount(seeded, "inspector_gate_clean"), 0);
        assert.equal(seeded.store.getDelivery(packet.id)?.deliveredAt, null);
      } finally {
        scriptGitHub(null);
        await seeded.manager.stop();
      }
    });
  }
}

for (const policy of ["restart_workflow", "inspector_only"] as const) {
  for (const newest of ["ledger", "event", "ledger-tie"] as const) {
    test(`unsent Inspector recovery uses the newest remote observation: ${policy}, ${newest}`, async () => {
      let captureHead = "queued-head-a";
      const seeded = await seed({ policy, deliveryMode: "live", head: captureHead, captureHead: () => captureHead });
      try {
        const { packet, session } = await blockUnsentFeedback(seeded);
        const olderAt = Date.now();
        const newerAt = newest === "ledger-tie" ? olderAt : olderAt + 1;
        captureHead = "current-head-b";
        // Queue an update with A's old ledger snapshot. Before the per-run evaluator gets
        // the turn, Inspector records B. The converse proves a newer event also wins.
        updateInspectorPr(seeded.key, {
          observedHeadSha: seeded.head, observedState: "OPEN", observedAt: olderAt,
        }, olderAt);
        signal(seeded, newest === "event" ? captureHead : seeded.head,
          newest === "event" ? newerAt : olderAt);
        if (newest !== "event") {
          updateInspectorPr(seeded.key, {
            observedHeadSha: captureHead, observedState: "OPEN", observedAt: newerAt,
          }, newerAt);
        }
        session.state = "idle";
        await settleGate(seeded);
        const recovered = seeded.store.getDelivery(packet.id)!;
        assert.equal(recovered.state, "cancelled", "head A feedback must not cross the send boundary");
        assert.equal(recovered.deliveredAt, null);
        assert.deepEqual(seeded.injected, []);
        assert.equal(eventCount(seeded, "delivery_sending"), 0);
        assert.equal(eventCount(seeded, "inspector_gate_clean"), 0);
        const latest = seeded.store.latestSubmission(seeded.ids.run)!;
        if (policy === "restart_workflow") {
          assert.equal(latest.mode, "full_workflow");
          assert.equal((latest.context as unknown as WorkflowContextSnapshot).evidence.headSha, captureHead);
          assert.equal(inspectorOnlyRounds(seeded), 0);
        } else {
          assert.equal(latest.prHeadSha, captureHead, "the same newest observation must reach gate evaluation");
          const gate = seeded.store.getRun(seeded.ids.run)!.gateState as unknown as WorkflowInspectorGateState;
          assert.equal(gate.observedHeadSha, captureHead);
          assert.equal(gate.lastObservedAt, newerAt);
          assert.equal(gate.targetHeadSha, captureHead);
          assert.equal(gate.waitReason, "review_pending");
          assert.equal(seeded.store.getRun(seeded.ids.run)?.status, "waiting_for_inspector");
        }
      } finally {
        await seeded.manager.stop();
      }
    });
  }
}

for (const source of ["ledger", "event"] as const) {
  for (const staleState of ["OPEN", "CLOSED", "MERGED"] as const) {
    test(`stale Inspector signals cannot regress a recovered head: ${staleState}, ${source}`, async () => {
      const seeded = await seed({ policy: "inspector_only", deliveryMode: "live" });
      try {
        const { packet, session } = await blockUnsentFeedback(seeded);
        const repairedHead = "recovered-head-b";
        const observedAt = Date.now() + 1_000;
        updateInspectorPr(seeded.key, {
          observedHeadSha: source === "ledger" ? repairedHead : seeded.head,
          observedState: "OPEN", observedAt: source === "ledger" ? observedAt : observedAt - 1,
        }, observedAt);
        session.state = "idle";
        signal(seeded, repairedHead, observedAt);
        await settleGate(seeded);
        assert.equal(phaseOf(seeded), "waiting_for_inspector/inspector_review");
        const accepted = seeded.store.getRun(seeded.ids.run)!.gateState as unknown as WorkflowInspectorGateState;
        const submission = seeded.store.latestSubmission(seeded.ids.run)!;
        assert.equal(submission.mode, "inspector_only");
        assert.equal(submission.prHeadSha, repairedHead);
        assert.equal(accepted.lastObservedAt, observedAt);
        assert.ok(observedAt - 1 >= accepted.enteredAt, "the stale signal must pass the entry-time guard");

        // A delayed signal arrives after delivery recovery has already recorded B. Both an
        // older head and an older closed state must leave the newer review wait untouched.
        for (const queuedAt of [observedAt - 1, observedAt]) {
          seeded.registry.inspectionUpdated(seeded.key,
            staleState === "OPEN" ? seeded.head : repairedHead, staleState, queuedAt);
          await settleGate(seeded);
          assert.equal(phaseOf(seeded), "waiting_for_inspector/inspector_review",
            `a conflicting signal at ${queuedAt} must not replace the accepted observation at ${observedAt}`);
          assert.deepEqual(seeded.store.getRun(seeded.ids.run)!.gateState, accepted);
          assert.equal(seeded.store.latestSubmission(seeded.ids.run)!.id, submission.id);
          assert.equal(seeded.store.getDelivery(packet.id)!.state, "cancelled");
          assert.equal(seeded.store.getDelivery(packet.id)!.deliveredAt, null);
          assert.deepEqual(seeded.injected, []);
        }

        // Equal observation times remain usable when Inspector finishes the current review.
        db.prepare("UPDATE inspector_comments SET status = 'resolved' WHERE pr_key = ?").run(seeded.key);
        updateInspectorPr(seeded.key, {
          headSha: repairedHead, cleanReviewHeadSha: repairedHead, reviewComplete: true,
        }, observedAt);
        signal(seeded, repairedHead, observedAt);
        await settleGate(seeded);
        assert.equal(phaseOf(seeded), "completed/complete");
      } finally {
        await seeded.manager.stop();
      }
    });
  }
}

for (const guard of ["uncertain", "sending", "delivered", "refused", "preview", "retargeted",
  "paused", "unauthorized", "unavailable", "stale", "closed", "switched-pr", "old-submission"] as const) {
  test(`unsent Inspector recovery preserves the ${guard} guard`, async () => {
    const seeded = await seed({ policy: "inspector_only", deliveryMode: "live" });
    try {
      const { packet, session } = await blockUnsentFeedback(seeded);
      session.state = "idle";
      updateInspectorPr(seeded.key, { observedHeadSha: "new-head", observedState: "OPEN",
        observedAt: guard === "stale" ? seeded.now - 1 : Date.now(),
        state: guard === "closed" ? "closed" : "open" }, Date.now());
      if (["uncertain", "sending", "delivered", "refused"].includes(guard)) {
        seeded.store.setDeliveryState(packet.id, guard as "uncertain" | "sending" | "delivered" | "refused", null);
      }
      if (guard === "preview") seeded.store.updateBinding(seeded.ids.binding, { deliveryMode: "preview" });
      if (guard === "retargeted") db.prepare("UPDATE workflow_bindings SET session_id = 'other' WHERE id = ?").run(seeded.ids.binding);
      if (guard === "paused") seeded.registry.setSessionPause(session.id, {
        phase: "frozen", reason: "operator", since: Date.now(), frozenAt: Date.now(),
        interrupted: null, stopped: true,
      });
      if (guard === "unauthorized") setWorkflowPolicy({ liveEnabled: false });
      if (guard === "unavailable") session.state = "exited";
      if (guard === "switched-pr") session.prUrl = "https://github.com/owner/repo/pull/9999";
      if (guard === "old-submission") db.prepare("UPDATE workflow_deliveries SET submission_id = 'older' WHERE id = ?").run(packet.id);
      const before = seeded.store.getDelivery(packet.id);
      await (seeded.manager as unknown as {
        evaluateInspectorGate(id: string, observation: null): Promise<void>;
      }).evaluateInspectorGate(seeded.ids.run, null);
      await settleGate(seeded);
      assert.equal(phaseOf(seeded), "blocked/delivery_blocked");
      assert.deepEqual(seeded.store.getDelivery(packet.id), before);
      assert.deepEqual(seeded.injected, []);
      assert.equal(eventCount(seeded, "inspector_feedback_recovered"), 0);
    } finally {
      await seeded.manager.stop();
    }
  });
}

for (const answer of ["unchanged", "newer", "outage"] as const) {
test(`startup refreshes a blocked unsent packet before recovery: ${answer}`, async () => {
  const seeded = await seed({ policy: "inspector_only", deliveryMode: "live" });
  const { packet, session } = await blockUnsentFeedback(seeded);
  await seeded.manager.stop();
  session.state = "idle";
  if (answer === "newer") {
    db.prepare("UPDATE inspector_comments SET status = 'resolved' WHERE pr_key = ?").run(seeded.key);
  }
  updateInspectorPr(seeded.key, { observedHeadSha: seeded.head, observedState: "OPEN",
    observedAt: Date.now(), headSha: answer === "newer" ? "restart-head" : seeded.head,
    cleanReviewHeadSha: answer === "newer" ? "restart-head" : null }, Date.now());
  let release!: () => void;
  const reading = new Promise<void>((resolve) => { release = resolve; });
  let reads = 0;
  scriptGitHub(answer === "outage" ? null : "OPEN", answer === "newer" ? "restart-head" : seeded.head);
  const manager = new WorkflowManager(seeded.registry, seeded.store, {
    resolveCommit: async (_root, head) => head,
    reobservePullRequest: async (prKey) => {
      reads += 1;
      await reading;
      return reobserveInspectorPr(seeded.registry, prKey);
    },
    inject: async (_session, payload) => {
      seeded.injected.push(payload);
      return { ok: true, pasted: true, submitVerified: true };
    },
    recordInjection: () => {},
  });
  seeded.manager = manager;
  try {
    manager.start();
    await waitFor(() => reads === 1, "startup did not request fresh PR facts");
    assert.equal(seeded.store.getDelivery(packet.id)?.state, "prepared");
    assert.deepEqual(seeded.injected, []);
    release();
    await settleGate(seeded);
    if (answer === "newer") {
      assert.equal(phaseOf(seeded), "completed/complete");
      assert.equal(seeded.store.getDelivery(packet.id)?.state, "cancelled");
      assert.equal(seeded.store.getDelivery(packet.id)?.deliveredAt, null);
      assert.equal(inspectorOnlyRounds(seeded), 1);
      assert.deepEqual(seeded.injected, []);
    } else if (answer === "unchanged") {
      assert.equal(seeded.store.getDelivery(packet.id)?.state, "delivered");
      assert.deepEqual(seeded.injected, [packet.payload]);
    } else {
      assert.equal(phaseOf(seeded), "blocked/delivery_blocked");
      assert.equal(seeded.store.getDelivery(packet.id)?.state, "prepared");
      assert.equal(seeded.store.getDelivery(packet.id)?.deliveredAt, null);
      assert.deepEqual(seeded.injected, []);
    }
  } finally {
    release();
    scriptGitHub(null);
    await manager.stop();
  }
});
}

for (const kind of ["evidence_capture_repair", "persona_feedback", "pr_handoff", "inspector_feedback"] as const) {
  test(`Inspector recheck is limited to the recoverable blocked packet: ${kind}`, async () => {
    const seeded = await seed({ policy: "inspector_only", deliveryMode: "live" });
    try {
      const { packet } = await blockUnsentFeedback(seeded);
      db.prepare("UPDATE workflow_deliveries SET kind = ? WHERE id = ?").run(kind, packet.id);
      const expected = kind === "inspector_feedback";
      const recovery = seeded.store.runSummary(seeded.ids.run)!.recovery!;
      assert.equal(recovery.operations.includes("recheck-inspector"), expected);
      assert.equal(recovery.primary === "recheck-inspector", expected);
      assert.equal(seeded.manager.recheckInspector(seeded.ids.run, "packet-kind").ok, expected);
      await settleGate(seeded);
      assert.equal(phaseOf(seeded), "blocked/delivery_blocked");
      assert.equal(seeded.store.getDelivery(packet.id)?.state, "prepared");
      assert.deepEqual(seeded.injected, []);
      if (expected) {
        for (const state of ["refused", "uncertain", "delivered", "cancelled"] as const) {
          seeded.store.setDeliveryState(packet.id, state, null);
          assert.equal(seeded.store.runSummary(seeded.ids.run)!.recovery!.operations.includes("recheck-inspector"), false, state);
          assert.equal(seeded.manager.recheckInspector(seeded.ids.run, `packet-${state}`).ok, false, state);
        }
      }
    } finally {
      await seeded.manager.stop();
    }
  });
}

for (const recovery of ["session return", "operator acknowledgement"] as const) {
  test(`published-tree review obligation survives Inspector feedback ${recovery}`, async () => {
    const seeded = await seed({ policy: "inspector_only", deliveryMode: "live" });
    try {
      const { packet, session } = await blockUnsentFeedback(seeded);
      const run = seeded.store.getRun(seeded.ids.run)!;
      const gate = run.gateState as unknown as WorkflowInspectorGateState;
      const reviewedContent = { submissionId: seeded.ids.submission, headSha: "reviewed-head",
        treeOid: "a".repeat(40), publishedTreeOid: "b".repeat(40) };
      seeded.store.setRunState(run.id, run.status, "delivery_blocked", {
        ...gate, reviewedContent,
      }, Date.now());
      session.state = "idle";
      if (recovery === "session return") {
        scriptGitHub("OPEN", seeded.head);
        seeded.registry.setSessionPause(session.id, null);
        await waitFor(() => seeded.store.getDelivery(packet.id)?.state === "delivered", "feedback was not recovered");
        assert.deepEqual(seeded.injected, [packet.payload]);
      } else {
        seeded.store.setDeliveryState(packet.id, "uncertain", "lost acknowledgement");
        const result = await seeded.manager.resolveDelivery(packet.id, {
          requestId: "ack-published-feedback", resolution: "mark_delivered",
        });
        assert.equal(result.ok, true, JSON.stringify(result));
        assert.deepEqual(seeded.injected, []);
      }
      assert.equal(seeded.store.getRun(run.id)?.status, "waiting_for_session",
        "recovery must not restore Inspector-only bypass when full review is owed");
      assert.deepEqual((seeded.store.getRun(run.id)?.gateState as unknown as WorkflowInspectorGateState)?.reviewedContent,
        reviewedContent);
    } finally {
      scriptGitHub(null);
      await seeded.manager.stop();
    }
  });
}
const verifiedRecoveryOid = "b".repeat(40);
const priorRefOid = "d".repeat(40);
const laterRefOid = "a".repeat(40);

async function spentInspectorGrant(options: SeedOptions = {}) {
  const seeded = await seed({ ...options, policy: "inspector_only" });
  const { manager, ids, store, now, key, url } = seeded;
  await manager.settleBackgroundWork();
  const initial: WorkflowInspectorGateState = {
    prKey: key, prUrl: url, targetHeadSha: seeded.head, failedHeadSha: seeded.head,
    enteredAt: now, lastObservedAt: now + 1, observedHeadSha: seeded.head,
    reviewPosture: "live", waitReason: "findings", findingFingerprints: ["initial-finding"],
  };
  store.setRunState(ids.run, "waiting_for_new_head", "inspector_findings", workflowJson(initial), now + 1);
  const failed = { ...initial, targetHeadSha: "failed", observedHeadSha: "failed" };
  assert.ok(store.createInspectorOnlySubmission({
    id: "failed-sub", runId: ids.run, triggerKey: `inspector-head:${ids.run}:failed`,
    newHeadSha: "failed", failedHeadSha: seeded.head, priorFindingFingerprints: initial.findingFingerprints,
    bypassReason: "Published GitHub Inspector-only findings policy", expectedState: initial, state: failed, now: now + 2,
  }));
  const stale = { ...failed, failedHeadSha: "failed", observedHeadSha: priorRefOid,
    lastObservedAt: now + 3, findingFingerprints: ["prior-finding"] };
  db.prepare("UPDATE workflow_runs SET max_repair_rounds = 1 WHERE id = ?").run(ids.run);
  store.setRunState(ids.run, "blocked", "round_limit", workflowJson(stale), now + 4);
  store.appendEvent(ids.run, "inspector_round_limit", { maxRepairRounds: 1 }, now + 4);
  const grant = () => manager.grantRepairRounds(ids.run, { requestId: "buy-two", rounds: 2 }, now + 10);
  return { ...seeded, stale, grant };
}

test("grant chooses a newer pre-grant durable head on a null evaluation and waits for its own clean review", async () => {
  const { manager, store, ids, key, now, grant, registry } = await spentInspectorGrant();
  try {
    updateInspectorPr(key, { observedState: "OPEN", observedHeadSha: "current", observedAt: now + 9,
      headSha: "current", cleanReviewHeadSha: priorRefOid, reviewPosture: "live" }, now + 9);
    assert.ok(grant().ok);
    const replay = grant();
    assert.ok(replay.ok && replay.idempotent);
    await manager.settleBackgroundWork();
    const child = store.latestSubmission(ids.run)!;
    assert.equal(child.prHeadSha, "current");
    assert.equal(child.round, 3);
    assert.deepEqual(child.context, { newHeadSha: "current", failedHeadSha: "failed",
      priorFindingFingerprints: ["prior-finding"], bypassReason: "Published GitHub Inspector-only findings policy" });
    assert.equal(store.getRun(ids.run)?.currentPhase, "inspector_clean_review");
    registry.inspectionUpdated(key, priorRefOid, "OPEN", now + 5);
    await manager.settleBackgroundWork();
    assert.equal(store.getRun(ids.run)?.currentPhase, "inspector_clean_review");
    upsertInspectorComment({ id: "still-open", prKey: key, fingerprint: "prior-finding", path: "src/file.ts",
      line: 1, title: "Unresolved", body: "Repair still needed", severity: "major", round: 1,
      status: "open", replies: 0, answeredCommentId: null, createdAt: now, updatedAt: now });
    updateInspectorPr(key, { cleanReviewHeadSha: "current" }, now + 12);
    registry.inspectionUpdated(key, "current", "OPEN", now + 12);
    await manager.settleBackgroundWork();
    assert.equal(store.getRun(ids.run)?.currentPhase, "inspector_findings");
    db.prepare("UPDATE inspector_comments SET status = 'resolved' WHERE pr_key = ?").run(key);
    registry.inspectionUpdated(key, "current", "OPEN", now + 13);
    await manager.settleBackgroundWork();
    assert.equal(store.getRun(ids.run)?.status, "completed");
    assert.equal(store.listEvents(ids.run).filter(e => e.kind === "repair_rounds_granted").length, 1);
  } finally { await manager.stop(); }
});

test("a grant retains the superseding head across restart without sending failed-head feedback or spending a round", async () => {
  const { manager, store, ids, injected, now, grant } = await spentInspectorGrant({ deliveryMode: "live" });
  try {
    const { delivery } = store.prepareDelivery({
      id: "old-feedback", runId: ids.run, submissionId: "failed-sub", kind: "inspector_feedback",
      sessionId: ids.session, noteKey: `agent-${serial}`, payload: "repair failed head",
      payloadSha256: "old-feedback-digest",
    }, now + 2);
    assert.ok(grant().ok);
    await manager.settleBackgroundWork();
    const gate = () => store.getRun(ids.run)?.gateState as unknown as WorkflowInspectorGateState;
    assert.equal(gate().observedHeadSha, priorRefOid);
    assert.equal(gate().lastObservedAt, null);
    await manager.stop();
    manager.start();
    await manager.settleBackgroundWork();
    assert.equal(gate().observedHeadSha, priorRefOid);
    assert.equal(gate().lastObservedAt, null);
    assert.equal(store.latestSubmission(ids.run)?.round, 2);
    assert.equal(store.getDelivery(delivery.id)?.state, "prepared");
    assert.deepEqual(injected, []);
  } finally { await manager.stop(); }
});

test("after restart a grant selects the newer durable PR head on a recheck without a new observation", async () => {
  const { manager, store, ids, key, now, grant, registry } = await spentInspectorGrant();
  try {
    assert.ok(grant().ok);
    await manager.settleBackgroundWork();
    // The read preceded the grant. Its result reaches the ledger before shutdown,
    // but the gate receives no notification for it.
    updateInspectorPr(key, { observedState: "OPEN", observedHeadSha: "current", observedAt: now + 9,
      headSha: "current", cleanReviewHeadSha: priorRefOid, reviewPosture: "live" }, now + 11);
  } finally { await manager.stop(); }

  const gate = store.getRun(ids.run)?.gateState as unknown as WorkflowInspectorGateState;
  assert.equal(gate.observedHeadSha, priorRefOid);
  assert.equal(store.latestSubmission(ids.run)?.round, 2);

  const restarted = new WorkflowManager(registry, new WorkflowStore(db), {
    resolveCommit: async (_root, head) => head,
  });
  try {
    restarted.start();
    assert.ok(restarted.recheckInspector(ids.run, "after-restart").ok);
    await restarted.settleBackgroundWork();
    assert.deepEqual(store.listSubmissions(ids.run).slice(2).map(s => [s.round, s.mode, s.prHeadSha]),
      [[3, "inspector_only", "current"]]);
    assert.equal(store.getRun(ids.run)?.currentPhase, "inspector_clean_review");
  } finally { await restarted.stop(); }
});

test("grant waits through absent, failed, foreign and old observations and a closed PR before accepting a new head", async () => {
  const { manager, store, ids, key, now, grant, registry } = await spentInspectorGrant();
  try {
    assert.ok(grant().ok);
    await manager.settleBackgroundWork();
    registry.inspectionUpdated(key, null, null, now + 12);
    registry.inspectionUpdated(key, priorRefOid, "OPEN", now + 3);
    registry.inspectionUpdated("other/repo#1", "foreign", "OPEN", now + 13);
    await manager.settleBackgroundWork();
    assert.equal(store.getRun(ids.run)?.status, "waiting_for_new_head");
    assert.equal(store.latestSubmission(ids.run)?.round, 2);
    registry.inspectionUpdated(key, "failed", "OPEN", now + 14);
    registry.inspectionUpdated(key, "closed", "CLOSED", now + 15);
    await manager.settleBackgroundWork();
    assert.equal(store.latestSubmission(ids.run)?.round, 2);
    assert.equal(store.getRun(ids.run)?.currentPhase, "inspector_pr_closed");
    registry.inspectionUpdated(key, "repair", "OPEN", now + 16);
    await manager.settleBackgroundWork();
    assert.equal(store.latestSubmission(ids.run)?.prHeadSha, "repair");
    assert.equal(store.getRun(ids.run)?.status, "waiting_for_inspector");
  } finally { await manager.stop(); }
});

test("a grant waits for a positive observation newer than the last durable null read", async () => {
  const { manager, store, ids, key, now, grant, registry } = await spentInspectorGrant();
  try {
    assert.ok(grant().ok);
    await manager.settleBackgroundWork();
    updateInspectorPr(key, { observedState: "OPEN", observedHeadSha: "queued", observedAt: now + 11 }, now + 11);
    registry.inspectionUpdated(key, "queued", "OPEN", now + 11);
    // The queued evaluation will read the ledger after this unsuccessful read.
    updateInspectorPr(key, { observedState: null, observedHeadSha: null, observedAt: now + 12 }, now + 12);
    await manager.settleBackgroundWork();
    assert.equal(store.latestSubmission(ids.run)?.round, 2);
    assert.equal(store.getRun(ids.run)?.status, "waiting_for_new_head");

    registry.inspectionUpdated(key, "tied", "OPEN", now + 12);
    await manager.settleBackgroundWork();
    assert.equal(store.latestSubmission(ids.run)?.round, 2);

    registry.inspectionUpdated(key, "confirmed", "OPEN", now + 13);
    await manager.settleBackgroundWork();
    assert.deepEqual(store.listSubmissions(ids.run).slice(2).map(s => [s.round, s.prHeadSha]), [[3, "confirmed"]]);
    assert.equal(store.getRun(ids.run)?.status, "waiting_for_inspector");
  } finally { await manager.stop(); }
});

test("a durable observation arriving during commit resolution wins over a delayed grant notification", async () => {
  let entered!: () => void;
  let release!: () => void;
  const resolving = new Promise<void>((resolve) => { entered = resolve; });
  const resume = new Promise<void>((resolve) => { release = resolve; });
  const seeded = await spentInspectorGrant({ resolveCommit: async (_root, head) => {
    if (head === "failed") {
      entered();
      await resume;
    }
    return head;
  } });
  const { key, ids, manager, store, now, registry } = seeded;
  try {
    updateInspectorPr(key, { observedState: "OPEN", observedHeadSha: "delayed", observedAt: now + 9 }, now + 9);
    assert.ok(seeded.grant().ok);
    await resolving;
    registry.inspectionUpdated(key, "delayed", "OPEN", now + 11);
    updateInspectorPr(key, { observedState: "OPEN", observedHeadSha: "newest", observedAt: now + 12 }, now + 12);
    registry.inspectionUpdated(key, "newest", "OPEN", now + 12);
    release();
    await manager.settleBackgroundWork();
    assert.deepEqual(store.listSubmissions(ids.run).slice(2).map(s => s.prHeadSha), ["newest"]);
    assert.equal(store.getRun(ids.run)?.status, "waiting_for_inspector");
  } finally { release(); await manager.stop(); }
});

test("a clean granted head superseded during verification cannot approve the run", async () => {
  const seeded = await spentInspectorGrant({ resolveCommit: async (_root, head) => {
    if (head === "clean") {
      // The bypass has already pinned its immutable identity. GitHub advances before
      // commit resolution finishes and before its next notification reaches the gate.
      updateInspectorPr(seeded.key, { observedHeadSha: "pushed", observedState: "OPEN",
        observedAt: seeded.now + 12 }, seeded.now + 12);
    }
    return head;
  } });
  try {
    updateInspectorPr(seeded.key, { headSha: "clean", cleanReviewHeadSha: "clean", reviewPosture: "live",
      observedState: "OPEN", observedHeadSha: "clean", observedAt: seeded.now + 9 }, seeded.now + 9);
    assert.ok(seeded.grant().ok);
    await seeded.manager.settleBackgroundWork();
    assert.equal(seeded.store.latestSubmission(seeded.ids.run)?.prHeadSha, "clean");
    assert.equal(seeded.store.getRun(seeded.ids.run)?.currentPhase, "inspector_head_mismatch");
    assert.equal(seeded.store.listEvents(seeded.ids.run).some(e => e.kind === "inspector_gate_clean"), false);
  } finally { await seeded.manager.stop(); }
});

test("later clean recheck rereads the durable head after resolving the immutable Inspector submission", async () => {
  let pushDuringRecheck = false;
  const seeded = await spentInspectorGrant({ resolveCommit: async (_root, head) => {
    if (head === "repair" && pushDuringRecheck) {
      updateInspectorPr(seeded.key, { observedState: "OPEN", observedHeadSha: "pushed",
        observedAt: seeded.now + 14 }, seeded.now + 14);
    }
    return head;
  } });
  const { store, manager, ids, key, now } = seeded;
  try {
    updateInspectorPr(key, { headSha: "repair", cleanReviewHeadSha: null, reviewPosture: "live",
      observedState: "OPEN", observedHeadSha: "repair", observedAt: now + 9 }, now + 9);
    assert.ok(seeded.grant().ok);
    await manager.settleBackgroundWork();
    const child = store.latestSubmission(ids.run);
    assert.equal(child?.prHeadSha, "repair");
    assert.equal(store.getRun(ids.run)?.currentPhase, "inspector_clean_review");
    updateInspectorPr(key, { cleanReviewHeadSha: "repair" }, now + 12);
    pushDuringRecheck = true;
    assert.ok(manager.recheckInspector(ids.run, "recheck-clean").ok);
    await manager.settleBackgroundWork();
    assert.deepEqual(store.latestSubmission(ids.run), child);
    assert.equal(store.getRun(ids.run)?.currentPhase, "inspector_head_mismatch");
    assert.equal(store.listEvents(ids.run).some(e => e.kind === "inspector_gate_clean"), false);
  } finally { await manager.stop(); }
});

for (const timing of ["tied", "newer"] as const) {
  test(`clean Inspector submission waits after a ${timing} failed read during commit resolution`, async () => {
    let failRead = true;
    const seeded = await spentInspectorGrant({ resolveCommit: async (_root, head) => {
      if (head === "clean" && failRead) {
        failRead = false;
        const at = seeded.now + (timing === "tied" ? 9 : 11);
        updateInspectorPr(seeded.key, { observedState: null, observedHeadSha: null, observedAt: at }, at);
      }
      return head;
    } });
    const { store, manager, ids, key, now, registry } = seeded;
    try {
      updateInspectorPr(key, { headSha: "clean", cleanReviewHeadSha: "clean", reviewPosture: "live",
        observedState: "OPEN", observedHeadSha: "clean", observedAt: now + 9 }, now + 9);
      assert.ok(seeded.grant().ok);
      await manager.settleBackgroundWork();
      assert.equal(failRead, false);
      const child = store.latestSubmission(ids.run)!;
      assert.equal(child.prHeadSha, "clean");
      assert.equal(store.getRun(ids.run)?.status, "waiting_for_inspector");
      assert.equal(eventCount(seeded, "inspector_gate_clean"), 0);

      updateInspectorPr(key, { observedState: "OPEN", observedHeadSha: "clean", observedAt: now + 12 }, now + 12);
      registry.inspectionUpdated(key, "clean", "OPEN", now + 12);
      await manager.settleBackgroundWork();
      assert.equal(store.getRun(ids.run)?.status, "completed");
      assert.equal(store.latestSubmission(ids.run)?.id, child.id);
      assert.equal(eventCount(seeded, "inspector_gate_clean"), 1);
    } finally { await manager.stop(); }
  });
}

test("a later push after a current-head grant remains an ordinary nonrecoverable mismatch", async () => {
  const { manager, store, ids, key, now, grant, registry } = await spentInspectorGrant();
  try {
    assert.ok(grant().ok);
    registry.inspectionUpdated(key, "first-repair", "OPEN", now + 11);
    await manager.settleBackgroundWork();
    const child = store.latestSubmission(ids.run)!;
    assert.equal(child.prHeadSha, "first-repair");
    updateInspectorPr(key, { observedState: "OPEN", observedHeadSha: "later", observedAt: now + 20 }, now + 20);
    registry.inspectionUpdated(key, "later", "OPEN", now + 20);
    await manager.settleBackgroundWork();
    assert.equal(store.getRun(ids.run)?.currentPhase, "inspector_head_mismatch");
    assert.equal((await manager.recoverStaleInspectorGrant(ids.run, "refuse", {
      grantRequestId: "buy-two", submissionId: child.id, staleHeadSha: "first-repair", currentHeadSha: "later",
    })).ok, false);
    assert.equal(store.listEvents(ids.run).some(e => e.kind === "inspector_stale_grant_recovered"), false);
  } finally { await manager.stop(); }
});

async function strandLegacyGrant(
  seeded: Awaited<ReturnType<typeof spentInspectorGrant>>,
  preGrantHead: string,
  { delayedObservation = false, returnedToPinnedHead = false, maxRepairRounds = 4 } = {},
) {
  const { key, ids, manager, store, now, stale, registry } = seeded;
  // The old daemon restored the saved gate, which still names the historical head.
  // Only the actual Inspector facts leading up to that grant differ between cases.
  updateInspectorPr(key, { observedState: "OPEN", observedHeadSha: preGrantHead, observedAt: now + 8,
    reviewPosture: "live", ...(delayedObservation ? {} : { headSha: preGrantHead, lastReviewedAt: now + 8 }) }, now + 8);
  recordCodeRabbit(key, { headSha: preGrantHead, state: "OPEN", draft: false, findings: [] }, now + 8);
  if (returnedToPinnedHead) {
    updateInspectorPr(key, { observedState: "OPEN", observedHeadSha: priorRefOid, observedAt: now + 9 }, now + 9);
  }
  store.grantRunRepairRounds(ids.run, maxRepairRounds, { status: "waiting_for_new_head", phase: "inspector_findings",
    gateState: workflowJson(stale) }, 3, { kind: "repair_rounds_granted", payload: {
      requestId: "legacy", from: 1, to: maxRepairRounds, round: 2, resumed: "waiting_for_new_head",
    } }, now + 1010);
  const stranded = store.createInspectorOnlySubmission({
    id: "stranded", runId: ids.run, triggerKey: `inspector-head:${ids.run}:${priorRefOid}`,
    newHeadSha: priorRefOid, failedHeadSha: "failed", priorFindingFingerprints: ["prior-finding"],
    bypassReason: "Published GitHub Inspector-only findings policy", expectedState: stale,
    state: { ...stale, targetHeadSha: priorRefOid, waitReason: "review_pending" }, now: now + 1011,
  });
  assert.ok(stranded);
  updateInspectorPr(key, { observedState: "OPEN", observedHeadSha: verifiedRecoveryOid, observedAt: now + 1012,
    ...(preGrantHead === verifiedRecoveryOid ? {} : { headSha: verifiedRecoveryOid, lastReviewedAt: now + 1012 }),
    cleanReviewHeadSha: null }, now + 1012);
  const number = Number(key.split("#")[1]);
  writeFileSync(recoveryPr, JSON.stringify({ number, state: "open", created_at: new Date(now - 10_000).toISOString(), base: { repo: { full_name: "owner/repo" } },
    head: { repo: { full_name: "author/fork" }, ref: "feature", sha: verifiedRecoveryOid } }));
  writeFileSync(branchActivity, JSON.stringify([
    { id: 101, ref: "refs/heads/feature", before: priorRefOid, after: verifiedRecoveryOid,
      timestamp: new Date(now + (returnedToPinnedHead || preGrantHead !== verifiedRecoveryOid ? 1012 : 6)).toISOString() },
    { id: 99, ref: "refs/heads/feature", before: "c".repeat(40), after: priorRefOid,
      timestamp: new Date(now - 12_000).toISOString() },
  ]));
  registry.inspectionUpdated(key, verifiedRecoveryOid, "OPEN", delayedObservation ? now + 8 : now + 1012);
  await manager.settleBackgroundWork();
  assert.equal(store.getRun(ids.run)?.currentPhase, "inspector_head_mismatch");
  return stranded;
}

async function legacyRecoveryRoute({ registry, manager, ids }: Awaited<ReturnType<typeof spentInspectorGrant>>) {
  const { buildApp } = await import("../src/server/routes.ts");
  const { ReviewManager } = await import("../src/server/reviews.ts");
  const { TaskManager } = await import("../src/server/tasks.ts");
  const { QueueManager } = await import("../src/server/queue.ts");
  const app = buildApp({ registry, workflows: manager, reviews: new ReviewManager(registry),
    tasks: new TaskManager(registry), queues: new QueueManager(registry) });
  return (currentHeadSha = verifiedRecoveryOid, requestId = "recover") => app.request(`/api/workflow-runs/${ids.run}/recheck-inspector`, {
    method: "POST", headers: { host: "127.0.0.1:7317", "content-type": "application/json" },
    body: JSON.stringify({ requestId, recoverStaleGrant: { grantRequestId: "legacy", submissionId: "stranded", staleHeadSha: priorRefOid, currentHeadSha } }),
  });
}

// The fake gh has already captured the first response when it creates activityPending.
async function duringActivityRead(start: () => Response | Promise<Response>, change: () => void) {
  writeFileSync(holdActivity, "");
  const pending = start();
  let response: Response;
  try {
    await waitFor(() => existsSync(activityPending), "the branch activity read never reached the fixture");
    change();
  } finally {
    rmSync(holdActivity, { force: true });
    rmSync(activityPending, { force: true });
    response = await pending;
  }
  return response;
}

test("legacy recovery rechecks the durable head after a concurrent change during branch activity verification", async () => {
  const seeded = await spentInspectorGrant();
  const { key, ids, manager, store, now } = seeded;
  try {
    await strandLegacyGrant(seeded, verifiedRecoveryOid);
    const before = store.getRun(ids.run);
    const submissions = store.listSubmissions(ids.run);
    const recover = await legacyRecoveryRoute(seeded);
    const response = await duringActivityRead(recover, () => {
      updateInspectorPr(key, {
        observedState: "OPEN", observedHeadSha: "newer-repair", observedAt: now + 1013,
      }, now + 1013);
    });
    assert.equal(response.status, 409);
    await manager.settleBackgroundWork();
    assert.equal(getInspectorPr(key)?.observedHeadSha, "newer-repair");
    assert.deepEqual(store.getRun(ids.run), before);
    assert.deepEqual(store.listSubmissions(ids.run), submissions);
    assert.equal(store.listEvents(ids.run).some(e => e.kind === "inspector_stale_grant_recovered"), false);
  } finally { await manager.stop(); }
});

test("legacy recovery rechecks the open PR and its source after GitHub snapshots branch activity", async () => {
  const seeded = await spentInspectorGrant();
  const { store, manager, ids, key } = seeded;
  try {
    await strandLegacyGrant(seeded, verifiedRecoveryOid);
    const before = store.getRun(ids.run);
    const submissions = store.listSubmissions(ids.run);
    const recover = await legacyRecoveryRoute(seeded);
    const pull = JSON.parse(readFileSync(recoveryPr, "utf8"));
    for (const changed of [null, { ...pull, state: "closed" }, { ...pull, number: pull.number + 1 },
      { ...pull, head: { ...pull.head, sha: laterRefOid } }, { ...pull, head: { ...pull.head, ref: "another-branch" } },
      { ...pull, head: { ...pull.head, repo: { full_name: "another/fork" } } }]) {
      writeFileSync(recoveryPr, JSON.stringify(pull));
      const response = await duringActivityRead(recover, () => {
        if (changed) writeFileSync(recoveryPr, JSON.stringify(changed));
        else rmSync(recoveryPr);
      });
      assert.equal(response.status, 409);
      await manager.settleBackgroundWork();
      assert.equal(getInspectorPr(key)?.observedHeadSha, verifiedRecoveryOid);
      assert.deepEqual(store.getRun(ids.run), before);
      assert.deepEqual(store.listSubmissions(ids.run), submissions);
      assert.equal(store.listEvents(ids.run).some(e => e.kind === "inspector_stale_grant_recovered"), false);
    }
  } finally { await manager.stop(); }
});

test("legacy recovery rejects a changed latest ref update even when the PR returns to the verified head", async () => {
  const seeded = await spentInspectorGrant();
  const { store, manager, ids, key, now } = seeded;
  try {
    await strandLegacyGrant(seeded, verifiedRecoveryOid);
    const before = store.getRun(ids.run);
    const submissions = store.listSubmissions(ids.run);
    const recover = await legacyRecoveryRoute(seeded);
    const [activity, ...history] = JSON.parse(readFileSync(branchActivity, "utf8"));
    const pull = readFileSync(recoveryPr, "utf8");
    // Include a second update in the same timestamp bucket. A time comparison
    // alone cannot distinguish it from the activity that preceded the grant.
    for (const latest of [null, { ...activity, id: activity.id + 1 },
      { ...activity, id: activity.id + 2, timestamp: new Date(now + 1014).toISOString() },
      { ...activity, timestamp: new Date(now + 7).toISOString() }]) {
      writeFileSync(branchActivity, JSON.stringify([activity, ...history]));
      const response = await duringActivityRead(recover, () => {
        if (latest) writeFileSync(branchActivity, JSON.stringify([latest, ...history]));
        else rmSync(branchActivity);
      });
      assert.equal(response.status, 409);
      await manager.settleBackgroundWork();
      assert.equal(readFileSync(recoveryPr, "utf8"), pull);
      assert.equal(getInspectorPr(key)?.observedHeadSha, verifiedRecoveryOid);
      assert.deepEqual(store.getRun(ids.run), before);
      assert.deepEqual(store.listSubmissions(ids.run), submissions);
      assert.equal(store.listEvents(ids.run).some(e => e.kind === "inspector_stale_grant_recovered"), false);
    }
  } finally { await manager.stop(); }
});

test("a push after the legacy recovery receipt cannot spend the replacement on an unverified head", async () => {
  let advanceBranch = false;
  const seeded = await spentInspectorGrant({ resolveCommit: async (_root, head) => {
    if (head === priorRefOid && advanceBranch) {
      advanceBranch = false;
      updateInspectorPr(seeded.key, { observedState: "OPEN", observedHeadSha: "later",
        observedAt: seeded.now + 1013 }, seeded.now + 1013);
    }
    return head;
  } });
  const { store, manager, ids } = seeded;
  try {
    await strandLegacyGrant(seeded, verifiedRecoveryOid);
    const submissions = store.listSubmissions(ids.run);
    const recover = await legacyRecoveryRoute(seeded);
    advanceBranch = true;
    assert.equal((await recover()).status, 200);
    await manager.settleBackgroundWork();
    const receipts = store.listEvents(ids.run).filter(e => e.kind === "inspector_stale_grant_recovered");
    assert.deepEqual(receipts.map(e => (e.payload as { currentHeadSha: string }).currentHeadSha), [verifiedRecoveryOid]);
    assert.equal(store.getRun(ids.run)?.currentPhase, "inspector_head_mismatch");
    const gate = store.getRun(ids.run)?.gateState as unknown as WorkflowInspectorGateState;
    assert.equal(gate.targetHeadSha, priorRefOid);
    assert.equal(gate.observedHeadSha, "later");
    assert.deepEqual(store.listSubmissions(ids.run), submissions);
  } finally { await manager.stop(); }
});

test("a GitHub-only push during commit resolution cannot spend the recovered round", async () => {
  let pushDuringResolution = false;
  const seeded = await spentInspectorGrant({ resolveCommit: async (_root, head) => {
    if (head === priorRefOid && pushDuringResolution) {
      pushDuringResolution = false;
      const pull = JSON.parse(readFileSync(recoveryPr, "utf8"));
      writeFileSync(recoveryPr, JSON.stringify({ ...pull, head: { ...pull.head, sha: laterRefOid } }));
    }
    return head;
  } });
  const { manager, store, ids, key } = seeded;
  try {
    await strandLegacyGrant(seeded, verifiedRecoveryOid);
    const submissions = store.listSubmissions(ids.run);
    const recover = await legacyRecoveryRoute(seeded);
    pushDuringResolution = true;
    assert.equal((await recover()).status, 200);
    await manager.settleBackgroundWork();
    assert.equal(pushDuringResolution, false);
    assert.equal(getInspectorPr(key)?.observedHeadSha, verifiedRecoveryOid);
    assert.equal(store.getRun(ids.run)?.currentPhase, "inspector_head_mismatch");
    assert.deepEqual(store.listSubmissions(ids.run), submissions);
    assert.equal(store.listEvents(ids.run).filter(e => e.kind === "inspector_stale_grant_recovered").length, 1);
  } finally { await manager.stop(); }
});

for (const change of ["new ref update on the same SHA", "PR closes during the final activity read", "unavailable final PR read"] as const) {
  test(`legacy replacement selection waits for live confirmation: ${change}`, async () => {
    let applyChange = false;
    const seeded = await spentInspectorGrant({ resolveCommit: async (_root, head) => {
      if (head === priorRefOid && applyChange) {
        applyChange = false;
        if (change === "unavailable final PR read") rmSync(recoveryPr);
        else writeFileSync(holdActivity, change === "PR closes during the final activity read" ? "hold second read" : "");
      }
      return head;
    } });
    const { store, manager, ids, key } = seeded;
    try {
      await strandLegacyGrant(seeded, verifiedRecoveryOid);
      const pull = readFileSync(recoveryPr);
      const submissions = store.listSubmissions(ids.run);
      const recover = await legacyRecoveryRoute(seeded);
      applyChange = true;
      assert.equal((await recover()).status, 200);
      if (change !== "unavailable final PR read") {
        await waitFor(() => existsSync(activityPending), "the final ref read did not start");
        if (change === "PR closes during the final activity read") {
          writeFileSync(recoveryPr, JSON.stringify({ ...JSON.parse(pull.toString()), state: "closed" }));
        } else {
          // The first tip response is in flight; the PR returns to the same head.
          const [previous, ...rest] = JSON.parse(readFileSync(branchActivity, "utf8"));
          writeFileSync(branchActivity, JSON.stringify([{ ...previous, id: previous.id + 1 }, ...rest]));
        }
        rmSync(holdActivity);
      }
      await manager.settleBackgroundWork();
      assert.equal(applyChange, false);
      assert.deepEqual(store.listSubmissions(ids.run), submissions);
      if (change !== "unavailable final PR read") {
        assert.equal(getInspectorPr(key)?.observedState, "OPEN");
        assert.equal(store.getRun(ids.run)?.currentPhase, "inspector_head_mismatch");
      } else {
        assert.equal(store.getRun(ids.run)?.status, "waiting_for_new_head");
        writeFileSync(recoveryPr, pull);
        assert.equal((await recover(laterRefOid)).status, 409);
        await manager.settleBackgroundWork();
        assert.deepEqual(store.listSubmissions(ids.run), submissions);
        // No Inspector notification follows the outage. The original request retries
        // the pending receipt even when its caller sends two copies together.
        for (const replay of await Promise.all([recover(), recover()])) {
          assert.equal(replay.status, 200);
          assert.equal((await replay.json()).idempotent, true);
        }
        await manager.settleBackgroundWork();
        assert.equal(store.listSubmissions(ids.run).length, submissions.length + 1);
        assert.equal(store.latestSubmission(ids.run)?.prHeadSha, verifiedRecoveryOid);
      }
      assert.equal(store.listEvents(ids.run).filter(e => e.kind === "inspector_stale_grant_recovered").length, 1);
    } finally {
      rmSync(holdActivity, { force: true });
      rmSync(activityPending, { force: true });
      await manager.stop();
    }
  });
}

test("an older recovery request cannot wake a different pending receipt for the same submission and head", async () => {
  let change: "mismatch" | "outage" | undefined;
  const seeded = await spentInspectorGrant({ resolveCommit: async (_root, head) => {
    if (head === priorRefOid && change) {
      if (change === "mismatch") {
        const pull = JSON.parse(readFileSync(recoveryPr, "utf8"));
        writeFileSync(recoveryPr, JSON.stringify({ ...pull, head: { ...pull.head, sha: laterRefOid } }));
      } else rmSync(recoveryPr);
      change = undefined;
    }
    return head;
  } });
  const { manager, store, ids } = seeded;
  try {
    await strandLegacyGrant(seeded, verifiedRecoveryOid);
    const recover = await legacyRecoveryRoute(seeded);
    const pull = readFileSync(recoveryPr);
    const submissions = store.listSubmissions(ids.run);
    change = "mismatch";
    assert.equal((await recover()).status, 200);
    await manager.settleBackgroundWork();
    assert.equal(phaseOf(seeded), "blocked/inspector_head_mismatch");
    writeFileSync(recoveryPr, pull);
    change = "outage";
    assert.equal((await recover(verifiedRecoveryOid, "second")).status, 200);
    await manager.settleBackgroundWork();
    writeFileSync(recoveryPr, pull);

    assert.equal((await (await recover()).json()).idempotent, true);
    await manager.settleBackgroundWork();
    assert.equal(phaseOf(seeded), "waiting_for_new_head/inspector_findings");
    assert.deepEqual(store.listSubmissions(ids.run), submissions);
    assert.equal((await (await recover(verifiedRecoveryOid, "second")).json()).idempotent, true);
    await manager.settleBackgroundWork();
    assert.equal(store.latestSubmission(ids.run)?.prHeadSha, verifiedRecoveryOid);
    assert.equal(store.listSubmissions(ids.run).length, submissions.length + 1);
    assert.equal(eventCount(seeded, "inspector_stale_grant_recovered"), 2);
  } finally { await manager.stop(); }
});

for (const race of ["return to the verified SHA", "conversation transfer hold"] as const) {
  test(`legacy recovery preserves the round during the final PR read: ${race}`, async () => {
    let pause = false;
    const seeded = await spentInspectorGrant({ resolveCommit: async (_root, head) => {
      if (pause && head === priorRefOid) {
        pause = false;
        writeFileSync(holdRecoveryPull, "hold second read");
      }
      return head;
    } });
    const { manager, store, ids, key } = seeded;
    try {
      await strandLegacyGrant(seeded, verifiedRecoveryOid);
      const submissions = store.listSubmissions(ids.run);
      const recover = await legacyRecoveryRoute(seeded);
      pause = true;
      assert.equal((await recover()).status, 200);
      await waitFor(() => existsSync(pullPending), "the final PR read did not start");
      if (race === "return to the verified SHA") {
        const pull = JSON.parse(readFileSync(recoveryPr, "utf8"));
        const [previous, ...history] = JSON.parse(readFileSync(branchActivity, "utf8"));
        writeFileSync(branchActivity, JSON.stringify([{ ...previous, id: previous.id + 2, before: laterRefOid },
          { ...previous, id: previous.id + 1, before: verifiedRecoveryOid, after: laterRefOid }, previous, ...history]));
        writeFileSync(recoveryPr, JSON.stringify({ ...pull, rewrites: [{ __typename: "HeadRefForcePushedEvent", id: "later-force" }] }));
      } else {
        const { reserveSessionTransfer } = await import("../src/server/session-transfers/store.ts");
        const binding = store.getBinding(store.getRun(ids.run)!.bindingId)!;
        reserveSessionTransfer({ sourceSessionId: ids.session, noteKey: binding.noteKey, taskId: null, facts: {
          agent: "claude", nativeId: binding.noteKey, sourceName: "Transfer", sourceRuntime: "sdk", sourceEpisodeId: null,
          cwd: home, repoRoot: home, taskIdentity: null, taskEpisodeId: null, bindings: [], leaseRoot: home,
          leaseId: "lease", backend: null, home: null, sourceStopped: false, stopStarted: false, sourceProcess: null,
          launchAt: null, launchOutcome: "not_started", canEnd: false,
        } });
      }
      rmSync(holdRecoveryPull);
      await manager.settleBackgroundWork();
      assert.equal(getInspectorPr(key)?.observedHeadSha, verifiedRecoveryOid);
      assert.deepEqual(store.listSubmissions(ids.run), submissions);
      assert.equal(store.getRun(ids.run)?.status, race === "conversation transfer hold" ? "waiting_for_new_head" : "blocked");
      assert.equal(store.listEvents(ids.run).filter(e => e.kind === "inspector_stale_grant_recovered").length, 1);
    } finally {
      rmSync(holdRecoveryPull, { force: true });
      rmSync(pullPending, { force: true });
      db.prepare("DELETE FROM session_runtime_transfers WHERE source_session_id = ?").run(ids.session);
      await manager.stop();
    }
  });
}

for (const liveResult of ["closed PR", "changed ref", "matching tip"] as const) {
  test(`legacy recovery with a failed ledger read respects the live result: ${liveResult}`, async () => {
    let selecting = false;
    const seeded = await spentInspectorGrant({ resolveCommit: async (_root, head) => {
      if (head === priorRefOid && selecting) {
        selecting = false;
        const at = seeded.now + 1013;
        updateInspectorPr(seeded.key, { observedState: null, observedHeadSha: null, observedAt: at }, at);
        if (liveResult === "closed PR") {
          const pull = JSON.parse(readFileSync(recoveryPr, "utf8"));
          writeFileSync(recoveryPr, JSON.stringify({ ...pull, state: "closed" }));
        } else if (liveResult === "changed ref") {
          const [tip, ...history] = JSON.parse(readFileSync(branchActivity, "utf8"));
          writeFileSync(branchActivity, JSON.stringify([{ ...tip, id: tip.id + 1 }, ...history]));
        }
      }
      return head;
    } });
    const { manager, store, ids } = seeded;
    try {
      await strandLegacyGrant(seeded, verifiedRecoveryOid);
      const submissions = store.listSubmissions(ids.run);
      const recover = await legacyRecoveryRoute(seeded);
      selecting = true;
      assert.equal((await recover()).status, 200);
      await manager.settleBackgroundWork();
      assert.equal(selecting, false);
      assert.deepEqual(store.listSubmissions(ids.run), submissions);
      assert.equal(eventCount(seeded, "inspector_stale_grant_recovered"), 1);
      const run = store.getRun(ids.run)!;
      const gate = run.gateState as unknown as WorkflowInspectorGateState;
      if (liveResult === "matching tip") {
        assert.equal(run.status, "waiting_for_new_head");
        assert.equal(gate.grantObservation?.verifiedHeadSha, verifiedRecoveryOid);
      } else {
        assert.equal(run.currentPhase, "inspector_head_mismatch");
        assert.equal(gate.targetHeadSha, priorRefOid);
        assert.equal(gate.grantObservation, undefined);
      }
    } finally { await manager.stop(); }
  });
}

test("a confirmed ref mismatch still blocks recovery when the final PR read is unavailable", async () => {
  let changeRef = false;
  const seeded = await spentInspectorGrant({ resolveCommit: async (_root, head) => {
    if (changeRef && head === priorRefOid) {
      changeRef = false;
      const [tip, ...history] = JSON.parse(readFileSync(branchActivity, "utf8"));
      writeFileSync(branchActivity, JSON.stringify([{ ...tip, id: tip.id + 1 }, ...history]));
      rmSync(recoveryPr);
    }
    return head;
  } });
  const { manager, store, ids } = seeded;
  try {
    await strandLegacyGrant(seeded, verifiedRecoveryOid);
    const submissions = store.listSubmissions(ids.run);
    const recover = await legacyRecoveryRoute(seeded);
    changeRef = true;
    assert.equal((await recover()).status, 200);
    await manager.settleBackgroundWork();
    assert.equal(store.getRun(ids.run)?.currentPhase, "inspector_head_mismatch");
    assert.deepEqual(store.listSubmissions(ids.run), submissions);
  } finally { await manager.stop(); }
});

for (const scenario of [
  { name: "closed", state: "closed", blocked: true },
  { name: "merged", state: "merged", blocked: true },
  { name: "open", state: "open", blocked: false },
  { name: "partial closed response", state: "closed", errors: true, exit: 1, blocked: true },
  { name: "partial merged response", state: "merged", errors: true, exit: 1, blocked: true },
  { name: "partial open response", state: "open", errors: true, exit: 1, blocked: false },
  { name: "failed read without GraphQL errors", state: "closed", exit: 1, blocked: false },
  { name: "partial closure for a different PR", state: "closed", errors: true, exit: 1, wrongPr: true, blocked: false },
  { name: "partial response with a PR state error", state: "closed", errors: true, errorField: "state", exit: 1, blocked: false },
  { name: "interrupted partial response", state: "closed", errors: true, interrupted: true, blocked: false },
]) {
  test(`recovery checks the PR state before requiring the fork repository: ${scenario.name}`, async () => {
    let deleteFork = false;
    const seeded = await spentInspectorGrant({ resolveCommit: async (_root, head) => {
      if (deleteFork && head === priorRefOid) {
        deleteFork = false;
        const pull = JSON.parse(readFileSync(recoveryPr, "utf8"));
        writeFileSync(recoveryPr, JSON.stringify({ ...pull, state: scenario.state,
          number: scenario.wrongPr ? pull.number + 1 : pull.number,
          head: { ...pull.head, repo: scenario.name === "partial open response" ? pull.head.repo : null },
          graphExitCode: scenario.exit, graphInterrupted: scenario.interrupted, graphErrors: scenario.errors ? [
            { message: "Field unavailable", path: ["repository", "pullRequest", scenario.errorField ?? "headRepository"] },
          ] : undefined }));
      }
      return head;
    } });
    const { manager, store, ids, key } = seeded;
    try {
      await strandLegacyGrant(seeded, verifiedRecoveryOid);
      const submissions = store.listSubmissions(ids.run);
      const recover = await legacyRecoveryRoute(seeded);
      deleteFork = true;
      assert.equal((await recover()).status, 200);
      await manager.settleBackgroundWork();
      assert.equal(deleteFork, false);
      assert.equal(getInspectorPr(key)?.observedState, "OPEN");
      assert.equal(store.getRun(ids.run)?.status, scenario.blocked ? "blocked" : "waiting_for_new_head");
      assert.deepEqual(store.listSubmissions(ids.run), submissions);
      assert.equal(store.listEvents(ids.run).filter(e => e.kind === "inspector_stale_grant_recovered").length, 1);
    } finally { await manager.stop(); }
  });
}

for (const partial of [
  { name: "changed head", head: laterRefOid, errors: ["timelineItems"], blocked: true },
  { name: "changed SHA-256 head", head: "a".repeat(64), errors: ["timelineItems"], blocked: true },
  { name: "matching head", head: verifiedRecoveryOid, errors: ["timelineItems"], blocked: false },
  { name: "matching head and ref activity", head: verifiedRecoveryOid, errors: ["timelineItems"], keepActivity: true, blocked: false },
  { name: "missing head", head: null, errors: ["timelineItems"], blocked: false },
  { name: "invalid OID", head: "unavailable", errors: ["timelineItems"], blocked: false },
  { name: "head field also failed", head: laterRefOid, errors: ["timelineItems", "headRefOid"], blocked: false },
  { name: "different PR", head: laterRefOid, errors: ["timelineItems"], wrongPr: true, blocked: false },
]) {
  test(`recovery checks the head in a partial PR response: ${partial.name}`, async () => {
    let selecting = false;
    const seeded = await spentInspectorGrant({ resolveCommit: async (_root, head) => {
      if (selecting && head === priorRefOid) {
        selecting = false;
        if (!partial.keepActivity) rmSync(branchActivity);
        const pull = JSON.parse(readFileSync(recoveryPr, "utf8"));
        writeFileSync(recoveryPr, JSON.stringify({ ...pull, number: pull.number + (partial.wrongPr ? 1 : 0),
          head: { ...pull.head, sha: partial.head }, graphExitCode: 1,
          graphErrors: partial.errors.map(field => ({ message: "Field unavailable", path: ["repository", "pullRequest", field] })),
        }));
      }
      return head;
    } });
    const { manager, store, ids } = seeded;
    try {
      await strandLegacyGrant(seeded, verifiedRecoveryOid);
      const submissions = store.listSubmissions(ids.run);
      const recover = await legacyRecoveryRoute(seeded);
      selecting = true;
      assert.equal((await recover(verifiedRecoveryOid)).status, 200);
      await manager.settleBackgroundWork();
      assert.equal(selecting, false);
      assert.equal(phaseOf(seeded), partial.blocked ? "blocked/inspector_head_mismatch" : "waiting_for_new_head/inspector_findings");
      assert.deepEqual(store.listSubmissions(ids.run), submissions);
    } finally { await manager.stop(); }
  });
}

for (const other of ["PR number", "base repository", "activity ref"] as const) {
  test(`final recovery ignores a successful response for a different ${other} and retries the same receipt`, async () => {
    let substitute = false;
    const seeded = await spentInspectorGrant({ resolveCommit: async (_root, head) => {
      if (substitute && head === priorRefOid) {
        substitute = false;
        if (other === "activity ref") {
          const [tip, ...history] = JSON.parse(readFileSync(branchActivity, "utf8"));
          writeFileSync(branchActivity, JSON.stringify([{ ...tip, ref: "refs/heads/other", after: laterRefOid }, ...history]));
        } else {
          const pull = JSON.parse(readFileSync(recoveryPr, "utf8"));
          if (other === "PR number") pull.number += 1;
          else pull.base.repo.full_name = "owner/other";
          pull.state = "closed";
          pull.head.sha = laterRefOid;
          writeFileSync(recoveryPr, JSON.stringify(pull));
        }
      }
      return head;
    } });
    const { manager, store, ids, registry, key, now } = seeded;
    try {
      await strandLegacyGrant(seeded, verifiedRecoveryOid);
      const submissions = store.listSubmissions(ids.run);
      const recover = await legacyRecoveryRoute(seeded);
      const path = other === "activity ref" ? branchActivity : recoveryPr;
      const valid = readFileSync(path);
      substitute = true;
      assert.equal((await recover()).status, 200);
      await manager.settleBackgroundWork();
      assert.equal(substitute, false);
      assert.equal(phaseOf(seeded), "waiting_for_new_head/inspector_findings");
      assert.deepEqual(store.listSubmissions(ids.run), submissions);

      writeFileSync(path, valid);
      registry.inspectionUpdated(key, verifiedRecoveryOid, "OPEN", now + 1014);
      await manager.settleBackgroundWork();
      assert.equal(store.latestSubmission(ids.run)?.prHeadSha, verifiedRecoveryOid);
      assert.equal(store.listSubmissions(ids.run).length, submissions.length + 1);
      assert.equal(eventCount(seeded, "inspector_stale_grant_recovered"), 1);
    } finally { await manager.stop(); }
  });
}

for (const source of ["PR snapshot", "ref activity"] as const) {
  test(`successful ${source} reads with invalid head OIDs keep the receipt available for a valid retry`, async () => {
    let invalidOid: string | undefined;
    const seeded = await spentInspectorGrant({ resolveCommit: async (_root, head) => {
      if (head === priorRefOid && invalidOid !== undefined) {
        if (source === "PR snapshot") {
          const pull = JSON.parse(readFileSync(recoveryPr, "utf8"));
          writeFileSync(recoveryPr, JSON.stringify({ ...pull, head: { ...pull.head, sha: invalidOid } }));
        } else {
          const [tip, ...history] = JSON.parse(readFileSync(branchActivity, "utf8"));
          writeFileSync(branchActivity, JSON.stringify([{ ...tip, after: invalidOid }, ...history]));
        }
      }
      return head;
    } });
    const { manager, store, ids, registry, key, now } = seeded;
    try {
      await strandLegacyGrant(seeded, verifiedRecoveryOid);
      const submissions = store.listSubmissions(ids.run);
      const recover = await legacyRecoveryRoute(seeded);
      const path = source === "PR snapshot" ? recoveryPr : branchActivity;
      const valid = readFileSync(path);
      invalidOid = "";
      assert.equal((await recover()).status, 200);
      const invalidOids = ["", "not-an-oid", "a".repeat(39)];
      if (source === "PR snapshot") invalidOids.push("0".repeat(40));
      for (const oid of invalidOids) {
        invalidOid = oid;
        registry.inspectionUpdated(key, verifiedRecoveryOid, "OPEN", now + 1013);
        await manager.settleBackgroundWork();
        assert.equal(phaseOf(seeded), "waiting_for_new_head/inspector_findings");
        assert.deepEqual(store.listSubmissions(ids.run), submissions);
      }
      invalidOid = undefined;
      writeFileSync(path, valid);
      registry.inspectionUpdated(key, verifiedRecoveryOid, "OPEN", now + 1014);
      await manager.settleBackgroundWork();
      assert.equal(store.latestSubmission(ids.run)?.prHeadSha, verifiedRecoveryOid);
      assert.equal(store.listSubmissions(ids.run).length, submissions.length + 1);
      assert.equal(eventCount(seeded, "inspector_stale_grant_recovered"), 1);
    } finally { await manager.stop(); }
  });
}

for (const later of ["none", "same-bucket rewrite", "different event ID"] as const) {
  test(`legacy recovery recognizes only the verified pre-grant force push: ${later}`, async () => {
    let selection = false;
    const seeded = await spentInspectorGrant({ resolveCommit: async (_root, head) => {
      if (selection && head === priorRefOid) {
        selection = false;
        const pull = JSON.parse(readFileSync(recoveryPr, "utf8"));
        const [verified] = pull.rewrites;
        const other = { ...verified, id: "subsequent-event" };
        if (later !== "none") writeFileSync(recoveryPr, JSON.stringify({ ...pull,
          rewrites: later === "different event ID" ? [other] : [verified, other] }));
      }
      return head;
    } });
    const { manager, store, ids } = seeded;
    try {
      await strandLegacyGrant(seeded, verifiedRecoveryOid);
      const [tip, ...history] = JSON.parse(readFileSync(branchActivity, "utf8"));
      const pull = JSON.parse(readFileSync(recoveryPr, "utf8"));
      const force = { __typename: "HeadRefForcePushedEvent", id: "verified-event", createdAt: tip.timestamp,
        beforeCommit: { oid: tip.before }, afterCommit: { oid: tip.after },
        ref: { prefix: "refs/heads/", name: pull.head.ref, repository: { nameWithOwner: pull.head.repo.full_name } } };
      writeFileSync(branchActivity, JSON.stringify([{ ...tip, activity_type: "force_push" }, ...history]));
      const submissions = store.listSubmissions(ids.run);
      const recover = await legacyRecoveryRoute(seeded);
      if (later === "none") {
        for (const rewrites of [[], [force, force], [{ ...force, beforeCommit: { oid: "different" } }],
          [{ ...force, afterCommit: { oid: "different" } }], [{ ...force, ref: { ...force.ref, name: "other" } }],
          [{ ...force, createdAt: new Date(Date.parse(force.createdAt) + 1_000).toISOString() }]]) {
          writeFileSync(recoveryPr, JSON.stringify({ ...pull, rewrites }));
          assert.equal((await recover()).status, 409);
        }
        assert.equal(store.listEvents(ids.run).some(event => event.kind === "inspector_stale_grant_recovered"), false);
        assert.deepEqual(store.listSubmissions(ids.run), submissions);
      }
      writeFileSync(recoveryPr, JSON.stringify({ ...pull, rewrites: [force] }));
      selection = true;
      assert.equal((await recover()).status, 200);
      await manager.settleBackgroundWork();
      if (later === "none") {
        assert.equal(store.latestSubmission(ids.run)?.prHeadSha, verifiedRecoveryOid);
        assert.equal(store.listSubmissions(ids.run).length, submissions.length + 1);
      } else {
        assert.equal(store.getRun(ids.run)?.currentPhase, "inspector_head_mismatch");
        assert.deepEqual(store.listSubmissions(ids.run), submissions);
      }
      const receipt = store.listEvents(ids.run).find(event => event.kind === "inspector_stale_grant_recovered");
      assert.ok(receipt);
      assert.equal((receipt.payload as { branchActivity: { verifiedForcePushId: string } }).branchActivity.verifiedForcePushId, force.id);
    } finally { await manager.stop(); }
  });
}

test("legacy recovery reads eligibility from the workflow store's own database", async () => {
  const seeded = await spentInspectorGrant();
  const { manager, store, ids, key, now, url } = seeded;
  try {
    await strandLegacyGrant(seeded, verifiedRecoveryOid);
    const path = join(home, "isolated-workflow-store.db");
    db.prepare("VACUUM INTO ?").run(path);
    const isolated = new DatabaseSync(path);
    try {
      const input = { grantRequestId: "legacy", submissionId: "stranded",
        staleHeadSha: priorRefOid, currentHeadSha: verifiedRecoveryOid };
      updateInspectorPr(key, { observedHeadSha: "different", observedAt: now + 1013 }, now + 1013);
      assert.equal(store.recoverStaleInspectorGrant(ids.run, "recover", input, now + 1014), null);
      assert.deepEqual(new WorkflowStore(isolated).recoverStaleInspectorGrant(ids.run, "recover", input, now + 1014),
        { verifyPrUrl: url });
    } finally { isolated.close(); }
  } finally { await manager.stop(); }
});

test("legacy recovery refuses a replacement beyond the granted cap", async () => {
  const seeded = await spentInspectorGrant();
  const { ids, store, manager } = seeded;
  try {
    const stranded = await strandLegacyGrant(seeded, verifiedRecoveryOid, { maxRepairRounds: 3 });
    const before = store.getRun(ids.run);
    assert.equal(stranded.submission.round, 3);
    assert.equal(before?.maxRepairRounds, 3);
    const submissions = store.listSubmissions(ids.run);
    const recover = await legacyRecoveryRoute(seeded);
    assert.equal((await recover()).status, 409);
    await manager.settleBackgroundWork();
    assert.deepEqual(store.getRun(ids.run), before);
    assert.deepEqual(store.listSubmissions(ids.run), submissions);
    assert.equal(store.listEvents(ids.run).some(e => e.kind === "inspector_stale_grant_recovered"), false);
  } finally { await manager.stop(); }
});

test("legacy recovery route refuses unavailable, closed, wrong-identity and changed-head PR reads", async () => {
  const seeded = await spentInspectorGrant();
  const { ids, store, manager } = seeded;
  try {
    await strandLegacyGrant(seeded, verifiedRecoveryOid);
    const before = store.getRun(ids.run);
    const submissions = store.listSubmissions(ids.run);
    const valid = JSON.parse(readFileSync(recoveryPr, "utf8"));
    const recover = await legacyRecoveryRoute(seeded);
    rmSync(recoveryPr);
    for (const response of [null, { ...valid, state: "closed" }, { ...valid, number: valid.number + 1 },
      { ...valid, base: { repo: { full_name: "owner/other" } } }, { ...valid, head: { ...valid.head, sha: laterRefOid } }]) {
      if (response) writeFileSync(recoveryPr, JSON.stringify(response));
      assert.equal((await recover()).status, 409);
      await manager.settleBackgroundWork();
      assert.deepEqual(store.getRun(ids.run), before);
      assert.deepEqual(store.listSubmissions(ids.run), submissions);
      assert.equal(store.listEvents(ids.run).some(e => e.kind === "inspector_stale_grant_recovered"), false);
    }
  } finally { await manager.stop(); }
});

test("legacy grant that selected the current head cannot recover from an ordinary later push", async () => {
  const seeded = await spentInspectorGrant();
  const { ids, store, manager } = seeded;
  try {
    await strandLegacyGrant(seeded, priorRefOid);
    const before = store.getRun(ids.run);
    const submissions = store.listSubmissions(ids.run);
    assert.equal((await manager.recoverStaleInspectorGrant(ids.run, "refuse", {
      grantRequestId: "legacy", submissionId: "stranded", staleHeadSha: priorRefOid, currentHeadSha: verifiedRecoveryOid,
    })).ok, false);
    assert.deepEqual(store.getRun(ids.run), before);
    assert.deepEqual(store.listSubmissions(ids.run), submissions);
    assert.equal(store.listEvents(ids.run).some(e => e.kind === "inspector_stale_grant_recovered"), false);
  } finally { await manager.stop(); }
});

test("legacy B to A to B stays blocked even with a retained pre-grant review of B", async () => {
  const seeded = await spentInspectorGrant();
  const { key, ids, manager, store, now } = seeded;
  try {
    await strandLegacyGrant(seeded, verifiedRecoveryOid, { returnedToPinnedHead: true });
    const ledger = getInspectorPr(key)!;
    assert.equal(ledger.headSha, verifiedRecoveryOid);
    assert.equal(ledger.lastReviewedAt, now + 8);
    const request = { grantRequestId: "legacy", submissionId: "stranded", staleHeadSha: priorRefOid, currentHeadSha: verifiedRecoveryOid };
    const before = store.getRun(ids.run);
    assert.equal((await manager.recoverStaleInspectorGrant(ids.run, "deny-aba", request)).ok, false);
    await manager.settleBackgroundWork();
    assert.deepEqual(store.getRun(ids.run), before);
    assert.equal(store.latestSubmission(ids.run)?.id, "stranded");
    assert.equal(store.listEvents(ids.run).some(e => e.kind === "inspector_stale_grant_recovered"), false);
  } finally { await manager.stop(); }
});

test("a post-grant return to the witnessed head stays blocked when GitHub's clock is behind", async () => {
  const seeded = await spentInspectorGrant();
  const { ids, now, store, manager } = seeded;
  try {
    await strandLegacyGrant(seeded, verifiedRecoveryOid, { returnedToPinnedHead: true });
    const [latest, anchor] = JSON.parse(readFileSync(branchActivity, "utf8"));
    // The daemon observed B, then A, then granted at now + 1010. GitHub's clock
    // is 5 seconds behind: its later return to B passes the old timestamp cutoff.
    const providerTime = (local: number) => new Date(now + local - 5_000).toISOString();
    writeFileSync(branchActivity, JSON.stringify([
      { ...latest, id: 103, timestamp: providerTime(1012) },
      { ...latest, id: 102, before: verifiedRecoveryOid, after: priorRefOid, timestamp: providerTime(9) },
      { ...latest, timestamp: providerTime(6) },
      anchor,
    ]));
    const before = store.getRun(ids.run);
    const submissions = store.listSubmissions(ids.run);
    const recover = await legacyRecoveryRoute(seeded);
    assert.equal((await recover()).status, 409);
    await manager.settleBackgroundWork();
    assert.deepEqual(store.getRun(ids.run), before);
    assert.deepEqual(store.listSubmissions(ids.run), submissions);
    assert.equal(store.listEvents(ids.run).some(e => e.kind === "inspector_stale_grant_recovered"), false);
  } finally { await manager.stop(); }
});

test("legacy grant recovery fails closed on unavailable, inconsistent or time-ambiguous branch activity", async () => {
  const seeded = await spentInspectorGrant();
  const { ids, store, now, manager } = seeded;
  try {
    await strandLegacyGrant(seeded, verifiedRecoveryOid);
    const request = { grantRequestId: "legacy", submissionId: "stranded", staleHeadSha: priorRefOid, currentHeadSha: verifiedRecoveryOid };
    const [valid, ...history] = JSON.parse(readFileSync(branchActivity, "utf8"));
    const submissions = store.listSubmissions(ids.run);
    rmSync(branchActivity);
    assert.equal((await manager.recoverStaleInspectorGrant(ids.run, "refuse", request)).ok, false);
    for (const response of [[], [{ ...valid, ref: "refs/heads/other" }], [{ ...valid, after: "unknown" }],
      [{ ...valid, timestamp: new Date(now + 1009).toISOString() }],
      [{ ...valid, pushed_at: new Date(now + 7).toISOString() }]]) {
      writeFileSync(branchActivity, JSON.stringify([...response, ...history]));
      assert.equal((await manager.recoverStaleInspectorGrant(ids.run, "refuse", request)).ok, false);
    }
    await manager.settleBackgroundWork();
    assert.equal(store.getRun(ids.run)?.status, "blocked");
    assert.equal(store.getRun(ids.run)?.currentPhase, "inspector_head_mismatch");
    assert.deepEqual(store.listSubmissions(ids.run), submissions);
    assert.equal(store.listEvents(ids.run).some(e => e.kind === "inspector_stale_grant_recovered"), false);
  } finally { await manager.stop(); }
});

test("a skewed GitHub clock requires contiguous ref history through PR creation", async () => {
  const seeded = await spentInspectorGrant();
  const { ids, now, store, manager } = seeded;
  try {
    await strandLegacyGrant(seeded, verifiedRecoveryOid);
    const [tip, anchor] = JSON.parse(readFileSync(branchActivity, "utf8"));
    const prCreatedAt = Date.parse(JSON.parse(readFileSync(recoveryPr, "utf8")).created_at);
    const unique = { ...tip, timestamp: new Date(now - 5_000).toISOString() };
    const submissions = store.listSubmissions(ids.run);
    const recover = await legacyRecoveryRoute(seeded);
    for (const history of [
      [unique], // retained page ends before reaching an update older than PR creation
      [unique, { ...anchor, after: laterRefOid }],
      [unique, { ...anchor, id: unique.id }],
      [unique, { ...anchor, ref: "refs/heads/other" }],
      [unique, { ...anchor, timestamp: new Date(now - 4_000).toISOString() }],
      [unique, { ...anchor, timestamp: new Date(prCreatedAt - 999).toISOString() }],
      [{ ...unique, before: "0".repeat(40) }, anchor], // branch recreated after PR creation
    ]) {
      writeFileSync(branchActivity, JSON.stringify(history));
      assert.equal((await recover()).status, 409);
      assert.equal(store.getRun(ids.run)?.currentPhase, "inspector_head_mismatch");
      assert.deepEqual(store.listSubmissions(ids.run), submissions);
      assert.equal(store.listEvents(ids.run).some(e => e.kind === "inspector_stale_grant_recovered"), false);
    }
    writeFileSync(branchActivity, JSON.stringify([unique, { ...anchor, timestamp: new Date(prCreatedAt - 1_000).toISOString() }]));
    assert.equal((await recover()).status, 200);
    await manager.settleBackgroundWork();
    assert.equal(store.latestSubmission(ids.run)?.prHeadSha, verifiedRecoveryOid);
    const receipt = store.listEvents(ids.run).find(e => e.kind === "inspector_stale_grant_recovered");
    assert.ok(receipt);
    assert.deepEqual((receipt.payload as { branchActivity: { refHistory: unknown } }).branchActivity.refHistory,
      { prCreatedAt, anchorActivityId: anchor.id, anchorChangedAt: prCreatedAt - 1_000, updatesChecked: 2 });
  } finally { await manager.stop(); }
});

test("a poll started before the grant requires a retained completed read before the grant", async () => {
  const seeded = await spentInspectorGrant();
  const { key, ids, now, store, manager } = seeded;
  try {
    await strandLegacyGrant(seeded, verifiedRecoveryOid);
    const recover = await legacyRecoveryRoute(seeded);
    const submissions = store.listSubmissions(ids.run);
    const observation = { headSha: verifiedRecoveryOid, state: "OPEN" as const, draft: false, findings: [] };
    const grant = store.listEvents(ids.run).find(e => e.kind === "repair_rounds_granted")!;
    for (const at of [grant.timestamp, grant.timestamp + 1]) {
      recordCodeRabbit(key, observation, at);
      assert.equal((await recover()).status, 409);
    }
    assert.equal(store.getRun(ids.run)?.currentPhase, "inspector_head_mismatch");
    assert.deepEqual(store.listSubmissions(ids.run), submissions);
    assert.equal(store.listEvents(ids.run).some(e => e.kind === "inspector_stale_grant_recovered"), false);

    // A later poll can overwrite the scan while preserving its earlier delivery claim.
    recordCodeRabbit(key, { ...observation, findings: [{ id: "thread", rootId: "root", url: "https://github.com/owner/repo",
      path: null, identity: "finding", resolved: false }] }, now + 8);
    const { observationId } = readCodeRabbit(key)!;
    assert.ok(claimCodeRabbit(key, { noteKey: "note", episodeKey: "episode" }, observationId, now + 9));
    recordCodeRabbit(key, observation, grant.timestamp + 1);
    assert.equal((await recover()).status, 200);
    await manager.settleBackgroundWork();
    assert.equal(store.latestSubmission(ids.run)?.prHeadSha, verifiedRecoveryOid);
    const receipt = store.listEvents(ids.run).find(e => e.kind === "inspector_stale_grant_recovered");
    assert.ok(receipt);
    assert.deepEqual((receipt.payload as { completedObservation: unknown }).completedObservation,
      { source: "delivery_claim", observationId, at: now + 9 });
  } finally { await manager.stop(); }
});

for (const elapsedMs of [1_000, 999]) {
  test(`legacy recovery branch activity cutoff: ${elapsedMs} ms before the grant`, async () => {
    const seeded = await spentInspectorGrant();
    const { ids, store, manager } = seeded;
    try {
      await strandLegacyGrant(seeded, verifiedRecoveryOid);
      const grant = store.listEvents(ids.run).find(e => e.kind === "repair_rounds_granted");
      assert.ok(grant);
      const changedAt = grant.timestamp - elapsedMs;
      const [activity, ...history] = JSON.parse(readFileSync(branchActivity, "utf8"));
      writeFileSync(branchActivity, JSON.stringify([{ ...activity, timestamp: new Date(changedAt).toISOString() }, ...history]));
      const before = store.listSubmissions(ids.run);
      const recover = await legacyRecoveryRoute(seeded);
      const response = await recover();
      await manager.settleBackgroundWork();
      const submissions = store.listSubmissions(ids.run);
      const receipts = store.listEvents(ids.run).filter(e => e.kind === "inspector_stale_grant_recovered");
      if (elapsedMs === 1_000) {
        assert.equal(response.status, 200);
        assert.equal(submissions.length, before.length + 1);
        assert.equal(store.latestSubmission(ids.run)?.prHeadSha, verifiedRecoveryOid);
        assert.equal(receipts.length, 1);
      } else {
        assert.equal(response.status, 409);
        assert.equal(store.getRun(ids.run)?.currentPhase, "inspector_head_mismatch");
        assert.deepEqual(submissions, before);
        assert.equal(receipts.length, 0);
      }
    } finally { await manager.stop(); }
  });
}

test("legacy recovery accepts branch activity with only pushed_at and records its time", async () => {
  const seeded = await spentInspectorGrant();
  const { ids, store, manager, now } = seeded;
  try {
    await strandLegacyGrant(seeded, verifiedRecoveryOid);
    const pushedAt = now + 7;
    const [, ...history] = JSON.parse(readFileSync(branchActivity, "utf8"));
    writeFileSync(branchActivity, JSON.stringify([{ id: 102, ref: "refs/heads/feature", before: priorRefOid,
      after: verifiedRecoveryOid, pushed_at: new Date(pushedAt).toISOString() }, ...history]));
    const recover = await legacyRecoveryRoute(seeded);
    assert.equal((await recover()).status, 200);
    await manager.settleBackgroundWork();
    assert.equal(store.latestSubmission(ids.run)?.prHeadSha, verifiedRecoveryOid);
    const receipt = store.listEvents(ids.run).find(e => e.kind === "inspector_stale_grant_recovered");
    assert.ok(receipt);
    assert.deepEqual((receipt.payload as { branchActivity: unknown }).branchActivity, {
      prKey: seeded.key, repository: "author/fork", ref: "refs/heads/feature",
      headSha: verifiedRecoveryOid, activityId: 102, changedAt: pushedAt,
      refHistory: { prCreatedAt: now - 10_000, anchorActivityId: 99, anchorChangedAt: now - 12_000, updatesChecked: 2 },
    });
  } finally { await manager.stop(); }
});

test("legacy grant recovery refuses missing, overwritten and ambiguous pre-grant proof", async () => {
  const seeded = await spentInspectorGrant();
  const { key, ids, store, manager, now } = seeded;
  try {
    await strandLegacyGrant(seeded, verifiedRecoveryOid);
    const request = { grantRequestId: "legacy", submissionId: "stranded", staleHeadSha: priorRefOid, currentHeadSha: verifiedRecoveryOid };
    for (const proof of [
      { headSha: verifiedRecoveryOid, lastReviewedAt: null },
      { headSha: verifiedRecoveryOid, lastReviewedAt: now + 4 }, // tied with the budget block
      { headSha: verifiedRecoveryOid, lastReviewedAt: now + 1010 }, // tied with the grant
      { headSha: verifiedRecoveryOid, lastReviewedAt: now + 1013 }, // a subsequent review replaced the witness
      { headSha: "different", lastReviewedAt: now + 8 },
    ]) {
      updateInspectorPr(key, proof, now + 1014);
      assert.equal((await manager.recoverStaleInspectorGrant(ids.run, "refuse", request)).ok, false);
    }
    assert.equal(store.getRun(ids.run)?.currentPhase, "inspector_head_mismatch");
    assert.equal(store.latestSubmission(ids.run)?.id, "stranded");
    assert.equal(store.listEvents(ids.run).some(e => e.kind === "inspector_stale_grant_recovered"), false);
  } finally { await manager.stop(); }
});

test("a legacy grant can use a delayed pre-grant observation without treating it as a review", async () => {
  const seeded = await spentInspectorGrant();
  const { ids, store, manager, now } = seeded;
  try {
    await strandLegacyGrant(seeded, verifiedRecoveryOid, { delayedObservation: true });
    const result = await manager.recoverStaleInspectorGrant(ids.run, "recover", {
      grantRequestId: "legacy", submissionId: "stranded", staleHeadSha: priorRefOid, currentHeadSha: verifiedRecoveryOid,
    });
    assert.ok(result.ok);
    await manager.settleBackgroundWork();
    const receipt = store.listEvents(ids.run).find(e => e.kind === "inspector_stale_grant_recovered");
    assert.ok(receipt);
    assert.deepEqual((receipt.payload as { preGrantWitness: unknown }).preGrantWitness,
      { source: "gate_observation", observedAt: now + 8, headSha: verifiedRecoveryOid });
    assert.equal(store.latestSubmission(ids.run)?.prHeadSha, verifiedRecoveryOid);
    assert.equal(store.getRun(ids.run)?.currentPhase, "inspector_review");
  } finally { await manager.stop(); }
});

test("explicit legacy-grant recovery uses remaining budget and retains both submission audits", async () => {
  const seeded = await spentInspectorGrant();
  const { key, ids, manager, store, now, registry } = seeded;
  try {
    const stranded = await strandLegacyGrant(seeded, verifiedRecoveryOid);
    assert.equal(manager.recheckInspector(ids.run, "ordinary").ok, false);
    const request = { grantRequestId: "legacy", submissionId: "stranded", staleHeadSha: priorRefOid, currentHeadSha: verifiedRecoveryOid };
    for (const invalid of [{ grantRequestId: "other" }, { submissionId: "failed-sub" },
      { staleHeadSha: "different" }, { currentHeadSha: "failed" }, { currentHeadSha: "unobserved" }]) {
      assert.equal((await manager.recoverStaleInspectorGrant(ids.run, "recover", { ...request, ...invalid })).ok, false);
    }
    const recover = await legacyRecoveryRoute(seeded);
    const recovered = await recover();
    assert.equal(recovered.status, 200);
    assert.equal((await recovered.json()).idempotent, false);
    await manager.settleBackgroundWork();
    const committedSubmissions = store.listSubmissions(ids.run);
    const committedEvents = store.listEvents(ids.run);
    assert.equal((await recover("different-replacement")).status, 409);
    assert.deepEqual(store.listSubmissions(ids.run), committedSubmissions);
    assert.deepEqual(store.listEvents(ids.run), committedEvents);
    rmSync(branchActivity); // A replay uses the committed receipt even during an outage.
    const replay = await recover();
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).idempotent, true);
    await manager.settleBackgroundWork();
    assert.deepEqual(store.getSubmission("stranded"), stranded.submission);
    assert.equal(store.latestSubmission(ids.run)?.prHeadSha, verifiedRecoveryOid);
    assert.equal(store.latestSubmission(ids.run)?.round, 4);
    assert.deepEqual(store.latestSubmission(ids.run)?.context, {
      newHeadSha: verifiedRecoveryOid, failedHeadSha: "failed", priorFindingFingerprints: ["prior-finding"],
      bypassReason: "Published GitHub Inspector-only findings policy",
    });
    assert.equal(store.getRun(ids.run)?.maxRepairRounds, 4);
    assert.equal(store.getRun(ids.run)?.currentPhase, "inspector_clean_review");
    const receipts = store.listEvents(ids.run).filter(e => e.kind === "inspector_stale_grant_recovered");
    assert.equal(receipts.length, 1);
    const [receipt] = receipts;
    assert.ok(receipt);
    assert.deepEqual((receipt.payload as { branchActivity: unknown }).branchActivity, {
      prKey: key, repository: "author/fork", ref: "refs/heads/feature", headSha: verifiedRecoveryOid, activityId: 101, changedAt: now + 6,
      refHistory: { prCreatedAt: now - 10_000, anchorActivityId: 99, anchorChangedAt: now - 12_000, updatesChecked: 2 },
    });
    assert.deepEqual((receipt.payload as { preGrantWitness: unknown }).preGrantWitness,
      { source: "inspector_review", observedAt: now + 8, headSha: verifiedRecoveryOid });
    registry.inspectionUpdated(key, "another", "OPEN", now + 1015);
    await manager.settleBackgroundWork();
    assert.equal(store.getRun(ids.run)?.currentPhase, "inspector_head_mismatch");
    assert.equal((await manager.recoverStaleInspectorGrant(ids.run, "again", request)).ok, false);
  } finally { await manager.stop(); }
});
