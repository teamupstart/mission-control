import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SubmitEnsembleResultSchema } from "../src/shared/protocol.ts";

/**
 * What is at stake: a submission is the ONE reliable "ready for comparison" signal - a hook falling
 * silent and a Task going idle are not it - and it is also the moment a member's work becomes an
 * immutable artifact. Two things must hold no matter what. A member can only ever submit for ITSELF:
 * attribution is derived server-side from its authenticated session, its Task and its worktree, and a
 * guessed id reaches nothing. And a submission is exactly-once against honest evidence: a
 * byte-equivalent repeat returns the prior artifact, a conflicting one is refused, and a capture that
 * fails leaves the member active with no invented artifact.
 */

const home = mkdtempSync(join(tmpdir(), "mission-ensemble-submit-"));
process.env.HARNESS_HOME = join(home, "state");

const { openDb } = await import("../src/server/db.ts");
const { EnsembleStore, clearEnsembleTables } = await import("../src/server/ensembles/store.ts");
const { EnsembleEngine } = await import("../src/server/ensembles/engine.ts");
const { EnsembleManager } = await import("../src/server/ensembles/manager.ts");
const { Registry } = await import("../src/server/registry.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { FakeGateway, failingAdapters, stubAdapters, singleWavePlan, runInsert, gitRepo } = await import("./ensemble-fixture.ts");
const { ARTIFACT_ADAPTERS } = await import("../src/server/ensembles/artifacts/index.ts");

const db = openDb();
after(() => rmSync(home, { recursive: true, force: true }));
beforeEach(() => clearEnsembleTables(db));

/**
 * A run with one ACTIVE member (its attempt in a real git worktree) and a sibling still pending, so
 * submitting the active one does not complete the run - the member stays `submitted`, which is the
 * realistic state a comparison later reads.
 */
function seedActiveMember(store: InstanceType<typeof EnsembleStore>, worktree: string, baseSha: string, taskId = "seeded-task") {
  const { run } = store.createRun(runInsert(singleWavePlan(2), { baseSha, sourceKey: `s:${worktree}` }));
  const member = store.listMembers(run.id)[0]!;
  store.insertAttempt({
    runId: run.id,
    memberId: member.id,
    attempt: 1,
    taskId,
    sessionId: null,
    agent: "claude",
    requestedModel: null,
    requestedEffort: null,
    baseSha,
    worktreePath: worktree,
    branch: null,
    status: "running",
  });
  store.setMemberStatus(member.id, ["pending"], "launching", { taskId });
  store.setMemberStatus(member.id, ["launching"], "active", {});
  return { run, member };
}

function engineWith(store: InstanceType<typeof EnsembleStore>, adapters = ARTIFACT_ADAPTERS) {
  const gateway = new FakeGateway();
  const run = store.listNonTerminalRuns()[0];
  for (const attempt of run ? store.listAttempts(run.id) : []) {
    if (attempt.taskId && attempt.worktreePath) gateway.running(attempt.taskId, attempt.worktreePath);
  }
  return new EnsembleEngine({ store, tasks: gateway, publish: () => {}, armTimer: () => () => {}, adapters });
}

const CLAIMS = { summary: "implemented it", checks: ["npm test"], testEvidence: null };

test("a happy submission captures an immutable artifact and marks the member submitted", async () => {
  const { path, baseSha } = gitRepo();
  writeFileSync(join(path, "feature.ts"), "export const x = 1;\n");
  const store = new EnsembleStore(db);
  const { run, member } = seedActiveMember(store, path, baseSha);
  const engine = engineWith(store);

  const result = await engine.submit({ runId: run.id, memberId: member.id, claims: CLAIMS, source: "mcp", requireWorktree: path });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.replayed, false);
  assert.equal(result.artifact.status, "ready");
  assert.equal(store.getMember(member.id)!.status, "submitted");
  assert.equal(store.getMember(member.id)!.selectedAttemptId, result.artifact.attemptId);

  // Evidence is git fact, and the claims are stored labelled as claims, never as observed fact.
  const metadata = result.artifact.metadata as { observed: { dirty: boolean }; reported: { summary: string } };
  assert.equal(metadata.observed.dirty, true);
  assert.equal(metadata.reported.summary, "implemented it");
});

