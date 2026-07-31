import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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
const { setWorkflowConfig } = await import("../src/server/workflows/config.ts");
const { WorkflowManager } = await import("../src/server/workflows/manager.ts");
const {
  WorkflowStore,
  clearWorkflowTables,
  workflowJson,
} = await import("../src/server/workflows/store.ts");

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
    adoptedAt: now,
    updatedAt: now,
  };
}

interface SeedOptions {
  policy?: "none" | "restart_workflow" | "inspector_only";
  missingPrAction?: "offer_prepare_pr" | "prepare_pr";
  deliveryMode?: "preview" | "live";
  adopted?: boolean;
  withHint?: boolean;
  dirty?: boolean;
  enabled?: boolean;
  head?: string;
  skillAvailable?: boolean;
  agent?: AgentType;
  startBeforeGate?: boolean;
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
    sessionAgent: agent,
    sessionName: "work",
    sessionCwd: "/repo",
    sessionRepoRoot: "/repo",
    triggerMode: "manual",
    deliveryMode: over.deliveryMode ?? "preview",
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
  const captured = context(head, over.dirty ?? false, agent);
  store.updateSubmissionCapture(ids.submission, {
    context: workflowJson(captured),
    evidence: workflowJson(captured.evidence),
    fingerprint: `fingerprint-${suffix}`,
    status: "running",
  }, now);
  store.setRunState(ids.run, "running", "persona_review", null, now);
  const injected: string[] = [];
  if (over.deliveryMode === "live") {
    setWorkflowConfig({ liveEnabled: true, repoAllowlist: ["/repo"] });
  }
  const manager = new WorkflowManager(registry, store, {
    inject: async (_session, payload) => {
      injected.push(payload);
      return { ok: true, pasted: true, submitVerified: true };
    },
    recordInjection: () => {},
    requireSkill: (session, id) => over.skillAvailable === false
      ? { ok: false, message: `${id} is not ready` }
      : { ok: true, command: skillCommand(session.agent, id)! },
    readEvidenceProbe: async () => ({
      headSha: head,
      workingTreeStatus: over.dirty ? [" M src/file.ts"] : [],
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

  setWorkflowConfig({ liveEnabled: true, repoAllowlist: ["/repo"] });
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
    setWorkflowConfig({ liveEnabled: false, repoAllowlist: ["/repo"] });
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
    setWorkflowConfig({ liveEnabled: false, repoAllowlist: ["/repo"] });
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
    setWorkflowConfig({ liveEnabled: false, repoAllowlist: ["/repo"] });
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
    setWorkflowConfig({ liveEnabled: false, repoAllowlist: ["/repo"] });
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
      seeded.manager.blocksMerge(staleKey),
      false,
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
    assert.equal(seeded.manager.blocksMerge(seeded.key), true);

    await seeded.manager.stop();
    const recovered = new WorkflowManager(seeded.registry, seeded.store);
    try {
      // No Inspector event and no Session.prUrl has been restored. The persisted adoption row
      // alone must fail closed until normal Inspector reconciliation pins and evaluates it.
      assert.equal(recovered.blocksMerge(seeded.key), true);
    } finally {
      await recovered.stop();
    }
  } finally {
    await seeded.manager.stop();
    setWorkflowConfig({ liveEnabled: false, repoAllowlist: ["/repo"] });
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
      assert.equal(seeded.manager.blocksMerge(seeded.key), false);

      seeded.registry.applyHook({
        agent: "claude",
        event: "PostToolUse",
        sessionId: seeded.ids.session,
        cwd: repoRoot ?? "/repo",
        transcriptPath: null,
        env: { tmuxPane: `%${serial}` },
        prUrl: seeded.url,
        prCreated: false,
      });
      seeded.registry.inspectionUpdated(seeded.key, null, null, adoptedAt);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(
        (seeded.store.getRun(seeded.ids.run)?.gateState as { prKey?: string | null })?.prKey,
        null,
      );
    } finally {
      await seeded.manager.stop();
      setWorkflowConfig({ liveEnabled: false, repoAllowlist: ["/repo"] });
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
    setWorkflowConfig({ liveEnabled: false, repoAllowlist: ["/repo"] });
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
  setWorkflowConfig({ liveEnabled: true, repoAllowlist: ["/repo"] });
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
    setWorkflowConfig({ liveEnabled: false, repoAllowlist: ["/repo"] });
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

test("sessionless Inspector-only findings still wait for a new head", async () => {
  const seeded = await seed({ policy: "inspector_only" });
  updateInspectorPr(seeded.key, {
    headSha: seeded.head,
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

test("sessionless full-workflow findings remain visible and blocked", async () => {
  const seeded = await seed();
  updateInspectorPr(seeded.key, {
    headSha: seeded.head,
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
  setWorkflowConfig({ liveEnabled: true, repoAllowlist: ["/repo"] });
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
  setWorkflowConfig({ liveEnabled: false, repoAllowlist: ["/repo"] });
});

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
  setWorkflowConfig({ liveEnabled: true, repoAllowlist: ["/repo"] });
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
  setWorkflowConfig({ liveEnabled: false, repoAllowlist: ["/repo"] });
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
  setWorkflowConfig({ liveEnabled: true, repoAllowlist: ["/repo"] });
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
  setWorkflowConfig({ liveEnabled: false, repoAllowlist: ["/repo"] });
});
