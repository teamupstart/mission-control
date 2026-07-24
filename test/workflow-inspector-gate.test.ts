import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type {
  InspectorComment,
  InspectorPr,
} from "../src/shared/types.ts";
import type {
  WorkflowContextSnapshot,
  WorkflowInspectorGateState,
} from "../src/shared/workflow.ts";
import { mkMuxHandle } from "./helpers/session-fixture.ts";

// What is at stake: a successful Persona End is not completion when the published
// version owns an Inspector gate. Every conclusion must be about an adopted PR and a
// fresh observation of the exact clean, committed head.
const home = mkdtempSync(join(tmpdir(), "mission-workflow-inspector-gate-"));
process.env.MISSION_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const {
  adoptInspectorPr,
  openDb,
  updateInspectorPr,
  upsertInspectorComment,
} = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { setInspectorConfig } = await import("../src/server/inspector/config.ts");
const { WorkflowManager } = await import("../src/server/workflows/manager.ts");
const {
  WorkflowStore,
  clearWorkflowTables,
  workflowJson,
} = await import("../src/server/workflows/store.ts");

const db = openDb();
let serial = 0;

function context(headSha: string, workingTreeDirty = false): WorkflowContextSnapshot {
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
    adoptedAt: now,
    updatedAt: now,
  };
}

interface SeedOptions {
  policy?: "none" | "restart_workflow" | "inspector_only";
  adopted?: boolean;
  withHint?: boolean;
  dirty?: boolean;
  enabled?: boolean;
  head?: string;
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
  const key = `owner/repo#${100 + serial}`;
  const url = `https://github.com/owner/repo/pull/${100 + serial}`;
  const policy = over.policy ?? "restart_workflow";
  const completionPolicy = policy === "none"
    ? { kind: "none" as const }
    : {
        kind: "inspector" as const,
        onFindings: policy,
        missingPrAction: "offer_prepare_pr" as const,
      };
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
       binding_defaults_json, draft_revision, current_version_id, archived_at, created_at, updated_at
     ) VALUES (?, ?, ?, '', ?, ?, ?, 1, ?, NULL, 1, 1)`,
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
       completion_policy_json, binding_defaults_json, published_at
     ) VALUES (?, ?, 1, 1, ?, ?, ?, 1)`,
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
    agent: "claude",
    name: "work",
    nameSource: "process",
    cwd: "/repo",
    gitBranch: "feature",
    gitRoot: "/repo",
    repoRoot: "/repo",
    nomistakesGated: false,
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
      prCreated: false,
    });
  }
  const now = Date.now() - 1_000;
  if (over.adopted ?? true) adoptInspectorPr(inspectorPr(key, url, ids.session, now));

  const store = new WorkflowStore(db);
  const binding = store.insertBinding({
    id: ids.binding,
    workflowVersionId: ids.version,
    noteKey: (over.withHint ?? true) ? `agent-${suffix}` : ids.session,
    sessionId: ids.session,
    sessionAgent: "claude",
    sessionName: "work",
    sessionCwd: "/repo",
    sessionRepoRoot: "/repo",
    triggerMode: "manual",
    deliveryMode: "preview",
    maxRepairRounds: 3,
    now,
  });
  store.createInitialSubmission(
    {
      id: ids.run,
      binding,
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
  const captured = context(head, over.dirty ?? false);
  store.updateSubmissionCapture(ids.submission, {
    context: workflowJson(captured),
    evidence: workflowJson(captured.evidence),
    fingerprint: `fingerprint-${suffix}`,
    status: "running",
  }, now);
  store.setRunState(ids.run, "running", "persona_review", null, now);
  const manager = new WorkflowManager(registry, store);
  const claimed = (manager as unknown as {
    enterInspectorGate(id: string, at: number): boolean;
  }).enterInspectorGate(ids.submission, now);
  manager.start();
  return { ids, head, key, url, manager, registry, store, claimed, now };
}

async function waitFor(check: () => boolean, message: string): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > 2_000) assert.fail(message);
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

test("no final-gate policy keeps the Phase 4 completion path unclaimed", async () => {
  const seeded = await seed({ policy: "none" });
  assert.equal(seeded.claimed, false);
  assert.equal(seeded.store.getRun(seeded.ids.run)?.status, "running");
  assert.equal(seeded.store.getRun(seeded.ids.run)?.gateState, null);
  await seeded.manager.stop();
});

test("missing and unadopted PR hints wait without creating Inspector provenance", async () => {
  const missing = await seed({ withHint: false, adopted: false });
  assert.equal(missing.store.getRun(missing.ids.run)?.status, "waiting_for_pr");
  assert.equal((missing.store.getRun(missing.ids.run)?.gateState as { waitReason: string }).waitReason, "missing_pr");
  const handoff = await missing.manager.preparePr(missing.ids.run, "prepare-request");
  assert.equal(handoff.ok, true);
  if (handoff.ok) {
    assert.equal(handoff.value.kind, "pr_handoff");
    assert.match(handoff.value.payload, /Commit all reviewed work, push it, open the pull request/);
  }
  const repeatedHandoff = await missing.manager.preparePr(missing.ids.run, "prepare-request");
  assert.equal(repeatedHandoff.ok && repeatedHandoff.idempotent, true);
  assert.equal(missing.store.getRun(missing.ids.run)?.status, "waiting_for_session");
  await missing.manager.stop();

  const unadopted = await seed({ withHint: true, adopted: false });
  assert.equal(unadopted.store.getRun(unadopted.ids.run)?.status, "waiting_for_pr");
  assert.equal((unadopted.store.getRun(unadopted.ids.run)?.gateState as { waitReason: string }).waitReason, "unadopted_pr");
  assert.equal(
    (openDb().prepare(`SELECT COUNT(*) AS n FROM inspector_prs WHERE key = ?`).get(unadopted.key) as { n: number }).n,
    0,
    "session.prUrl is a lookup hint and cannot adopt",
  );
  await unadopted.manager.stop();
});

test("disabled Inspector blocks honestly and a post-entry observation is required", async () => {
  const disabled = await seed({ enabled: false });
  assert.equal(disabled.store.getRun(disabled.ids.run)?.status, "blocked");
  assert.equal((disabled.store.getRun(disabled.ids.run)?.gateState as { waitReason: string }).waitReason, "inspector_disabled");
  await disabled.manager.stop();

  const waiting = await seed();
  assert.equal(waiting.store.getRun(waiting.ids.run)?.status, "waiting_for_inspector");
  assert.equal((waiting.store.getRun(waiting.ids.run)?.gateState as { lastObservedAt: number | null }).lastObservedAt, null);
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
  assert.equal(mismatch.store.getRun(mismatch.ids.run)?.status, "waiting_for_inspector");
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
