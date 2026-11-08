// Exercise the agent-facing stdio protocol through HTTP to the real workflow owner and SQLite.
import assert from "node:assert/strict";
import { after, test, type TestContext } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { FIXTURE_RUN_INTENT } from "./helpers/workflow-run-intent.ts";
import { decisionLead, formatResponse } from "../src/shared/review-item.ts";
import { WorkflowActionRequestSchema, workflowActionPath } from "../src/shared/workflow-mcp.ts";
import { WORKFLOW_ACTION_ROUTES } from "../src/shared/workflow-actions.ts";
import type { WorkflowManagerOptions } from "../src/server/workflows/manager.ts";
import type { WorkflowBinding, WorkflowCompletionPolicy, WorkflowInspectorGateState } from "../src/shared/workflow.ts";
import type { LlmRunner } from "../src/shared/llm.ts";

const home = mkdtempSync(join(tmpdir(), "mission-mcp-workflow-"));
const successfulActions = new Set<string>();
process.env.MISSION_HOME = home;
// Capabilities are namespaced by daemon port. Reserve the fixture's port before
// importing runtime constants so the daemon and its MCP children use the same namespace.
const reservation = createServer();
await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
const reservedAddress = reservation.address();
assert.ok(reservedAddress && typeof reservedAddress !== "string");
const port = reservedAddress.port;
await new Promise<void>((resolve, reject) => reservation.close((err) => err ? reject(err) : resolve()));
process.env.MISSION_PORT = String(port);
after(() => rmSync(home, { recursive: true, force: true }));

const { Registry } = await import("../src/server/registry.ts");
const { TaskManager } = await import("./helpers/task-manager-fixture.ts");
const { ReviewManager } = await import("../src/server/reviews.ts");
const { QueueManager } = await import("../src/server/queue.ts");
const { WorkflowManager } = await import("../src/server/workflows/manager.ts");
const { WorkflowCommandArtifactService } = await import("../src/server/workflows/command-artifacts.ts");
const { WorkflowCommandManager } = await import("../src/server/workflows/commands.ts");
const { BUILTIN_WORKFLOWS } = await import("../src/server/workflows/builtin-workflows.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { ensureToken } = await import("../src/server/auth.ts");
const { fallbackWorkflowContext, compactWorkflowContext } = await import("../src/server/workflows/context.ts");
const { workflowJson } = await import("../src/server/workflows/store.ts");
const { setWorkflowPolicy } = await import("../src/server/workflows/config.ts");
const { maintainScoutSessionCredentials } = await import("../src/server/scouts/session-credentials.ts");
const { sessionScoutCredentialLocator } = await import("../src/server/scouts/submission-auth.ts");
const { sessionScoutCredentialPath, sessionScoutCredentialDirectory } = await import("../src/shared/harness-runtime.mjs");
after(() => rmSync(sessionScoutCredentialDirectory(), { recursive: true, force: true }));

async function fixture(
  t: TestContext, options: WorkflowManagerOptions = {}, credentialLocator?: string, childSessionIdentity = false,
) {
  const registry = new Registry();
  const releaseCredentials = maintainScoutSessionCredentials(registry);
  const caller = registry.registerSdkSession({ id: `sdk:workflow-caller-${randomUUID()}`,
    agent: "claude", name: "Workflow controller", cwd: home, agentSessionId: `native-${randomUUID()}` });
  registry.setSessionControlEnabled(caller.id, true);
  const commandArtifacts = options.commandArtifacts
    ?? new WorkflowCommandArtifactService(undefined, join(home, `command-output-${randomUUID()}`));
  const workflows = new WorkflowManager(registry, undefined, { ...options, commandArtifacts });
  const store = workflows.store;
  const workflowCommands = new WorkflowCommandManager(registry, store);
  const reviews = new ReviewManager(registry);
  const app = buildApp({ registry, workflows, workflowCommands, tasks: new TaskManager(registry),
    queues: new QueueManager(registry), reviews });
  const requests: Array<{ path: string; method: string; body: unknown; actor: string | null; surface: string | null }> = [];
  const server = serve({ hostname: "127.0.0.1", port, fetch: async (req) => {
    requests.push({ path: new URL(req.url).pathname, method: req.method,
      body: req.method === "POST" ? await req.clone().json() : null,
      actor: req.headers.get("x-mission-operation-actor"), surface: req.headers.get("x-mission-operation-surface") });
    return app.fetch(req);
  } });
  const client = new Client({ name: "workflow-actions-test", version: "1" });
  t.after(async () => {
    await client.close();
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    await workflows.stop();
    releaseCredentials();
  });
  await new Promise<void>((resolve) => server.listening ? resolve() : server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: ["--import", "tsx", fileURLToPath(new URL("../src/mcp/server.ts", import.meta.url))],
    env: { ...process.env, MISSION_HOME: home, MISSION_API_TOKEN: ensureToken(), MISSION_PORT: String(address.port),
      MISSION_SCOUT_SESSION_LOCATOR: credentialLocator ?? sessionScoutCredentialLocator(caller.id),
      // Only where a test asks: the SDK launch identity `request_input` files its card under.
      ...(childSessionIdentity ? { MISSION_SESSION_ID: caller.id } : {}) } as Record<string, string>,
    stderr: "pipe" }));
  async function call(name: string, args: Record<string, unknown>, error?: RegExp) {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as Array<{ type: string; text: string }>).filter((item) => item.type === "text").map((item) => item.text).join("\n");
    assert.equal(Boolean(result.isError), Boolean(error), text);
    if (error) { assert.match(text, error); return null; }
    if (name === "trigger_workflow_action") successfulActions.add((args.request as { action: string }).action);
    return JSON.parse(text);
  }
  function seed(ownerSessionId?: string, sessionRepoRoot: string | null = "/repo") {
    const key = randomUUID();
    const version = store.getWorkflowVersionById(BUILTIN_WORKFLOWS[0]!.definition.currentVersionId!)!;
    const binding = store.insertBinding({ id: `binding-${key}`, workflowVersionId: version.id,
      noteKey: ownerSessionId === caller.id ? caller.agentSessionId! : key,
      sessionId: ownerSessionId ?? key, sessionAgent: "claude", sessionName: "MCP test", sessionCwd: "/repo",
      sessionRepoRoot, repoRoot: `/repo/${key}`, triggerMode: "manual", deliveryMode: "preview", maxRepairRounds: 1, now: Date.now() });
    const { run, submission } = store.createInitialSubmission({ id: key, binding, intent: FIXTURE_RUN_INTENT,
      triggerSource: "manual", triggerKey: key, now: Date.now() },
    { id: `submission-${key}`, triggerSource: "manual", triggerKey: key, context: {}, evidence: {}, now: Date.now() });
    store.createRepairSubmission({ id: `repair-${key}`, runId: run.id, round: 2,
      triggerSource: "manual", triggerKey: `repair-${key}`, context: {}, evidence: {}, now: Date.now() });
    store.blockForRoundLimit(store.getRun(run.id)!);
    return { run, submission, version };
  }
  const credential = () => readFileSync(sessionScoutCredentialPath(`session:${sessionScoutCredentialLocator(caller.id)}`), "utf8").trim();
  /** The operator picking exactly `command` on one of the caller's `request_input` cards. */
  function confirm(command: string[]) {
    const label = command.join(" ");
    const card = reviews.create(caller.id, "input", "Confirm the Command", `Use ${label}?`,
      [{ id: "q", question: `Use ${label}?`, options: [{ id: "o0", label }, { id: "o1", label: "Something else" }] }]);
    reviews.resolve(card.id, "answer", `Answered:\n\n• Use ${label}?\n  → ${label}`, "human",
      [{ decisionId: "q", selected: ["o0"], other: null }]);
    return card.id;
  }
  return {
    client, call, seed, requests, store, workflows, registry, caller, app, credential,
    commandArtifacts, workflowCommands, reviews, confirm,
  };
}

