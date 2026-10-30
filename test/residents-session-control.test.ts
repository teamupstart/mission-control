import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Persona } from "../src/shared/workflow.ts";
import type { ResidentLaunchAuthorization } from "../src/shared/session-control-authorization.ts";
import type { Task } from "../src/shared/types.ts";
import { mkTask } from "./helpers/session-fixture.ts";

// Phase 6 of residents: a profile with Control other sessions on gives its run the existing
// session-control grant only through the operator's desktop Launch click. The click is armed in
// the shell, consumed once by the daemon over the private channel for exactly that request,
// profile and revision, applied through the Registry's own grant, recorded on the run, and
// re-applied after a restart only to the same conversation, working directory, work episode and
// task. Real Registry, TaskManager, store and routes; the dispatcher plays the SDK supervisor.

const home = mkdtempSync(join(tmpdir(), "mission-residents-control-"));
process.env.HARNESS_HOME = home;

const { Registry } = await import("../src/server/registry.ts");
const { RESIDENT_LAUNCH_TASK_CREATE, TaskManager } = await import("./helpers/task-manager-fixture.ts");
const { ResidentManager } = await import("../src/server/residents/manager.ts");
const store = await import("../src/server/residents/store.ts");
const { upsertSdkSession } = await import("../src/server/sdk/store.ts");
const { openDb, upsertTask } = await import("../src/server/db.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { ResidentProfileRevisionSchema, residentRunControlRecorded } = await import("../src/shared/residents.ts");
const {
  armResidentLaunchAuthorization,
  armSessionControlAuthorization,
  serveSessionControlAuthorization,
} = await import("../src/main/session-control-authorization.ts");
const { residentLaunchAuthorization } = await import("../src/server/session-control-authorization.ts");
const { serveDashboardClick } = await import("../src/main/dashboard-click-ipc.ts");

type Registry = InstanceType<typeof Registry>;
type Manager = InstanceType<typeof ResidentManager>;
type ReviewManager = import("../src/server/reviews.ts").ReviewManager;
type QueueManager = import("../src/server/queue.ts").QueueManager;

const PERSONA: Persona = {
  id: "builtin:fleet-triage",
  name: "Fleet Triage",
  normalizedName: "fleet triage",
  description: "Watches the fleet.",
  guidanceMarkdown: "You watch the fleet.",
  runner: null,
  model: null,
  revision: 1,
  archivedAt: null,
  createdAt: 0,
  updatedAt: 0,
  provenance: null,
  builtin: true,
};
const REPO = "/work/mission-control";

function settings(controlOtherSessions: boolean, name = "Triage Bot") {
  return ResidentProfileRevisionSchema.parse({
    identity: { name },
    persona: { personaId: PERSONA.id },
    workspace: { defaultRepoRoot: REPO },
    authority: { controlOtherSessions },
  });
}

const managers: Manager[] = [];
afterEach(() => {
  for (const manager of managers.splice(0)) manager.stop();
});
beforeEach(() => {
  openDb().exec("DELETE FROM resident_runs; DELETE FROM resident_profile_revisions; DELETE FROM resident_profiles; DELETE FROM sdk_sessions; DELETE FROM tasks;");
});

/** The supervisor's part: write the session row, register the conversation, bind the task. */
function startSession(registry: Registry, taskId: string): void {
  const task = registry.getTask(taskId)!;
  const sessionId = `sdk:${taskId}`;
  const cwd = `/worktrees/${taskId}`;
  upsertSdkSession({
    id: sessionId,
    agent: task.agent,
    agentSessionId: `native-${taskId}`,
    cwd,
    taskId,
    model: task.model,
    effort: task.effort,
    permissionMode: null,
    status: "starting",
    turnInProgress: true,
  });
  registry.registerSdkSession({ id: sessionId, name: task.title, agent: task.agent, cwd, agentSessionId: `native-${taskId}` });
  registry.upsertTask({ ...task, status: "running", sessionId });
}

interface Harness {
  registry: Registry;
  residents: Manager;
  asked: ResidentLaunchAuthorization[];
  /** The clicks the shell would hold: consumed once, exact request, profile and revision. */
  clicks: Map<string, ResidentLaunchAuthorization>;
}

function harness(registry: Registry = new Registry()): Harness {
  const tasks = new TaskManager(registry);
  (tasks as unknown as { dispatcher: { dispatch(id: string): Promise<void> } }).dispatcher = {
    async dispatch(id) {
      await Promise.resolve();
      startSession(registry, id);
    },
  };
  const asked: ResidentLaunchAuthorization[] = [];
  const clicks = new Map<string, ResidentLaunchAuthorization>();
  const residents = new ResidentManager({
    registry,
    createTask: (input, internal) => tasks.create(input, internal, RESIDENT_LAUNCH_TASK_CREATE),
    persona: (id) => (id === PERSONA.id ? PERSONA : null),
    resolveRepoRoot: async () => ({ ok: true as const, repoRoot: REPO }),
    launchResponseWaitMs: 5_000,
    authorizeLaunch: async (input) => {
      asked.push(input);
      const click = clicks.get(input.requestId);
      clicks.delete(input.requestId);
      return click?.profileId === input.profileId && click?.revision === input.revision;
    },
  });
  residents.start();
  managers.push(residents);
  return { registry, residents, asked, clicks };
}

function profileIn(h: Harness, controlOtherSessions: boolean) {
  const created = h.residents.createProfile(settings(controlOtherSessions));
  return created.ok ? created.profile : assert.fail(created.error);
}

async function launched(h: Harness, profileId: string, requestId: string, options?: { mayConsumeControlClick?: boolean }) {
  const outcome = await h.residents.launch(profileId, { repoRoot: REPO, requestId }, options ?? { mayConsumeControlClick: true });
  if (!("result" in outcome) || outcome.result.state !== "launched") assert.fail(JSON.stringify(outcome));
  const sessionId = h.registry.getTask(outcome.result.taskId)!.sessionId!;
  return { run: outcome.result.run, sessionId };
}

function control(runId: string) {
  return store.getResidentRun(runId)!.run.control;
}

// ---- the shell's half: arm and consume ----

function shellChannel() {
  const child = Object.assign(new EventEmitter(), { postMessage: (data: unknown) => port.emit("message", { data }) });
  const port = Object.assign(new EventEmitter(), { postMessage: (data: unknown) => { child.emit("message", data); } });
  serveSessionControlAuthorization(child as never);
  return { port, authorize: residentLaunchAuthorization(port as never) };
}

test("the shell gives a resident launch the click armed for its exact request, profile and revision, once, within 15 seconds", async () => {
  const c = shellChannel();
  const click = { requestId: randomUUID(), profileId: "profile-1", revision: 3 };
  assert.equal(await c.authorize(click), false, "no operator click");
  for (const mismatch of [{ profileId: "profile-2" }, { revision: 4 }]) {
    assert.equal(armResidentLaunchAuthorization(click), true);
    assert.equal(await c.authorize({ ...click, ...mismatch }), false);
    assert.equal(await c.authorize(click), false, "a refused use also consumes the click");
  }
  assert.equal(armResidentLaunchAuthorization(click), true);
  assert.equal(await c.authorize({ ...click, requestId: randomUUID() }), false, "another launch request");
  assert.equal(await c.authorize(click), true, "the click is still this request's");
  assert.equal(await c.authorize(click), false, "a replayed click");
  assert.equal(armResidentLaunchAuthorization(click, Date.now() - 15_001), true);
  assert.equal(await c.authorize(click), false, "an expired click");
  // The session menu's click is a different authority, even under the same request id.
  assert.equal(armSessionControlAuthorization({ requestId: click.requestId, sessionId: "sdk:x", enabled: true }), true);
  assert.equal(await c.authorize(click), false);
  assert.equal(c.port.listenerCount("message"), 0);
});

test("the shell refuses a malformed arm, and a replaced daemon inherits no click", async () => {
  const click = { requestId: randomUUID(), profileId: "profile-1", revision: 1 };
  for (const invalid of [
    null,
    { ...click, requestId: "forged" },
    { ...click, profileId: "" },
    { ...click, revision: 0 },
    { ...click, revision: 1.5 },
    { ...click, revision: "1" },
    { ...click, extra: true },
  ]) {
    assert.equal(armResidentLaunchAuthorization(invalid), false, JSON.stringify(invalid));
  }
  assert.equal(armResidentLaunchAuthorization(click), true);
  assert.equal(armResidentLaunchAuthorization(click), false, "one arm per request id");
  const replacement = shellChannel();
  assert.equal(await replacement.authorize(click), false);
  assert.equal(await residentLaunchAuthorization(undefined)(click), false, "a standalone daemon has no shell to ask");
});

test("only the dashboard's own contents can arm a resident Launch click", async () => {
  const c = shellChannel();
  const handlers = new Map<string, (event: { sender: unknown; returnValue?: unknown }, input: unknown) => void>();
  const dashboard = { id: "dashboard" };
  serveDashboardClick(
    { on: (channel: string, fn: never) => { handlers.set(channel, fn); } } as never,
    "mission:resident-launch-click",
    () => dashboard as never,
    armResidentLaunchAuthorization,
  );
  const arm = handlers.get("mission:resident-launch-click")!;
  const click = { requestId: randomUUID(), profileId: "profile-1", revision: 2 };
  const forged = { sender: { id: "another window" }, returnValue: undefined as unknown };
  arm(forged, click);
  assert.equal(forged.returnValue, false);
  assert.equal(await c.authorize(click), false, "nothing was armed");
  const real = { sender: dashboard, returnValue: undefined as unknown };
  arm(real, click);
  assert.equal(real.returnValue, true);
  assert.equal(await c.authorize(click), true);
});

// ---- the daemon's half: consume at launch, grant, record ----

/** A Registry whose grant refuses to apply, as it does for a session it no longer considers live. */
class GrantRefusingRegistry extends Registry {
  refusedGrants = 0;
  override setSessionControlEnabled(id: string, enabled: boolean): boolean {
    if (enabled) {
      this.refusedGrants += 1;
      return false;
    }
    return super.setSessionControlEnabled(id, enabled);
  }
}

test("a Launch click whose grant the Registry refuses records nothing a restart could restore", async () => {
  const registry = new GrantRefusingRegistry();
  const h = harness(registry);
  const profile = profileIn(h, true);
  const requestId = randomUUID();
  h.clicks.set(requestId, { requestId, profileId: profile.id, revision: profile.revision });
  const { run, sessionId } = await launched(h, profile.id, requestId);
  assert.equal(registry.refusedGrants, 1, "the grant was attempted once, and refused");
  assert.equal(registry.sessionControlEnabled(sessionId), false);
  const recorded = control(run.id);
  assert.equal(typeof recorded.authorizedAt, "number", "the click itself was consumed");
  assert.deepEqual({ conversationId: recorded.conversationId, cwd: recorded.cwd, episodeId: recorded.episodeId },
    { conversationId: null, cwd: null, episodeId: null }, "no identity is recorded for a grant that never applied");
  assert.equal(residentRunControlRecorded(recorded), false);
  for (const manager of managers.splice(0)) manager.stop();
  const after = restart(run);
  assert.equal(after.h.registry.sessionControlEnabled(after.sessionId), false);
});

test("a desktop Launch click grants the run session control and records the identity it was applied to", async () => {
  const h = harness();
  const profile = profileIn(h, true);
  const requestId = randomUUID();
  h.clicks.set(requestId, { requestId, profileId: profile.id, revision: profile.revision });
  const { run, sessionId } = await launched(h, profile.id, requestId);
  assert.deepEqual(h.asked, [{ requestId, profileId: profile.id, revision: 1 }]);
  assert.equal(h.registry.sessionControlEnabled(sessionId), true);
  assert.equal(h.registry.getSession(sessionId)!.sessionControlEnabled, true);
  const recorded = control(run.id);
  assert.equal(typeof recorded.authorizedAt, "number");
  assert.deepEqual({ ...recorded, authorizedAt: null }, {
    authorizedAt: null,
    conversationId: `native-${run.taskId}`,
    cwd: `/worktrees/${run.taskId}`,
    episodeId: h.registry.workEpisodeForSession(sessionId)!.episodeId,
  });
});

test("a launch without the click, or with one for another revision, starts ungranted", async () => {
  const h = harness();
  const profile = profileIn(h, true);
  const first = await launched(h, profile.id, randomUUID());
  assert.equal(h.asked.length, 1, "it asked, and the shell had nothing");
  assert.equal(h.registry.sessionControlEnabled(first.sessionId), false);
  assert.deepEqual(control(first.run.id), { authorizedAt: null, conversationId: null, cwd: null, episodeId: null });
  // A click armed against the revision the operator saw does not authorize a newer one.
  const edited = h.residents.updateProfile(profile.id, 1, settings(true));
  assert.equal(edited.ok, true);
  const requestId = randomUUID();
  h.clicks.set(requestId, { requestId, profileId: profile.id, revision: 1 });
  const second = await launched(h, profile.id, requestId);
  assert.equal(h.asked.at(-1)!.revision, 2, "the daemon asks for the revision the run pinned");
  assert.equal(h.registry.sessionControlEnabled(second.sessionId), false);
  assert.equal(control(second.run.id).authorizedAt, null);
});

test("a profile with control off never asks for a click, and a replay never consumes one", async () => {
  const h = harness();
  const off = profileIn(h, false);
  const requestId = randomUUID();
  h.clicks.set(requestId, { requestId, profileId: off.id, revision: 1 });
  const { sessionId } = await launched(h, off.id, requestId);
  assert.equal(h.asked.length, 0);
  assert.equal(h.registry.sessionControlEnabled(sessionId), false);
  const on = h.residents.updateProfile(off.id, 1, settings(true));
  assert.equal(on.ok, true);
  const granted = randomUUID();
  h.clicks.set(granted, { requestId: granted, profileId: off.id, revision: 2 });
  await launched(h, off.id, granted);
  await launched(h, off.id, granted);
  assert.equal(h.asked.length, 1, "the replay is answered from the run row");
});

test("a tool, an agent or another origin launches without consuming a click", async () => {
  const h = harness();
  const app = buildApp({
    registry: h.registry,
    reviews: {} as ReviewManager,
    tasks: {} as import("../src/server/tasks.ts").TaskManager,
    queues: {} as QueueManager,
    residents: h.residents,
  });
  const profile = profileIn(h, true);
  const base = { host: "127.0.0.1:7317", "content-type": "application/json" };
  const launch = async (headers: Record<string, string>) => {
    const requestId = randomUUID();
    h.clicks.set(requestId, { requestId, profileId: profile.id, revision: 1 });
    const response = await app.request(`/api/residents/profiles/${profile.id}/launch`, {
      method: "POST",
      headers: { ...base, ...headers },
      body: JSON.stringify({ repoRoot: REPO, requestId }),
    });
    const body = await response.json() as { state: string; run: { id: string; taskId: string } };
    assert.equal(body.state, "launched");
    return { run: body.run, sessionId: h.registry.getTask(body.run.taskId)!.sessionId! };
  };
  const callers: Array<Record<string, string>> = [
    { "x-harness-token": "machine-token" },
    { "x-mission-scout-credential": "signed-agent" },
    { "x-mission-operation-actor": "agent" },
    { origin: "https://example.com" },
  ];
  for (const headers of callers) {
    const { run, sessionId } = await launch(headers);
    assert.equal(h.asked.length, 0, JSON.stringify(headers));
    assert.equal(h.registry.sessionControlEnabled(sessionId), false);
    assert.equal(control(run.id).authorizedAt, null);
  }
  const operator = await launch({ origin: "http://127.0.0.1:7317" });
  assert.equal(h.asked.length, 1);
  assert.equal(h.registry.sessionControlEnabled(operator.sessionId), true);
});

test("turning control off with the session control toggle forgets the run's grant", async () => {
  const h = harness();
  const menuClicks = new Set<string>();
  const app = buildApp({
    registry: h.registry,
    reviews: {} as ReviewManager,
    tasks: {} as import("../src/server/tasks.ts").TaskManager,
    queues: {} as QueueManager,
    residents: h.residents,
    authorizeSessionControl: async (input) => menuClicks.delete(input.requestId),
  });
  const profile = profileIn(h, true);
  const requestId = randomUUID();
  h.clicks.set(requestId, { requestId, profileId: profile.id, revision: 1 });
  const { run, sessionId } = await launched(h, profile.id, requestId);
  assert.notEqual(control(run.id).conversationId, null);
  const revoke = randomUUID();
  menuClicks.add(revoke);
  const response = await app.request(`/api/sessions/${encodeURIComponent(sessionId)}/session-control`, {
    method: "PUT",
    headers: { host: "127.0.0.1:7317", "content-type": "application/json" },
    body: JSON.stringify({ enabled: false, requestId: revoke }),
  });
  assert.equal(response.status, 200);
  assert.equal(h.registry.sessionControlEnabled(sessionId), false);
  assert.deepEqual(control(run.id), { authorizedAt: null, conversationId: null, cwd: null, episodeId: null });
});

test("a revoke whose event log fails still forgets the run's grant, so a restart cannot restore it", async () => {
  const h = harness();
  const menuClicks = new Set<string>();
  const app = buildApp({
    registry: h.registry,
    reviews: {} as ReviewManager,
    tasks: {} as import("../src/server/tasks.ts").TaskManager,
    queues: {} as QueueManager,
    residents: h.residents,
    authorizeSessionControl: async (input) => menuClicks.delete(input.requestId),
  });
  const profile = profileIn(h, true);
  const requestId = randomUUID();
  h.clicks.set(requestId, { requestId, profileId: profile.id, revision: 1 });
  const { run, sessionId } = await launched(h, profile.id, requestId);
  assert.equal(residentRunControlRecorded(control(run.id)), true);
  const revoke = randomUUID();
  menuClicks.add(revoke);
  // The session event ledger refuses every write, as a full disk or a locked database would.
  openDb().exec(`CREATE TRIGGER refuse_session_events BEFORE INSERT ON session_events
    BEGIN SELECT RAISE(ABORT, 'session event ledger unavailable'); END;`);
  try {
    const response = await app.request(`/api/sessions/${encodeURIComponent(sessionId)}/session-control`, {
      method: "PUT",
      headers: { host: "127.0.0.1:7317", "content-type": "application/json" },
      body: JSON.stringify({ enabled: false, requestId: revoke }),
    });
    assert.equal(response.status, 500, "the failed log write still fails the request");
  } finally {
    openDb().exec("DROP TRIGGER refuse_session_events");
  }
  assert.equal(h.registry.sessionControlEnabled(sessionId), false);
  assert.deepEqual(control(run.id), { authorizedAt: null, conversationId: null, cwd: null, episodeId: null });
  for (const manager of managers.splice(0)) manager.stop();
  const after = restart(run);
  assert.equal(after.h.registry.sessionControlEnabled(after.sessionId), false, "the revoked grant stays revoked");
});

// ---- after a restart ----

/**
 * Bring the run's session back the way SDK restore does - same session id and native
 * conversation, unless `conversation` says otherwise - into a fresh Registry and manager, then
 * complete the first sweep that follows restore.
 *
 * `claimedBy` is another active task, stored before the restart and created before the resident
 * task, bound to that same session: the restarted Registry loads it first, so its grant identity
 * names it as the session's task instead of the run's.
 */
function restart(run: { taskId: string }, conversation = `native-${run.taskId}`, claimedBy?: Task) {
  if (claimedBy) upsertTask(claimedBy);
  const registry = new Registry();
  const h = harness(registry);
  const sessionId = `sdk:${run.taskId}`;
  registry.registerSdkSession({
    id: sessionId,
    name: "Triage Bot",
    agent: "claude",
    cwd: `/worktrees/${run.taskId}`,
    agentSessionId: conversation,
    initialState: "idle",
  });
  const durable = h.registry.getTask(run.taskId);
  assert.ok(durable, "the TaskManager hydrated the resident task");
  registry.upsertTask({ ...durable, status: "running", sessionId });
  if (claimedBy) registry.upsertTask({ ...registry.getTask(claimedBy.id)!, status: "running", sessionId });
  registry.applyDiscovery([]);
  return { h, sessionId };
}

async function grantedRun() {
  const h = harness();
  const profile = profileIn(h, true);
  const requestId = randomUUID();
  h.clicks.set(requestId, { requestId, profileId: profile.id, revision: 1 });
  const result = await launched(h, profile.id, requestId);
  assert.equal(h.registry.sessionControlEnabled(result.sessionId), true);
  for (const manager of managers.splice(0)) manager.stop();
  return result;
}

test("a restart re-grants the same conversation, working directory, work episode and task", async () => {
  const { run } = await grantedRun();
  const before = control(run.id);
  const { h, sessionId } = restart(run);
  assert.equal(h.asked.length, 0, "a restart never asks for a new click");
  assert.equal(h.registry.sessionControlEnabled(sessionId), true);
  assert.equal(h.registry.getSession(sessionId)!.sessionControlEnabled, true);
  assert.deepEqual(control(run.id), before, "the record is unchanged");
});

for (const [field, value] of [
  ["control_cwd", "/worktrees/elsewhere"],
  ["control_episode_id", "a-replacement-episode"],
  ["control_conversation_id", "native-before-a-clear"],
] as const) {
  test(`a restart does not carry the grant when only the recorded ${field.replace("control_", "")} differs`, async () => {
    const { run } = await grantedRun();
    openDb().prepare(`UPDATE resident_runs SET ${field} = ? WHERE id = ?`).run(value, run.id);
    const { h, sessionId } = restart(run);
    assert.equal(h.registry.sessionControlEnabled(sessionId), false);
    assert.deepEqual(control(run.id), { authorizedAt: null, conversationId: null, cwd: null, episodeId: null },
      "a grant that no longer matches is forgotten");
  });
}

test("a restart does not carry the grant to a session that now belongs to another task", async () => {
  const { run } = await grantedRun();
  const sessionId = `sdk:${run.taskId}`;
  const other = mkTask({ id: "another-task", status: "running", sessionId, worktreePath: `/worktrees/${run.taskId}` });
  const { h } = restart(run, `native-${run.taskId}`, other);
  // The conversation, working directory and work episode all still match; only the task differs.
  // The Registry binds a session to one task, so the run's own task no longer names it.
  assert.equal(h.registry.taskForSession(sessionId, `/worktrees/${run.taskId}`)?.id, "another-task");
  assert.equal(h.registry.getTask(run.taskId)?.sessionId, null);
  assert.equal(h.registry.sessionControlEnabled(sessionId), false);
  assert.deepEqual(control(run.id), { authorizedAt: null, conversationId: null, cwd: null, episodeId: null },
    "a grant whose task no longer matches is forgotten");
});

test("a restart into a new conversation does not carry the grant", async () => {
  const { run } = await grantedRun();
  const { h, sessionId } = restart(run, "native-after-a-clear");
  assert.equal(h.registry.sessionControlEnabled(sessionId), false);
  assert.equal(control(run.id).authorizedAt, null);
});

for (const field of ["control_authorized_at", "control_conversation_id", "control_cwd", "control_episode_id"]) {
  test(`a run missing ${field} stays ungranted after a restart`, async () => {
    const { run } = await grantedRun();
    openDb().prepare(`UPDATE resident_runs SET ${field} = NULL WHERE id = ?`).run(run.id);
    const { h, sessionId } = restart(run);
    assert.equal(h.registry.sessionControlEnabled(sessionId), false);
  });
}

test("a run whose click was consumed but whose grant never applied stays ungranted after a restart", async () => {
  const { run } = await grantedRun();
  openDb().prepare(`UPDATE resident_runs SET control_conversation_id = NULL, control_cwd = NULL, control_episode_id = NULL WHERE id = ?`).run(run.id);
  assert.notEqual(control(run.id).authorizedAt, null);
  const { h, sessionId } = restart(run);
  assert.equal(h.registry.sessionControlEnabled(sessionId), false);
});