test("a byte-equivalent resubmission returns the prior artifact; a conflicting one is refused", async () => {
  const { path, baseSha } = gitRepo();
  writeFileSync(join(path, "a.txt"), "a\n");
  const store = new EnsembleStore(db);
  const { run, member } = seedActiveMember(store, path, baseSha);
  const engine = engineWith(store);

  const first = await engine.submit({ runId: run.id, memberId: member.id, claims: CLAIMS, source: "mcp", requireWorktree: path });
  assert.equal(first.ok, true);
  const replay = await engine.submit({ runId: run.id, memberId: member.id, claims: CLAIMS, source: "mcp", requireWorktree: path });
  assert.equal(replay.ok, true);
  if (first.ok && replay.ok) assert.equal(replay.artifact.id, first.artifact.id, "same artifact, not a second one");
  assert.equal(replay.ok && replay.replayed, true);
  assert.equal(store.listArtifacts(run.id).length, 1, "no second artifact row");

  const conflict = await engine.submit({
    runId: run.id,
    memberId: member.id,
    claims: { summary: "totally different", checks: [], testEvidence: null },
    source: "mcp",
    requireWorktree: path,
  });
  assert.equal(conflict.ok, false);
  if (!conflict.ok) assert.equal(conflict.reason, "already_submitted");
});

test("a submission from the wrong worktree is refused", async () => {
  const { path, baseSha } = gitRepo();
  const store = new EnsembleStore(db);
  const { run, member } = seedActiveMember(store, path, baseSha);
  const engine = engineWith(store);
  const result = await engine.submit({ runId: run.id, memberId: member.id, claims: CLAIMS, source: "mcp", requireWorktree: "/some/other/tree" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "wrong_cwd");
});

test("a historical worktree path is refused when the Task no longer owns it", async () => {
  const { path, baseSha } = gitRepo();
  const store = new EnsembleStore(db);
  const { run, member } = seedActiveMember(store, path, baseSha);
  const gateway = new FakeGateway();
  gateway.running("seeded-task", "/reused/by/another/task");
  const engine = new EnsembleEngine({ store, tasks: gateway, publish: () => {}, armTimer: () => () => {}, adapters: stubAdapters() });
  const result = await engine.submit({
    runId: run.id,
    memberId: member.id,
    claims: CLAIMS,
    source: "operator",
    requireWorktree: null,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "no_worktree");
  assert.equal(store.listArtifacts(run.id).length, 0);
});

test("a late submission fails the run before artifact capture", async () => {
  let clock = 0;
  const { path, baseSha } = gitRepo();
  const store = new EnsembleStore(db);
  const plan = singleWavePlan(2, { deadlineMs: 100 });
  const { run, member } = seedActiveMember(store, path, baseSha);
  db.prepare(`UPDATE ensemble_runs SET compiled_plan_json = ?, created_at = 0 WHERE id = ?`)
    .run(JSON.stringify(plan), run.id);
  const gateway = new FakeGateway();
  gateway.running("seeded-task", path);
  let captures = 0;
  const adapters = stubAdapters();
  const original = adapters.commit!;
  adapters.commit = {
    ...original,
    async capture(input) {
      captures += 1;
      return original.capture(input);
    },
  };
  clock = 1000;
  const engine = new EnsembleEngine({ store, tasks: gateway, publish: () => {}, armTimer: () => () => {}, adapters, now: () => clock });
  const result = await engine.submit({
    runId: run.id,
    memberId: member.id,
    claims: CLAIMS,
    source: "mcp",
    requireWorktree: path,
  });
  assert.equal(result.ok, false);
  assert.equal(captures, 0);
  assert.equal(store.getRun(run.id)!.status, "failed");
});

test("a withdrawn member cannot submit", async () => {
  const { path, baseSha } = gitRepo();
  const store = new EnsembleStore(db);
  const { run, member } = seedActiveMember(store, path, baseSha);
  store.setMemberStatus(member.id, ["active"], "withdrawn", {});
  const engine = engineWith(store);
  const result = await engine.submit({ runId: run.id, memberId: member.id, claims: CLAIMS, source: "mcp", requireWorktree: path });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "member_inactive");
});

test("a capture failure leaves the member active with no ready artifact", async () => {
  const { path, baseSha } = gitRepo();
  const store = new EnsembleStore(db);
  const { run, member } = seedActiveMember(store, path, baseSha);
  const engine = engineWith(store, failingAdapters());
  const result = await engine.submit({ runId: run.id, memberId: member.id, claims: CLAIMS, source: "mcp", requireWorktree: path });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "capture_failed");
  assert.equal(store.getMember(member.id)!.status, "active", "the member stays active and may retry");
  assert.equal(store.listArtifacts(run.id).filter((a) => a.status === "ready").length, 0, "no invented artifact");
});

// ---- attribution through the manager, against a real Registry ----

