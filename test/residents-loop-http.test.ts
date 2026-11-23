import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { Registry } from "../src/server/registry.ts";
import { ResidentLoop } from "../src/server/residents/loop.ts";
import { ResidentManager } from "../src/server/residents/manager.ts";
import { TaskManager } from "../src/server/tasks.ts";
import { registerResidentLoopRoutes } from "../src/server/residents/routes.ts";
import { maintainScoutSessionCredentials } from "../src/server/scouts/session-credentials.ts";
import { sessionScoutCredentialLocator } from "../src/server/scouts/submission-auth.ts";
import { sessionScoutCredentialPath } from "../src/shared/harness-runtime.mjs";
import { ensureToken } from "../src/server/auth.ts";
import { ResidentProfileRevisionSchema, residentLaunchInput } from "../src/shared/residents.ts";
import * as store from "../src/server/residents/store.ts";
import { mkTask } from "./helpers/session-fixture.ts";
import { ReviewManager } from "../src/server/reviews.ts";
import { openDb } from "../src/server/db.ts";
import { scheduleResidentIteration } from "../src/mcp/resident-pacing.ts";

test("pacing resolves only the signed caller; no session-control grant or body identity can substitute", async () => {
  const registry = new Registry();
  const stopCredentials = maintainScoutSessionCredentials(registry);
  const loop = new ResidentLoop({ registry, refreshSession: () => {}, sdk: { sendWhenIdle: async () => null, compact: async () => 1 } });
  const tasks = new TaskManager(registry);
  const residents = new ResidentManager({ registry, persona: () => null, createTask: () => { throw new Error("unused"); } });
  const app = new Hono(); registerResidentLoopRoutes(app, { registry, loop, residents });
  const settings = ResidentProfileRevisionSchema.parse({ identity: { name: "Signed resident" }, persona: { personaId: "p" } });
  store.createResidentProfile({ id: "profile", settings, at: Date.now() });
  store.reserveResidentRun({ id: "run", profileId: "profile", profileRevision: 1, taskId: "resident-task", launchRequestId: "launch", launchInput: residentLaunchInput("/repo", ""), repoSpelling: "/repo", persona: { personaId: "p", name: "Observer", guidanceMarkdown: "" }, runInstructions: "", at: Date.now() });
  store.markResidentRunLaunched("run", null);
  const resident = registry.registerSdkSession({ id: "sdk:resident", agent: "claude", name: "Resident", cwd: "/repo", agentSessionId: "native-resident", initialState: "idle" });
  registry.upsertTask(mkTask({ id: "resident-task", kind: "resident", status: "running", sessionId: resident.id, repoRoot: "/repo" }));
  const ordinary = registry.registerSdkSession({ id: "sdk:ordinary", agent: "claude", name: "Ordinary", cwd: "/repo", agentSessionId: "native-ordinary" });
  const credential = (id: string) => readFileSync(sessionScoutCredentialPath(`session:${sessionScoutCredentialLocator(id)}`), "utf8").trim();
  const request = (cred?: string, extra: Record<string, unknown> = {}) => app.request("/mcp/residents/schedule-next-iteration", {
    method: "POST", headers: { "content-type": "application/json", "x-harness-token": ensureToken(), ...(cred ? { "x-mission-scout-credential": cred } : {}) },
    body: JSON.stringify({ delaySeconds: 1200, callId: "intent", ...extra }),
  });
  try {
    assert.equal((await request()).status, 409);
    assert.equal((await request(credential(resident.id) + "forged")).status, 409);
    assert.equal((await request(credential(ordinary.id))).status, 409);
    assert.equal((await request(credential(resident.id), { sessionId: ordinary.id })).status, 409);
    assert.equal(registry.sessionControlEnabled(resident.id), false);
    const accepted = await request(credential(resident.id)); assert.equal(accepted.status, 200);
    const receipt = await accepted.json(); assert.equal(receipt.callId, "intent"); assert.equal(receipt.delaySeconds, 1200);
    assert.deepEqual(await (await request(credential(resident.id))).json(), receipt);
    loop.pause("run"); const refused = await request(credential(resident.id), { callId: "paused" });
    assert.equal((await refused.json()).code, "not_recorded");
    store.endResidentRun("run", Date.now());
    for (const control of ["pause", "resume", "run-now", "cancel-run-now", "restart"]) {
      assert.equal((await app.request(`/api/residents/runs/run/${control}`, { method: "POST" })).status, 409);
    }
  } finally { await loop.stop(); residents.stop(); stopCredentials(); await tasks.stop(); }
});