/** Fake only external work. Actions still use the real MCP child, routes, manager and store. */
async function runtimeFixture(
  t: TestContext, readiness = false, extra: WorkflowManagerOptions = {}, childSessionIdentity = false,
) {
  const control = { mappingFails: false, revision: 1, captures: 0 };
  const sent: string[] = [];
  const runner: LlmRunner = {
    id: "claude", label: "fake", runInThread: null, structuredOutput: null, sandbox: null,
    price: () => null, litter: null, killLiveRuns() {},
    async run() {
      return JSON.stringify({ verdict: "pass", summary: "Passed", confidence: 1,
        approvalDetails: { reason: "The fixture behavior is present", evidence: [] } });
    },
  };
  function rawContext(binding: WorkflowBinding) {
    return {
      primaryGoal: { rawPrompt: "Verify MCP workflow actions", refined: null, sourceNoteKey: binding.noteKey },
      humanDecisions: [], priorPersonaFeedback: [],
      session: { agent: "claude" as const, name: "MCP runtime", cwd: home, branch: "feature" },
      evidence: {
        headSha: `head-${control.revision}`, diffFingerprint: `diff-${control.revision}`, diff: "fixture patch",
        diffTruncated: false, workingTreeDirty: false, workingTreeStatus: [], workingTreeStatusTruncated: false,
        transcript: [], transcriptAnchor: null, transcriptTruncated: false, standards: [], standardsTruncated: false,
      },
    };
  }
  const f = await fixture(t, {
    ...extra,
    requireSkill: () => ({ ok: true, command: "/pull-request" }),
    inject: async (_session, text, _deps, beforeWrite) => {
      const blocked = beforeWrite?.();
      if (blocked) return { ok: false, error: blocked, pasted: false, submitVerified: false };
      sent.push(text);
      return { ok: true, pasted: true, submitVerified: true };
    },
    recordInjection: () => {},
    readContextRaw: async (_registry, binding) => {
      control.captures++;
      const raw = rawContext(binding);
      return { raw, context: fallbackWorkflowContext(raw, null), boundary: {
        noteKey: binding.noteKey, sessionId: binding.sessionId!, headSha: raw.evidence.headSha,
        transcriptPath: null, transcriptSize: 0, repositoryFingerprint: raw.evidence.diffFingerprint,
      } };
    },
    boundaryChanged: async () => false,
    readEvidenceProbe: async () => ({ headSha: `head-${control.revision}`, workingTreeStatus: [], diffFingerprint: `diff-${control.revision}` }),
    compactContext: async (raw) => readiness ? compactWorkflowContext(raw, {
      deferReconciliation: true,
      execute: async () => ({ kind: "ok", value: { constraints: [], acceptanceCriteria: ["MCP workflow proof"],
        canonicalCriteria: [{ text: "MCP workflow proof", material: true, suggestedProofClass: null }] } }),
    }) : fallbackWorkflowContext(raw, null),
    reconcileContext: async () => control.mappingFails
      ? { kind: "failed", cause: "transport", reason: "fixture mapping unavailable" }
      : { kind: "ok", value: { criterionMappings: [{ canonicalCriterionOrdinal: 1, matchedClientCriterionIds: ["proof-claim"] }] } },
    engine: { runnerFor: () => runner, resolveExecution: () => ({
      runner: { id: "claude", source: "config", unknown: null }, model: { id: "fake", source: "config" },
    }) },
  }, undefined, childSessionIdentity);
  function session() {
    const sessionId = `sdk:${randomUUID()}`;
    f.registry.registerSdkSession({ id: sessionId, agent: "claude", name: "MCP runtime", cwd: home, repoRoot: home, gitRoot: home });
    f.registry.applyDriverEvent(sessionId, { kind: "bound", agentSessionId: sessionId,
      transcriptPath: null, modelId: null, pid: null });
    return sessionId;
  }
  function bind(completionPolicy: WorkflowCompletionPolicy = { kind: "none" }, sessionId = session()) {
    const key = randomUUID();
    const personaId = `persona-${key}`;
    f.store.insertPersona({ id: personaId, name: personaId, normalizedName: personaId, description: "",
      guidanceMarkdown: "Review the fixture", runner: "claude", model: "fake", createdAt: 1, updatedAt: 1 });
    const created = f.store.insertWorkflow({ id: key, name: key, normalizedName: key, description: "",
      draft: { nodes: [
        { id: "session", kind: "session", position: { x: 0, y: 0 } },
        { id: "reviewer", kind: "persona", personaId, position: { x: 100, y: 0 } },
        { id: "end", kind: "end", outcome: "Complete", position: { x: 200, y: 0 } },
      ], edges: [
        { id: "start", source: "session", sourcePort: "submitted", target: "reviewer", targetPort: "activate" },
        { id: "pass", source: "reviewer", sourcePort: "pass", target: "end", targetPort: "terminal" },
        { id: "fail", source: "reviewer", sourcePort: "fail", target: "session", targetPort: "return_for_changes" },
      ] }, completionPolicy, resumptionPolicy: "manual", evidenceReadinessPolicy: readiness ? "criterion_mapped_v1" : "off",
      bindingDefaults: { triggerMode: "manual", deliveryMode: "preview", maxRepairRounds: 5 }, createdAt: 1, updatedAt: 1 });
    assert.ok(created.ok);
    const published = f.store.publishWorkflow(key, 1, `version-${key}`, 2);
    assert.ok(published.ok);
    const attached = f.workflows.createBinding({ workflowVersionId: published.version.id, sessionId });
    assert.ok(attached.ok);
    return attached.value;
  }
  function seedRun(binding: WorkflowBinding) {
    const key = randomUUID();
    const result = f.store.createInitialSubmission({ id: key, binding, intent: FIXTURE_RUN_INTENT,
      triggerSource: "manual", triggerKey: key, now: Date.now() },
    { id: `submission-${key}`, triggerSource: "manual", triggerKey: key, context: {}, evidence: {}, now: Date.now() });
    const context = fallbackWorkflowContext(rawContext(binding), null);
    f.store.updateSubmissionCapture(result.submission.id, { context: workflowJson(context), evidence: workflowJson(context.evidence), fingerprint: key, status: "running" });
    return result;
  }
  async function act(action: string, target: Record<string, string>, parameters: Record<string, unknown> = {}, error?: RegExp) {
    return f.call("trigger_workflow_action", { request: { action, ...target,
      parameters: action === "reattach" ? parameters : { requestId: randomUUID(), ...parameters } } }, error);
  }
  return { ...f, bind, seedRun, act, session, control, sent };
}

test("MCP discovers runs, grants rounds exactly once, and durably cancels with agent attribution", async (t) => {
  const f = await fixture(t);
  const { run } = f.seed();
  const tools = (await f.client.listTools()).tools.map((tool) => tool.name);
  for (const name of ["list_workflow_runs", "get_workflow_run", "trigger_workflow_action"]) assert.ok(tools.includes(name));
  const page = await f.call("list_workflow_runs", { status: "blocked", limit: 1 });
  assert.equal(page.items[0].id, run.id);
  const request = { action: "grant-rounds", runId: run.id, parameters: { requestId: "grant-once", rounds: 2 } };
  const first = await f.call("trigger_workflow_action", { request });
  assert.equal(first.run.maxRepairRounds, 3);
  assert.equal(first.idempotent, false);
  const replay = await f.call("trigger_workflow_action", { request });
  assert.equal(replay.idempotent, true);
  assert.equal(f.store.getRun(run.id)?.maxRepairRounds, 3);
  assert.equal(f.store.listEvents(run.id).filter((event) => event.kind === "repair_rounds_granted").length, 1);
  const cancellation = { action: "cancel", runId: run.id, parameters: { requestId: "cancel-once" } };
  const cancelled = await f.call("trigger_workflow_action", { request: cancellation });
  assert.equal(cancelled.run.status, "cancelled");
  assert.equal((await f.call("trigger_workflow_action", { request: cancellation })).idempotent, true);
  assert.equal(f.store.getRun(run.id)?.status, "cancelled");
  for (const req of f.requests) {
    assert.equal(req.actor, "agent");
    assert.equal(req.surface, "mcp");
  }
});

test("MCP self-control works with delegation off, but cross-session grants require opt-in", async (t) => {
  const f = await fixture(t);
  const own = f.seed(f.caller.id);
  const other = f.seed();
  f.registry.setSessionControlEnabled(f.caller.id, false);
  await f.call("trigger_workflow_action", { request: { action: "grant-rounds", runId: own.run.id,
    parameters: { requestId: "self-grant", rounds: 2 } } });
  assert.equal(f.store.getRun(own.run.id)?.maxRepairRounds, 3);
  const request = { action: "grant-rounds", runId: other.run.id, parameters: { requestId: "cross-grant", rounds: 2 } };
  await f.call("trigger_workflow_action", { request }, /Control other sessions|session control/i);
  assert.equal(f.store.getRun(other.run.id)?.maxRepairRounds, 1);
  f.registry.setSessionControlEnabled(f.caller.id, true);
  await f.call("trigger_workflow_action", { request });
  assert.equal(f.store.getRun(other.run.id)?.maxRepairRounds, 3);
  f.registry.setSessionControlEnabled(f.caller.id, false);
  await f.call("trigger_workflow_action", { request: { action: "cancel", runId: other.run.id,
    parameters: { requestId: "revoked" } } }, /Control other sessions|session control/i);
  assert.notEqual(f.store.getRun(other.run.id)?.status, "cancelled");
});

