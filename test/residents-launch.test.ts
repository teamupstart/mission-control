import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { ensureNativeStateLockAddon } from "./helpers/native-state-lock.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { ResidentLaunchResult } from "../src/shared/residents.ts";

import type { Persona } from "../src/shared/workflow.ts";
import type { Task } from "../src/shared/types.ts";
import { mkTask } from "./helpers/session-fixture.ts";

// `ResidentManager.launch` against a real Registry, a real TaskManager and real `sdk_sessions`
// rows. Only the dispatcher is a stand-in: it plays the SDK supervisor's part by writing the
// session row (the evidence the run waits for) and binding the task, or by failing.

ensureNativeStateLockAddon();

const home = mkdtempSync(join(tmpdir(), "mission-residents-launch-"));
process.env.HARNESS_HOME = home;

const { Registry } = await import("../src/server/registry.ts");
const { RESIDENT_LAUNCH_TASK_CREATE, TaskManager } = await import("./helpers/task-manager-fixture.ts");
const {
  RESIDENT_INTERRUPTED_BEFORE_SESSION,
  RESIDENT_INTERRUPTED_BEFORE_TASK,
  ResidentManager,
} = await import("../src/server/residents/manager.ts");
const store = await import("../src/server/residents/store.ts");
const { upsertSdkSession } = await import("../src/server/sdk/store.ts");
const { openDb } = await import("../src/server/db.ts");
const { ResidentLoop } = await import("../src/server/residents/loop.ts");
const { registerResidentLoopRoutes } = await import("../src/server/residents/routes.ts");
const {
  RESIDENT_OPENING_TURN,
  ResidentProfileRevisionSchema,
  residentLaunchInput,
} = await import("../src/shared/residents.ts");

type Registry = InstanceType<typeof Registry>;
type Manager = InstanceType<typeof ResidentManager>;

const PERSONA: Persona = {
  id: "builtin:fleet-triage",
  name: "Fleet Triage",
  normalizedName: "fleet triage",
  description: "Watches the fleet.",
  guidanceMarkdown: "You watch the fleet and summarize blockers.",
  runner: null,
  model: null,
  revision: 1,
  archivedAt: null,
  createdAt: 0,
  updatedAt: 0,
  provenance: null,
  builtin: true,
};

/** Two spellings of one repository resolve to one real path; anything else is not a repo. */
const REPO = "/work/mission-control";
const REPO_SPELLINGS = new Set([REPO, `${REPO}/`, "/work/./mission-control", "/work/other/../mission-control"]);
const OTHER_REPO = "/work/other-repo";

async function resolveRepoRoot(path: string) {
  if (REPO_SPELLINGS.has(path)) return { ok: true as const, repoRoot: REPO };
  if (path === OTHER_REPO) return { ok: true as const, repoRoot: OTHER_REPO };
  return { ok: false as const, error: `not a git repository: ${path}` };
}

function settings(over: { name?: string; agent?: "claude" | "codex"; model?: string | null; effort?: "low" | "high" | null; instructions?: string } = {}) {
  return ResidentProfileRevisionSchema.parse({
    identity: { name: over.name ?? "Triage Bot" },
    persona: { personaId: PERSONA.id },
    instructions: { markdown: over.instructions ?? "Summarize blockers first." },
    execution: {
      agent: over.agent ?? "claude",
      model: over.model === undefined ? "claude-opus-4-8" : over.model,
      effort: over.effort === undefined ? "high" : over.effort,
    },
    workspace: { defaultRepoRoot: REPO },
  });
}

type DispatchMode = "start" | "fail" | "hold";

interface Harness {
  registry: Registry;
  tasks: InstanceType<typeof TaskManager>;
  residents: Manager;
  dispatched: string[];
  mode: { current: DispatchMode };
  release: () => void;
  resolveCalls: { count: number };
}

const managers: Manager[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.stop();
});

beforeEach(() => {
  const d = openDb();
  d.exec("DELETE FROM resident_runs; DELETE FROM resident_profile_revisions; DELETE FROM resident_profiles; DELETE FROM sdk_sessions; DELETE FROM tasks;");
});

/** Play the supervisor: write the session row, then bind the task - in that order. */
function startSession(registry: Registry, taskId: string): void {
  const task = registry.getTask(taskId)!;
  upsertSdkSession({
    id: `sdk-${taskId}`,
    agent: task.agent,
    agentSessionId: null,
    cwd: `/worktrees/${taskId}`,
    taskId,
    model: task.model,
    effort: task.effort,
    permissionMode: null,
    status: "starting",
    turnInProgress: true,
  });
  registry.upsertTask({ ...task, status: "running", sessionId: `sdk-${taskId}` });
}

function harness(options: {
  mode?: DispatchMode;
  registry?: Registry;
  resolve?: typeof resolveRepoRoot;
  waitMs?: number;
  start?: boolean;
  hasLiveDriver?: (id: string) => boolean;
  removeWorkspace?: ConstructorParameters<typeof ResidentManager>[0]["removeWorkspace"];
} = {}): Harness {
  const registry = options.registry ?? new Registry();
  const tasks = new TaskManager(registry);
  const dispatched: string[] = [];
  const mode = { current: options.mode ?? ("start" as DispatchMode) };
  let releaseHeld: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    releaseHeld = resolve;
  });
  (tasks as unknown as { dispatcher: { dispatch(id: string): Promise<void> } }).dispatcher = {
    async dispatch(id) {
      dispatched.push(id);
      await Promise.resolve();
      if (mode.current === "hold") await held;
      const task = registry.getTask(id)!;
      if (mode.current === "fail") {
        registry.upsertTask({ ...task, status: "failed", error: `agent binary "claude" not found on PATH` });
        return;
      }
      startSession(registry, id);
    },
  };
  const resolveCalls = { count: 0 };
  const residents = new ResidentManager({
    registry,
    createTask: (input, internal) => tasks.create(input, internal, RESIDENT_LAUNCH_TASK_CREATE),
    persona: (id) => (id === PERSONA.id ? PERSONA : null),
    resolveRepoRoot: async (path) => {
      resolveCalls.count += 1;
      return (options.resolve ?? resolveRepoRoot)(path);
    },
    launchResponseWaitMs: options.waitMs ?? 5_000,
    hasLiveDriver: options.hasLiveDriver,
    removeWorkspace: options.removeWorkspace,
  });
  if (options.start !== false) residents.start();
  managers.push(residents);
  return { registry, tasks, residents, dispatched, mode, release: () => releaseHeld(), resolveCalls };
}

function profileIn(h: Harness, over: Parameters<typeof settings>[0] = {}) {
  const created = h.residents.createProfile(settings(over));
  assert.equal(created.ok, true, created.ok ? "" : created.error);
  return created.ok ? created.profile : assert.fail("profile");
}

function runCount(): number {
  return (openDb().prepare("SELECT COUNT(*) AS n FROM resident_runs").get() as { n: number }).n;
}

function residentTasks(registry: Registry): Task[] {
  return registry.listTasks().filter((task) => task.kind === "resident");
}

test("a launch reserves one run, creates its resident task with the profile's agent, model and effort, and settles launched on the session row", async () => {
  const h = harness();
  const profile = profileIn(h);
  const outcome = await h.residents.launch(profile.id, { repoRoot: `${REPO}/`, instructions: "  Focus on the release branch.  ", requestId: "req-first" });
  assert.equal(outcome.ok, true);
  if (!("result" in outcome) || outcome.result.state !== "launched") assert.fail(JSON.stringify(outcome));
  const { run, taskId } = outcome.result;
  assert.equal(outcome.status, 200);
  assert.equal(run.profileRevision, 1);
  assert.equal(run.launchState, "launched");
  assert.equal(run.endedAt, null);
  assert.equal(run.runInstructions, "Focus on the release branch.");
  assert.deepEqual(run.persona, {
    personaId: PERSONA.id,
    name: PERSONA.name,
    guidanceMarkdown: PERSONA.guidanceMarkdown,
  });
  const task = h.registry.getTask(taskId)!;
  assert.equal(task.id, run.taskId, "the task carries the id the run reserved");
  assert.equal(task.kind, "resident");
  assert.equal(task.agent, "claude");
  assert.equal(task.model, "claude-opus-4-8");
  assert.equal(task.effort, "high");
  assert.equal(task.workflowId, null, "a resident never inherits an after-work Workflow");
  assert.equal(task.intent, RESIDENT_OPENING_TURN);
  assert.equal(task.title, "Triage Bot");
  assert.equal(task.repoRoot, REPO);
  assert.deepEqual(h.dispatched, [taskId]);
});

