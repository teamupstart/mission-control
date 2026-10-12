import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkTask } from "./helpers/session-fixture.ts";
import { FIXTURE_RUN_INTENT } from "./helpers/workflow-run-intent.ts";
import { LOCAL_PLAN_VALIDATION_WORKFLOW_ID, PLAN_VALIDATION_WORKFLOW_ID, builtinWorkflowVersionId } from "../src/shared/builtin-workflow.ts";
import type { PlanIdentity } from "../src/shared/managed-plans.ts";
import { declaredBlockers } from "../src/shared/backlog.ts";

const home = realpathSync(mkdtempSync(join(tmpdir(), "mission-local-publication-")));
process.env.MISSION_HOME = join(home, "state");
const { Registry, noteKeyFor } = await import("../src/server/registry.ts");
const { WorkflowManager } = await import("../src/server/workflows/manager.ts");
const { PersonaManager } = await import("../src/server/workflows/personas.ts");
const { TaskManager } = await import("./helpers/task-manager-fixture.ts");
const { ReviewManager } = await import("../src/server/reviews.ts");
const { QueueManager } = await import("../src/server/queue.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { ensureToken } = await import("../src/server/auth.ts");
const { openDb, closeDb, loadActiveTasks } = await import("../src/server/db.ts");
const { savePlan, planContext, readPlanFile, reserveTaskPlans } = await import("../src/server/plans/store.ts");
const { planAuthority } = await import("../src/server/plans/authority.ts");
const { freezeLocalPlanSubmission, verifyLocalPlanEvidence, localWorkflowProblem, localPlanAuthorityContext } = await import("../src/server/plans/publication.ts");
const { publicationReceipt, taskPlanInputProblem, taskPlanDiscovery } = await import("../src/server/plans/inputs.ts");
const { applySkillsConfig } = await import("../src/server/skills/config.ts");
const managers: InstanceType<typeof WorkflowManager>[] = [];
afterEach(async () => { for (const m of managers.splice(0)) await m.stop(); });
after(() => { closeDb(); rmSync(home, { recursive: true, force: true }); });
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
async function fixture(workflow = false, kind: "plan" | "ship" = "plan") {
  const id = randomUUID(), repo = join(home, id);
  mkdirSync(repo); git(repo, "init", "-q", "-b", "main");
  git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "initial");
  const registry = new Registry();
  registry.applyDiscovery([{ syntheticId: id, agent: "claude", name: id, nameSource: "process", cwd: repo, gitRoot: repo, repoRoot: repo, gitBranch: "main", pid: 1, tty: null, terminals: [], startedAt: 1 }]);
  registry.applyHook({ agent: "claude", event: "Stop", sessionId: id, cwd: repo, transcriptPath: null, env: {} });
  const session = registry.getSession(id)!;
  const task = mkTask({ id: `task-${id}`, kind, status: "running", sessionId: id, repoRoot: repo, worktreePath: repo, baseSha: git(repo, "rev-parse", "HEAD"), workflowId: workflow ? LOCAL_PLAN_VALIDATION_WORKFLOW_ID : null,
    planPolicy: { version: 2, storage: "local", commitPlanHtml: true }, planInputs: [] });
  registry.upsertTask(task);
  const personas = new PersonaManager(registry), workflows = new WorkflowManager(registry, personas.store);
  managers.push(workflows);
  const tasks = new TaskManager(registry), reviews = new ReviewManager(registry);
  const app = buildApp({ registry, workflows, personas, tasks, reviews, queues: new QueueManager(registry) });
  const binding = workflow ? workflows.store.insertBinding({ id: randomUUID(), workflowVersionId: builtinWorkflowVersionId("local-plan-validation", 1), noteKey: noteKeyFor(session), sessionId: id, sessionAgent: "claude", sessionName: id, sessionCwd: repo, sessionRepoRoot: repo, triggerMode: "manual", deliveryMode: "preview", maxRepairRounds: 1, now: Date.now() }) : null;
  const authority = planAuthority(registry, session, "repo-01");
  // Mixed task storage is independently selected; it never gains plan-only publication rights.
  if (kind === "ship") authority.policy = { version: 2, storage: "local", commitPlanHtml: true };
  const files = [{ name: "plan.md", content: "# Exact local plan\n\nRead the phase." }, { name: "plan.html", content: "<h1>Exact local plan</h1>" }, { name: "phase-1.md", content: "# Implement phase 1" }, { name: "phase-1.html", content: "<h1>Implement phase 1</h1>" }];
  const saved = await savePlan(authority, { repoSlot: "repo-01", requestId: randomUUID(), slug: "local-plan", expectedRevision: 0, files });
  const input: PlanIdentity = { repoKey: saved.manifest.repoKey, planId: saved.manifest.planId, revision: 1 };
  const service = workflows.localPlanPublication(tasks);
  const post = (path: string, body: object) => app.request(path, { method: "POST", headers: { host: "127.0.0.1:7317", "content-type": "application/json", "x-harness-token": ensureToken() }, body: JSON.stringify({ env: {}, sessionId: id, cwd: repo, ...body }) });
  const review = async (action: "answer" | "dismiss" = "answer", revision = 1) => {
    const res = await post("/mcp/v2/reviews", { kind: "plan-decisions", title: "Approve bundle", body: "Inspect complete Markdown and HTML", managedPlan: { repoSlot: "repo-01", planId: input.planId, revision } });
    assert.equal(res.status, 200, await res.clone().text());
    const { id: reviewId } = await res.json() as { id: string };
    reviews.resolve(reviewId, action, null, "human", action === "answer" ? [{ decisionId: "approve-final-bundle", selected: ["approve"], other: null }] : null);
    return reviewId;
  };
  return { id, repo, registry, workflows, tasks, task, session, authority, saved, input, service, post, review, binding, files };
}