test("MCP run reads and pagination are scoped before limiting, and credentials cannot be spoofed", async (t) => {
  const f = await fixture(t);
  const own = [f.seed(f.caller.id), f.seed(f.caller.id)];
  const other = f.seed();
  f.registry.setSessionControlEnabled(f.caller.id, false);
  const page = await f.call("list_workflow_runs", { limit: 1 });
  const next = await f.call("list_workflow_runs", { limit: 1, cursor: page.nextCursor });
  assert.deepEqual([page.items[0].id, next.items[0].id].sort(), own.map(({ run }) => run.id).sort());
  assert.equal(next.nextCursor, null);
  assert.deepEqual((await f.call("list_workflow_runs", { session: f.store.getBinding(other.run.bindingId)!.sessionId })).items, []);
  assert.equal((await f.call("get_workflow_run", { runId: own[0]!.run.id })).run.id, own[0]!.run.id);
  await f.call("get_workflow_run", { runId: other.run.id }, /Control other sessions/i);
  f.registry.setSessionControlEnabled(f.caller.id, true);
  assert.equal((await f.call("get_workflow_run", { runId: other.run.id })).run.id, other.run.id);
  const visible = (await f.call("list_workflow_runs", {})).items.map((run: { id: string }) => run.id);
  for (const { run } of [...own, other]) assert.ok(visible.includes(run.id));
  f.registry.setSessionControlEnabled(f.caller.id, false);
  const signed = f.credential();
  const request = { request: { action: "cancel", runId: own[0]!.run.id, parameters: { requestId: "forged" } } };
  for (const credential of [undefined, "forged", `${signed}tampered`]) {
    const response = await f.app.request("/mcp/workflows/act", { method: "POST",
      headers: { host: "localhost", "content-type": "application/json", "x-harness-token": ensureToken(),
        ...(credential ? { "x-mission-scout-credential": credential } : {}) }, body: JSON.stringify(request) });
    assert.equal(response.status, 403);
  }
  assert.notEqual(f.store.getRun(own[0]!.run.id)?.status, "cancelled");
  f.registry.applyDriverEvent(f.caller.id, { kind: "bound", agentSessionId: "replacement-conversation",
    transcriptPath: null, modelId: null, pid: null });
  const stale = await f.app.request("/mcp/workflows/read", { method: "POST",
    headers: { host: "localhost", "content-type": "application/json", "x-harness-token": ensureToken(),
      "x-mission-scout-credential": signed }, body: JSON.stringify({ runId: own[0]!.run.id }) });
  assert.equal(stale.status, 403);
  // A refreshed credential also cannot claim the previous conversation's binding.
  await f.call("get_workflow_run", { runId: own[0]!.run.id }, /Control other sessions/i);
});

test("MCP retained Command output uses the same owning-session authorization and opaque paging", async (t) => {
  const f = await fixture(t);
  const own = f.seed(f.caller.id);
  const other = f.seed();
  const ownCapture = f.commandArtifacts.beginCapture({
    runId: own.run.id,
    submissionId: own.submission.id,
    attemptId: "attempt-own-output",
  });
  ownCapture.push("stdout", Buffer.from("🙂owned"));
  const ownArtifact = ownCapture.finalize(true).find((artifact) => artifact.kind === "stdout")!;
  const otherCapture = f.commandArtifacts.beginCapture({
    runId: other.run.id,
    submissionId: other.submission.id,
    attemptId: "attempt-other-output",
  });
  otherCapture.push("stdout", Buffer.from("other"));
  const otherArtifact = otherCapture.finalize(true).find((artifact) => artifact.kind === "stdout")!;

  f.registry.setSessionControlEnabled(f.caller.id, false);
  const first = await f.call("read_workflow_command_output", {
    runId: own.run.id,
    attemptId: "attempt-own-output",
    artifactId: ownArtifact.id,
    limit: 4,
  });
  assert.equal(first.text, "🙂");
  assert.ok(first.nextCursor);
  const second = await f.call("read_workflow_command_output", {
    runId: own.run.id,
    attemptId: "attempt-own-output",
    artifactId: ownArtifact.id,
    cursor: first.nextCursor,
    limit: 64,
  });
  assert.equal(second.text, "owned");
  assert.equal(second.nextCursor, null);

  await f.call("read_workflow_command_output", {
    runId: other.run.id,
    attemptId: "attempt-other-output",
    artifactId: otherArtifact.id,
  }, /Control other sessions/i);
  f.registry.setSessionControlEnabled(f.caller.id, true);
  assert.equal((await f.call("read_workflow_command_output", {
    runId: other.run.id,
    attemptId: "attempt-other-output",
    artifactId: otherArtifact.id,
  })).text, "other");

  await f.call("read_workflow_command_output", {
    runId: own.run.id,
    attemptId: "attempt-other-output",
    artifactId: otherArtifact.id,
  }, /No such retained Command output/i);
});

test("MCP configures the Command for its own run's repository and frees the slot to run again", async (t) => {
  const f = await fixture(t);
  const own = f.seed(f.caller.id);
  const other = f.seed();
  // The operator's machine-wide default, and an override another repository already holds.
  const seeded = f.workflowCommands.get("test")!;
  const kept = { repoRoot: "/elsewhere", command: ["npm", "test"] };
  assert.ok(f.workflowCommands.replace("test", { expectedRevision: seeded.revision,
    defaultCommand: ["make", "test"], overrides: [kept], maxRuns: 1, timeoutMs: null,
    onUnavailable: "skip", onBudgetExhausted: "skip" }).ok);
  // The misconfigured default already spent this run's one execution of `test`.
  f.store.insertAttempt({ id: `spent-${own.run.id}`, submissionId: own.submission.id, nodeId: "gate",
    attempt: 1, state: "running", persona: null, inputFingerprint: "fingerprint", now: Date.now() });
  assert.equal(f.store.reserveCheckRun(own.run.id, `spent-${own.run.id}`, "test", 1, null).granted, true);
  f.store.finishAttempt(`spent-${own.run.id}`, { state: "completed", output: { status: "failed", slot: "test",
    command: ["make", "test"], exitCode: 2, output: "", truncatedBytes: 0, note: "make test exited 2.",
    misfitSignal: "make: *** No rule to make target 'test'.  Stop." } }, Date.now());

  f.registry.setSessionControlEnabled(f.caller.id, false);
  // Without the operator picking this argv, the daemon stores nothing.
  const unconfirmedRevision = f.workflowCommands.get("test")!.revision;
  await f.call("configure_workflow_command", { runId: own.run.id, slot: "test", command: ["npm", "run", "test:unit"] },
    /The operator has not confirmed `npm run test:unit`/);
  assert.equal(f.workflowCommands.get("test")!.revision, unconfirmedRevision);
  assert.equal(f.store.checkRunsSpent(own.run.id, "test", null), 1, "an unconfirmed call forgives nothing");
  const confirmationId = f.confirm(["npm", "run", "test:unit"]);
  const result = await f.call("configure_workflow_command", {
    runId: own.run.id, slot: "test", command: ["npm", "run", "test:unit"],
  });
  assert.equal(result.confirmationReviewId, confirmationId);
  assert.equal(result.repoRoot, "/repo");
  assert.deepEqual(result.command, ["npm", "run", "test:unit"]);
  assert.equal(result.forgivenRuns, 1);
  const view = f.workflowCommands.get("test")!;
  assert.deepEqual(view.defaultCommand, ["make", "test"], "the machine-wide default is never changed");
  assert.deepEqual(view.overrides, [kept, { repoRoot: "/repo", command: ["npm", "run", "test:unit"] }]);
  assert.equal(f.store.checkRunsSpent(own.run.id, "test", null), 0);
  assert.ok(f.store.listEvents(own.run.id).some((event) => event.kind === "workflow_command_configured"));

  // The corrected command then spends the allowance again. Re-confirming that same argv - any
  // number of times - neither rewrites the catalog nor hands it another execution.
  f.store.insertAttempt({ id: `rerun-${own.run.id}`, submissionId: own.submission.id, nodeId: "gate",
    attempt: 2, state: "running", persona: null, inputFingerprint: "fingerprint", now: Date.now() });
  assert.equal(f.store.reserveCheckRun(own.run.id, `rerun-${own.run.id}`, "test", 1, null).granted, true);
  f.store.finishAttempt(`rerun-${own.run.id}`, { state: "completed", output: { status: "failed", slot: "test",
    command: ["npm", "run", "test:unit"], exitCode: 1, output: "", truncatedBytes: 0, note: "exited 1." } }, Date.now());
  const revision = f.workflowCommands.get("test")!.revision;
  for (let repeat = 0; repeat < 3; repeat += 1) {
    const again = await f.call("configure_workflow_command", {
      runId: own.run.id, slot: "test", command: ["npm", "run", "test:unit"],
    });
    assert.equal(again.forgivenRuns, 0);
  }
  assert.equal(f.workflowCommands.get("test")!.revision, revision, "an unchanged override is not rewritten");
  assert.equal(f.store.checkRunsSpent(own.run.id, "test", null), 1, "maxRuns still bounds the same command");

  // A second answer replaces this repository's override rather than adding a duplicate. The
  // corrected command actually ran, so switching away from it forgives nothing either.
  f.confirm(["pytest", "-q"]);
  const switched = await f.call("configure_workflow_command", { runId: own.run.id, slot: "test", command: ["pytest", "-q"] });
  assert.deepEqual([switched.forgivenRuns, switched.restoredRuns], [0, 0]);
  assert.equal(f.store.checkRunsSpent(own.run.id, "test", null), 1, "a real execution is never returned");
  assert.deepEqual(f.workflowCommands.get("test")!.overrides,
    [kept, { repoRoot: "/repo", command: ["pytest", "-q"] }]);

  // Another session's run is refused even with Control other sessions on: this is catalog config.
  f.registry.setSessionControlEnabled(f.caller.id, true);
  await f.call("configure_workflow_command", { runId: other.run.id, slot: "test", command: ["npm", "test"] },
    /Only the session that owns this workflow run/);
  // CodeRabbit is typed review tuning, never an argv, and a malformed argv fails before HTTP.
  await f.call("configure_workflow_command", { runId: own.run.id, slot: "coderabbit", command: ["x"] }, /Invalid|invalid_enum|Expected/i);
  await f.call("configure_workflow_command", { runId: own.run.id, slot: "lint", command: [] }, /Invalid|too_small|at least/i);
  assert.deepEqual(f.workflowCommands.get("lint")!.overrides, []);
});

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("the Command a session configures over MCP is the argv the resubmitted check runs", async (t) => {
  // The whole repair, end to end through the real MCP child, routes, manager, engine and store:
  // the machine-wide `make test` fails in a repository without a Makefile, the session sets the
  // repository's command, resubmits unchanged work, and the next check runs THAT argv - not
  // the default, and not skipped as `budget_spent` for the execution the default already used.
  const executed: string[][] = [];
  const f = await runtimeFixture(t, false, {
    checkDeps: () => ({
      checkoutSubpath: async () => "",
      execute: async (request) => {
        executed.push([...request.command]);
        return request.command[0] === "make"
          ? { kind: "exited", exitCode: 2, output: "make: *** No rule to make target 'test'.  Stop.\n", truncatedBytes: 0 }
          : { kind: "exited", exitCode: 0, output: "3 passing\n", truncatedBytes: 0 };
      },
    }),
  });
  setWorkflowPolicy({ checksEnabled: true, repoAllowlist: ["/repo"] });
  t.after(() => { setWorkflowPolicy({}); });
  const slot = f.workflowCommands.get("test")!;
  assert.ok(f.workflowCommands.replace("test", { expectedRevision: slot.revision, defaultCommand: ["make", "test"],
    overrides: [], maxRuns: 1, timeoutMs: null, onUnavailable: "skip", onBudgetExhausted: "skip" }).ok);

  const key = randomUUID();
  assert.ok(f.store.insertWorkflow({ id: key, name: key, normalizedName: key, description: "",
    draft: { nodes: [
      { id: "session", kind: "session", position: { x: 0, y: 0 } },
      { id: "gate", kind: "check", slot: "test", position: { x: 100, y: 0 } },
      { id: "end", kind: "end", outcome: "Complete", position: { x: 200, y: 0 } },
    ], edges: [
      { id: "start", source: "session", sourcePort: "submitted", target: "gate", targetPort: "activate" },
      { id: "pass", source: "gate", sourcePort: "pass", target: "end", targetPort: "terminal" },
      { id: "fail", source: "gate", sourcePort: "fail", target: "session", targetPort: "return_for_changes" },
    ] }, completionPolicy: { kind: "none" }, resumptionPolicy: "manual", evidenceReadinessPolicy: "off",
    bindingDefaults: { triggerMode: "manual", deliveryMode: "preview", maxRepairRounds: 5 }, createdAt: 1, updatedAt: 1 }).ok);
  const published = f.store.publishWorkflow(key, 1, `version-${key}`, 2);
  assert.ok(published.ok);
  const binding = f.store.insertBinding({ id: `binding-${key}`, workflowVersionId: published.version.id,
    noteKey: f.caller.agentSessionId!, sessionId: f.caller.id, sessionAgent: "claude", sessionName: "MCP test",
    sessionCwd: "/repo", sessionRepoRoot: "/repo", repoRoot: "", triggerMode: "manual", deliveryMode: "preview",
    maxRepairRounds: 5, now: Date.now() });

  // This fixture leaves the engine stopped for the action tests; this one needs the check to run.
  f.workflows.engine.start();
  const first = await f.act("submit", { bindingId: binding.id });
  const runId = first.run.id as string;
  await waitFor(() => f.store.getRun(runId)?.status === "waiting_for_session", "the default should fail");
  const failed = f.store.listAttempts(first.submission.id).find((attempt) => attempt.nodeId === "gate")!;
  assert.match((failed.verdict as { requestedChanges: Array<{ title: string }> }).requestedChanges[0]!.title,
    /^Configure the test Command for this repository/);

  f.confirm(["npm", "test"]);
  const configured = await f.call("configure_workflow_command", { runId, slot: "test", command: ["npm", "test"] });
  assert.equal(configured.forgivenRuns, 1);
  const resubmitted = await f.act("resubmit", { runId }, { resubmitUnchanged: true });
  assert.equal(resubmitted.submission.round, 2);
  await waitFor(() => f.store.getRun(runId)?.status === "completed", "the configured command should pass");

  assert.deepEqual(executed, [["make", "test"], ["npm", "test"]]);
  const rerun = f.store.listAttempts(resubmitted.submission.id).find((attempt) => attempt.nodeId === "gate")!;
  const output = rerun.output as { status: string; command: string[]; commandSource: string };
  assert.equal(output.status, "passed");
  assert.deepEqual(output.command, ["npm", "test"]);
  assert.equal(output.commandSource, "override");
});