function discovered(cwd: string, agent: "claude" | "codex", pid: number) {
  return {
    syntheticId: `sess-${pid}`,
    agent,
    name: `member ${pid}`,
    nameSource: "process" as const,
    cwd,
    gitBranch: null,
    gitRoot: cwd,
    repoRoot: cwd,
    nomistakesGated: false,
    pid,
    tty: null,
    terminals: [],
    startedAt: Date.now(),
  };
}

function attributionFixture(agent: "claude" | "codex") {
  const { path, baseSha } = gitRepo();
  writeFileSync(join(path, "work.ts"), "export const y = 2;\n");
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const store = new EnsembleStore(db);
  const gateway = new FakeGateway();
  const manager = new EnsembleManager(registry, store, { tasks: gateway });

  registry.applyDiscovery([discovered(path, agent, 500)]);
  const session = registry.snapshot().sessions.find((s) => s.cwd === path)!;
  const task = tasks.create({ repoRoot: path, intent: "x", title: "member", kind: "ship", agent, backlog: true });
  registry.upsertTask({ ...task, status: "running", worktreePath: path, sessionId: session.id });

  const { member } = seedActiveMember(store, path, baseSha, task.id);
  gateway.running(task.id, path);
  return { manager, registry, store, path, session, task, member };
}

for (const agent of ["claude", "codex"] as const) {
  test(`a ${agent} member's MCP submission is attributed to it by session, task and worktree`, async () => {
    const fx = attributionFixture(agent);
    const result = await fx.manager.submitFromSession({ env: {}, sessionId: null, cwd: fx.path, claims: CLAIMS });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(fx.store.getMember(fx.member.id)!.status, "submitted");
    fx.manager.stop();
  });
}

test("an MCP submission with no matching live session is refused", async () => {
  const fx = attributionFixture("claude");
  const result = await fx.manager.submitFromSession({ env: {}, sessionId: "nobody", cwd: "/not/a/worktree", claims: CLAIMS });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "no_session");
  fx.manager.stop();
});

test("an MCP submission from an exited session is refused as stale", async () => {
  const fx = attributionFixture("claude");
  // A sweep that no longer sees the session marks it exited (still in the map briefly).
  fx.registry.applyDiscovery([]);
  const result = await fx.manager.submitFromSession({ env: {}, sessionId: null, cwd: fx.path, claims: CLAIMS });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "no_session");
  fx.manager.stop();
});

test("a session running a non-ensemble task cannot submit", async () => {
  const { path } = gitRepo();
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const store = new EnsembleStore(db);
  const manager = new EnsembleManager(registry, store, { tasks: new FakeGateway() });
  registry.applyDiscovery([discovered(path, "claude", 600)]);
  const session = registry.snapshot().sessions.find((s) => s.cwd === path)!;
  const task = tasks.create({ repoRoot: path, intent: "x", title: "plain", kind: "ship", agent: "claude", backlog: true });
  registry.upsertTask({ ...task, status: "running", worktreePath: path, sessionId: session.id });
  // No ensemble member is bound to this task.
  const result = await manager.submitFromSession({ env: {}, sessionId: null, cwd: path, claims: CLAIMS });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "no_member");
  manager.stop();
});

test("the manual fallback captures identically but labels its provenance operator", async () => {
  const { path, baseSha } = gitRepo();
  writeFileSync(join(path, "m.ts"), "export const z = 3;\n");
  const registry = new Registry();
  const store = new EnsembleStore(db);
  const gateway = new FakeGateway();
  const manager = new EnsembleManager(registry, store, { tasks: gateway });
  const { run, member } = seedActiveMember(store, path, baseSha);
  gateway.running("seeded-task", path);

  const result = await manager.submitManual(run.id, member.id, CLAIMS);
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  const metadata = result.artifact.metadata as { source: string };
  assert.equal(metadata.source, "operator", "manual submission does not borrow session provenance");
  assert.equal(store.getMember(member.id)!.status, "submitted");
  manager.stop();
});

test("the submission schema exposes no id a member could use to submit for a sibling", () => {
  // Attribution is server-side; the only way to keep it so is to refuse to read an id off the wire.
  const parsed = SubmitEnsembleResultSchema.safeParse({
    env: {},
    result: { summary: "x", checks: [], testEvidence: null },
    memberId: "sibling",
    ensembleId: "run",
    artifactId: "guess",
  });
  assert.equal(parsed.success, true);
  if (parsed.success) {
    assert.equal("memberId" in parsed.data, false, "a caller-supplied member id is stripped, never honoured");
    assert.equal("ensembleId" in parsed.data, false);
  }
});