test("a Codex profile's agent reaches the task explicitly rather than falling back to a default", async () => {
  const h = harness();
  const profile = profileIn(h, { name: "Docs Gardener", agent: "codex", model: "gpt-6-luna", effort: null });
  const outcome = await h.residents.launch(profile.id, { repoRoot: REPO, requestId: "req-codex" });
  if (!("result" in outcome) || outcome.result.state !== "launched") assert.fail(JSON.stringify(outcome));
  const task = h.registry.getTask(outcome.result.taskId)!;
  assert.equal(task.agent, "codex");
  assert.equal(task.model, "gpt-6-luna");
  assert.equal(task.effort, null);
});

test("a repeated requestId returns the same run and task and dispatches once", async () => {
  const h = harness();
  const profile = profileIn(h);
  const first = await h.residents.launch(profile.id, { repoRoot: REPO, requestId: "req-repeat" });
  const second = await h.residents.launch(profile.id, { repoRoot: REPO, requestId: "req-repeat" });
  if (!("result" in first) || !("result" in second)) assert.fail("both launched");
  assert.equal(second.status, 200);
  assert.equal(second.result.run.id, first.result.run.id);
  assert.equal(second.result.state, "launched");
  assert.equal(runCount(), 1);
  assert.equal(residentTasks(h.registry).length, 1);
  assert.equal(h.dispatched.length, 1);
});

test("the restart route replays the same run and task without repeating completion or dispatch", async t => {
  const h = harness();
  const loop = new ResidentLoop({ registry: h.registry, refreshSession: () => {}, sdk: { sendWhenIdle: async () => null, compact: async () => 1 } });
  t.after(() => loop.stop());
  const complete = t.mock.method(h.tasks, "complete");
  const app = new Hono();
  registerResidentLoopRoutes(app, { registry: h.registry, loop, tasks: h.tasks, residents: h.residents });
  const profile = profileIn(h);
  const original = await h.residents.launch(profile.id, { repoRoot: REPO, instructions: "Watch the release", requestId: "before-restart" });
  if (!("result" in original) || original.result.state !== "launched") assert.fail(JSON.stringify(original));
  assert.equal(h.residents.updateProfile(profile.id, 1, settings({ instructions: "Updated brief" })).ok, true);
  const restart = () => app.request(`/api/residents/runs/${original.result.run.id}/restart`, { method: "POST" });

  const response = await restart();
  assert.equal(response.status, 200);
  const first = await response.json() as ResidentLaunchResult;
  assert.equal(first.state, "launched");
  assert.notEqual(first.run.id, original.result.run.id);
  assert.notEqual(first.taskId, original.result.taskId);
  assert.equal(first.run.profileRevision, 2);
  assert.equal(first.run.runInstructions, "Watch the release");
  assert.notEqual(store.getResidentRun(original.result.run.id)!.run.endedAt, null);
  assert.equal(h.registry.getTask(original.result.taskId)!.status, "done");

  const replayResponse = await restart();
  assert.equal(replayResponse.status, 200);
  const replay = await replayResponse.json() as ResidentLaunchResult;
  assert.equal(replay.state, "launched");
  assert.equal(replay.run.id, first.run.id);
  assert.equal(replay.taskId, first.taskId);
  assert.equal(replay.run.profileRevision, 2);
  assert.equal(runCount(), 2, "only the original and its replacement run exist");
  assert.equal(residentTasks(h.registry).length, 2);
  assert.deepEqual(h.dispatched, [original.result.taskId, first.taskId], "the replacement dispatch happens once");
  assert.equal(complete.mock.callCount(), 1, "a replay never completes the original task again");
  assert.equal(complete.mock.calls[0]!.arguments[0], original.result.taskId);
});

test("a replay after the profile is edited returns the original run and its pinned revision", async () => {
  const h = harness();
  const profile = profileIn(h);
  const first = await h.residents.launch(profile.id, { repoRoot: REPO, requestId: "req-pinned" });
  if (!("result" in first)) assert.fail("launched");
  const edited = h.residents.updateProfile(profile.id, 1, settings({ instructions: "A different brief." }));
  assert.equal(edited.ok, true);
  const replay = await h.residents.launch(profile.id, { repoRoot: REPO, requestId: "req-pinned" });
  if (!("result" in replay) || replay.result.state !== "launched") assert.fail(JSON.stringify(replay));
  assert.equal(replay.result.run.id, first.result.run.id);
  assert.equal(replay.result.run.profileRevision, 1);
  assert.equal(replay.result.run.settings.instructions.markdown, "Summarize blockers first.");
  assert.equal(store.getResidentProfile(profile.id)?.revision, 2);
  assert.equal(store.residentProfileRevision(profile.id, 1)?.instructions.markdown, "Summarize blockers first.");
  assert.equal(h.dispatched.length, 1);
});

test("a replay of a pending launch answers in progress and creates nothing; launched is never written before the session row", async () => {
  const h = harness({ mode: "hold", waitMs: 20 });
  const profile = profileIn(h);
  const first = await h.residents.launch(profile.id, { repoRoot: REPO, requestId: "req-held" });
  if (!("result" in first)) assert.fail(JSON.stringify(first));
  assert.equal(first.status, 202);
  assert.equal(first.result.state, "pending");
  // The task exists and is dispatching, and no session row exists: still pending.
  assert.equal(h.registry.getTask(first.result.run.taskId)?.status, "dispatching");
  assert.equal(store.getResidentRun(first.result.run.id)?.run.launchState, "pending");

  const replay = await h.residents.launch(profile.id, { repoRoot: REPO, requestId: "req-held" });
  if (!("result" in replay)) assert.fail(JSON.stringify(replay));
  assert.equal(replay.result.state, "pending");
  assert.equal(replay.result.run.id, first.result.run.id);
  assert.equal(runCount(), 1);
  assert.equal(h.dispatched.length, 1);

  h.release();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const settled = await h.residents.launch(profile.id, { repoRoot: REPO, requestId: "req-held" });
  if (!("result" in settled)) assert.fail(JSON.stringify(settled));
  assert.equal(settled.result.state, "launched");
  assert.equal(h.dispatched.length, 1);
});

test("a dispatch that fails before its session starts fails the run with the task's error, and a replay returns it", async () => {
  const h = harness({ mode: "fail" });
  const profile = profileIn(h);
  const first = await h.residents.launch(profile.id, { repoRoot: REPO, requestId: "req-fail" });
  if (!("result" in first) || first.result.state !== "failed") assert.fail(JSON.stringify(first));
  assert.equal(first.status, 409);
  assert.equal(first.result.error, `agent binary "claude" not found on PATH`);
  assert.notEqual(first.result.run.endedAt, null, "a failed run is never left live");

  const replay = await h.residents.launch(profile.id, { repoRoot: REPO, requestId: "req-fail" });
  if (!("result" in replay) || replay.result.state !== "failed") assert.fail(JSON.stringify(replay));
  assert.equal(replay.result.error, first.result.error);
  assert.equal(runCount(), 1);
  assert.equal(h.dispatched.length, 1, "a failed launch needs a new requestId; the replay creates nothing");
});

test("a requestId reused for a different repository, instructions, or profile is refused as a typed conflict", async () => {
  const h = harness();
  const profile = profileIn(h);
  const other = profileIn(h, { name: "Release Watch" });
  await h.residents.launch(profile.id, { repoRoot: REPO, instructions: "Today", requestId: "req-reuse" });
  for (const conflicting of [
    { profileId: profile.id, input: { repoRoot: OTHER_REPO, instructions: "Today", requestId: "req-reuse" } },
    { profileId: profile.id, input: { repoRoot: REPO, instructions: "Tomorrow", requestId: "req-reuse" } },
    { profileId: other.id, input: { repoRoot: REPO, instructions: "Today", requestId: "req-reuse" } },
  ]) {
    const outcome = await h.residents.launch(conflicting.profileId, conflicting.input);
    assert.equal(outcome.ok, false);
    assert.ok("code" in outcome && outcome.code === "conflict", JSON.stringify(outcome));
    assert.equal(outcome.status, 409);
  }
  assert.equal(runCount(), 1);
  assert.equal(h.dispatched.length, 1);
});