test("a session inspects a repository without a Makefile, confirms its command through request_input, and the confirmed command runs", async (t) => {
  // The repair a session performs, scripted step by step through the real MCP tools rather than
  // a model, so it spends no tokens: the packet, the inspection, the operator's confirmation,
  // the repository override, the resubmission, and the real commands spawned in a real
  // repository that has no Makefile. Every step is reported as a diagnostic line.
  for (const bin of ["make", "npm"]) {
    if (spawnSync(bin, ["--version"], { encoding: "utf8" }).error) {
      t.skip(`${bin} is not installed`);
      return;
    }
  }
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "mission-no-makefile-")));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  writeFileSync(join(repo, "package.json"), `${JSON.stringify({
    name: "no-makefile-fixture", version: "1.0.0", private: true,
    scripts: { test: "node -e \"console.log('CONFIRMED SUITE RAN')\"" },
  }, null, 2)}\n`);
  for (const name of ["Makefile", "makefile", "GNUmakefile"]) assert.equal(existsSync(join(repo, name)), false);
  const say = (line: string) => t.diagnostic(line);
  say(`repository ${repo} holds ${JSON.stringify(readFileSync(join(repo, "package.json"), "utf8").trim())} and no Makefile`);

  const executed: string[][] = [];
  const outputs: string[] = [];
  const f = await runtimeFixture(t, false, {
    checkDeps: () => ({
      checkoutSubpath: async () => "",
      // The real argv, spawned in the real repository: `make` and `npm` answer for themselves.
      execute: async (request) => {
        executed.push([...request.command]);
        const ran = spawnSync(request.command[0]!, request.command.slice(1), {
          cwd: request.repoRoot, encoding: "utf8", timeout: 60_000,
        });
        if (ran.error) throw ran.error;
        const output = `${ran.stdout}${ran.stderr}`;
        outputs.push(output);
        say(`check spawned \`${request.command.join(" ")}\` in the repository -> exit ${ran.status}: ${JSON.stringify(output.trim())}`);
        return { kind: "exited", exitCode: ran.status ?? 1, output, truncatedBytes: 0 };
      },
    }),
  }, true);
  setWorkflowPolicy({ checksEnabled: true, repoAllowlist: [repo] });
  t.after(() => { setWorkflowPolicy({}); });
  const slot = f.workflowCommands.get("test")!;
  assert.ok(f.workflowCommands.replace("test", { expectedRevision: slot.revision, defaultCommand: ["make", "test"],
    overrides: [], maxRuns: 1, timeoutMs: null, onUnavailable: "skip", onBudgetExhausted: "skip" }).ok);
  say("operator's machine-wide test Command is `make test`; no repository override exists");

  const key = randomUUID();
  assert.ok(f.store.insertWorkflow({ id: key, name: key, normalizedName: key, description: "",
    draft: { nodes: [
      { id: "session", kind: "session", position: { x: 0, y: 0 } },
      { id: "gate", kind: "check", slot: "test", position: { x: 100, y: 0 } },
      { id: "end", kind: "end", outcome: "Complete", position: { x: 200, y: 0 } },
    ], edges: [
      { id: "start", source: "session", sourcePort: "submitted", target: "gate", targetPort: "activate" },
      { id: "pass", source: "gate", sourcePort: "pass", target: "end", targetPort: "terminal" },
      { id: "fail", source: "gate", sourcePort: "fail", target: "session", targetPort: "return_for_changes" },
    ] }, completionPolicy: { kind: "none" }, resumptionPolicy: "manual", evidenceReadinessPolicy: "off",
    bindingDefaults: { triggerMode: "manual", deliveryMode: "preview", maxRepairRounds: 5 }, createdAt: 1, updatedAt: 1 }).ok);
  const published = f.store.publishWorkflow(key, 1, `version-${key}`, 2);
  assert.ok(published.ok);
  const binding = f.store.insertBinding({ id: `binding-${key}`, workflowVersionId: published.version.id,
    noteKey: f.caller.agentSessionId!, sessionId: f.caller.id, sessionAgent: "claude", sessionName: "MCP test",
    sessionCwd: repo, sessionRepoRoot: repo, repoRoot: "", triggerMode: "manual", deliveryMode: "preview",
    maxRepairRounds: 5, now: Date.now() });

  f.workflows.engine.start();
  const first = await f.act("submit", { bindingId: binding.id });
  const runId = first.run.id as string;
  await waitFor(() => f.store.listDeliveries(runId).length === 1, "the failed default should prepare a repair packet");
  // Whatever make implementation answered, it refused before running anything; the packet
  // below is what proves the refusal was classified as the repository not providing `test`.
  assert.match(outputs[0]!, /\btest\b/);

  // 1. The session reads its repair packet.
  const packet = f.store.listDeliveries(runId)[0]!.payload;
  assert.match(packet, /Configure the test Command for this repository; do not add files to satisfy it/);
  assert.match(packet, /Call request_input to ask the operator to confirm the exact command/);
  say("session received: \"Configure the test Command for this repository; do not add files to satisfy it\"");

  // 2. It inspects the repository for how tests run, and writes no Makefile.
  const manifest = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as { scripts?: Record<string, string> };
  assert.ok(manifest.scripts?.test);
  const proposed = ["npm", "test"];
  say(`session inspected the repository: no Makefile; package.json scripts.test is ${JSON.stringify(manifest.scripts.test)}; proposes ${JSON.stringify(proposed)}`);

  // 3. It asks the operator through request_input and blocks for the answer.
  const question = "This repository has no Makefile, so the workflow's default `make test` cannot run. "
    + `package.json defines scripts.test (${manifest.scripts.test}). Set \`npm test\` as this repository's test Command?`;
  const asking = f.client.callTool({ name: "request_input", arguments: { question, options: [
    { label: "npm test", detail: "package.json scripts.test", recommended: true },
    { label: "Use a different command" },
  ] } });
  await waitFor(() => f.registry.pendingReviews(f.caller.id).length === 1, "the confirmation card should be pending");
  const card = f.registry.pendingReviews(f.caller.id)[0]!;
  assert.equal(card.kind, "input");
  assert.deepEqual(card.decisions?.[0]?.options.map((option) => option.label), ["npm test", "Use a different command"]);
  say(`session called request_input; the operator's card asks: ${JSON.stringify(card.decisions?.[0]?.question ?? card.body)}`);
  // Nothing is configured while the operator has not answered.
  assert.deepEqual(f.workflowCommands.get("test")!.overrides, []);

  // 4. The operator confirms the recommended command from the card, sending exactly what the
  // dashboard's review form sends: the selections and the shared formatted response.
  const selections = [{ decisionId: "q", selected: ["o0"], other: null }];
  const resolved = await f.app.request(`/api/reviews/${encodeURIComponent(card.id)}/resolve`, { method: "POST",
    headers: { host: "localhost", "content-type": "application/json" },
    body: JSON.stringify({ action: "answer", by: "human", selections,
      response: formatResponse(card.decisions!, selections, decisionLead(card.kind)) }) });
  assert.equal(resolved.status, 200, await resolved.clone().text());
  const answer = await asking;
  const answerText = (answer.content as Array<{ type: string; text: string }>).map((item) => item.text).join("\n");
  assert.equal(Boolean(answer.isError), false, answerText);
  assert.match(answerText, /npm test/);
  say(`operator answered the card; request_input returned: ${JSON.stringify(answerText)}`);

  // 5. Only then does it configure the confirmed argv for this repository.
  const configured = await f.call("configure_workflow_command", { runId, slot: "test", command: proposed });
  assert.equal(configured.repoRoot, repo);
  const view = f.workflowCommands.get("test")!;
  assert.deepEqual(view.overrides, [{ repoRoot: repo, command: ["npm", "test"] }]);
  assert.deepEqual(view.defaultCommand, ["make", "test"]);
  say(`session called configure_workflow_command -> override ${JSON.stringify(view.overrides[0])}; machine-wide default still ${JSON.stringify(view.defaultCommand)}; forgivenRuns ${configured.forgivenRuns}`);

  // 6. It resubmits the unchanged work, and the confirmed command is what the gate runs.
  const resubmitted = await f.act("resubmit", { runId }, { resubmitUnchanged: true });
  say(`session called trigger_workflow_action resubmit (resubmitUnchanged) -> round ${resubmitted.submission.round}`);
  await waitFor(() => f.store.getRun(runId)?.status === "completed", "the confirmed command should pass", 60_000);
  assert.deepEqual(executed, [["make", "test"], ["npm", "test"]]);
  assert.match(outputs[1]!, /CONFIRMED SUITE RAN/);
  const rerun = f.store.listAttempts(resubmitted.submission.id).find((attempt) => attempt.nodeId === "gate")!;
  const output = rerun.output as { status: string; command: string[]; commandSource: string };
  assert.deepEqual([output.status, output.command, output.commandSource], ["passed", ["npm", "test"], "override"]);
  assert.equal(existsSync(join(repo, "Makefile")), false);
  say(`run ${f.store.getRun(runId)?.status}: round 2 gate ${output.status} with ${JSON.stringify(output.command)} (${output.commandSource}); no Makefile was created`);
});