async function restart(f: Awaited<ReturnType<typeof fixture>>) {
  await f.workflows.stop();
  closeDb();
  f.workflows = new WorkflowManager(f.registry, new PersonaManager(f.registry).store);
  managers.push(f.workflows);
  f.service = f.workflows.localPlanPublication(f.tasks);
}

test("explicit final approval publishes an exact local receipt, survives restart and pruning, and leaves code merge edges blocked", async () => {
  const f = await fixture();
  await assert.rejects(f.service.publish(f.authority, f.input), /explicit human approval/);
  await f.review("dismiss");
  await assert.rejects(f.service.publish(f.authority, f.input), /explicit human approval/);
  await f.review();
  const dependent = f.tasks.create({ kind: "ship", repoRoot: f.repo, title: "Implementation phase", intent: "Implement only the phase", backlog: true, workflowId: null,
    planInputs: [{ ...f.input, files: ["plan.md", "phase-1.md"] }], dependencies: [{ type: "plan", ...f.input }, { type: "task", taskId: f.task.id }] });
  assert.match(taskPlanInputProblem(dependent)!, /waiting/);
  await restart(f);
  const receipt = await f.service.publish(f.authority, f.input);
  assert.deepEqual(await f.service.publish(f.authority, f.input), receipt);
  const edges = f.registry.getTask(dependent.id)!.dependencies;
  assert.equal(edges[0]!.satisfiedAt, receipt.publishedAt);
  assert.equal(edges[1]!.satisfiedAt, null);
  assert.equal(f.registry.getTask(f.task.id)!.status, "running", "receipt creation alone does not bypass task lifecycle");
  assert.equal(git(f.repo, "status", "--porcelain"), "");
  await restart(f);
  await f.service.stop();
  assert.deepEqual(publicationReceipt(f.input), receipt);
  assert.deepEqual(loadActiveTasks().find((t) => t.id === dependent.id)!.planInputs, dependent.planInputs);
  openDb().prepare("DELETE FROM tasks WHERE id = ?").run(f.task.id);
  const fresh = new Registry();
  const recreated = new TaskManager(fresh).create({ kind: "ship", repoRoot: f.repo, title: "After pruning", intent: "Use retained exact bytes", backlog: true, workflowId: null,
    planInputs: [{ ...f.input, files: ["plan.md"] }], dependencies: [{ type: "plan", ...f.input }] });
  assert.equal(recreated.dependencies[0]!.satisfiedAt, receipt.publishedAt);
  assert.equal(taskPlanInputProblem(recreated), null);
  const discovery = await taskPlanDiscovery(recreated);
  assert.match(discovery, /docs\/plans/); assert.match(discovery, /read_plan/); assert.ok(discovery.includes(f.input.planId));
  // This is the actual durable receipt and actual remaining edge, retained as focused workflow evidence.
  process.stdout.write(`LOCAL PUBLICATION TRACE ${JSON.stringify({ receipt, artifactEdge: edges[0], ordinaryMergeEdge: edges[1] })}\n`);
});