test("Run now on a busy resident answers queued, and the queued run can be cancelled once", async () => {
  const registry = new Registry();
  const sent: string[] = [];
  const loop = new ResidentLoop({ registry, refreshSession: () => {}, sdk: { sendWhenIdle: async (_id, turn) => { sent.push(turn.text); return null; }, compact: async () => 1 } });
  const residents = new ResidentManager({ registry, persona: () => null, createTask: () => { throw new Error("unused"); } });
  const app = new Hono(); registerResidentLoopRoutes(app, { registry, loop, residents });
  const settings = ResidentProfileRevisionSchema.parse({ identity: { name: "Busy resident" }, persona: { personaId: "p" } });
  store.createResidentProfile({ id: "busy-profile", settings, at: Date.now() });
  store.reserveResidentRun({ id: "busy-run", profileId: "busy-profile", profileRevision: 1, taskId: "busy-task", launchRequestId: "busy-launch", launchInput: residentLaunchInput("/repo", ""), repoSpelling: "/repo", persona: { personaId: "p", name: "Observer", guidanceMarkdown: "" }, runInstructions: "", at: Date.now() });
  store.markResidentRunLaunched("busy-run", null);
  const resident = registry.registerSdkSession({ id: "sdk:busy", agent: "claude", name: "Busy", cwd: "/repo", agentSessionId: "native-busy", initialState: "idle" });
  // The driver reports a turn in progress, exactly as an accepted turn does.
  registry.applyDriverEvent(resident.id, { kind: "state", state: "working", activity: null });
  registry.upsertTask(mkTask({ id: "busy-task", kind: "resident", status: "running", sessionId: resident.id, repoRoot: "/repo" }));
  loop.start();
  const control = (action: string) => app.request(`/api/residents/runs/busy-run/${action}`, { method: "POST" });
  try {
    const queued = await control("run-now");
    assert.equal(queued.status, 200);
    assert.deepEqual(await queued.json(), { ok: true, outcome: "queued" });
    assert.notEqual(registry.snapshot().residentRuns.find(run => run.id === "busy-run")?.runRequestedAt ?? null, null, "the queued run reaches the published summary");
    assert.deepEqual(sent, []);
    assert.equal((await control("cancel-run-now")).status, 200);
    assert.equal(store.getResidentRun("busy-run")!.run.runRequestedAt, null);
    const stale = await control("cancel-run-now");
    assert.equal(stale.status, 409);
    assert.deepEqual(await stale.json(), { error: "No queued run to cancel." });
  } finally { await loop.stop(); residents.stop(); }
});