test("MCP refuses to configure a Command for a finished run and leaves the catalog unchanged", async (t) => {
  const f = await fixture(t);
  f.registry.setSessionControlEnabled(f.caller.id, false);
  const phases = { completed: "complete", cancelled: "binding_archived", failed: "failed_outcome" } as const;
  for (const status of ["completed", "cancelled", "failed"] as const) {
    const own = f.seed(f.caller.id);
    f.store.setRunState(own.run.id, status, phases[status], null);
    assert.equal(f.store.getRun(own.run.id)?.status, status);
    const before = f.workflowCommands.get("test")!;
    await f.call("configure_workflow_command", { runId: own.run.id, slot: "test", command: ["npm", "test"] },
      /This workflow run has finished/);
    const signed = f.credential();
    const response = await f.app.request("/mcp/workflows/configure-command", { method: "POST",
      headers: { host: "localhost", "content-type": "application/json", "x-harness-token": ensureToken(),
        "x-mission-scout-credential": signed },
      body: JSON.stringify({ runId: own.run.id, slot: "test", command: ["npm", "test"] }) });
    assert.equal(response.status, 409, status);
    const after = f.workflowCommands.get("test")!;
    assert.equal(after.revision, before.revision, status);
    assert.deepEqual(after.overrides, before.overrides, status);
  }
});

test("MCP defers configuring a Command while a check for that slot is still running", async (t) => {
  // The running check's outcome is unknown, so whether its reservation proved nothing is too.
  // Configuring now would leave a misfit it later records counted against the new command.
  const f = await fixture(t);
  f.registry.setSessionControlEnabled(f.caller.id, false);
  const own = f.seed(f.caller.id);
  const gate = own.version.graph.nodes.find((node) => node.kind === "check" && node.slot === "test")!;
  f.store.insertAttempt({ id: `running-${own.run.id}`, submissionId: own.submission.id, nodeId: gate.id,
    attempt: 1, state: "running", persona: null, inputFingerprint: "fingerprint", now: Date.now() });
  assert.equal(f.store.reserveCheckRun(own.run.id, `running-${own.run.id}`, "test", 1, null).granted, true);
  const before = f.workflowCommands.get("test")!;
  await f.call("configure_workflow_command", { runId: own.run.id, slot: "test", command: ["npm", "test"] },
    /A test check is still running in this workflow run; configure the Command after it finishes/);
  assert.equal(f.workflowCommands.get("test")!.revision, before.revision);
  assert.equal(f.store.checkRunsSpent(own.run.id, "test", null), 1, "the running reservation is untouched");
  // Another slot is not held up by it.
  f.confirm(["npm", "run", "lint"]);
  f.confirm(["npm", "test"]);
  await f.call("configure_workflow_command", { runId: own.run.id, slot: "lint", command: ["npm", "run", "lint"] });

  // Once the check finishes and records its misfit, configuring proceeds and forgives it.
  f.store.finishAttempt(`running-${own.run.id}`, { state: "completed", output: { status: "failed", slot: "test",
    command: ["make", "test"], exitCode: 2, output: "", truncatedBytes: 0, note: "make test exited 2.",
    misfitSignal: "make: *** No rule to make target 'test'.  Stop." } }, Date.now());
  const configured = await f.call("configure_workflow_command", { runId: own.run.id, slot: "test", command: ["npm", "test"] });
  assert.equal(configured.forgivenRuns, 1);
  assert.equal(f.store.checkRunsSpent(own.run.id, "test", null), 0);
});

test("MCP refuses to configure a Command for a run that reported no repository", async (t) => {
  const f = await fixture(t);
  f.registry.setSessionControlEnabled(f.caller.id, false);
  const own = f.seed(f.caller.id, null);
  assert.equal(f.store.getBinding(own.run.bindingId)?.sessionRepoRoot, null);
  const before = f.workflowCommands.get("test")!;
  await f.call("configure_workflow_command", { runId: own.run.id, slot: "test", command: ["npm", "test"] },
    /This workflow run reported no repository to configure/);
  const response = await f.app.request("/mcp/workflows/configure-command", { method: "POST",
    headers: { host: "localhost", "content-type": "application/json", "x-harness-token": ensureToken(),
      "x-mission-scout-credential": f.credential() },
    body: JSON.stringify({ runId: own.run.id, slot: "test", command: ["npm", "test"] }) });
  assert.equal(response.status, 409);
  const after = f.workflowCommands.get("test")!;
  assert.equal(after.revision, before.revision);
  assert.deepEqual(after.overrides, before.overrides);
  assert.ok(!f.store.listEvents(own.run.id).some((event) => event.kind === "workflow_command_configured"));
});