test("workflow publication requires the approved revision, active exact binding, retained text and completed submission", async () => {
  const f = await fixture(true); await f.review();
  assert.equal(f.service.readiness(f.input).state, "waiting-workflow");
  await assert.rejects(f.service.publish(f.authority, f.input), /successful validation/);
  const binding = f.binding!, runId = randomUUID(), subId = randomUUID();
  const { submission } = f.workflows.store.createInitialSubmission({ id: runId, binding, intent: FIXTURE_RUN_INTENT, triggerSource: "manual", triggerKey: runId, now: Date.now() }, { id: subId, triggerSource: "manual", triggerKey: subId, context: {}, evidence: {}, now: Date.now() });
  freezeLocalPlanSubmission(f.registry, f.workflows, binding, submission);
  assert.throws(() => verifyLocalPlanEvidence(f.workflows.store, subId), /missing the exact complete Markdown/);
  const content = f.files.filter((file) => file.name.endsWith(".md")).map((file) => `${file.name}\n${file.content}`).join("\n\n");
  f.workflows.store.finalizeSubmissionTextArtifacts(subId, [{ id: randomUUID(), stagingId: randomUUID(), ordinal: 0, displayName: "Final bundle", caption: "Exact Markdown for validation", repositoryScope: "repo-01", mimeType: "text/plain", bytes: Buffer.byteLength(content), sha256: createHash("sha256").update(content).digest("hex"), content, createdAt: Date.now() }]);
  f.workflows.store.updateSubmissionCapture(subId, { context: {}, evidence: {}, fingerprint: "a".repeat(64), status: "running" });
  for (const state of ["running", "blocked"] as const) {
    f.workflows.store.setRunState(runId, state, state === "blocked" ? "round_limit" : "persona_review", state === "blocked" ? { maxRepairRounds: 1, parkedPhase: "persona_review" } : null);
    await assert.rejects(f.service.publish(f.authority, f.input), /successful validation/);
  }
  f.workflows.store.setSubmissionState(subId, "completed");
  f.workflows.store.setRunState(runId, "completed", "complete", null);
  f.workflows.store.updateBinding(binding.id, { state: "paused" });
  await assert.rejects(f.service.publish(f.authority, f.input), /paused/);
  f.workflows.store.updateBinding(binding.id, { state: "active" });
  assert.equal(f.workflows.store.latestRunForBinding(binding.id)!.status, "completed");
  assert.equal(f.workflows.store.latestSubmission(runId)!.status, "completed");
  await restart(f);
  await f.service.stop(); // Drain startup recovery through the ordinary completion owner.
  const receipt = publicationReceipt(f.input)!;
  assert.ok(receipt, "restart publishes the completed exact validation");
  assert.equal(receipt.submissionId, subId); assert.equal(receipt.bindingId, binding.id);
  assert.equal(receipt.workflowVersionId, binding.workflowVersionId);
});

