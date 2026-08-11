import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type { Task, TaskRepoEntry } from "../src/shared/types.ts";
import type { WorkflowBinding, WorkflowContextSnapshot } from "../src/shared/workflow.ts";
import { mkTask, mkMuxHandle } from "./helpers/session-fixture.ts";

// One workflow run is one repository.
//
// What is at stake, in both directions. Too few runs and a repository's changes ship with no
// review at all - the failure this phase exists to prevent, and the one that is invisible
// until somebody reads the merged diff. Too many and a repository that was never touched
// holds a pull request behind a review of nothing, or worse, pins a SIBLING repository's pull
// request and vetoes a merge adopted decision 4 says must be independent.
//
// The concurrency lives entirely at the binding and run layer. Every run below is an ordinary
// single-repository run: same adapter proofs, same `(round, segment)` evidence identity, same
// gate vocabulary. That is the design constraint, and the last test in this file is the one
// that says so - a single-repo session must come out of every rule here unchanged.

const home = mkdtempSync(join(tmpdir(), "mission-per-repo-runs-"));
process.env.MISSION_HOME = home;
process.env.HARNESS_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { openDb, adoptInspectorPr } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { setInspectorConfig } = await import("../src/server/inspector/config.ts");
const { setWorkflowConfig } = await import("../src/server/workflows/config.ts");
const { WorkflowManager } = await import("../src/server/workflows/manager.ts");
const { WorkflowStore, clearWorkflowTables, workflowJson } =
  await import("../src/server/workflows/store.ts");
const { workflowCheckoutPath } = await import("../src/server/workflows/context.ts");

const db = openDb();

const PRIMARY_ROOT = "/repo";
const SECOND_ROOT = "/second";
const PRIMARY_BASE = "a".repeat(40);
const SECOND_BASE = "b".repeat(40);
const MOVED = "c".repeat(40);

let serial = 0;

function entry(over: Partial<TaskRepoEntry> = {}): TaskRepoEntry {
  return {
    repoRoot: SECOND_ROOT,
    worktreePath: null,
    branch: "feat/work",
    provider: "git",
    baseSha: SECOND_BASE,
    prUrl: null,
    prState: null,
    mergedAt: null,
    ...over,
  };
}