test("MCP requires daemon-issued caller identity even when the machine token and grant are present", async (t) => {
  const f = await fixture(t, {}, "not-a-private-locator");
  const { run } = f.seed(f.caller.id);
  await f.call("list_workflow_runs", {}, /signed session credential/i);
  await f.call("get_workflow_run", { runId: run.id }, /signed session credential/i);
  await f.call("trigger_workflow_action", { request: { action: "cancel", runId: run.id,
    parameters: { requestId: "missing-identity" } } }, /signed session credential/i);
  assert.notEqual(f.store.getRun(run.id)?.status, "cancelled");
});

test("MCP self-control covers bindings, submissions, deliveries and session targets", async (t) => {
  const f = await runtimeFixture(t, true);
  const ownBinding = f.bind({ kind: "none" }, f.caller.id);
  const otherBinding = f.bind();
  f.registry.setSessionControlEnabled(otherBinding.sessionId!, true);
  f.registry.setSessionControlEnabled(f.caller.id, false);
  const own = await f.act("submit", { bindingId: ownBinding.id });
  assert.equal(f.store.getRun(own.run.id)?.status, "waiting_for_evidence_readiness");
  await f.act("submit", { bindingId: otherBinding.id }, {}, /Control other sessions/i);
  assert.equal(f.store.latestRunForBinding(otherBinding.id), null);
  await f.act("reattach", { bindingId: ownBinding.id }, { sessionId: otherBinding.sessionId! }, /Control other sessions/i);
  await f.act("reattach", { bindingId: otherBinding.id }, { sessionId: f.caller.id }, /Control other sessions/i);
  assert.equal(f.store.getBinding(ownBinding.id)?.sessionId, f.caller.id);
  const target = { runId: own.run.id, submissionId: own.submission.id };
  await f.act("override-evidence-readiness", target, { reason: "Accept the fixture gap", acknowledgedRisk: true });
  assert.equal(f.store.getSubmission(own.submission.id)?.readiness?.status, "overridden");
  const other = f.seedRun(otherBinding);
  await f.act("override-evidence-readiness", { runId: other.run.id, submissionId: other.submission.id },
    { reason: "Accept the fixture gap", acknowledgedRisk: true }, /Control other sessions/i);
  // Cross-run submission IDs retain the manager's ownership check.
  await f.act("override-evidence-readiness", { runId: own.run.id, submissionId: other.submission.id },
    { reason: "Accept the fixture gap", acknowledgedRisk: true }, /not found|does not belong|No such/i);
  function packet(runId: string, submissionId: string, sessionId: string, noteKey: string) {
    const delivery = f.store.prepareDelivery({ id: randomUUID(), runId, submissionId, kind: "persona_feedback",
      sessionId, noteKey, payload: "Fixture feedback", payloadSha256: "a".repeat(64) }).delivery;
    f.store.claimDeliverySend(delivery.id);
    f.store.setDeliveryState(delivery.id, "uncertain", "fixture transport ambiguity");
    return delivery;
  }
  const delivery = packet(own.run.id, own.submission.id, f.caller.id, ownBinding.noteKey);
  await f.act("resolve-delivery", { deliveryId: delivery.id }, { resolution: "mark_delivered" });
  assert.equal(f.store.getDelivery(delivery.id)?.state, "delivered");
  const foreign = packet(other.run.id, other.submission.id, otherBinding.sessionId!, otherBinding.noteKey);
  await f.act("resolve-delivery", { deliveryId: foreign.id }, { resolution: "mark_delivered" }, /Control other sessions/i);
  assert.equal(f.store.getDelivery(foreign.id)?.state, "uncertain");
  // A binding move cannot turn a packet addressed to another conversation into a self action.
  await f.act("cancel", { runId: own.run.id });
  f.store.updateBinding(ownBinding.id, { state: "archived" });
  f.store.reattachBinding(otherBinding.id, { noteKey: ownBinding.noteKey, sessionId: f.caller.id,
    sessionAgent: "claude", sessionName: f.caller.name, sessionCwd: home, sessionRepoRoot: null });
  await f.act("resolve-delivery", { deliveryId: foreign.id }, { resolution: "mark_delivered" }, /Control other sessions/i);
  await f.act("start-review", { sessionId: otherBinding.sessionId! }, {}, /Control other sessions/i);
  f.store.updateBinding(otherBinding.id, { state: "archived" });
  const review = await f.act("start-review", { sessionId: f.caller.id });
  assert.equal(f.store.getBinding(review.run.bindingId)?.sessionId, f.caller.id);
});