test("new revisions, damaged inputs, mixed work and incompatible workflows fail closed", async () => {
  const f = await fixture(); await f.review();
  writeFileSync(join(f.repo, "code.ts"), "export const changed = true;");
  await assert.rejects(f.service.publish(f.authority, f.input), /repository changes/);
  rmSync(join(f.repo, "code.ts"));
  const updated = await savePlan(f.authority, { repoSlot: "repo-01", requestId: randomUUID(), planId: f.input.planId, slug: "local-plan", expectedRevision: 1, files: f.files });
  await assert.rejects(f.service.publish(f.authority, f.input), /stale/);
  await assert.rejects(f.service.publish(f.authority, { ...f.input, revision: 2 }), /explicit human approval/);
  await f.review("answer", 2);
  await f.service.publish(f.authority, { ...f.input, revision: 2 });
  assert.equal(publicationReceipt(f.input), null, "newer receipt cannot release the old revision");
  const task = f.tasks.create({ kind: "ship", repoRoot: f.repo, title: "Pinned", intent: "Read exactly", backlog: true, workflowId: null, planInputs: [{ ...f.input, revision: 2, files: ["plan.md"] }] });
  const context = await planContext(f.authority);
  writeFileSync(join(context.localStore, f.input.planId, "2", "plan.md"), "damaged");
  assert.match(taskPlanInputProblem(task)!, /missing or corrupt/);
  const refusedDispatch = await f.tasks.dispatch(task.id);
  assert.equal(refusedDispatch.ok, false);
  assert.match(refusedDispatch.error!, /missing or corrupt/);
  const refusedAssignment = await f.tasks.assign(task.id, f.session.id);
  assert.equal(refusedAssignment.ok, false);
  assert.match(refusedAssignment.error!, /missing or corrupt/);
  assert.throws(() => readPlanFile(updated.manifest.planId, 2, "plan.md"), /missing or corrupt/);
  const mixed = await fixture(false, "ship"); await mixed.review();
  await assert.rejects(mixed.service.publish(mixed.authority, mixed.input), /mixed code-and-plan/);
  assert.throws(() => mixed.tasks.create({ kind: "ship", repoRoot: mixed.repo, title: "Unsafe bypass", backlog: true, intent: "Do work", dependencies: [{ type: "plan", ...mixed.input }] }), /plan-only source/);
});

test("committed code after an attached repository's task base refuses local publication without releasing its artifact edge", async () => {
  const f = await fixture();
  const attached = mkdtempSync(join(home, "attached-"));
  git(attached, "init", "-q", "-b", "main");
  git(attached, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "initial");
  const baseSha = git(attached, "rev-parse", "HEAD");
  f.registry.upsertTask({ ...f.task, extraRepos: [{
    repoRoot: attached, worktreePath: attached, branch: "main", baseSha,
    provider: null, worktreeLeaseId: null, prUrl: null, prState: null, mergedAt: null,
  }] });
  await f.review();
  const dependent = f.tasks.create({ kind: "ship", repoRoot: f.repo, title: "Blocked implementation phase", intent: "Use the approved local plan", backlog: true, workflowId: null,
    planInputs: [{ ...f.input, files: ["plan.md", "phase-1.md"] }], dependencies: [{ type: "plan", ...f.input }] });
  const originalEdges = f.registry.getTask(dependent.id)!.dependencies;
  assert.equal(originalEdges[0]!.satisfiedAt, null);
  assert.equal(publicationReceipt(f.input), null);

  writeFileSync(join(attached, "code.ts"), "export const changed = true;\n");
  git(attached, "add", "code.ts");
  git(attached, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "Implement code after task base");
  assert.equal(git(f.repo, "status", "--porcelain"), "");
  assert.equal(git(f.repo, "diff", "--name-only", f.task.baseSha!, "HEAD"), "");
  assert.equal(git(attached, "status", "--porcelain"), "", "the working-tree guard alone cannot detect committed code");
  assert.equal(git(attached, "diff", "--name-only", baseSha, "HEAD"), "code.ts");
  assert.equal(f.registry.getTask(f.task.id)!.extraRepos[0]!.baseSha, baseSha);

  await assert.rejects(f.service.publish(f.authority, f.input), /repository changes/);
  assert.equal(publicationReceipt(f.input), null, "refusal must not persist a publication receipt");
  assert.deepEqual(f.registry.getTask(dependent.id)!.dependencies, originalEdges, "refusal must not release the in-memory artifact edge");
  assert.deepEqual(loadActiveTasks().find((task) => task.id === dependent.id)!.dependencies, originalEdges, "refusal must not persist a released artifact edge");
  assert.match(taskPlanInputProblem(f.registry.getTask(dependent.id)!)!, /waiting/);
  assert.equal(f.registry.getTask(f.task.id)!.status, "running");
});