function snapshot(cwd: string, headSha: string): WorkflowContextSnapshot {
  return {
    primaryGoal: { rawPrompt: "Rename the shared field", refined: null, sourceNoteKey: "note" },
    humanDecisions: [],
    constraints: [],
    acceptanceCriteria: [],
    priorPersonaFeedback: [],
    session: { agent: "claude", name: "work", cwd, branch: "feat/work" },
    evidence: {
      headSha,
      diffFingerprint: `diff-${cwd}`,
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

interface SeedOptions {
  /** Attached repos on the task. Empty means a single-repo task. */
  extras?: TaskRepoEntry[];
  /** Observed worktree heads, keyed by worktree path. Absent means "nothing has looked". */
  heads?: Record<string, string>;
  /** Whether the task exists at all - a bound conversation with no task is the manual case. */
  withTask?: boolean;
  triggerMode?: "manual" | "foreman_complete";
  deliveryMode?: "preview" | "live";
}

/**
 * A dispatched session with a workflow armed on its own checkout, and a task attaching
 * however many repositories the case needs.
 *
 * Deliberately close to what dispatch produces: one session whose cwd is the primary
 * worktree, one active binding on the conversation, and per-repo worktrees recorded on the
 * task. Everything a per-repo run needs to exist is derived from those - nothing here creates
 * a secondary binding, because the whole point is that the trigger does.
 */
function seed(over: SeedOptions = {}) {
  clearWorkflowTables(db);
  serial += 1;
  const suffix = String(serial);
  const sessionId = `session-${suffix}`;
  const agentSessionId = `agent-${suffix}`;
  const taskId = `task-${suffix}`;
  const primaryCwd = `/wt/${suffix}-0`;
  const secondCwd = `/wt/${suffix}-1`;
  const versionId = `v-${suffix}`;
  const workflowId = `w-${suffix}`;

  const graph = {
    nodes: [
      { id: "session", kind: "session", position: { x: 0, y: 0 } },
      { id: "end", kind: "end", outcome: "Complete", position: { x: 200, y: 0 } },
    ],
    edges: [],
  };
  const completionPolicy = {
    kind: "inspector" as const,
    onFindings: "restart_workflow" as const,
    missingPrAction: "wait" as const,
  };
  const defaults = {
    triggerMode: over.triggerMode ?? ("manual" as const),
    deliveryMode: over.deliveryMode ?? ("preview" as const),
    maxRepairRounds: 3,
  };
  db.prepare(
    `INSERT INTO workflow_definitions (
       id, name, normalized_name, description, draft_graph_json, completion_policy_json,
       resumption_policy, binding_defaults_json, draft_revision, current_version_id,
       archived_at, created_at, updated_at
     ) VALUES (?, ?, ?, '', ?, ?, 'auto', ?, 1, ?, NULL, 1, 1)`,
  ).run(
    workflowId,
    `Workflow ${suffix}`,
    `workflow ${suffix}`,
    JSON.stringify(graph),
    JSON.stringify(completionPolicy),
    JSON.stringify(defaults),
    versionId,
  );
  db.prepare(
    `INSERT INTO workflow_versions (
       id, workflow_id, version, source_draft_revision, graph_json,
       completion_policy_json, resumption_policy, binding_defaults_json, published_at
     ) VALUES (?, ?, 1, 1, ?, ?, 'auto', ?, 1)`,
  ).run(
    versionId,
    workflowId,
    JSON.stringify(graph),
    JSON.stringify(completionPolicy),
    JSON.stringify(defaults),
  );

  setInspectorConfig({ enabled: true, mode: "live", repoAllowlist: [PRIMARY_ROOT, SECOND_ROOT] });

  const registry = new Registry();
  registry.applyDiscovery([{
    syntheticId: sessionId,
    agent: "claude",
    name: "work",
    nameSource: "process",
    cwd: primaryCwd,
    gitBranch: "feat/work",
    gitRoot: PRIMARY_ROOT,
    repoRoot: PRIMARY_ROOT,
    pid: 1000 + serial,
    tty: `ttys${serial}`,
    terminals: [mkMuxHandle({ paneId: `%${serial}` })],
    startedAt: 1,
  } as DiscoveredSession]);
  registry.applyHook({
    agent: "claude",
    event: "Stop",
    sessionId: agentSessionId,
    cwd: primaryCwd,
    transcriptPath: null,
    env: { tmuxPane: `%${serial}` },
  });

  const extras = (over.extras ?? [entry({ worktreePath: secondCwd })]);
  if (over.withTask !== false) {
    registry.upsertTask(mkTask({
      id: taskId,
      title: "Rename the shared field",
      status: "running",
      sessionId,
      repoRoot: PRIMARY_ROOT,
      worktreePath: primaryCwd,
      branch: "feat/work",
      provider: "git",
      baseSha: PRIMARY_BASE,
      extraRepos: extras,
    }) as Task);
    registry.bindTaskToWorkEpisode(taskId, sessionId);
  }
  if (over.heads) {
    registry.recordWorktreeHeads(new Map(Object.entries(over.heads)));
  }

  const store = new WorkflowStore(db);
  const anchor = store.insertBinding({
    id: `b-${suffix}`,
    workflowVersionId: versionId,
    noteKey: agentSessionId,
    sessionId,
    sessionAgent: "claude",
    sessionName: "work",
    sessionCwd: primaryCwd,
    sessionRepoRoot: PRIMARY_ROOT,
    triggerMode: over.triggerMode ?? "manual",
    deliveryMode: over.deliveryMode ?? "preview",
    maxRepairRounds: 3,
    now: Date.now() - 1_000,
  });

  const captures: WorkflowBinding[] = [];
  const manager = new WorkflowManager(registry, store, {
    // The one seam that matters here: capture must read the RUN'S checkout. Recording the
    // binding is how the per-repo evidence test proves it without a real worktree.
    readContextRaw: async (_registry, binding) => {
      captures.push(binding);
      const session = registry.getSession(binding.sessionId!)!;
      const cwd = workflowCheckoutPath(binding, session) ?? "/unknown";
      const context = snapshot(cwd, over.heads?.[cwd] ?? PRIMARY_BASE);
      return {
        raw: {
          primaryGoal: context.primaryGoal,
          humanDecisions: [],
          priorPersonaFeedback: [],
          session: context.session,
          evidence: context.evidence,
        },
        context,
        boundary: {
          noteKey: agentSessionId,
          sessionId,
          headSha: context.evidence.headSha,
          transcriptPath: null,
          transcriptSize: null,
          repositoryFingerprint: `fp-${cwd}`,
        },
      };
    },
    boundaryChanged: async () => false,
    compactContext: async (raw) => snapshot(raw.session.cwd ?? "/unknown", raw.evidence.headSha ?? ""),
    inject: async () => ({ ok: true, pasted: true, submitVerified: true }),
    recordInjection: () => {},
    resumptionSettleMs: 0,
  });

  return {
    registry,
    store,
    manager,
    anchor,
    sessionId,
    agentSessionId,
    taskId,
    primaryCwd,
    secondCwd,
    versionId,
    captures,
  };
}

/**
 * The repositories that got a run, sorted by repository.
 *
 * Sorted rather than left in creation order because sibling runs are created inside one
 * millisecond and `startedAt` cannot separate them - an order assertion here would be a
 * uuid-comparison assertion wearing a meaning. Which run LEADS is asserted where it matters,
 * off the value the trigger hands back.
 */
function reviewedRepos(f: ReturnType<typeof seed>): string[] {
  return f.store.listRuns()
    .map((run) => f.store.getBinding(run.bindingId)!.sessionRepoRoot ?? "")
    .sort();
}

// ---- binding uniqueness -----------------------------------------------------------------

test("a conversation owns one active binding PER REPOSITORY, and still only one per repo", () => {
  clearWorkflowTables(db);
  const insert = db.prepare(
    `INSERT INTO workflow_bindings (
       id, workflow_version_id, note_key, session_id, repo_root, trigger_mode, delivery_mode,
       state, max_repair_rounds, created_at, updated_at
     ) VALUES (?, 'v1', 'note', 'session', ?, 'manual', 'preview', ?, 5, 1, 1)`,
  );
  // The conversation's own checkout, and one attached repository. Both active at once - which
  // is the entire widening, and what one run per changed repo is built on.
  insert.run("own", "", "active");
  insert.run("second", SECOND_ROOT, "active");
  // The invariant that was NOT removed: a second active binding on the same repository of the
  // same conversation is still refused by the database rather than by whoever checked first.
  assert.throws(() => insert.run("duplicate-own", "", "active"));
  assert.throws(() => insert.run("duplicate-second", SECOND_ROOT, "active"));
  // History coexists exactly as it did.
  insert.run("archived", "", "archived");
});

test("the conversation's own binding is what every existing lookup still resolves", () => {
  const f = seed();
  const store = f.store;
  const sibling = store.insertBinding({
    id: `sibling-${serial}`,
    workflowVersionId: f.versionId,
    noteKey: f.agentSessionId,
    sessionId: f.sessionId,
    sessionAgent: "claude",
    sessionName: "work",
    sessionCwd: f.secondCwd,
    sessionRepoRoot: SECOND_ROOT,
    repoRoot: SECOND_ROOT,
    triggerMode: "manual",
    deliveryMode: "preview",
    maxRepairRounds: 3,
    now: Date.now(),
  });
  // `activeBindingForNote` is read by the create conflict check, the dispatch arming, the
  // Foreman claim and reattach. Every one of them means the conversation's own binding, and a
  // sibling repository's must never be handed back in its place.
  assert.equal(store.activeBindingForNote(f.agentSessionId)?.id, f.anchor.id);
  assert.equal(store.activeBindingForNoteRepo(f.agentSessionId, SECOND_ROOT)?.id, sibling.id);
  assert.deepEqual(
    store.activeBindingsForNote(f.agentSessionId).map((b) => b.repoRoot),
    ["", SECOND_ROOT],
    "the conversation's own binding sorts first, so surfaces list the session's repo first",
  );
});

// ---- run creation -----------------------------------------------------------------------

test("one run per CHANGED repo, and none for a repo the task never touched", async () => {
  const f = seed({ heads: { [`/wt/${serial + 1}-0`]: MOVED } });
  // Both worktrees exist; only the primary's head moved off its baseline.
  f.registry.recordWorktreeHeads(new Map([
    [f.primaryCwd, MOVED],
    [f.secondCwd, SECOND_BASE],
  ]));
  const submitted = f.manager.enqueueSubmit(f.anchor.id, { requestId: "r1" });
  assert.equal(submitted.ok, true);
  await f.manager.stop();
  assert.deepEqual(reviewedRepos(f), [PRIMARY_ROOT]);
});

test("a changed ATTACHED repo gets its own run, on its own binding and worktree", async () => {
  const f = seed();
  f.registry.recordWorktreeHeads(new Map([
    [f.primaryCwd, MOVED],
    [f.secondCwd, MOVED],
  ]));
  const submitted = f.manager.enqueueSubmit(f.anchor.id, { requestId: "r1" });
  assert.equal(submitted.ok, true);
  await f.manager.stop();
  assert.deepEqual(reviewedRepos(f), [PRIMARY_ROOT, SECOND_ROOT]);
  // The run this submission answers with is the conversation's own repository, because the
  // attach order puts the primary first and it changed.
  assert.equal(
    submitted.ok === true ? submitted.value.run.bindingId : "",
    f.anchor.id,
  );

  const sibling = f.store.activeBindingForNoteRepo(f.agentSessionId, SECOND_ROOT);
  assert.ok(sibling, "the attached repo's review got a binding of its own");
  // Everything but the repository is the conversation's own binding's, and each clone is
  // load-bearing: the same published version, the same delivery consent, and its OWN copy of
  // the repair budget so a finding here restarts only this repository's graph.
  assert.equal(sibling.workflowVersionId, f.anchor.workflowVersionId);
  assert.equal(sibling.deliveryMode, f.anchor.deliveryMode);
  assert.equal(sibling.maxRepairRounds, f.anchor.maxRepairRounds);
  assert.equal(sibling.sessionCwd, f.secondCwd, "evidence comes from the attached worktree");
  assert.equal(sibling.sessionRepoRoot, SECOND_ROOT);
});

test("a task whose PRIMARY is untouched gets no primary run - and the attached repo still does", async () => {
  const f = seed();
  f.registry.recordWorktreeHeads(new Map([
    [f.primaryCwd, PRIMARY_BASE],
    [f.secondCwd, MOVED],
  ]));
  const submitted = f.manager.enqueueSubmit(f.anchor.id, { requestId: "r1" });
  assert.equal(submitted.ok, true);
  await f.manager.stop();
  // The run this submission answers with is the one that exists, not the primary's absent one.
  assert.deepEqual(reviewedRepos(f), [SECOND_ROOT]);
  assert.equal(f.store.activeRunForBinding(f.anchor.id), null);
});

test("a repo whose head nobody has read yet is REVIEWED, never silently skipped", async () => {
  // The shared predicate's third verdict. Completion holds on it, because completing early
  // ships work unmerged; run creation reviews on it, because skipping ships work unreviewed.
  // Same predicate, opposite conservative arm, and this is the arm that belongs here.
  const f = seed();
  f.registry.recordWorktreeHeads(new Map([[f.primaryCwd, PRIMARY_BASE]]));
  const submitted = f.manager.enqueueSubmit(f.anchor.id, { requestId: "r1" });
  assert.equal(submitted.ok, true);
  await f.manager.stop();
  assert.deepEqual(reviewedRepos(f), [SECOND_ROOT]);
});

test("a multi-repo turn that changed nothing anyone can see still gets one review", async () => {
  const f = seed();
  f.registry.recordWorktreeHeads(new Map([
    [f.primaryCwd, PRIMARY_BASE],
    [f.secondCwd, SECOND_BASE],
  ]));
  const submitted = f.manager.enqueueSubmit(f.anchor.id, { requestId: "r1" });
  assert.equal(submitted.ok, true);
  await f.manager.stop();
  // The completion boundary keeps an owner. Zero runs would be a session that finished with
  // no review anywhere, which is worse than a review that finds nothing to say.
  assert.deepEqual(reviewedRepos(f), [PRIMARY_ROOT]);
});

test("a repo with a pull request is changed even when its head never moved", async () => {
  const f = seed();
  f.registry.recordWorktreeHeads(new Map([
    [f.primaryCwd, PRIMARY_BASE],
    [f.secondCwd, SECOND_BASE],
  ]));
  db.prepare(
    `INSERT INTO work_episode_prs (
       episode_id, repo_root, session_id, task_id, pr_url, pr_state, pr_head_sha,
       merged_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 'open', NULL, NULL, 1)`,
  ).run(
    f.registry.workEpisodeForSession(f.sessionId)!.episodeId,
    SECOND_ROOT,
    f.sessionId,
    f.taskId,
    "https://github.com/owner/second/pull/2",
  );
  const submitted = f.manager.enqueueSubmit(f.anchor.id, { requestId: "r1" });
  assert.equal(submitted.ok, true);
  await f.manager.stop();
  assert.deepEqual(reviewedRepos(f), [SECOND_ROOT]);
});

test("submitting to an attached repo's own binding reviews that repo and nothing else", async () => {
  // The repo discriminator on a submission IS the binding id, now that a binding is per
  // repository. Only the conversation's own binding fans out.
  const f = seed();
  f.registry.recordWorktreeHeads(new Map([
    [f.primaryCwd, MOVED],
    [f.secondCwd, MOVED],
  ]));
  const sibling = f.store.insertBinding({
    id: `direct-${serial}`,
    workflowVersionId: f.versionId,
    noteKey: f.agentSessionId,
    sessionId: f.sessionId,
    sessionAgent: "claude",
    sessionName: "work",
    sessionCwd: f.secondCwd,
    sessionRepoRoot: SECOND_ROOT,
    repoRoot: SECOND_ROOT,
    triggerMode: "manual",
    deliveryMode: "preview",
    maxRepairRounds: 3,
    now: Date.now(),
  });
  const submitted = f.manager.enqueueSubmit(sibling.id, { requestId: "r1" });
  assert.equal(submitted.ok, true);
  await f.manager.stop();
  assert.deepEqual(reviewedRepos(f), [SECOND_ROOT]);
});

// ---- the Foreman completion boundary ----------------------------------------------------

test("one settled turn spends ONE completion episode and starts a run per changed repo", async () => {
  const f = seed({ triggerMode: "foreman_complete" });
  f.registry.recordWorktreeHeads(new Map([
    [f.primaryCwd, MOVED],
    [f.secondCwd, MOVED],
  ]));
  // The once-only drain guard Foreman arms: a queue with nothing left to do and no wrap-up
  // answer yet. Retiring it is what "this episode is spent" means.
  db.prepare(
    `INSERT INTO foreman_queues (
       note_key, cwd, branch, wrapup_asked_at, wrapup_answer, prompted_goal, updated_at
     ) VALUES (?, ?, 'feat/work', NULL, NULL, NULL, 10)`,
  ).run(f.agentSessionId, f.primaryCwd);
  db.prepare(
    `INSERT INTO foreman_queue_items (
       id, note_key, seq, intent, state, round, base_sha, transcript_anchor, gaps,
       send_attempts, verify_failures, escalation_reason, last_verdict, approved_at,
       proposed_payload, recovered_at, revision, created_at, updated_at, sent_at, completed_at
     ) VALUES (?, ?, 0, 'work', 'verified', 1, 'base', 1, '[]',
       1, 0, NULL, 'complete', NULL, NULL, NULL, 0, 1, 2, 1, 2)`,
  ).run(`item-${serial}`, f.agentSessionId);

  const result = await f.manager.claimCompletion(f.sessionId, {
    completionKind: "drain",
    marker: "d".repeat(64),
    summary: "work complete",
    evidenceFingerprint: "fp",
    expectedIntent: null,
  });
  await f.manager.stop();

  assert.equal(result.claimed, true);
  assert.deepEqual(reviewedRepos(f), [PRIMARY_ROOT, SECOND_ROOT]);
  // Spent once, however many repositories the turn touched. Retiring it a second time throws
  // - correctly - so a fan-out that claimed per repository would have failed here.
  const guard = db.prepare(
    `SELECT wrapup_asked_at, wrapup_answer FROM foreman_queues WHERE note_key = ?`,
  ).get(f.agentSessionId) as { wrapup_asked_at: number | null; wrapup_answer: string | null };
  assert.ok(guard.wrapup_asked_at !== null, "the completion episode was spent");
  assert.ok(guard.wrapup_answer?.startsWith("workflow:"));
  // The answer names the run the claim reported, which is the one it hands back.
  assert.equal(
    guard.wrapup_answer,
    `workflow:${result.claimed === true ? result.runId : ""}`,
  );
});

test("a repeated claim on the same proof starts nothing new", async () => {
  const f = seed({ triggerMode: "foreman_complete" });
  f.registry.recordWorktreeHeads(new Map([
    [f.primaryCwd, MOVED],
    [f.secondCwd, MOVED],
  ]));
  db.prepare(
    `INSERT INTO foreman_queues (
       note_key, cwd, branch, wrapup_asked_at, wrapup_answer, prompted_goal, updated_at
     ) VALUES (?, ?, 'feat/work', NULL, NULL, NULL, 10)`,
  ).run(f.agentSessionId, f.primaryCwd);
  db.prepare(
    `INSERT INTO foreman_queue_items (
       id, note_key, seq, intent, state, round, base_sha, transcript_anchor, gaps,
       send_attempts, verify_failures, escalation_reason, last_verdict, approved_at,
       proposed_payload, recovered_at, revision, created_at, updated_at, sent_at, completed_at
     ) VALUES (?, ?, 0, 'work', 'verified', 1, 'base', 1, '[]',
       1, 0, NULL, 'complete', NULL, NULL, NULL, 0, 1, 2, 1, 2)`,
  ).run(`item-${serial}`, f.agentSessionId);
  const claim = {
    completionKind: "drain" as const,
    marker: "e".repeat(64),
    summary: "work complete",
    evidenceFingerprint: "fp",
    expectedIntent: null,
  };
  const first = await f.manager.claimCompletion(f.sessionId, claim);
  const again = await f.manager.claimCompletion(f.sessionId, claim);
  await f.manager.stop();
  assert.equal(first.claimed, true);
  assert.equal(again.claimed && again.state, "already_claimed");
  assert.equal(f.store.listRuns().length, 2, "still one run per repository, not four");
});

// ---- per-repo evidence ------------------------------------------------------------------

test("each run's evidence is read from ITS repository's worktree", async () => {
  const f = seed();
  f.registry.recordWorktreeHeads(new Map([
    [f.primaryCwd, MOVED],
    [f.secondCwd, MOVED],
  ]));
  f.manager.enqueueSubmit(f.anchor.id, { requestId: "r1" });
  await f.manager.stop();
  const session = f.registry.getSession(f.sessionId)!;
  assert.deepEqual(
    f.captures.map((binding) => workflowCheckoutPath(binding, session)).sort(),
    [f.primaryCwd, f.secondCwd].sort(),
    "one capture per repository, each in its own checkout",
  );
});

test("the conversation's own run reads the LIVE session cwd, not the frozen copy", () => {
  // A primary run must review the checkout the agent is standing in. The frozen copy exists
  // to detect that the session moved (`reattach` compares them); reading it here would review
  // a checkout that was left behind.
  const anchor = {
    repoRoot: "",
    sessionCwd: "/stale",
  } as unknown as WorkflowBinding;
  assert.equal(workflowCheckoutPath(anchor, { cwd: "/live" }), "/live");
  const sibling = {
    repoRoot: SECOND_ROOT,
    sessionCwd: "/wt/second",
  } as unknown as WorkflowBinding;
  assert.equal(workflowCheckoutPath(sibling, { cwd: "/live" }), "/wt/second");
});

// ---- merge veto membership --------------------------------------------------------------

test("a run never vetoes a SIBLING repository's pull request", async () => {
  const f = seed();
  f.registry.recordWorktreeHeads(new Map([
    [f.primaryCwd, MOVED],
    [f.secondCwd, MOVED],
  ]));
  f.manager.enqueueSubmit(f.anchor.id, { requestId: "r1" });
  await f.manager.stop();

  const now = Date.now();
  const pr = (key: string, url: string, repoRoot: string) => ({
    key,
    url,
    owner: "owner",
    repo: key.split("/")[1]!.split("#")[0]!,
    number: Number(key.split("#")[1]),
    repoRoot,
    cwd: repoRoot,
    sessionId: f.sessionId,
    source: "hook" as const,
    state: "open" as const,
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
  });
  adoptInspectorPr(pr("owner/repo#1", "https://github.com/owner/repo/pull/1", PRIMARY_ROOT));
  adoptInspectorPr(pr("owner/second#2", "https://github.com/owner/second/pull/2", SECOND_ROOT));
  // `Session.prUrl` is the current branch's pull request, and it follows the session's OWN
  // checkout - so it can only ever name the primary's. The attached repo's run finds its own
  // through the adoption ledger instead, which is the whole reason that hint is per binding.
  f.registry.applyHook({
    agent: "claude",
    event: "PostToolUse",
    sessionId: f.agentSessionId,
    cwd: f.primaryCwd,
    transcriptPath: null,
    env: { tmuxPane: `%${serial}` },
    prUrl: "https://github.com/owner/repo/pull/1",
    prCreated: false,
  });

  // Both reviews are open, so both repositories' pull requests are held - by their OWN run.
  assert.equal(f.manager.mergeGate("owner/repo#1"), "pending");
  assert.equal(f.manager.mergeGate("owner/second#2"), "pending");

  // The attached repo's review finishes. Its pull request is released, and the primary's is
  // still held - independent per-PR merges, which is adopted decision 4.
  const sibling = f.store.activeBindingForNoteRepo(f.agentSessionId, SECOND_ROOT)!;
  const siblingRun = f.store.activeRunForBinding(sibling.id)!;
  f.store.setRunState(siblingRun.id, "completed", "complete", null, Date.now());
  assert.equal(f.manager.mergeGate("owner/second#2"), "none");
  assert.equal(f.manager.mergeGate("owner/repo#1"), "pending");
});

// ---- cross-run delivery serialization ---------------------------------------------------

/** Both repositories reviewing at once, each run holding a Live repair packet of its own. */
async function twoLiveRuns() {
  setWorkflowConfig({ liveEnabled: true, repoAllowlist: [PRIMARY_ROOT] });
  const f = seed({ deliveryMode: "live" });
  f.registry.recordWorktreeHeads(new Map([
    [f.primaryCwd, MOVED],
    [f.secondCwd, MOVED],
  ]));
  f.manager.enqueueSubmit(f.anchor.id, { requestId: "r1" });
  await f.manager.stop();
  const bindings = f.store.activeBindingsForNote(f.agentSessionId);
  assert.equal(bindings.length, 2, "one binding per repository under review");
  const runs = bindings.map((binding) => {
    const run = f.store.activeRunForBinding(binding.id)!;
    const submission = f.store.latestSubmission(run.id)!;
    f.store.setRunState(run.id, "waiting_for_session", "persona_feedback", null, Date.now());
    f.store.setSubmissionState(submission.id, "waiting_for_session", Date.now());
    const delivery = f.store.prepareDelivery({
      id: `d-${binding.id}`,
      runId: run.id,
      submissionId: submission.id,
      kind: "persona_feedback",
      sessionId: f.sessionId,
      noteKey: f.agentSessionId,
      payload: `fix ${binding.sessionRepoRoot}`,
      payloadSha256: `sha-${binding.id}`,
    }).delivery;
    return { binding, run, submission, delivery };
  });
  return { f, runs };
}

test("two repositories' packets never type into one pane at once", async () => {
  const { f, runs } = await twoLiveRuns();
  const [first, second] = runs;
  assert.ok(first && second);

  // The first packet takes the turn.
  await (f.manager as unknown as {
    deliverPrepared(id: string, retry: boolean): Promise<void>;
  }).deliverPrepared(first.delivery.id, false);
  assert.equal(f.store.getDelivery(first.delivery.id)?.state, "delivered");

  // The second is HELD, not refused and not discarded: still `prepared`, so the same bytes go
  // out when the turn frees up. Refusing would block its run over a race.
  await (f.manager as unknown as {
    deliverPrepared(id: string, retry: boolean): Promise<void>;
  }).deliverPrepared(second.delivery.id, false);
  assert.equal(f.store.getDelivery(second.delivery.id)?.state, "prepared");
  assert.equal(
    f.store.listEvents(second.run.id).filter((e) => e.kind === "delivery_queued").length,
    1,
    "the hold is recorded once, naming the run that owns the turn",
  );

  // The holding run resubmits, which is the agent's repair landing. The SWEEP re-offers - not
  // a second explicit call - because that is what actually runs on a live daemon, and a queue
  // nothing dequeues is a stall wearing a nicer name.
  f.store.setRunState(first.run.id, "capturing", "capturing", null, Date.now());
  (f.manager as unknown as { scheduleQueuedDeliveries(noteKey: string): void })
    .scheduleQueuedDeliveries(f.agentSessionId);
  await f.manager.stop();
  assert.equal(f.store.getDelivery(second.delivery.id)?.state, "delivered");
});

test("a BLOCKED run's unresolved packet never holds its siblings hostage", async () => {
  const { f, runs } = await twoLiveRuns();
  const [first, second] = runs;
  assert.ok(first && second);
  // An uncertain write blocks its run until a person resolves it. Holding every sibling
  // behind that would turn one unanswered question into a stalled conversation.
  f.store.claimDeliverySend(first.delivery.id);
  f.store.finishDeliverySend(first.delivery.id, "uncertain", "test");
  await (f.manager as unknown as {
    deliverPrepared(id: string, retry: boolean): Promise<void>;
  }).deliverPrepared(second.delivery.id, false);
  assert.equal(f.store.getDelivery(second.delivery.id)?.state, "delivered");
});

test("a queued packet whose run ends is forgotten, not remembered for ever", async () => {
  // The id the queue remembers is a delivery id, so it has to be swept by asking that
  // DELIVERY - not by walking bindings to their runs. A run that goes terminal while one of
  // its packets waits (its binding archived, its run cancelled, while a sibling repository
  // still owns the pane) is never walked again, because `activeRunForBinding` excludes
  // terminal runs, and the id would sit in memory for the life of the process.
  const { f, runs } = await twoLiveRuns();
  const [first, second] = runs;
  assert.ok(first && second);
  const queued = f.manager as unknown as {
    deliverPrepared(id: string, retry: boolean): Promise<void>;
    scheduleQueuedDeliveries(noteKey: string): void;
    queuedDeliveries: Set<string>;
  };
  await queued.deliverPrepared(first.delivery.id, false);
  await queued.deliverPrepared(second.delivery.id, false);
  assert.equal(queued.queuedDeliveries.has(second.delivery.id), true);

  // The waiting repository's review is cancelled out from under its queued packet - the one
  // shape the binding walk cannot see, because the run it would have to reach is gone.
  f.store.archiveBindingAndCancel(second.binding.id, Date.now());
  assert.notEqual(f.store.getDelivery(second.delivery.id)?.state, "prepared");
  queued.scheduleQueuedDeliveries(f.agentSessionId);
  assert.equal(
    queued.queuedDeliveries.has(second.delivery.id),
    false,
    "the queue lets go of a packet it can never send",
  );
  await f.manager.stop();
});

test("the queue re-derives itself from persisted state after a restart", async () => {
  const { f, runs } = await twoLiveRuns();
  const [first, second] = runs;
  assert.ok(first && second);
  await (f.manager as unknown as {
    deliverPrepared(id: string, retry: boolean): Promise<void>;
  }).deliverPrepared(first.delivery.id, false);
  await (f.manager as unknown as {
    deliverPrepared(id: string, retry: boolean): Promise<void>;
  }).deliverPrepared(second.delivery.id, false);
  assert.equal(f.store.getDelivery(second.delivery.id)?.state, "prepared");

  // A fresh manager over the same rows - the daemon restarting. Nothing durable says
  // "queued"; the queue is the answer `conversationDeliveryHold` gives about persisted
  // delivery and run state, so the same packet is held again for the same reason.
  const restarted = new WorkflowManager(f.registry, f.store, {
    inject: async () => ({ ok: true, pasted: true, submitVerified: true }),
    recordInjection: () => {},
  });
  await (restarted as unknown as {
    deliverPrepared(id: string, retry: boolean): Promise<void>;
  }).deliverPrepared(second.delivery.id, false);
  assert.equal(f.store.getDelivery(second.delivery.id)?.state, "prepared");
  await restarted.stop();
});

test("a single-repo conversation's delivery is never queued behind anything", async () => {
  setWorkflowConfig({ liveEnabled: true, repoAllowlist: [PRIMARY_ROOT] });
  const f = seed({ extras: [], deliveryMode: "live" });
  f.registry.recordWorktreeHeads(new Map([[f.primaryCwd, MOVED]]));
  f.manager.enqueueSubmit(f.anchor.id, { requestId: "r1" });
  await f.manager.stop();
  const run = f.store.activeRunForBinding(f.anchor.id)!;
  const submission = f.store.latestSubmission(run.id)!;
  f.store.setRunState(run.id, "waiting_for_session", "persona_feedback", null, Date.now());
  f.store.setSubmissionState(submission.id, "waiting_for_session", Date.now());
  const delivery = f.store.prepareDelivery({
    id: "d-solo",
    runId: run.id,
    submissionId: submission.id,
    kind: "persona_feedback",
    sessionId: f.sessionId,
    noteKey: f.agentSessionId,
    payload: "fix it",
    payloadSha256: "sha-solo",
  }).delivery;
  await (f.manager as unknown as {
    deliverPrepared(id: string, retry: boolean): Promise<void>;
  }).deliverPrepared(delivery.id, false);
  assert.equal(f.store.getDelivery(delivery.id)?.state, "delivered");
  assert.deepEqual(f.store.listEvents(run.id).filter((e) => e.kind === "delivery_queued"), []);
});

// ---- single-repo regression -------------------------------------------------------------

test("a single-repo session takes exactly the path it always took", async () => {
  for (const over of [{ extras: [] }, { withTask: false as const }]) {
    const f = seed(over);
    f.registry.recordWorktreeHeads(new Map([[f.primaryCwd, MOVED]]));
    const submitted = f.manager.enqueueSubmit(f.anchor.id, { requestId: "r1" });
    assert.equal(submitted.ok, true);
    await f.manager.stop();
    // One run, on the conversation's own binding, and NO sibling binding was ever created.
    assert.deepEqual(reviewedRepos(f), [PRIMARY_ROOT]);
    assert.deepEqual(
      f.store.activeBindingsForNote(f.agentSessionId).map((b) => b.id),
      [f.anchor.id],
    );
    // And a second submission on a binding whose run is still active is refused exactly as
    // it was, with that run attached.
    const again = f.manager.enqueueSubmit(f.anchor.id, { requestId: "r2" });
    assert.equal(again.ok, false);
    assert.equal(again.ok === false && again.reason, "run_active");
  }
});