test("every dashboard action denies unowned targets without delegation and retains its payload with delegation", async (t) => {
  const f = await fixture(t);
  const parameters = { requestId: "action-intent" };
  const cases = [
    ["grant-rounds", { rounds: 1 }, "grant-rounds"], ["cancel", {}, "cancel"],
    ["retry", { nodeAttemptId: "attempt" }, "retry"],
    ["resubmit", { resubmitUnchanged: true, evidence: [] }, "resubmit"],
    ["restart-full", { confirmation: "RESTART FULL WORKFLOW" }, "restart-full"],
    ["prepare-pr", {}, "prepare-pr"], ["recheck-inspector", {}, "recheck-inspector"],
    ["set-nodes-disabled", { nodeIds: ["reviewer"], disabled: true }, "set-nodes-disabled"],
    ["set-persona-directive", { nodeId: "reviewer", feedback: "Keep the requested scope." }, "set-persona-directive"],
    ["remove-persona-directive", { nodeId: "reviewer" }, "remove-persona-directive"],
    ["recover-evidence", {}, "submissions/sub/evidence-recovery"],
    ["retry-evidence-readiness", {}, "submissions/sub/evidence-readiness/retry"],
    ["override-evidence-readiness", { reason: "Operator accepts the gap", acknowledgedRisk: true }, "submissions/sub/evidence-readiness/override"],
  ] as const;
  const paths = new Set<string>();
  for (const [action, extra, suffix] of cases) {
    const request = { action, runId: "missing", ...("submissionId" in WorkflowActionRequestSchema.optionsMap.get(action)!.shape ? { submissionId: "sub" } : {}), parameters: { ...parameters, ...extra } };
    f.registry.setSessionControlEnabled(f.caller.id, false);
    await f.call("trigger_workflow_action", { request }, /Control other sessions/i);
    f.registry.setSessionControlEnabled(f.caller.id, true);
    await f.call("trigger_workflow_action", { request }, /not found|No such|no such|No active/i);
    const sent = f.requests.at(-1)!;
    assert.equal(sent.path, "/mcp/workflows/act");
    assert.deepEqual(sent.body, { request });
    const path = workflowActionPath(WorkflowActionRequestSchema.parse(request));
    assert.equal(path, `/api/workflow-runs/missing/${suffix}`);
    paths.add(path.replace("missing", ":id").replace("/sub/", "/:submissionId/"));
  }
  for (const [action, target, extra, path] of [
    ["retry-delivery", { deliveryId: "missing" }, { expectedSessionId: "session", expectedNoteKey: "note" }, "/api/workflow-deliveries/missing/retry"],
    ["resolve-delivery", { deliveryId: "missing" }, { resolution: "mark_delivered" }, "/api/workflow-deliveries/missing/resolve"],
    ["submit", { bindingId: "missing" }, { evidence: [] }, "/api/workflow-bindings/missing/submit"],
    ["reattach", { bindingId: "missing" }, { sessionId: "session" }, "/api/workflow-bindings/missing/reattach"],
    ["start-review", { sessionId: "missing" }, { evidence: [] }, "/api/sessions/missing/workflow-review"],
  ] as const) {
    const body = action === "reattach" ? extra : { ...parameters, ...extra };
    f.registry.setSessionControlEnabled(f.caller.id, false);
    await f.call("trigger_workflow_action", { request: { action, ...target, parameters: body } }, /Control other sessions/i);
    f.registry.setSessionControlEnabled(f.caller.id, true);
    await f.call("trigger_workflow_action", { request: { action, ...target, parameters: body } }, /not found|No such|no such|unavailable|not available/i);
    assert.equal(f.requests.at(-1)?.path, "/mcp/workflows/act");
    assert.deepEqual(f.requests.at(-1)?.body, { request: { action, ...target, parameters: body } });
    assert.equal(workflowActionPath(WorkflowActionRequestSchema.parse({ action, ...target, parameters: body })), path);
    paths.add(path.replace("missing", ":id"));
  }
  // Adding a dashboard runtime action must not silently leave the MCP behind.
  for (const [, path] of WORKFLOW_ACTION_ROUTES.filter(([, path]) => /^\/api\/workflow-(runs|deliveries)\//.test(path))) {
    assert.ok(paths.has(path), `MCP covers ${path}`);
  }
});

test("invalid requests fail before HTTP; daemon refusals are returned without retry or fallback", async (t) => {
  const f = await fixture(t);
  const { run } = f.seed();
  for (const request of [
    { action: "grant-rounds", runId: run.id, parameters: { requestId: "bad", rounds: 0 } },
    { action: "grant-rounds", runId: run.id, parameters: { requestId: "bad", rounds: 1.5 } },
    { action: "cancel", runId: " ", parameters: { requestId: "bad" } },
    { action: "cancel", runId: "..", parameters: { requestId: "bad" } },
    { action: "cancel", runId: run.id, parameters: {} },
    { action: "cancel", runId: run.id, parameters: { requestId: "bad", force: true } },
    { action: "override-evidence-readiness", runId: run.id, submissionId: "sub", parameters: { requestId: "bad", reason: "accept" } },
    { action: "retry-delivery", deliveryId: "delivery", parameters: { requestId: "bad" } },
    { action: "set-nodes-disabled", runId: run.id, parameters: { requestId: "bad", nodeIds: ["p", "p"], disabled: true } },
    { action: "unknown", runId: run.id, parameters: { requestId: "bad" } },
  ]) {
    await f.call("trigger_workflow_action", { request }, /validation/i);
    assert.equal(f.requests.length, 0);
  }
  // Well-typed input still goes through the dashboard's state checks.
  f.store.setRunState(run.id, "running", "persona_review", null, Date.now());
  await f.call("trigger_workflow_action", { request: { action: "grant-rounds", runId: run.id,
    parameters: { requestId: "unspent", rounds: 1 } } }, /spent its repair budget/);
  assert.equal(f.requests.length, 1);
  assert.equal(f.store.getRun(run.id)?.maxRepairRounds, 1);
  await f.call("trigger_workflow_action", { request: { action: "restart-full", runId: run.id,
    parameters: { requestId: "restart" } } }, /No active GitHub Inspector gate/i);
  assert.equal(f.requests.length, 2);
  await f.call("get_workflow_run", { runId: "missing" }, /no such workflow run/i);
  assert.equal(f.requests.length, 3);
});

test("MCP run listing preserves filter encoding and pagination and reads existing run detail", async (t) => {
  const f = await fixture(t);
  // The tour's immutable fixture provides a strictly valid full snapshot without any model calls.
  const { runId } = f.workflows.seedTourDemoRun();
  const detail = await f.call("get_workflow_run", { runId });
  assert.equal(detail.run.id, runId);
  assert.ok(detail.submissions.length > 0);
  assert.ok(detail.binding.id);
  f.seed();
  const page = await f.call("list_workflow_runs", { limit: 1 });
  assert.equal(page.items.length, 1);
  assert.ok(page.nextCursor);
  const next = await f.call("list_workflow_runs", { limit: 1, cursor: page.nextCursor });
  assert.equal(next.items.length, 1);
  assert.notEqual(next.items[0].id, page.items[0].id);
  const empty = await f.call("list_workflow_runs", { workflowId: "missing&status=running", session: "no session" });
  assert.deepEqual(empty.items, []);
  const before = f.requests.length;
  await f.call("list_workflow_runs", { limit: 201 }, /validation/i);
  assert.equal(f.requests.length, before);
});

test("MCP mutation paths cannot be redirected with IDs or arbitrary endpoint input", async (t) => {
  const f = await fixture(t);
  const hostileId = "missing/../cancel?force=true#fragment";
  await f.call("trigger_workflow_action", { request: { action: "cancel", runId: hostileId, parameters: { requestId: "r" } } }, /No such workflow run/i);
  assert.equal(f.requests.at(-1)?.path, "/mcp/workflows/act");
  assert.equal(workflowActionPath(WorkflowActionRequestSchema.parse({ action: "cancel", runId: hostileId,
    parameters: { requestId: "r" } })), `/api/workflow-runs/${encodeURIComponent(hostileId)}/cancel`);
  assert.equal(WorkflowActionRequestSchema.safeParse({ action: "cancel", runId: "run", path: "/api/tasks", parameters: { requestId: "r" } }).success, false);
});

test("MCP persists node toggles and Persona directives, retries infrastructure, and resubmits repairs", async (t) => {
  const f = await runtimeFixture(t);
  const binding = f.bind();
  const { run, submission } = f.seedRun(binding);
  const target = { runId: run.id };
  await f.act("set-nodes-disabled", target, { nodeIds: ["reviewer"], disabled: true });
  assert.deepEqual(f.store.getRun(run.id)?.disabledNodeIds, ["reviewer"]);
  await f.act("set-nodes-disabled", target, { nodeIds: ["reviewer"], disabled: false });
  assert.deepEqual(f.store.getRun(run.id)?.disabledNodeIds, []);
  await f.act("set-persona-directive", target, { nodeId: "reviewer", feedback: "Respect the requested scope." });
  assert.equal(f.store.getRun(run.id)?.personaDirectives?.[0]?.feedback, "Respect the requested scope.");
  await f.act("remove-persona-directive", target, { nodeId: "reviewer" });
  assert.deepEqual(f.store.getRun(run.id)?.personaDirectives, []);

  const node = f.store.getWorkflowVersionById(binding.workflowVersionId)!.graph.nodes.find((item) => item.kind === "persona")!;
  assert.equal(node.kind, "persona");
  const failed = f.store.insertAttempt({ id: randomUUID(), submissionId: submission.id, nodeId: node.id,
    attempt: 1, state: "error", persona: node.persona, inputFingerprint: "failed-input", now: Date.now() });
  f.store.setSubmissionState(submission.id, "failed");
  f.store.setRunState(run.id, "blocked", "infrastructure_error", { nodeId: node.id, error: "fixture provider failure" });
  await f.act("retry", target, { nodeAttemptId: failed.id });
  const retried = f.store.latestAttemptForNode(submission.id, node.id)!;
  assert.notEqual(retried.id, failed.id);
  assert.equal(retried.attempt, 2);
  assert.equal(retried.state, "queued");
  assert.equal(f.store.getSubmission(submission.id)?.status, "running");
  assert.ok(f.store.listEvents(run.id).some((event) => event.kind === "manual_infrastructure_retry"));

  const repair = f.seedRun(f.bind());
  f.store.setRunState(repair.run.id, "waiting_for_session", "persona_feedback", null);
  f.store.setSubmissionState(repair.submission.id, "waiting_for_session");
  const resubmitted = await f.act("resubmit", { runId: repair.run.id }, { resubmitUnchanged: true });
  assert.equal(resubmitted.submission.round, 2);
  assert.notEqual(resubmitted.submission.id, repair.submission.id);
  assert.equal(f.store.latestSubmission(repair.run.id)?.id, resubmitted.submission.id);
  assert.equal(f.store.getSubmission(resubmitted.submission.id)?.status, "running");
  assert.ok(f.store.listAttempts(resubmitted.submission.id).some((attempt) => attempt.nodeId === "reviewer"));
});

test("MCP submits and repeats bindings, reattaches them, and starts a session review", async (t) => {
  const f = await runtimeFixture(t);
  const binding = f.bind();
  const first = await f.act("submit", { bindingId: binding.id });
  assert.equal(f.store.getRun(first.run.id)?.bindingId, binding.id);
  assert.equal(f.store.getSubmission(first.submission.id)?.status, "running");
  await f.act("cancel", { runId: first.run.id });
  const again = await f.act("submit", { bindingId: binding.id });
  assert.notEqual(again.run.id, first.run.id);
  assert.equal(again.submission.round, 1);

  f.store.orphanBinding(binding.id, "session_disappeared");
  const sessionId = f.session();
  const attached = await f.act("reattach", { bindingId: binding.id }, { sessionId });
  assert.equal(attached.sessionId, sessionId);
  assert.equal(f.store.getBinding(binding.id)?.state, "active");
  assert.equal(f.store.getBinding(binding.id)?.sessionId, sessionId);
  assert.equal(f.store.getRun(again.run.id)?.currentPhase, "reattached_resubmit_required");

  const reviewSession = f.session();
  const review = await f.act("start-review", { sessionId: reviewSession });
  const reviewBinding = f.store.getBinding(review.run.bindingId)!;
  assert.equal(reviewBinding.sessionId, reviewSession);
  assert.equal(f.store.getWorkflowVersionById(reviewBinding.workflowVersionId)?.workflowId, "builtin-workflow:no-mistakes-review");
  assert.equal(f.store.getSubmission(review.submission.id)?.runId, review.run.id);
  assert.ok(f.control.captures >= 3, "all submission paths captured through the real manager");
});

test("MCP prepares a PR handoff, requests Inspector recheck, and confirms full restart", async (t) => {
  const f = await runtimeFixture(t);
  const binding = f.bind({ kind: "inspector", onFindings: "inspector_only", missingPrAction: "offer_prepare_pr" });
  const { run, submission } = f.seedRun(binding);
  const gate: WorkflowInspectorGateState = { prKey: null, prUrl: null, targetHeadSha: "head-1", failedHeadSha: null,
    enteredAt: Date.now(), lastObservedAt: null, observedHeadSha: null, reviewPosture: null,
    waitReason: "missing_pr", findingFingerprints: [] };
  f.store.setRunState(run.id, "waiting_for_pr", "inspector_missing_pr", workflowJson(gate));
  const prepared = await f.act("prepare-pr", { runId: run.id });
  assert.equal(prepared.delivery.kind, "pr_handoff");
  assert.equal(f.store.getDelivery(prepared.delivery.id)?.state, "prepared");
  assert.match(f.store.getDelivery(prepared.delivery.id)!.payload, /^\/pull-request\n/);
  assert.equal(f.store.getRun(run.id)?.currentPhase, "pr_handoff");

  // A recheck is an audited asynchronous request; it does not claim Inspector passed.
  f.store.setRunState(run.id, "waiting_for_inspector", "inspector_review", workflowJson(gate));
  await f.act("recheck-inspector", { runId: run.id });
  assert.equal(f.store.listEvents(run.id).filter((event) => event.kind === "inspector_recheck_requested").length, 1);

  f.store.setRunState(run.id, "waiting_for_new_head", "inspector_findings", workflowJson({ ...gate, failedHeadSha: "head-1" }));
  await f.act("restart-full", { runId: run.id }, {}, /Type RESTART FULL WORKFLOW/);
  const restarted = await f.act("restart-full", { runId: run.id }, { confirmation: "RESTART FULL WORKFLOW" });
  assert.notEqual(restarted.submission.id, submission.id);
  assert.equal(f.store.latestSubmission(run.id)?.mode, "full_workflow");
  assert.equal(f.store.latestSubmission(run.id)?.round, 2);
  assert.equal(f.store.getRun(run.id)?.gateState, null);
  assert.ok(f.store.listEvents(run.id).some((event) => event.kind === "inspector_only_abandoned_for_full_restart"));
});

test("MCP delivers a refused packet and resolves uncertain packets with both resolutions", async (t) => {
  const f = await runtimeFixture(t);
  setWorkflowPolicy({ liveEnabled: true, repoAllowlist: [home] });
  function packet(state: "refused" | "uncertain") {
    const binding = f.bind();
    f.store.updateBinding(binding.id, { deliveryMode: "live" });
    const { run, submission } = f.seedRun(binding);
    f.store.setRunState(run.id, "waiting_for_session", "persona_feedback", null);
    f.store.setSubmissionState(submission.id, "waiting_for_session");
    const delivery = f.store.prepareDelivery({ id: randomUUID(), runId: run.id, submissionId: submission.id,
      kind: "persona_feedback", sessionId: binding.sessionId!, noteKey: binding.noteKey,
      payload: "Repair the fixture issue.", payloadSha256: "b".repeat(64) }).delivery;
    f.store.claimDeliverySend(delivery.id);
    f.store.setDeliveryState(delivery.id, state, "fixture send interrupted");
    return { run, submission, binding, delivery };
  }
  const refused = packet("refused");
  const retried = await f.act("retry-delivery", { deliveryId: refused.delivery.id }, {
    expectedSessionId: refused.binding.sessionId, expectedNoteKey: refused.binding.noteKey });
  assert.equal(retried.delivery.state, "delivered");
  assert.equal(f.store.getDelivery(refused.delivery.id)?.state, "delivered");
  assert.deepEqual(f.sent, [refused.delivery.payload]);

  const uncertain = packet("uncertain");
  const resolved = await f.act("resolve-delivery", { deliveryId: uncertain.delivery.id }, { resolution: "mark_delivered" });
  assert.equal(resolved.value.state, "delivered");
  assert.equal(f.store.getDelivery(uncertain.delivery.id)?.state, "delivered");
  assert.equal(f.sent.length, 1, "mark delivered must not send the packet again");

  const discarded = packet("uncertain");
  const replacement = await f.act("resolve-delivery", { deliveryId: discarded.delivery.id }, {
    resolution: "discard_and_new_round", confirmation: "DISCARD AND SEND A NEW REPAIR ROUND",
    expectedSessionId: discarded.binding.sessionId, expectedNoteKey: discarded.binding.noteKey });
  assert.equal(f.store.getDelivery(discarded.delivery.id)?.state, "cancelled");
  assert.equal(f.store.getDelivery(discarded.delivery.id)?.error, "discarded_by_operator");
  assert.equal(replacement.value.submission.round, 2);
  assert.equal(f.store.latestSubmission(discarded.run.id)?.id, replacement.value.submission.id);
  assert.equal(f.store.getSubmission(replacement.value.submission.id)?.status, "running");
});

test("MCP retries readiness with new proof, overrides gaps, and recovers failed criterion mapping", async (t) => {
  const f = await runtimeFixture(t, true);
  async function proof(binding: WorkflowBinding, criterion = "MCP workflow proof") {
    await f.workflows.stageAgentEvidence(binding.sessionId!, { images: [],
      commandOutputs: [{ kind: "command", clientItemId: "proof", command: "fixture verification", exitCode: 0,
        output: "ok", caption: "Fixture proof", repositoryScope: "all" }],
      coverage: [{ clientCriterionId: "proof-claim", criterion, proofClass: "focused_execution",
        repositoryScope: "all", links: [{ clientItemId: "proof", role: "execution" }] }] });
  }
  const binding = f.bind();
  const waiting = await f.act("submit", { bindingId: binding.id });
  assert.equal(f.store.getRun(waiting.run.id)?.status, "waiting_for_evidence_readiness");
  await proof(binding);
  const refined = await f.act("retry-evidence-readiness", { runId: waiting.run.id, submissionId: waiting.submission.id });
  const child = f.store.getSubmission(refined.submission.id)!;
  assert.equal(child.parentSubmissionId, waiting.submission.id);
  assert.equal(child.round, 1);
  assert.equal(child.segment, 1);
  assert.equal(child.readiness?.status, "ready");
  assert.equal(child.status, "running");

  const overrideRun = await f.act("submit", { bindingId: f.bind().id });
  assert.equal(f.store.getRun(overrideRun.run.id)?.status, "waiting_for_evidence_readiness");
  const override = await f.act("override-evidence-readiness", { runId: overrideRun.run.id, submissionId: overrideRun.submission.id }, {
    reason: "Operator accepts the fixture evidence gap", acknowledgedRisk: true });
  assert.equal(override.override.acknowledgedRisk, true);
  assert.equal(f.store.listReadinessOverrides(overrideRun.run.id)[0]?.reason, "Operator accepts the fixture evidence gap");
  assert.equal(f.store.getSubmission(overrideRun.submission.id)?.readiness?.status, "overridden");
  assert.equal(f.store.getSubmission(overrideRun.submission.id)?.status, "running");

  const recoveryBinding = f.bind();
  // Distinct wording requires the semantic mapper rather than a deterministic text match.
  await proof(recoveryBinding, "The operator can verify workflow behavior");
  f.control.mappingFails = true;
  const failed = await f.act("submit", { bindingId: recoveryBinding.id });
  assert.equal(f.store.getRun(failed.run.id)?.currentPhase, "evidence_reconciliation_error");
  f.control.mappingFails = false;
  const captures = f.control.captures;
  const recovered = await f.act("recover-evidence", { runId: failed.run.id, submissionId: failed.submission.id });
  const recovery = f.store.getSubmission(recovered.submission.id)!;
  assert.equal(recovery.parentSubmissionId, failed.submission.id);
  assert.equal(recovery.refinementReason, "evidence_recovery");
  assert.equal(recovery.segment, 1);
  assert.equal(recovery.round, 1);
  assert.equal(recovery.readiness?.status, "ready");
  assert.equal(recovery.status, "running");
  assert.equal(f.control.captures, captures, "mapping recovery reuses immutable evidence without live recapture");
});

test("valid-state scenarios successfully execute every advertised MCP workflow action", () => {
  assert.deepEqual([...successfulActions].sort(), [...WorkflowActionRequestSchema.optionsMap.keys()].sort());
});

test("MCP retrieves complete normalized findings independently of a clipped raw stream",async(t)=>{
 const f=await fixture(t);const own=f.seed(f.caller.id);const other=f.seed();
 const identity={runId:own.run.id,submissionId:own.submission.id,attemptId:"semantic-findings-attempt"};
 const capture=f.commandArtifacts.beginCapture({...identity,semanticBytes:4*1024*1024});
 capture.push("stdout",Buffer.alloc(2*1024*1024+100,120));capture.push("stdout",Buffer.from("EARLY FINDING OUTSIDE RAW ARCHIVE"));
 const raw=capture.finalize(true).find(a=>a.kind==="stdout")!;assert.ok(raw.droppedBytes>0);
 const body=Buffer.from(JSON.stringify({id:"semantic:1",severity:"minor",comment:"EARLY FINDING OUTSIDE RAW ARCHIVE",codegenInstructions:"Verify before editing"})+"\n");
 const findings=f.commandArtifacts.publishFindings(identity,body,true);
 f.registry.setSessionControlEnabled(f.caller.id,false);
 let text="",cursor:string|null=null;
 do {
  const page=await f.call("read_workflow_command_output",{runId:own.run.id,attemptId:identity.attemptId,artifactId:findings.id,limit:32,...(cursor?{cursor}:{})});
  text+=page.text;cursor=page.nextCursor;
 }while(cursor);
 assert.equal(text,body.toString());
 await f.call("read_workflow_command_output",{runId:other.run.id,attemptId:identity.attemptId,artifactId:findings.id},/Control other sessions/i);
});
