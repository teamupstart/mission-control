import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerEvent, Session, SessionGoal } from "../src/shared/types.ts";

// POST /api/sessions/:id/goal/accept - a person's exit from a paused goal
// (docs/plans/foreman-stuck-goal-recovery/phase-3-accept-objective.md). The route's answers
// are a cross-phase contract: 404 without a goal, 409 without an objective, 200 with the full
// SessionGoal otherwise, idempotently. It confirms the objective and never rewrites it.

const home = mkdtempSync(join(tmpdir(), "mission-goal-accept-"));
process.env.MISSION_HOME = home;

const { openDb, readSessionGoalSteering } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { buildApp } = await import("../src/server/routes.ts");

type ReviewManager = import("../src/server/reviews.ts").ReviewManager;
type TaskManager = import("../src/server/tasks.ts").TaskManager;
type QueueManager = import("../src/server/queue.ts").QueueManager;

after(() => rmSync(home, { recursive: true, force: true }));

openDb();

const HEADERS = { host: "127.0.0.1:7317" };

function mkApp(registry: InstanceType<typeof Registry>): ReturnType<typeof buildApp> {
  return buildApp({
    registry,
    reviews: {} as ReviewManager,
    tasks: {} as TaskManager,
    queues: {} as QueueManager,
  });
}

function sdkSession(registry: InstanceType<typeof Registry>, name: string): Session {
  return registry.registerSdkSession({
    id: `sdk:${name}`,
    agent: "claude",
    name,
    cwd: `/wt/${name}`,
    agentSessionId: `agent:${name}`,
  });
}

/** Collect session_upsert emissions for one session id. */
function upserts(registry: InstanceType<typeof Registry>, id: string): Session[] {
  const seen: Session[] = [];
  registry.on("event", (e: ServerEvent) => {
    if (e.type === "session_upsert" && e.session.id === id) seen.push(e.session);
  });
  return seen;
}

const accept = (app: ReturnType<typeof buildApp>, id: string) =>
  app.request(`/api/sessions/${encodeURIComponent(id)}/goal/accept`, { method: "POST", headers: HEADERS });

test("404 for an unknown session and for a session with no goal", async () => {
  const registry = new Registry();
  const app = mkApp(registry);
  assert.equal((await accept(app, "sdk:no-such")).status, 404);
  const s = sdkSession(registry, "accept-no-goal");
  const res = await accept(app, s.id);
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "no goal for this session" });
});

test("409 for a goal with no objective, and nothing is written", async () => {
  const registry = new Registry();
  const app = mkApp(registry);
  const s = sdkSession(registry, "accept-no-objective");
  registry.upsertGoal(s.id, { promptRevision: 1, pendingPrompts: [{ revision: 1, prompt: null }] });
  const res = await accept(app, s.id);
  assert.equal(res.status, 409);
  assert.match(((await res.json()) as { error: string }).error, /no objective/);
  assert.equal(registry.getGoal(s.id)?.resolvedPromptRevision, 0);
});

test("200 resolves the pending instruction as steering, emits once, and is idempotent", async () => {
  const registry = new Registry();
  const app = mkApp(registry);
  const s = sdkSession(registry, "accept-ok");
  const key = "agent:accept-ok";
  registry.captureAcceptedPrompt(s.id, "ship the accept control", key);
  registry.resolveGoal(s.id, {
    objective: "Ship the accept control",
    text: "Ship the accept control",
    source: "model",
    relationship: "initial",
    rationale: "opening request",
    objectiveVersion: 1,
    resolvedPromptRevision: 1,
    pendingPrompts: [],
  }, "ship the accept control");
  registry.captureAcceptedPrompt(s.id, "also run the e2e spec", key);
  const before = registry.getGoal(s.id)!;
  assert.equal(before.resolvedPromptRevision, 1);
  assert.equal(before.promptRevision, 2);

  const seen = upserts(registry, s.id);
  const res = await accept(app, s.id);
  assert.equal(res.status, 200);
  const goal = (await res.json()) as SessionGoal;
  assert.equal(goal.relationship, "steer");
  assert.equal(goal.resolvedPromptRevision, goal.promptRevision);
  assert.deepEqual(goal.pendingPrompts, []);
  assert.match(goal.rationale ?? "", /^Accepted by you:/);
  assert.equal(goal.objective, before.objective);
  assert.equal(goal.objectiveVersion, before.objectiveVersion);
  assert.equal(goal.prompt, "also run the e2e spec", "the full record, prompt included");

  // The card learns through the stream that already owns it, exactly once.
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.goal?.relationship, "steer");
  assert.equal(seen[0]!.goal?.resolvedPromptRevision, 2);
  assert.equal(seen[0]!.goal?.promptRevision, 2);
  assert.equal(readSessionGoalSteering(key, 2).length, 1);

  const again = await accept(app, s.id);
  assert.equal(again.status, 200);
  assert.deepEqual(await again.json(), goal);
  assert.equal(seen.length, 1, "an idempotent accept changes nothing, so emits nothing");
  assert.equal(readSessionGoalSteering(key, 2).length, 1);
});
