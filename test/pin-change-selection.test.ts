import assert from "node:assert/strict";
import test from "node:test";
import type { TaskDependency } from "../src/shared/types.ts";
import type { TaskWorkEpisodeBinding } from "../src/server/db.ts";
import { planInputEdgesForOrigin, selectPinChangeDependencies } from "../src/server/plans/pin-change.ts";

type Selection = Parameters<typeof selectPinChangeDependencies>[0];
const from: Selection["from"] = {
  input: { repoKey: "repo", planId: "old-plan", revision: 1, files: ["plan.md"] },
  origin: { task_id: "old-task", session_id: "old-session", episode_id: "old-episode" },
};
const to: Selection["to"] = {
  input: { repoKey: "repo", planId: "new-plan", revision: 2, files: ["implementation.md"] },
  origin: { task_id: "new-task", session_id: "new-session", episode_id: "new-episode" },
};
const source: NonNullable<Selection["source"]> = {
  id: "new-task", title: "Replacement origin", kind: "ship",
  planPolicy: { version: 2, storage: "local", commitPlanHtml: false },
};
const binding: TaskWorkEpisodeBinding = {
  taskId: "new-task", sessionId: "new-session", episodeId: "new-episode", agentSessionId: "agent",
  branch: "replacement", prUrl: "https://github.com/example/repo/pull/2", prHeadSha: null,
  mergedAt: 20, boundAt: 10, updatedAt: 20,
};
function edge(pin = from): Extract<TaskDependency, { type: "task" }> {
  return { type: "task", taskId: pin.origin.task_id!, title: "Origin", sessionId: pin.origin.session_id,
    episodeId: pin.origin.episode_id, agentSessionId: "agent", branch: null, prUrl: null,
    selectedAt: 1, satisfiedAt: null };
}
function select(overrides: Partial<Selection> = {}) {
  return selectPinChangeDependencies({ current: [edge()], from, to, remainingPins: [to],
    storage: "repository", published: false, source, bindings: [], now: 30, ...overrides });
}

test("replacing an origin removes only its unused edges and preserves unrelated edge details", () => {
  const unrelated: TaskDependency = { ...edge(), taskId: "implementation", mode: "stack", satisfiedAt: 8 };
  const current = [edge(), unrelated];
  const before = structuredClone(current);
  const selected = select({ current });
  assert.deepEqual(selected.dependencies, [unrelated]);
  assert.equal(selected.dependencies[0], unrelated);
  assert.deepEqual(selected.addition, { type: "task", taskId: "new-task" });
  assert.deepEqual(current, before, "selection does not mutate the saved dependency list");
});

test("another pin retains its shared origin and an existing replacement retains merge proof", () => {
  const old = edge();
  const replacement = { ...edge(to), prUrl: binding.prUrl, satisfiedAt: 20 };
  const selected = select({ current: [old, replacement], remainingPins: [to, from] });
  assert.deepEqual(selected.dependencies, [old, replacement]);
  assert.equal(selected.dependencies[1], replacement);
  assert.equal(selected.addition, null);
  assert.equal(selected.mergeCandidate, null);
});

test("only a local plan-only source selects an artifact prerequisite", () => {
  assert.deepEqual(select({ storage: "local", source: { ...source, kind: "plan" } }).addition,
    { type: "plan", repoKey: "repo", planId: "new-plan", revision: 2 });
  for (const overrides of [
    { storage: "local", source },
    { storage: "repository", source: { ...source, kind: "plan" } },
    { storage: "local", source: { ...source, kind: "plan", planPolicy: { storage: "repository", commitPlanHtml: false } } },
  ] satisfies Partial<Selection>[]) {
    assert.deepEqual(select(overrides).addition, { type: "task", taskId: "new-task" });
  }
  const sessionPin = { ...to, origin: { ...to.origin, task_id: null } };
  assert.deepEqual(select({ to: sessionPin, remainingPins: [sessionPin], source: null }).addition,
    { type: "session", sessionId: "new-session" });
});

test("a published replacement needs no new edge, while another pin still retains its origin", () => {
  assert.deepEqual(select({ published: true }).dependencies, []);
  const selected = select({ published: true, remainingPins: [to, from] });
  assert.deepEqual(selected.dependencies, [edge()]);
  assert.equal(selected.addition, null);
  assert.equal(selected.mergeCandidate, null);
});

test("merge lookup candidates require the exact task, session, and work episode and remain unsatisfied", () => {
  const otherBindings = [
    { ...binding, episodeId: "earlier-episode" },
    { ...binding, sessionId: "other-session" },
    { ...binding, taskId: "other-task" },
  ];
  assert.equal(select({ bindings: otherBindings }).mergeCandidate, null);
  const selected = select({ bindings: [...otherBindings, binding] });
  assert.deepEqual(selected.dependencies, [], "a binding alone does not add a satisfied prerequisite");
  assert.deepEqual(selected.mergeCandidate, {
    edge: { ...edge(to), title: source.title, branch: binding.branch, prUrl: binding.prUrl, selectedAt: 30 },
    mergedAt: 20,
  });
  const unmerged = select({ bindings: [{ ...binding, mergedAt: null, prUrl: null }] });
  assert.equal(unmerged.mergeCandidate!.edge.satisfiedAt, null);
  assert.equal(unmerged.mergeCandidate!.mergedAt, null);
});

test("a shared old episode cannot silently be replaced by another episode of the same task", () => {
  const nextEpisode = { ...to, origin: { ...to.origin, task_id: from.origin.task_id } };
  const selected = select({ to: nextEpisode, remainingPins: [nextEpisode, from],
    source: { ...source, id: "old-task" }, bindings: [{ ...binding, taskId: "old-task" }] });
  assert.deepEqual(selected.dependencies, [edge()]);
  assert.deepEqual(selected.addition, { type: "task", taskId: "old-task" });
  assert.equal(selected.mergeCandidate, null, "existing validation must refuse incompatible episodes instead of replacing the shared edge");
});

test("exact-origin matching keeps artifact identity and bare-session ownership distinct", () => {
  const artifact: TaskDependency = { type: "plan", repoKey: "repo", planId: "old-plan", revision: 1,
    title: "Plan publication", selectedAt: 1, satisfiedAt: null,
    sessionId: null, episodeId: null, agentSessionId: null, branch: null, prUrl: null };
  const wrongRevision = { ...artifact, revision: 2 };
  const wrongRepo = { ...artifact, repoKey: "another-repo" };
  const session: TaskDependency = { ...edge(), type: "session", sessionId: "old-session" };
  assert.deepEqual(planInputEdgesForOrigin(from.input, from.origin, [artifact, wrongRevision, wrongRepo, session]), [artifact]);
  assert.deepEqual(planInputEdgesForOrigin(from.input, { ...from.origin, task_id: null }, [session]), [session]);
});