// Issue #1324, end to end across the agent-facing boundary. Two request_input questions are
// raised on the real ReviewManager and answered through the dashboard's resolve path. The
// resident paces itself through the MCP tool's own client, `scheduleResidentIteration`, over
// the signed `/mcp/residents/schedule-next-iteration` route. An open question holds wakes
// without pausing the run, so pacing is recorded while it is open and after it is answered.
// Before the fix, that call answered `not_recorded: needs-you` for ever.
test("after two answered request_input questions, schedule_next_iteration is recorded through the signed MCP route", async () => {
  const registry = new Registry();
  const stopCredentials = maintainScoutSessionCredentials(registry);
  const reviews = new ReviewManager(registry);
  const loop = new ResidentLoop({ registry, refreshSession: () => {}, sdk: { sendWhenIdle: async () => null, compact: async () => 1 } });
  const tasks = new TaskManager(registry);
  const residents = new ResidentManager({ registry, persona: () => null, createTask: () => { throw new Error("unused"); } });
  const app = new Hono(); registerResidentLoopRoutes(app, { registry, loop, residents });
  const settings = ResidentProfileRevisionSchema.parse({ identity: { name: "Issue 1324 resident" }, persona: { personaId: "p" },
    loop: { delaySeconds: 300, minDelaySeconds: 60, maxDelaySeconds: 3600 } });
  store.createResidentProfile({ id: "profile-1324", settings, at: Date.now() });
  store.reserveResidentRun({ id: "run-1324", profileId: "profile-1324", profileRevision: 1, taskId: "task-1324", launchRequestId: "launch-1324", launchInput: residentLaunchInput("/repo-1324", ""), repoSpelling: "/repo-1324", persona: { personaId: "p", name: "Observer", guidanceMarkdown: "" }, runInstructions: "", at: Date.now() });
  store.markResidentRunLaunched("run-1324", null);
  const resident = registry.registerSdkSession({ id: "sdk:resident-1324", agent: "claude", name: "Resident 1324", cwd: "/repo-1324", agentSessionId: "native-resident-1324", initialState: "idle" });
  registry.upsertTask(mkTask({ id: "task-1324", kind: "resident", status: "running", sessionId: resident.id, repoRoot: "/repo-1324" }));
  const credential = readFileSync(sessionScoutCredentialPath(`session:${sessionScoutCredentialLocator(resident.id)}`), "utf8").trim();
  // Exactly what the MCP tool does: the shared client, posting to the signed route.
  const scheduleNextIteration = (input: { delaySeconds: number; reason: string; callId: string }) =>
    scheduleResidentIteration(input, async (body, signal) => app.request("/mcp/residents/schedule-next-iteration", {
      method: "POST", signal, body: JSON.stringify(body),
      headers: { "content-type": "application/json", "x-harness-token": ensureToken(), "x-mission-scout-credential": credential },
    }));
  const run = () => store.getResidentRun("run-1324")!.run;
  const settle = () => new Promise((resolve) => setTimeout(resolve, 15));
  const options = (labels: string[]) => labels.map((label, i) => ({ id: `o${i}`, label, detail: `${label} detail`, ...(i === 0 ? { recommended: true } : {}) }));
  const ask = (question: string, labels: string[]) => reviews.create(resident.id, "input", question, question,
    [{ id: "q", question, options: options(labels), allowOther: true }]);
  try {
    loop.start(); await settle();
    const log: string[] = [];
    for (const [question, labels, pick] of [
      ["Which rollout should the resident take?\n\n- staging was clean\n- production is larger", ["Run it tonight", "Split by tenant", "Wait for on-call", "Skip this cycle"], "o1"],
      ["Which tenants go first?\n\n- small ones finish fastest", ["Smallest first", "Largest first", "Alphabetical", "Ask on-call"], "o1"],
    ] as const) {
      const review = ask(question, [...labels]);
      await settle();
      assert.equal(registry.getSession(resident.id)!.pendingReviews, 1);
      // The open question holds wakes; it never pauses the run.
      assert.notEqual(run().loopState, "paused"); assert.equal(run().pauseReason, null);
      const whileOpen = await scheduleNextIteration({ delaySeconds: 1800, reason: "while open", callId: `open-${review.id}` });
      assert.ok(!("code" in whileOpen), `recorded while held: ${JSON.stringify(whileOpen)}`);
      assert.equal(whileOpen.pending, true);
      log.push(`asked: open review -> loop ${run().loopState} (pause_reason ${run().pauseReason}); schedule_next_iteration -> ${JSON.stringify(whileOpen)}`);
      const answered = reviews.resolve(review.id, "answer", null, "human", [{ decisionId: "q", selected: [pick], other: null }]);
      assert.equal(answered?.status, "answered");
      await settle();
      assert.equal(registry.getSession(resident.id)!.pendingReviews, 0);
      assert.equal(run().pauseReason, null);
      log.push(`answered ${pick}: loop ${run().loopState}, pause_reason ${run().pauseReason}`);
    }
    const receipt = await scheduleNextIteration({ delaySeconds: 1800, reason: "wait for the migration window", callId: "after-answers" });
    log.push(`schedule_next_iteration(delaySeconds=1800) -> ${JSON.stringify(receipt)}`);
    assert.ok(!("code" in receipt), `recorded, not refused: ${JSON.stringify(receipt)}`);
    assert.equal(receipt.callId, "after-answers"); assert.equal(receipt.delaySeconds, 1800);
    const wake = openDb().prepare("SELECT loop_state, pause_reason, next_wake_at, wake_reason, wake_request_delay_s, wake_request_reason FROM resident_runs WHERE id = 'run-1324'").get() as Record<string, unknown>;
    log.push(`resulting wake state: ${JSON.stringify(wake)}`);
    assert.equal(wake.pause_reason, null);
    if (receipt.pending) {
      assert.equal(wake.wake_request_delay_s, 1800); assert.equal(wake.wake_request_reason, "wait for the migration window");
    } else {
      assert.equal(wake.next_wake_at, receipt.nextWakeAt); assert.equal(wake.wake_reason, "wait for the migration window");
    }
    // Replaying the call id returns the same receipt, as the tool contract promises.
    assert.deepEqual(await scheduleNextIteration({ delaySeconds: 1800, reason: "wait for the migration window", callId: "after-answers" }), receipt);
    console.log(log.join("\n"));
  } finally { await loop.stop(); residents.stop(); stopCredentials(); await tasks.stop(); }
});