test("two concurrent requests with one requestId that both miss the lookup produce one run, one task and one dispatch", async () => {
  // Both requests enter before either has reserved and then wait at the repository resolution.
  // The first to resume reserves; the second re-reads the run after its await and replays it.
  let releaseResolve: () => void = () => {};
  const barrier = new Promise<void>((resolve) => {
    releaseResolve = resolve;
  });
  const h = harness({
    resolve: async (path) => {
      await barrier;
      return resolveRepoRoot(path);
    },
  });
  const profile = profileIn(h);
  const a = h.residents.launch(profile.id, { repoRoot: REPO, instructions: "same", requestId: "req-race" });
  const b = h.residents.launch(profile.id, { repoRoot: `${REPO}/`, instructions: " same ", requestId: "req-race" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.resolveCalls.count, 2, "both requests passed the initial lookup before either reserved");
  releaseResolve();
  const [left, right] = await Promise.all([a, b]);
  if (!("result" in left) || !("result" in right)) assert.fail(JSON.stringify([left, right]));
  assert.equal(left.result.state, "launched");
  assert.equal(right.result.state, "launched");
  assert.equal(left.result.run.id, right.result.run.id);
  assert.equal(runCount(), 1);
  assert.equal(residentTasks(h.registry).length, 1);
  assert.equal(h.dispatched.length, 1);
});

test("a concurrent request with the same requestId but different normalized input gets the typed conflict, never a constraint error", async () => {
  let releaseResolve: () => void = () => {};
  const barrier = new Promise<void>((resolve) => {
    releaseResolve = resolve;
  });
  const h = harness({
    resolve: async (path) => {
      await barrier;
      return resolveRepoRoot(path);
    },
  });
  const profile = profileIn(h);
  const a = h.residents.launch(profile.id, { repoRoot: REPO, instructions: "first", requestId: "req-race-conflict" });
  const b = h.residents.launch(profile.id, { repoRoot: REPO, instructions: "second", requestId: "req-race-conflict" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.resolveCalls.count, 2);
  releaseResolve();
  const outcomes = await Promise.all([a, b]);
  const launched = outcomes.filter((o) => "result" in o && o.result.state === "launched");
  const conflicts = outcomes.filter((o) => "code" in o && o.code === "conflict");
  assert.equal(launched.length, 1, JSON.stringify(outcomes));
  assert.equal(conflicts.length, 1, JSON.stringify(outcomes));
  assert.equal(conflicts[0]!.status, 409);
  assert.equal(runCount(), 1);
  assert.equal(residentTasks(h.registry).length, 1);
  assert.equal(h.dispatched.length, 1);
});

for (const target of ["unknown", "archived"] as const) {
  test(`a racing request that reuses the requestId for an ${target} profile gets the typed conflict, not a profile error`, async () => {
    let releaseResolve: () => void = () => {};
    const barrier = new Promise<void>((resolve) => {
      releaseResolve = resolve;
    });
    const h = harness({
      resolve: async (path) => {
        await barrier;
        return resolveRepoRoot(path);
      },
    });
    const profile = profileIn(h);
    let otherId = "no-such-profile";
    if (target === "archived") {
      const other = profileIn(h, { name: "Retired" });
      assert.equal(h.residents.archiveProfile(other.id, 1).ok, true);
      otherId = other.id;
    }
    const winner = h.residents.launch(profile.id, { repoRoot: REPO, requestId: `req-race-${target}` });
    const loser = h.residents.launch(otherId, { repoRoot: REPO, requestId: `req-race-${target}` });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.resolveCalls.count, 2, "both requests started before either reserved");
    releaseResolve();
    const [won, lost] = await Promise.all([winner, loser]);
    if (!("result" in won)) assert.fail(JSON.stringify(won));
    assert.equal(won.result.state, "launched");
    assert.ok("code" in lost && lost.code === "conflict", JSON.stringify(lost));
    assert.equal(lost.status, 409);
    // The idempotency conflict, not the profile's own refusal ("archived" also answers 409).
    if ("error" in lost) assert.match(lost.error, /launch request id was already used/);
    assert.equal(runCount(), 1);
    assert.equal(residentTasks(h.registry).length, 1);
    assert.equal(h.dispatched.length, 1);
  });
}

test("a reservation that lands between the re-read and the insert is answered from the winner's row, matching or conflicting", async () => {
  for (const instructions of ["same", "different"] as const) {
    const h = harness();
    const profile = profileIn(h, { name: `Race ${instructions}` });
    const requestId = `req-insert-race-${instructions}`;
    // The persona read sits between the request-id re-read and the reservation insert, so a
    // winner reserved there forces the insert to lose on the unique index.
    const winnerRun = `run-winner-${instructions}`;
    let injected = false;
    const residents = new ResidentManager({
      registry: h.registry,
      createTask: () => assert.fail("the loser creates no task"),
      persona: (id) => {
        if (!injected) {
          injected = true;
          store.reserveResidentRun({
            id: winnerRun,
            profileId: profile.id,
            profileRevision: 1,
            taskId: `task-${winnerRun}`,
            launchRequestId: requestId,
            launchInput: residentLaunchInput(REPO, "same"),
            repoSpelling: REPO,
            persona: { personaId: PERSONA.id, name: PERSONA.name, guidanceMarkdown: PERSONA.guidanceMarkdown },
            runInstructions: "same",
            at: 1,
          });
        }
        return id === PERSONA.id ? PERSONA : null;
      },
      resolveRepoRoot,
    });
    managers.push(residents);
    const outcome = await residents.launch(profile.id, { repoRoot: REPO, instructions, requestId });
    if (instructions === "same") {
      if (!("result" in outcome)) assert.fail(JSON.stringify(outcome));
      assert.equal(outcome.result.run.id, winnerRun, "the loser answers with the winner's run");
      assert.equal(outcome.result.state, "pending");
    } else {
      assert.ok("code" in outcome && outcome.code === "conflict", JSON.stringify(outcome));
      assert.equal(outcome.status, 409);
    }
    assert.equal(
      (openDb().prepare("SELECT COUNT(*) AS n FROM resident_runs WHERE launch_request_id = ?").get(requestId) as { n: number }).n,
      1,
    );
  }
});

test("an exact replay is recognized after its repository stops resolving; another spelling is not", async () => {
  // The original launch named a noncanonical spelling (a symlink, a `..` path); later the
  // repository is removed, so nothing resolves any more.
  const gone = { current: false };
  const h = harness({
    resolve: async (path) => (gone.current
      ? { ok: false as const, error: `not a git repository: ${path}` }
      : resolveRepoRoot(path)),
  });
  const profile = profileIn(h);
  const spelling = "/work/other/../mission-control";
  const first = await h.residents.launch(profile.id, { repoRoot: spelling, instructions: "Today", requestId: "req-gone" });
  if (!("result" in first) || first.result.state !== "launched") assert.fail(JSON.stringify(first));

  gone.current = true;
  const replay = await h.residents.launch(profile.id, { repoRoot: ` ${spelling} `, instructions: "Today", requestId: "req-gone" });
  if (!("result" in replay)) assert.fail(JSON.stringify(replay));
  assert.equal(replay.status, 200);
  assert.equal(replay.result.state, "launched");
  assert.equal(replay.result.run.id, first.result.run.id);

  // The resolved path itself still matches what was stored.
  const resolvedSpelling = await h.residents.launch(profile.id, { repoRoot: REPO, instructions: "Today", requestId: "req-gone" });
  assert.ok("result" in resolvedSpelling && resolvedSpelling.result.run.id === first.result.run.id, JSON.stringify(resolvedSpelling));

  // A spelling the original request never used cannot be proven to be the same repository.
  const other = await h.residents.launch(profile.id, { repoRoot: "/work/./mission-control", instructions: "Today", requestId: "req-gone" });
  assert.ok("code" in other && other.code === "conflict", JSON.stringify(other));
  // And the instructions still have to match.
  const changed = await h.residents.launch(profile.id, { repoRoot: spelling, instructions: "Tomorrow", requestId: "req-gone" });
  assert.ok("code" in changed && changed.code === "conflict", JSON.stringify(changed));
  assert.equal(runCount(), 1);
  assert.equal(h.dispatched.length, 1);
});

test("an exact replay is recognized after its symlink is retargeted; alternate spellings still compare canonically", async () => {
  // The original launch named a symlink to the repository; before the retry the link is
  // pointed at another repository, so the same spelling now resolves somewhere else.
  const LINK = "/work/link-to-repo";
  const retargeted = { current: false };
  const h = harness({
    resolve: async (path) => {
      if (path === LINK) return { ok: true as const, repoRoot: retargeted.current ? OTHER_REPO : REPO };
      return resolveRepoRoot(path);
    },
  });
  const profile = profileIn(h);
  const first = await h.residents.launch(profile.id, { repoRoot: LINK, instructions: "Today", requestId: "req-link" });
  if (!("result" in first) || first.result.state !== "launched") assert.fail(JSON.stringify(first));

  retargeted.current = true;
  const replay = await h.residents.launch(profile.id, { repoRoot: LINK, instructions: "Today", requestId: "req-link" });
  if (!("result" in replay)) assert.fail(JSON.stringify(replay));
  assert.equal(replay.status, 200);
  assert.equal(replay.result.state, "launched");
  assert.equal(replay.result.run.id, first.result.run.id);

  // Another spelling of the ORIGINAL repository still compares by its canonical path.
  const alternate = await h.residents.launch(profile.id, { repoRoot: "/work/./mission-control", instructions: "Today", requestId: "req-link" });
  assert.ok("result" in alternate && alternate.result.run.id === first.result.run.id, JSON.stringify(alternate));
  // A spelling that now resolves to the other repository is a different launch.
  const elsewhere = await h.residents.launch(profile.id, { repoRoot: OTHER_REPO, instructions: "Today", requestId: "req-link" });
  assert.ok("code" in elsewhere && elsewhere.code === "conflict", JSON.stringify(elsewhere));
  // The exact spelling with changed instructions is still a different launch.
  const changed = await h.residents.launch(profile.id, { repoRoot: LINK, instructions: "Tomorrow", requestId: "req-link" });
  assert.ok("code" in changed && changed.code === "conflict", JSON.stringify(changed));
  assert.equal(runCount(), 1);
  assert.equal(h.dispatched.length, 1);
});

test("an uncertain settlement leaves the run pending and retries it, never declaring a live session failed", async () => {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  (tasks as unknown as { dispatcher: { dispatch(id: string): Promise<void> } }).dispatcher = {
    async dispatch(id) {
      await Promise.resolve();
      startSession(registry, id);
    },
  };
  // The session really started (its row exists), but reading that evidence fails twice.
  let failures = 2;
  const residents = new ResidentManager({
    registry,
    createTask: (input, internal) => tasks.create(input, internal, RESIDENT_LAUNCH_TASK_CREATE),
    persona: (id) => (id === PERSONA.id ? PERSONA : null),
    resolveRepoRoot,
    sessionRowsForTask: (taskId) => {
      if (failures > 0) {
        failures -= 1;
        throw new Error("database is locked");
      }
      return (openDb().prepare("SELECT id FROM sdk_sessions WHERE task_id = ?").all(taskId) as Array<{ id: string }>)
        .map((row) => row.id);
    },
    launchResponseWaitMs: 5,
    settlementRetryMs: 20,
  });
  managers.push(residents);
  residents.start();
  const created = residents.createProfile(settings({ name: "Settle Retry" }));
  if (!created.ok) assert.fail(created.error);
  const original = console.error;
  const errors: unknown[] = [];
  console.error = (...args: unknown[]) => errors.push(args);
  try {
    const first = await residents.launch(created.profile.id, { repoRoot: REPO, requestId: "req-settle-retry" });
    if (!("result" in first)) assert.fail(JSON.stringify(first));
    assert.equal(first.status, 202, "uncertain is in progress, not failed");
    assert.equal(first.result.state, "pending");
    assert.equal(store.getResidentRun(first.result.run.id)?.run.launchState, "pending");

    await new Promise((resolve) => setTimeout(resolve, 200));
    const settled = await residents.launch(created.profile.id, { repoRoot: REPO, requestId: "req-settle-retry" });
    if (!("result" in settled) || settled.result.state !== "launched") assert.fail(JSON.stringify(settled));
    assert.equal(settled.result.run.endedAt, null);
  } finally {
    console.error = original;
  }
  assert.ok(errors.length >= 2, "each uncertain attempt is logged");
  assert.equal(runCount(), 1);
});

test("a settlement that never becomes certain stays pending for startup reconciliation, which settles it from evidence", async () => {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  (tasks as unknown as { dispatcher: { dispatch(id: string): Promise<void> } }).dispatcher = {
    async dispatch(id) {
      await Promise.resolve();
      startSession(registry, id);
    },
  };
  const residents = new ResidentManager({
    registry,
    createTask: (input, internal) => tasks.create(input, internal, RESIDENT_LAUNCH_TASK_CREATE),
    persona: (id) => (id === PERSONA.id ? PERSONA : null),
    resolveRepoRoot,
    sessionRowsForTask: () => {
      throw new Error("database is locked");
    },
    launchResponseWaitMs: 5,
    settlementRetryMs: 1,
  });
  managers.push(residents);
  residents.start();
  const created = residents.createProfile(settings({ name: "Never Certain" }));
  if (!created.ok) assert.fail(created.error);
  const original = console.error;
  console.error = () => {};
  let runId = "";
  try {
    const outcome = await residents.launch(created.profile.id, { repoRoot: REPO, requestId: "req-never-certain" });
    if (!("result" in outcome)) assert.fail(JSON.stringify(outcome));
    runId = outcome.result.run.id;
    await new Promise((resolve) => setTimeout(resolve, 150));
  } finally {
    console.error = original;
  }
  assert.equal(store.getResidentRun(runId)?.run.launchState, "pending", "never declared failed");
  // A restarted daemon reads the evidence that exists and adopts the launch.
  const restarted = harness({ registry });
  void restarted;
  assert.equal(store.getResidentRun(runId)?.run.launchState, "launched");
});

test("two spellings of one repository normalize to the same launch input", async () => {
  const h = harness();
  const profile = profileIn(h);
  const first = await h.residents.launch(profile.id, { repoRoot: "/work/./mission-control", requestId: "req-spelling" });
  const second = await h.residents.launch(profile.id, { repoRoot: "/work/other/../mission-control", requestId: "req-spelling" });
  if (!("result" in first) || !("result" in second)) assert.fail("both answer");
  assert.equal(second.result.run.id, first.result.run.id);
  const stored = openDb().prepare("SELECT launch_input FROM resident_runs").get() as { launch_input: string };
  assert.deepEqual(JSON.parse(stored.launch_input), residentLaunchInput(REPO, undefined));
});

test("an input stored without a later-defaulted field compares equal after the schema grows", async () => {
  const h = harness();
  const profile = profileIn(h);
  const first = await h.residents.launch(profile.id, { repoRoot: REPO, requestId: "req-versioned" });
  if (!("result" in first)) assert.fail("launched");
  // The shape an older writer would have stored: its own version, and no `instructions`.
  openDb().prepare("UPDATE resident_runs SET launch_input = ? WHERE id = ?")
    .run(JSON.stringify({ version: 1, repoRoot: REPO }), first.result.run.id);
  const replay = await h.residents.launch(profile.id, { repoRoot: REPO, requestId: "req-versioned" });
  if (!("result" in replay)) assert.fail(JSON.stringify(replay));
  assert.equal(replay.result.run.id, first.result.run.id);
  assert.equal(replay.result.state, "launched");
});

// ---- crash reconciliation, each followed by a daemon restart ----

/** The reservation write alone, as a crash right after it leaves the database. */
function reserveOnly(profileId: string, requestId: string, taskId: string, input = residentLaunchInput(REPO, "Today")) {
  const runId = `run-${requestId}`;
  store.reserveResidentRun({
    id: runId,
    profileId,
    profileRevision: 1,
    taskId,
    launchRequestId: requestId,
    launchInput: input,
    repoSpelling: input.repoRoot ?? "",
    persona: { personaId: PERSONA.id, name: PERSONA.name, guidanceMarkdown: PERSONA.guidanceMarkdown },
    runInstructions: input.instructions,
    at: 1,
  });
  return runId;
}

test("a crash after the reservation and before task creation refuses a conflicting replay both before and after reconciliation", async () => {
  const setup = harness({ start: false });
  const profile = profileIn(setup);
  const runId = reserveOnly(profile.id, "req-crash-1", "task-never-created");

  // The restarted daemon, before its startup reconciliation has run: the run is pending.
  const restarted = harness({ start: false });
  for (const conflicting of [
    { repoRoot: OTHER_REPO, instructions: "Today" },
    { repoRoot: REPO, instructions: "Tomorrow" },
  ]) {
    const outcome = await restarted.residents.launch(profile.id, { ...conflicting, requestId: "req-crash-1" });
    assert.ok("code" in outcome && outcome.code === "conflict", JSON.stringify(outcome));
  }
  const pending = await restarted.residents.launch(profile.id, { repoRoot: REPO, instructions: "Today", requestId: "req-crash-1" });
  if (!("result" in pending)) assert.fail(JSON.stringify(pending));
  assert.equal(pending.result.state, "pending");

  restarted.residents.start();
  const after = store.getResidentRun(runId)!.run;
  assert.equal(after.launchState, "failed");
  assert.equal(after.launchError, RESIDENT_INTERRUPTED_BEFORE_TASK);
  assert.notEqual(after.endedAt, null);
  for (const conflicting of [
    { repoRoot: OTHER_REPO, instructions: "Today" },
    { repoRoot: REPO, instructions: "Tomorrow" },
  ]) {
    const outcome = await restarted.residents.launch(profile.id, { ...conflicting, requestId: "req-crash-1" });
    assert.ok("code" in outcome && outcome.code === "conflict", JSON.stringify(outcome));
  }
  const failed = await restarted.residents.launch(profile.id, { repoRoot: REPO, instructions: "Today", requestId: "req-crash-1" });
  if (!("result" in failed) || failed.result.state !== "failed") assert.fail(JSON.stringify(failed));
  assert.equal(failed.result.error, RESIDENT_INTERRUPTED_BEFORE_TASK);
  assert.equal(restarted.dispatched.length, 0, "nothing is relaunched");
  assert.equal(runCount(), 1);
});

test("a crash after the task was created and before the driver accepted turn one fails the run and never relaunches", async () => {
  const setup = harness({ start: false });
  const profile = profileIn(setup);
  const taskId = "task-created-no-session";
  const runId = reserveOnly(profile.id, "req-crash-2", taskId);
  const registry = new Registry();
  registry.upsertTask(mkTask({
    id: taskId,
    kind: "resident",
    status: "dispatching",
    repoRoot: REPO,
    worktreePath: null,
    homeName: null,
    sessionId: null,
  }));

  const restarted = harness({ registry });
  const after = store.getResidentRun(runId)!.run;
  assert.equal(after.launchState, "failed");
  assert.equal(after.launchError, RESIDENT_INTERRUPTED_BEFORE_SESSION);
  assert.notEqual(after.endedAt, null);
  assert.equal(registry.getTask(taskId)?.status, "failed", "the task settles through the existing path");
  assert.deepEqual(restarted.dispatched, []);
  const replay = await restarted.residents.launch(profile.id, { repoRoot: REPO, instructions: "Today", requestId: "req-crash-2" });
  if (!("result" in replay) || replay.result.state !== "failed") assert.fail(JSON.stringify(replay));
  assert.equal(replay.result.error, RESIDENT_INTERRUPTED_BEFORE_SESSION);
});

test("a crash after the driver accepted turn one, before the task was bound, is adopted as launched once the task is bound", async () => {
  const setup = harness({ start: false });
  const profile = profileIn(setup);
  const taskId = "task-session-unbound";
  const runId = reserveOnly(profile.id, "req-crash-3", taskId);
  const registry = new Registry();
  registry.upsertTask(mkTask({
    id: taskId,
    kind: "resident",
    status: "dispatching",
    repoRoot: REPO,
    worktreePath: "/worktrees/resident",
    homeName: null,
    sessionId: null,
  }));
  upsertSdkSession({
    id: "sdk-unbound",
    agent: "claude",
    agentSessionId: null,
    cwd: "/worktrees/resident",
    taskId,
    model: null,
    effort: null,
    permissionMode: null,
    status: "starting",
    turnInProgress: true,
  });
  // TaskManager's own reconciliation binds the dispatching task to the live row first.
  const supervisor = {
    taskLiveness: () => true,
    liveSessionForTask: () => "sdk-unbound",
  } as unknown as ConstructorParameters<typeof TaskManager>[2];
  const tasks = new TaskManager(registry, undefined, supervisor);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(registry.getTask(taskId)?.status, "running");
  assert.equal(registry.getTask(taskId)?.sessionId, "sdk-unbound");
  void tasks;

  const residents = new ResidentManager({
    registry,
    createTask: () => assert.fail("reconciliation creates nothing"),
    persona: () => PERSONA,
  });
  managers.push(residents);
  residents.start();
  const after = store.getResidentRun(runId)!.run;
  assert.equal(after.launchState, "launched");
  assert.equal(after.endedAt, null);
});

test("a crash after the task was bound and before the launched write is adopted as launched", async () => {
  const setup = harness({ start: false });
  const profile = profileIn(setup);
  const taskId = "task-bound";
  const runId = reserveOnly(profile.id, "req-crash-4", taskId);
  const registry = new Registry();
  registry.upsertTask(mkTask({
    id: taskId,
    kind: "resident",
    status: "running",
    repoRoot: REPO,
    worktreePath: "/worktrees/bound",
    sessionId: "sdk-bound",
  }));
  upsertSdkSession({
    id: "sdk-bound",
    agent: "claude",
    agentSessionId: "agent-1",
    cwd: "/worktrees/bound",
    taskId,
    model: null,
    effort: null,
    permissionMode: null,
    status: "running",
    turnInProgress: false,
  });
  const residents = new ResidentManager({
    registry,
    createTask: () => assert.fail("reconciliation creates nothing"),
    persona: () => PERSONA,
  });
  managers.push(residents);
  residents.start();
  const after = store.getResidentRun(runId)!.run;
  assert.equal(after.launchState, "launched");
  assert.equal(after.endedAt, null);
});

test("a launched run ends when its task is completed, and the startup twin ends one whose task settled while the daemon was down", async () => {
  const h = harness();
  const profile = profileIn(h);
  const outcome = await h.residents.launch(profile.id, { repoRoot: REPO, requestId: "req-end" });
  if (!("result" in outcome) || outcome.result.state !== "launched") assert.fail(JSON.stringify(outcome));
  const task = h.registry.getTask(outcome.result.taskId)!;
  h.registry.upsertTask({ ...task, status: "done", completedAt: 5 });
  assert.notEqual(store.getResidentRun(outcome.result.run.id)?.run.endedAt, null);

  // The startup twin: a launched run whose task is already done when the daemon comes up.
  const second = await h.residents.launch(profile.id, { repoRoot: REPO, requestId: "req-end-twin" });
  if (!("result" in second) || second.result.state !== "launched") assert.fail(JSON.stringify(second));
  const registry = new Registry();
  const twinTask = registry.getTask(second.result.taskId)!;
  openDb().prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(twinTask.id);
  const restarted = new ResidentManager({
    registry: new Registry(),
    createTask: () => assert.fail("nothing"),
    persona: () => PERSONA,
  });
  managers.push(restarted);
  await restarted.reconcileRunEnds();
  assert.notEqual(store.getResidentRun(second.result.run.id)?.run.endedAt, null);
});

// ---- validation ----

test("launch validation refuses a missing repository, a missing Persona, an archived profile and an unknown profile", async () => {
  const h = harness();
  const profile = profileIn(h);
  const missingRepo = await h.residents.launch(profile.id, { repoRoot: "/not/a/repo", requestId: "req-v1" });
  assert.ok("code" in missingRepo && missingRepo.code === "invalid" && missingRepo.status === 400);

  const unknown = await h.residents.launch("no-such-profile", { repoRoot: REPO, requestId: "req-v2" });
  assert.ok("code" in unknown && unknown.code === "not_found" && unknown.status === 404);

  const orphan = profileIn(h, { name: "Orphan" });
  openDb().prepare("UPDATE resident_profile_revisions SET settings_json = json_set(settings_json, '$.persona.personaId', 'gone') WHERE profile_id = ?").run(orphan.id);
  const missingPersona = await h.residents.launch(orphan.id, { repoRoot: REPO, requestId: "req-v3" });
  assert.ok("code" in missingPersona && missingPersona.code === "invalid", JSON.stringify(missingPersona));

  assert.equal(h.residents.archiveProfile(profile.id, 1).ok, true);
  const archived = await h.residents.launch(profile.id, { repoRoot: REPO, requestId: "req-v4" });
  assert.ok("code" in archived && archived.code === "conflict" && archived.status === 409);
  assert.equal(runCount(), 0);
  assert.equal(h.dispatched.length, 0);
});

test("a profile cannot be saved against a missing Persona", () => {
  const h = harness();
  const saved = h.residents.createProfile(ResidentProfileRevisionSchema.parse({
    identity: { name: "Nobody" },
    persona: { personaId: "builtin:does-not-exist" },
  }));
  assert.equal(saved.ok, false);
  if (!saved.ok) assert.equal(saved.status, 400);
});

test("repo-less launch skips repository resolution; completion waits for runtime shutdown and retries on startup", async () => {
  const { existsSync, writeFileSync } = await import("node:fs");
  const { setSdkSessionStatus } = await import("../src/server/sdk/store.ts");
  const setup = harness();
  const profile = profileIn(setup);
  const outcome = await setup.residents.launch(profile.id, { repoRoot: null, requestId: "workspace-lifetime" });
  if (!("result" in outcome) || outcome.result.state !== "launched") assert.fail(JSON.stringify(outcome));
  const run = outcome.result.run;
  const directory = run.workspaceDir!;
  assert.equal(setup.resolveCalls.count, 0);
  assert.ok(existsSync(directory));
  writeFileSync(join(directory, "notes.txt"), "still needed");
  const task = setup.registry.getTask(run.taskId)!;
  setup.registry.upsertTask({ ...task, status: "done" });
  assert.ok(existsSync(directory), "completion alone is not proof that the runtime stopped");
  await setup.residents.stop();
  let driverAlive = true;
  const restored = harness({ registry: setup.registry, hasLiveDriver: () => driverAlive });
  assert.ok(existsSync(directory), "a suspended or running SDK row protects the workspace after restart");
  setSdkSessionStatus(task.sessionId!, "exited");
  await restored.residents.reconcileRunEnds();
  assert.ok(existsSync(directory), "an exited row does not override a supervisor-owned handle");
  driverAlive = false;
  await restored.residents.reconcileRunEnds();
  assert.equal(existsSync(directory), false);
  assert.equal(store.getResidentRun(run.id)!.run.workspaceDir, null);
  await restored.residents.cleanupEndedWorkspaces();
});

test("workspace removal failure keeps cleanup owed until a later manager retries successfully", async (t) => {
  const { existsSync, lstatSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync } = await import("node:fs");
  const { setSdkSessionStatus } = await import("../src/server/sdk/store.ts");
  const setup = harness();
  const profile = profileIn(setup);
  const outcome = await setup.residents.launch(profile.id, { repoRoot: null, requestId: "workspace-cleanup-retry" });
  if (!("result" in outcome) || outcome.result.state !== "launched") assert.fail(JSON.stringify(outcome));
  const run = outcome.result.run;
  const directory = run.workspaceDir!;
  const savedDirectory = `${directory}-saved`;
  writeFileSync(join(directory, "notes.txt"), "preserve until cleanup succeeds");
  const task = setup.registry.getTask(run.taskId)!;
  setup.registry.upsertTask({ ...task, status: "done" });
  setSdkSessionStatus(task.sessionId!, "exited");

  // Exercise the real ownership check: cleanup must refuse a symlink without forgetting
  // the directory it still owes, even though the run and its runtime have both ended.
  renameSync(directory, savedDirectory);
  symlinkSync(savedDirectory, directory);
  const errors = t.mock.method(console, "error", () => {});
  await assert.doesNotReject(() => setup.residents.cleanupEndedWorkspaces());
  await assert.doesNotReject(() => setup.residents.cleanupEndedWorkspaces());
  assert.equal(errors.mock.callCount(), 1, "the manager caught a real removal failure");
  const failure = errors.mock.calls[0];
  assert.ok(failure);
  const [message, error] = failure.arguments;
  assert.equal(message, `[residents] workspace cleanup remains owed for ${run.id}:`);
  assert.ok(error instanceof Error && /owned directory/.test(error.message));
  const failedCleanup = store.getResidentRun(run.id)!.run;
  assert.notEqual(failedCleanup.endedAt, null);
  assert.equal(failedCleanup.workspaceDir, directory, "failed cleanup retains the durable marker");
  assert.deepEqual(store.endedResidentWorkspaces().map(({ id }) => id), [run.id]);
  assert.ok(lstatSync(directory).isSymbolicLink());
  assert.equal(readFileSync(join(savedDirectory, "notes.txt"), "utf8"), "preserve until cleanup succeeds");
  await setup.residents.stop();

  unlinkSync(directory);
  renameSync(savedDirectory, directory);
  const restored = harness({ registry: setup.registry });
  await restored.residents.cleanupEndedWorkspaces();
  assert.equal(existsSync(directory), false, "startup retries the persisted cleanup obligation");
  assert.equal(store.getResidentRun(run.id)!.run.workspaceDir, null);
  assert.deepEqual(store.endedResidentWorkspaces(), []);
  assert.equal(errors.mock.callCount(), 1, "the retry completed without another removal error");
});

test("an unreadable workspace directory keeps cleanup owed until permissions are restored", {
  skip: process.getuid?.() === 0 ? "root bypasses directory permissions" : false,
}, async (t) => {
  const { chmodSync, existsSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  const { setSdkSessionStatus } = await import("../src/server/sdk/store.ts");
  const setup = harness();
  const profile = profileIn(setup);
  const outcome = await setup.residents.launch(profile.id, { repoRoot: null, requestId: "unreadable-cleanup-retry" });
  if (!("result" in outcome) || outcome.result.state !== "launched") assert.fail(JSON.stringify(outcome));
  const run = outcome.result.run;
  const directory = run.workspaceDir!;
  const denied = join(directory, "unreadable");
  mkdirSync(denied);
  writeFileSync(join(denied, "keep-until-accessible.txt"), "temporary");
  const task = setup.registry.getTask(run.taskId)!;
  setup.registry.upsertTask({ ...task, status: "done" });
  setSdkSessionStatus(task.sessionId!, "exited");
  const errors = t.mock.method(console, "error", () => {});
  chmodSync(denied, 0o000);
  try {
    await setup.residents.cleanupEndedWorkspaces();
    await setup.residents.cleanupEndedWorkspaces();
    assert.equal(errors.mock.callCount(), 1);
    assert.equal(store.getResidentRun(run.id)!.run.workspaceDir, directory);
    assert.ok(existsSync(denied));
  } finally {
    chmodSync(denied, 0o700);
  }
  await setup.residents.cleanupEndedWorkspaces();
  assert.equal(store.getResidentRun(run.id)!.run.workspaceDir, null);
  assert.equal(existsSync(dirname(directory)), false);
  assert.equal(errors.mock.callCount(), 1);
});

test("cleanup retries an owed per-run directory after the workspace was already removed", async (t) => {
  const { existsSync, unlinkSync, writeFileSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  const { setSdkSessionStatus } = await import("../src/server/sdk/store.ts");
  const setup = harness();
  const profile = profileIn(setup);
  const outcome = await setup.residents.launch(profile.id, { repoRoot: null, requestId: "run-directory-retry" });
  if (!("result" in outcome) || outcome.result.state !== "launched") assert.fail(JSON.stringify(outcome));
  const run = outcome.result.run;
  const directory = run.workspaceDir!;
  const runDirectory = dirname(directory);
  const obstacle = join(runDirectory, "keep-until-released.txt");
  writeFileSync(obstacle, "an unexpected sibling must not be recursively deleted");
  const task = setup.registry.getTask(run.taskId)!;
  setup.registry.upsertTask({ ...task, status: "done" });
  setSdkSessionStatus(task.sessionId!, "exited");
  const errors = t.mock.method(console, "error", () => {});
  await assert.doesNotReject(() => setup.residents.cleanupEndedWorkspaces());
  assert.equal(errors.mock.callCount(), 1);
  assert.equal(existsSync(directory), false, "workspace removal succeeded before parent removal failed");
  assert.ok(existsSync(obstacle));
  assert.equal(store.getResidentRun(run.id)!.run.workspaceDir, directory);
  assert.deepEqual(store.endedResidentWorkspaces().map(({ id }) => id), [run.id]);
  await setup.residents.stop();

  unlinkSync(obstacle);
  const restored = harness({ registry: setup.registry });
  await restored.residents.cleanupEndedWorkspaces();
  assert.equal(existsSync(runDirectory), false, "startup retries removal even with no workspace left");
  assert.equal(store.getResidentRun(run.id)!.run.workspaceDir, null);
  assert.deepEqual(store.endedResidentWorkspaces(), []);
  assert.equal(errors.mock.callCount(), 1);
});

test("workspace cleanup contains database read failures and retries without losing the obligation", async (t) => {
  const { existsSync } = await import("node:fs");
  const { setSdkSessionStatus } = await import("../src/server/sdk/store.ts");
  const setup = harness();
  const profile = profileIn(setup);
  const outcome = await setup.residents.launch(profile.id, { repoRoot: null, requestId: "cleanup-read-retry" });
  if (!("result" in outcome) || outcome.result.state !== "launched") assert.fail(JSON.stringify(outcome));
  const run = outcome.result.run;
  const task = setup.registry.getTask(run.taskId)!;
  setup.registry.upsertTask({ ...task, status: "done" });
  setSdkSessionStatus(task.sessionId!, "exited");
  const db = openDb();
  const prepare = db.prepare.bind(db);
  const errors = t.mock.method(console, "error", () => {});
  // Exercise every synchronous read before removal, using the real stores and query flow.
  for (const read of [/FROM resident_runs WHERE ended_at/, /FROM sdk_sessions WHERE task_id/, /FROM sdk_sessions WHERE id/]) {
    const failingRead = t.mock.method(db, "prepare", (sql: string) => {
      if (read.test(sql)) throw new Error("database is locked");
      return prepare(sql);
    });
    try {
      await assert.doesNotReject(() => setup.residents.cleanupEndedWorkspaces());
      await assert.doesNotReject(() => setup.residents.cleanupEndedWorkspaces());
    } finally {
      failingRead.mock.restore();
    }
    assert.ok(existsSync(run.workspaceDir!));
    assert.equal(store.getResidentRun(run.id)!.run.workspaceDir, run.workspaceDir);
  }
  assert.equal(errors.mock.callCount(), 1, "a continuous scan failure is reported once until a pass succeeds");
  assert.match(String(errors.mock.calls[0]!.arguments[0]), /could not scan ended workspaces/);
  await setup.residents.cleanupEndedWorkspaces();
  assert.equal(existsSync(run.workspaceDir!), false);
  assert.equal(store.getResidentRun(run.id)!.run.workspaceDir, null);
  const laterFailure = t.mock.method(db, "prepare", () => { throw new Error("database is locked again"); });
  try {
    await setup.residents.cleanupEndedWorkspaces();
    assert.equal(errors.mock.callCount(), 2, "a later failure after recovery is reported again");
  } finally {
    laterFailure.mock.restore();
  }
});

test("workspace cleanup yields, serializes each run, and drains before manager shutdown", async () => {
  const { existsSync } = await import("node:fs");
  const { setImmediate: yieldToLoop } = await import("node:timers/promises");
  const { setSdkSessionStatus } = await import("../src/server/sdk/store.ts");
  const { removeResidentWorkspace } = await import("../src/server/residents/workspace.ts");
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  let attempts = 0;
  const setup = harness({ removeWorkspace: async (id, directory) => {
    attempts += 1;
    await held;
    await removeResidentWorkspace(id, directory);
  } });
  const profile = profileIn(setup);
  const outcome = await setup.residents.launch(profile.id, { repoRoot: null, requestId: "async-cleanup" });
  if (!("result" in outcome) || outcome.result.state !== "launched") assert.fail(JSON.stringify(outcome));
  const run = outcome.result.run;
  assert.deepEqual(setup.registry.listResidentRuns().map(({ id }) => id), [run.id]);
  const task = setup.registry.getTask(run.taskId)!;
  setup.registry.upsertTask({ ...task, status: "done" });
  assert.deepEqual(setup.registry.listResidentRuns(), [], "the live summary leaves before deferred filesystem cleanup");
  setSdkSessionStatus(task.sessionId!, "exited");
  const first = setup.residents.cleanupEndedWorkspaces();
  const second = setup.residents.cleanupEndedWorkspaces();
  let stopped = false;
  const stopping = setup.residents.stop().then(() => { stopped = true; });
  try {
    await yieldToLoop();
    assert.equal(attempts, 1, "overlapping passes share one removal for this run");
    assert.equal(stopped, false, "shutdown waits for the in-flight filesystem operation");
    assert.ok(existsSync(run.workspaceDir!));
    assert.equal(store.getResidentRun(run.id)!.run.workspaceDir, run.workspaceDir);
    assert.deepEqual(new Registry().snapshot().residentRuns, [], "reconnect cannot revive an ended run awaiting cleanup");
  } finally {
    release();
    await Promise.all([first, second, stopping]);
  }
  assert.equal(stopped, true);
  assert.equal(existsSync(run.workspaceDir!), false);
  assert.equal(store.getResidentRun(run.id)!.run.workspaceDir, null);
  await setup.residents.cleanupEndedWorkspaces();
  assert.equal(attempts, 1, "a stopped manager starts no new cleanup");
});

test("a failed repo-less launch removes its workspace and a replay does not recreate it", async () => {
  const { existsSync } = await import("node:fs");
  const setup = harness({ mode: "fail" });
  const profile = profileIn(setup);
  const outcome = await setup.residents.launch(profile.id, { repoRoot: null, requestId: "workspace-failure" });
  assert.ok("result" in outcome);
  const run = outcome.result.run;
  assert.equal(run.launchState, "failed");
  const { residentWorkspaceDir } = await import("../src/server/residents/workspace.ts");
  await setup.residents.cleanupEndedWorkspaces();
  assert.equal(existsSync(residentWorkspaceDir(run.id)), false);
  await setup.residents.launch(profile.id, { repoRoot: null, requestId: "workspace-failure" });
  assert.equal(existsSync(residentWorkspaceDir(run.id)), false);
  assert.equal(setup.dispatched.length, 1);
});

test("startup removes a workspace left by a crash between reservation and task creation", async () => {
  const { existsSync } = await import("node:fs");
  const { createResidentWorkspace, residentWorkspaceDir } = await import("../src/server/residents/workspace.ts");
  const setup = harness({ start: false });
  const profile = profileIn(setup);
  const id = "crashed-workspace";
  const directory = residentWorkspaceDir(id);
  store.reserveResidentRun({ id, profileId: profile.id, profileRevision: 1, taskId: "missing-task",
    launchRequestId: id, launchInput: residentLaunchInput(null, ""), repoSpelling: "", workspaceDir: directory,
    persona: { personaId: PERSONA.id, name: PERSONA.name, guidanceMarkdown: PERSONA.guidanceMarkdown },
    runInstructions: "", at: 1 });
  createResidentWorkspace(id, directory);
  setup.residents.start();
  await setup.residents.cleanupEndedWorkspaces();
  assert.equal(store.getResidentRun(id)!.run.launchState, "failed");
  assert.equal(existsSync(directory), false);
});

test("cancellation stops an owned repo-less resident before settlement and retries a refused stop", async () => {
  const registry = new Registry();
  let refuseStop = true;
  const stopped: string[] = [];
  const supervisor = {
    handleFor: () => ({}),
    taskLiveness: () => true,
    async stop(id: string) {
      assert.equal(registry.getTask("cancel-resident")?.status, "running");
      stopped.push(id);
      if (refuseStop) throw new Error("driver still stopping");
    },
  } as unknown as ConstructorParameters<typeof TaskManager>[2];
  const tasks = new TaskManager(registry, undefined, supervisor);
  const session = registry.registerSdkSession({ id: "sdk:cancel-resident", agent: "claude", name: "Resident", cwd: home });
  registry.upsertTask(mkTask({ id: "cancel-resident", kind: "resident", workspaceKind: "resident-workspace",
    status: "running", repoRoot: home, worktreePath: null, provider: null, homeName: null, sessionId: session.id }));
  const refused = await tasks.cancel("cancel-resident");
  assert.equal(refused.ok, false);
  assert.match(refused.error ?? "", /driver still stopping/);
  assert.equal(registry.getTask("cancel-resident")?.status, "running");
  refuseStop = false;
  assert.equal((await tasks.cancel("cancel-resident")).ok, true);
  assert.deepEqual(stopped, [session.id, session.id]);
  assert.equal(registry.getTask("cancel-resident")?.status, "cancelled");

  const assigned = registry.registerSdkSession({ id: "sdk:assigned-chat", agent: "claude", name: "Assigned", cwd: home });
  registry.upsertTask(mkTask({ id: "assigned-chat", kind: "chat", workspaceKind: "resident-workspace",
    status: "running", repoRoot: home, worktreePath: null, provider: null, homeName: null, sessionId: assigned.id }));
  assert.equal((await tasks.cancel("assigned-chat")).ok, true);
  assert.deepEqual(stopped, [session.id, session.id], "a stale marker on another kind cannot authorize stopping an assigned agent");
});

test("startup binds a repo-less task whose driver accepted launch before the task recorded its session", async () => {
  const registry = new Registry();
  const taskId = "repo-less-accepted-before-bind";
  registry.upsertTask(mkTask({ id: taskId, kind: "resident", workspaceKind: "resident-workspace",
    status: "dispatching", repoRoot: "/resident/workspace", worktreePath: null, provider: null,
    homeName: null, sessionId: null }));
  const supervisor = {
    taskLiveness: () => true,
    liveSessionForTask: () => "sdk-repo-less-unbound",
  } as unknown as ConstructorParameters<typeof TaskManager>[2];
  const tasks = new TaskManager(registry, undefined, supervisor);
  assert.equal(registry.getTask(taskId)?.status, "running");
  assert.equal(registry.getTask(taskId)?.sessionId, "sdk-repo-less-unbound");
  tasks.stop();
});

// ---- Phase 2: the `residentRuns` collection and the pinned marker ----

function runFrames(registry: Registry): Array<{ type: string; id: string; launchState?: string }> {
  const frames: Array<{ type: string; id: string; launchState?: string }> = [];
  registry.subscribe((event) => {
    if (event.type === "resident_run_upsert") {
      frames.push({ type: event.type, id: event.run.id, launchState: event.run.launchState });
    } else if (event.type === "resident_run_remove") {
      frames.push({ type: event.type, id: event.id });
    }
  });
  return frames;
}

test("a launch publishes its run while it is live, carrying the pinned settings, and removes it when the run ends", async () => {
  const h = harness();
  const frames = runFrames(h.registry);
  const profile = profileIn(h);
  const outcome = await h.residents.launch(profile.id, { repoRoot: REPO, requestId: "req-live" });
  if (!("result" in outcome) || outcome.result.state !== "launched") assert.fail(JSON.stringify(outcome));
  const { run, taskId } = outcome.result;

  // Reserved (pending), then launched: both frames carry the whole live summary.
  assert.deepEqual(frames, [
    { type: "resident_run_upsert", id: run.id, launchState: "pending" },
    { type: "resident_run_upsert", id: run.id, launchState: "launched" },
  ]);
  const [live] = h.registry.listResidentRuns();
  assert.equal(live?.id, run.id);
  assert.equal(live?.taskId, taskId);
  assert.equal(live?.personaName, PERSONA.name);
  assert.deepEqual(live?.settings.board, { colorId: "cyan", label: null, pin: true });
  // Only the sections the browser draws: never the profile instructions or the repository.
  assert.deepEqual(Object.keys(live!.settings).sort(), ["board", "identity", "loop"]);
  // The wire summary leaves out what no board surface reads.
  assert.equal("persona" in (live as object), false);
  assert.equal("runInstructions" in (live as object), false);
  assert.deepEqual(h.registry.snapshot().residentRuns.map((r) => r.id), [run.id]);

  // Complete & close settles the task; the run ends and leaves the collection.
  h.registry.upsertTask({ ...h.registry.getTask(taskId)!, status: "done" });
  assert.deepEqual(frames.at(-1), { type: "resident_run_remove", id: run.id });
  assert.deepEqual(h.registry.listResidentRuns(), []);
  assert.deepEqual(h.registry.snapshot().residentRuns, []);
});

test("a failed launch never stays in the collection, and a fresh registry seeds only open runs", async () => {
  const h = harness({ mode: "fail" });
  const frames = runFrames(h.registry);
  const profile = profileIn(h);
  const outcome = await h.residents.launch(profile.id, { repoRoot: REPO, requestId: "req-fail" });
  assert.equal(outcome.ok, false);
  const runId = frames[0]!.id;
  assert.deepEqual(frames, [
    { type: "resident_run_upsert", id: runId, launchState: "pending" },
    { type: "resident_run_remove", id: runId },
  ]);
  assert.deepEqual(h.registry.listResidentRuns(), []);

  // One live run and one failed run in the database: a reconnect snapshot from a new registry
  // carries exactly the live one. The collection is bounded by the residents running.
  h.mode.current = "start";
  const second = await h.residents.launch(profile.id, { repoRoot: REPO, requestId: "req-live-2" });
  if (!("result" in second) || second.result.state !== "launched") assert.fail(JSON.stringify(second));
  assert.equal(runCount(), 2);
  const fresh = new Registry();
  assert.deepEqual(fresh.snapshot().residentRuns.map((r) => r.id), [second.result.run.id]);
});

test("editing a profile's color, label or pin leaves a live run's marker and position unchanged; the next launch uses the edit", async () => {
  const h = harness();
  const profile = profileIn(h);
  const first = await h.residents.launch(profile.id, { repoRoot: REPO, requestId: "req-before-edit" });
  if (!("result" in first) || first.result.state !== "launched") assert.fail(JSON.stringify(first));

  const edited = h.residents.updateProfile(profile.id, 1, {
    ...profile.settings,
    board: { colorId: "violet", label: "DOC", pin: false },
  });
  assert.equal(edited.ok, true);
  const current = edited.ok ? edited.profile : assert.fail("edit");

  const { residentMarksBySession, pinnedResidentSessions } = await import("../src/web/residents/marker.ts");
  const { mkSession, mkTaskSummary } = await import("./helpers/session-fixture.ts");
  const liveSession = mkSession({ id: "s-live", task: mkTaskSummary({ id: first.result.taskId, kind: "resident" }) });
  const marks = residentMarksBySession([liveSession], h.registry.listResidentRuns(), [current]);
  const mark = marks.get("s-live")!;
  assert.equal(mark.colorId, "cyan", "the live run keeps the color it launched with");
  assert.equal(mark.label, "TB", "and the label its pinned revision derived from the name");
  assert.equal(mark.pin, true, "and stays pinned");
  assert.equal(mark.revision, 1);
  assert.equal(mark.changedTo, 2, "the profile's edit is only reported, never followed");
  assert.deepEqual([...pinnedResidentSessions(marks)], ["s-live"]);

  const second = await h.residents.launch(profile.id, { repoRoot: REPO, requestId: "req-after-edit" });
  if (!("result" in second) || second.result.state !== "launched") assert.fail(JSON.stringify(second));
  const nextSession = mkSession({ id: "s-next", task: mkTaskSummary({ id: second.result.taskId, kind: "resident" }) });
  const both = residentMarksBySession([liveSession, nextSession], h.registry.listResidentRuns(), [current]);
  assert.deepEqual(
    { colorId: both.get("s-next")!.colorId, label: both.get("s-next")!.label, pin: both.get("s-next")!.pin },
    { colorId: "violet", label: "DOC", pin: false },
  );
  assert.equal(both.get("s-next")!.changedTo, null);
  assert.deepEqual([...pinnedResidentSessions(both)], ["s-live"], "only the run whose pinned revision pins it sorts first");
});


test("unpriced capped models are refused at save and at launch", async () => {
  const h = harness();
  for (const agent of ["claude", "codex"] as const) {
    const unpriced = settings({ agent, name: `Unpriced ${agent}`, model: "unknown-new-model" });
    const refused = h.residents.createProfile(unpriced);
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.match(refused.error, /cannot be priced/);
    // An imported/old revision must pass the same check on launch, not just on save.
    const profile = store.createResidentProfile({ id: `unpriced-${agent}`, settings: unpriced, at: Date.now() });
    const launch = await h.residents.launch(profile.id, { repoRoot: REPO, requestId: `unpriced-${agent}` });
    assert.equal(launch.ok, false);
    if ("error" in launch) assert.match(launch.error, /cannot be priced/);
  }
  assert.deepEqual(h.dispatched, []);
});