test("versioned tasks authorize scopes and retain exact inputs; malformed persisted state stays blocked", async () => {
  const f = await fixture(); await f.review();
  const request = { title: "Scheduled phase", intent: "Implement only phase 1", repoRoot: f.repo,
    planInputs: [{ ...f.input, files: ["plan.md", "phase-1.md"] }], planPrerequisites: [f.input] };
  const response = await f.post("/mcp/v3/tasks", request);
  assert.equal(response.status, 200, await response.clone().text());
  const task = await response.json() as ReturnType<typeof mkTask>;
  assert.deepEqual(task.planInputs, request.planInputs);
  assert.equal((await f.post("/mcp/v3/tasks", { ...request, unknownPlanInput: true })).status, 400, "versioned contract refuses unknown fields");
  const other = await fixture();
  assert.equal((await other.post("/mcp/v3/tasks", request)).status, 403);
  assert.equal((await f.post("/mcp/v3/tasks", { ...request, targetRepository: other.repo })).status, 403);
  openDb().prepare("UPDATE tasks SET plan_inputs = ? WHERE id = ?").run('{"future":true}', task.id);
  const corrupt = loadActiveTasks().find((t) => t.id === task.id)!;
  assert.match(taskPlanInputProblem(corrupt)!, /corrupt or unsupported/);
  f.registry.upsertTask(corrupt);
  assert.match(loadActiveTasks().find((t) => t.id === task.id)!.planInputError!, /corrupt or unsupported/);
  openDb().prepare("UPDATE tasks SET dependencies = ? WHERE id = ?").run('[{"type":"future","satisfiedAt":1}]', task.id);
  assert.equal(loadActiveTasks().find((t) => t.id === task.id)!.dependencies[0]!.satisfiedAt, null);
});

test("task updates keep exact Markdown inputs paired with every plan publication prerequisite", async () => {
  const f = await fixture();
  await f.review();
  const input = { ...f.input, files: ["plan.md", "phase-1.md"] };
  const edge = { type: "plan" as const, ...f.input };
  const task = f.tasks.create({ kind: "ship", repoRoot: f.repo, title: "Pinned phase", intent: "Implement the exact phase", backlog: true, workflowId: null, planInputs: [input], dependencies: [edge] });
  const originalEdges = task.dependencies;
  for (const patch of [{ planInputs: [] }, { planInputs: [], dependencies: [edge] }]) {
    const refused = await f.tasks.update(task.id, patch);
    assert.equal(refused.ok, false, "an update cannot leave a plan edge without readable inputs");
    assert.match(refused.error!, /prerequisite.*exact Markdown input/);
    assert.deepEqual(f.tasks.get(task.id)!.planInputs, [input]);
    assert.deepEqual(f.tasks.get(task.id)!.dependencies, originalEdges);
  }
  await restart(f);
  assert.deepEqual(loadActiveTasks().find((row) => row.id === task.id)!.planInputs, [input]);
  assert.throws(() => f.tasks.create({ kind: "ship", repoRoot: f.repo, title: "Missing reference", intent: "Cannot infer a phase file", backlog: true, workflowId: null, dependencies: [edge] }), /prerequisite.*exact Markdown input/);
  await f.service.publish(f.authority, f.input);
  assert.equal((await f.tasks.update(task.id, { planInputs: [] })).ok, false, "published edges still need exact readable inputs");

  await savePlan(f.authority, { repoSlot: "repo-01", requestId: randomUUID(), planId: f.input.planId, slug: "local-plan", expectedRevision: 1, files: f.files });
  const nextEdge = { ...edge, revision: 2 };
  const mismatched = await f.tasks.update(task.id, { dependencies: [nextEdge] });
  assert.equal(mismatched.ok, false, "a published revision 1 input cannot stand in for a revision 2 prerequisite");
  assert.match(mismatched.error!, /prerequisite.*exact Markdown input/);
  const nextInput = { ...input, revision: 2 };
  assert.equal((await f.tasks.update(task.id, { planInputs: [nextInput], dependencies: [nextEdge] })).ok, true);
  await restart(f);
  const reloaded = loadActiveTasks().find((row) => row.id === task.id)!;
  assert.deepEqual(reloaded.planInputs, [nextInput]);
  assert.equal(reloaded.dependencies[0]!.type, "plan");
  assert.equal(reloaded.dependencies[0]!.satisfiedAt, null);
  const discovery = await taskPlanDiscovery(reloaded);
  assert.ok(discovery.includes(f.input.planId));
  assert.match(discovery, /revision: 2/);
  assert.match(discovery, /Read Markdown files: plan.md, phase-1.md/);
  assert.match(taskPlanInputProblem({ ...reloaded, planInputs: [] })!, /prerequisite.*exact Markdown input/, "persisted mismatches also refuse delivery");
  assert.equal((await f.tasks.update(task.id, { planInputs: [], dependencies: [] })).ok, true, "an explicit edit may remove both halves together");
});

for (const incompatible of ["session action", "Inspector gate"] as const) test(`local workflow compatibility rejects ${incompatible} using the correct selected or bound version`, async () => {
  const f = await fixture(true);
  const store = f.workflows.store;
  const approvedVersion = store.getWorkflowVersionById(f.binding!.workflowVersionId)!;
  const repositoryVersion = store.getWorkflowVersionById(store.getWorkflow(PLAN_VALIDATION_WORKFLOW_ID)!.currentVersionId!)!;
  const graph = incompatible === "session action" ? repositoryVersion.graph : approvedVersion.graph;
  assert.equal(graph.nodes.some((node) => node.kind === "session_action"), incompatible === "session action");
  const completionPolicy = incompatible === "Inspector gate"
    ? { kind: "inspector", onFindings: "restart_workflow", missingPrAction: "wait" }
    : { kind: "none" };
  // Seed operator-owned versions; built-ins are virtual catalog entries, not SQLite rows.
  const workflowId = randomUUID(), firstId = randomUUID(), id = randomUUID();
  assert.equal(store.insertWorkflow({ id: workflowId, name: workflowId, normalizedName: workflowId, description: "Compatibility fixture", draft: store.getWorkflow(LOCAL_PLAN_VALIDATION_WORKFLOW_ID)!.draft, completionPolicy: approvedVersion.completionPolicy, resumptionPolicy: "manual", bindingDefaults: approvedVersion.bindingDefaults, createdAt: Date.now(), updatedAt: Date.now() }).ok, true);
  const seedVersion = (versionId: string, version: number, graphJson: string, policyJson: string) => openDb().prepare(`INSERT INTO workflow_versions (id, workflow_id, version, source_draft_revision, graph_json, completion_policy_json, binding_defaults_json, published_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(versionId, workflowId, version, version, graphJson, policyJson, JSON.stringify(approvedVersion.bindingDefaults), Date.now());
  const selectVersion = (versionId: string) => openDb().prepare("UPDATE workflow_definitions SET current_version_id = ? WHERE id = ?").run(versionId, workflowId);
  seedVersion(firstId, 1, JSON.stringify(approvedVersion.graph), JSON.stringify(approvedVersion.completionPolicy));
  selectVersion(firstId);
  const bind = (versionId: string) => store.insertBinding({ id: randomUUID(), workflowVersionId: versionId, noteKey: f.binding!.noteKey, sessionId: f.id, sessionAgent: "claude", sessionName: f.id, sessionCwd: f.repo, sessionRepoRoot: f.repo, triggerMode: "manual", deliveryMode: "preview", maxRepairRounds: 1, now: Date.now() });
  store.updateBinding(f.binding!.id, { state: "archived" });
  const pinned = bind(firstId);
  assert.equal(localWorkflowProblem(workflowId, store), null);
  assert.equal(localPlanAuthorityContext(f.workflows, f.id).owner, "workflow");
  seedVersion(id, 2, JSON.stringify(graph), JSON.stringify(completionPolicy));
  selectVersion(id);
  assert.match(localWorkflowProblem(workflowId, store)!, /review-only workflow/);
  assert.equal(localPlanAuthorityContext(f.workflows, f.id).owner, "workflow", "a new current version cannot alter an existing compatible binding");
  store.updateBinding(pinned.id, { state: "archived" });
  bind(id);
  assert.throws(() => localPlanAuthorityContext(f.workflows, f.id), /publication actions incompatible/);
  selectVersion(firstId);
  assert.equal(localWorkflowProblem(workflowId, store), null);
  assert.throws(() => localPlanAuthorityContext(f.workflows, f.id), /publication actions incompatible/, "a compatible current version cannot launder an incompatible pinned binding");
});

test("valid plan input replacements clear stored corruption while unrelated and invalid updates retain it", async () => {
  const f = await fixture();
  await f.review();
  await f.service.publish(f.authority, f.input);
  const inputs = [{ ...f.input, files: ["plan.md"] }];
  applySkillsConfig({ planStorage: "local", commitPlanHtml: true });
  const task = f.tasks.create({ kind: "plan", repoRoot: f.repo, title: "Repair inputs", intent: "Consume the exact approved plan", backlog: true, workflowId: null, planInputs: inputs });
  for (const replacement of [inputs, []]) {
    openDb().prepare("UPDATE tasks SET plan_inputs = ? WHERE id = ?").run('{"future":true}', task.id);
    f.registry.upsertTask(loadActiveTasks().find((row) => row.id === task.id)!);
    assert.match(taskPlanInputProblem(f.tasks.get(task.id)!)!, /corrupt or unsupported/);
    assert.equal((await f.tasks.update(task.id, { title: "Still needs input repair" })).ok, true);
    assert.match(f.tasks.get(task.id)!.planInputError!, /corrupt or unsupported/);
    assert.equal((await f.tasks.update(task.id, { planInputs: [{ ...inputs[0]!, revision: 999 }] })).ok, false);
    assert.match(f.tasks.get(task.id)!.planInputError!, /corrupt or unsupported/);
    const repaired = await f.tasks.update(task.id, { planInputs: replacement });
    assert.equal(repaired.ok, true);
    assert.equal(f.tasks.get(task.id)!.planInputError, null);
    assert.deepEqual(f.tasks.get(task.id)!.planInputs, replacement);
    await restart(f);
    const reloaded = loadActiveTasks().find((row) => row.id === task.id)!;
    assert.equal(reloaded.planInputError, null);
    assert.deepEqual(reloaded.planInputs, replacement);
    assert.deepEqual(reloaded.planPolicy, task.planPolicy, "input corruption and repair must preserve the pinned policy");
    assert.equal(taskPlanInputProblem(reloaded), null);
    assert.deepEqual(declaredBlockers(reloaded, []), []);
  }
  openDb().prepare("UPDATE tasks SET plan_policy = ? WHERE id = ?").run('{"future":true}', task.id);
  f.registry.upsertTask(loadActiveTasks().find((row) => row.id === task.id)!);
  assert.equal((await f.tasks.update(task.id, { planInputs: inputs })).ok, true);
  await restart(f);
  const invalidPolicy = loadActiveTasks().find((row) => row.id === task.id)!;
  assert.deepEqual(invalidPolicy.planInputs, inputs);
  assert.match(taskPlanInputProblem(invalidPolicy)!, /policy is corrupt or unsupported/, "an input-only repair cannot erase separate policy corruption");
  assert.equal(declaredBlockers(invalidPolicy, [])[0]?.title, invalidPolicy.planPolicyError);
  applySkillsConfig({ planStorage: "repository", commitPlanHtml: false });
});

test("discovery is read-only and explicit reservation pins every repository once", async () => {
  const f = await fixture(), attached = await fixture();
  applySkillsConfig({ planStorage: "local", commitPlanHtml: true });
  const task = f.tasks.create({ kind: "plan", repoRoot: f.repo, extraRepoRoots: [attached.repo], title: "Reserved plan", intent: "Plan both repositories", backlog: true, workflowId: null });
  const reservations = () => openDb().prepare("SELECT repo_key, plan_id, policy FROM managed_plan_reservations WHERE task_id = ? ORDER BY repo_key").all(task.id);
  const changes = () => openDb().prepare("SELECT total_changes() AS count").get();
  const before = changes();
  const first = await taskPlanDiscovery(task);
  assert.match(first, /repo-01: repository plans/);
  assert.match(first, /repo-02: repository plans/);
  assert.deepEqual(reservations(), []);
  assert.deepEqual(changes(), before, "composing discovery cannot perform a durable write");
  reserveTaskPlans(task);
  const pinned = reservations();
  assert.equal(pinned.length, 2);
  assert.notEqual(pinned[0]!.plan_id, pinned[1]!.plan_id);
  for (const reservation of pinned) assert.deepEqual(JSON.parse(reservation.policy as string), task.planPolicy);
  applySkillsConfig({ planStorage: "repository", commitPlanHtml: false });
  const afterReservation = changes();
  assert.equal(await taskPlanDiscovery(task), first);
  assert.deepEqual(changes(), afterReservation);
  reserveTaskPlans(task);
  assert.deepEqual(reservations(), pinned, "repeated launch preflight preserves each reserved identity and policy");
});

for (const storage of ["repository", "local"] as const) test(`task creation checks and stores one ${storage} policy and workflow selection`, async (t) => {
  const f = await fixture();
  applySkillsConfig({ planStorage: storage, commitPlanHtml: true });
  const workflowId = storage === "local" ? LOCAL_PLAN_VALIDATION_WORKFLOW_ID : PLAN_VALIDATION_WORKFLOW_ID;
  const selectionBlock = f.workflows.workflowSelectionBlock.bind(f.workflows);
  let checked = false;
  t.mock.method(f.workflows, "workflowSelectionBlock", (selected: string) => {
    assert.equal(selected, workflowId);
    checked = true;
    const blocked = selectionBlock(selected);
    // Model a settings edit between route validation and TaskManager persistence.
    applySkillsConfig({ planStorage: storage === "local" ? "repository" : "local", commitPlanHtml: false });
    return blocked;
  });
  const response = await f.post("/api/tasks", { repoRoot: f.repo, title: "Pinned creation", intent: "Plan the change", kind: "plan", backlog: true });
  assert.equal(response.status, 200, await response.clone().text());
  const task = await response.json() as ReturnType<typeof mkTask>;
  assert.equal(checked, true);
  assert.equal(task.workflowId, workflowId);
  assert.equal(task.planPolicy?.storage, storage);
  assert.equal(task.planPolicy?.commitPlanHtml, true);
  assert.deepEqual(loadActiveTasks().find((row) => row.id === task.id)!.planPolicy, task.planPolicy);
  applySkillsConfig({ planStorage: "repository", commitPlanHtml: false });
});

test("local defaults are pinned before dispatch; incompatible explicit workflows and stale binding evidence are refused", async () => {
  const f = await fixture(true);
  const { applySkillsConfig } = await import("../src/server/skills/config.ts");
  applySkillsConfig({ planStorage: "local", commitPlanHtml: true });
  const created = await f.post("/api/tasks", { repoRoot: f.repo, title: "Future local plan", intent: "Plan the next change", kind: "plan", backlog: true });
  assert.equal(created.status, 200, await created.clone().text());
  const task = await created.json() as ReturnType<typeof mkTask>;
  assert.equal(task.workflowId, LOCAL_PLAN_VALIDATION_WORKFLOW_ID);
  assert.deepEqual(task.planPolicy, { version: 2, storage: "local", commitPlanHtml: true });
  applySkillsConfig({ planStorage: "repository", commitPlanHtml: false });
  assert.deepEqual(f.tasks.get(task.id)!.planPolicy, task.planPolicy);
  const incompatible = f.tasks.update(task.id, { workflowId: "builtin-workflow:plan-validation" });
  assert.equal((await incompatible).ok, false);
  await f.review();
  const binding = f.binding!;
  const runId = randomUUID(), subId = randomUUID();
  const { submission } = f.workflows.store.createInitialSubmission({ id: runId, binding, intent: FIXTURE_RUN_INTENT, triggerSource: "manual", triggerKey: runId, now: Date.now() }, { id: subId, triggerSource: "manual", triggerKey: subId, context: {}, evidence: {}, now: Date.now() });
  freezeLocalPlanSubmission(f.registry, f.workflows, binding, submission);
  f.workflows.store.setSubmissionState(subId, "failed");
  f.workflows.store.setRunState(runId, "failed", "failed_outcome", null);
  await assert.rejects(f.service.publish(f.authority, f.input), /successful validation/);
  f.workflows.store.updateBinding(binding.id, { state: "archived" });
  await assert.rejects(f.service.publish(f.authority, f.input), /explicit human approval/, "archival cannot downgrade a bound approval into an unbound grant");
  const newBinding = f.workflows.store.insertBinding({ id: randomUUID(), workflowVersionId: binding.workflowVersionId, noteKey: binding.noteKey, sessionId: f.id, sessionAgent: "claude", sessionName: f.id, sessionCwd: f.repo, sessionRepoRoot: f.repo, triggerMode: "manual", deliveryMode: "preview", maxRepairRounds: 1, now: Date.now() });
  assert.throws(() => freezeLocalPlanSubmission(f.registry, f.workflows, newBinding, submission), /explicit human approval/);
  assert.equal(publicationReceipt(f.input), null);
});
