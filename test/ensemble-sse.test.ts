import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EnsembleSummary } from "../src/shared/ensemble.ts";
import type { ServerEvent } from "../src/shared/types.ts";

/**
 * What is at stake: ensembles are SSE state, not a second polling subsystem, and the
 * collection has to stay COMPACT. Three things are pinned here:
 *
 *  1. A reconnect snapshot and the incremental upsert stream converge on the same catalog -
 *     the failure otherwise is a dashboard that is right until you reload it, or right only
 *     after you reload it.
 *  2. Nothing large rides on the live channel. Members, plans, artifacts and evaluations are
 *     HTTP reads; a summary that carried a compiled plan would grow without bound as a later
 *     strategy adds stages and pairwise evaluations.
 *  3. A member's task is named on the NESTED task summary. Putting it on `Session` would need
 *     its own comparator and would be a second denormalized copy of group state.
 */

const home = mkdtempSync(join(tmpdir(), "mission-ensemble-sse-"));
process.env.HARNESS_HOME = join(home, "state");

const { openDb } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { EnsembleManager } = await import("../src/server/ensembles/manager.ts");
const { EnsembleStore, clearEnsembleTables } = await import("../src/server/ensembles/store.ts");

const db = openDb();
after(() => rmSync(home, { recursive: true, force: true }));
beforeEach(() => clearEnsembleTables(db));

const request = {
  sourceKey: "manual:sse-1",
  sourceKind: "manual" as const,
  sourceId: null,
  title: "Try three approaches",
  intent: "Implement the feature",
  repoRoot: "/repo",
  strategyId: "best_of_n" as const,
  strategyConfig: { members: [{}, {}] },
};

test("snapshot, upsert, remove and reconnect produce one equivalent ensemble catalog", () => {
  const registry = new Registry();
  const store = new EnsembleStore(db);
  const manager = new EnsembleManager(registry, store);
  assert.deepEqual(registry.snapshot().ensembleSummaries, []);
  const empty = { type: "snapshot", ...registry.snapshot() } satisfies ServerEvent;
  assert.deepEqual(empty.ensembleSummaries, []);

  const events: ServerEvent[] = [];
  const unsubscribe = registry.subscribe((event) => events.push(event));
  const created = manager.create(request, 100);
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.equal(manager.remove(created.run.id), true);
  unsubscribe();

  assert.deepEqual(
    events.map((event) => event.type),
    ["ensemble_upsert", "ensemble_remove"],
  );

  const reduced = new Map<string, EnsembleSummary>();
  for (const event of events) {
    if (event.type === "ensemble_upsert") reduced.set(event.ensemble.id, event.ensemble);
    if (event.type === "ensemble_remove") reduced.delete(event.id);
  }
  assert.deepEqual([...reduced.values()], registry.snapshot().ensembleSummaries);

  // A browser that reconnects after the fact must land on the same catalog as one that
  // watched every event go past.
  const reconnect = new Registry();
  new EnsembleManager(reconnect, new EnsembleStore(db));
  assert.deepEqual(reconnect.snapshot().ensembleSummaries, registry.snapshot().ensembleSummaries);
});

test("a run persisted before this process started is in the first snapshot", () => {
  const seed = new EnsembleManager(new Registry(), new EnsembleStore(db));
  const created = seed.create(request, 100);
  assert.equal(created.ok, true);

  const registry = new Registry();
  new EnsembleManager(registry, new EnsembleStore(db));
  const summaries = registry.snapshot().ensembleSummaries;
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0]?.title, "Try three approaches");
  assert.equal(summaries[0]?.status, "planning");
});

test("the live channel carries a compact summary and nothing a detail read owns", () => {
  const registry = new Registry();
  const manager = new EnsembleManager(registry, new EnsembleStore(db));
  const events: ServerEvent[] = [];
  registry.subscribe((event) => events.push(event));
  const created = manager.create(request, 100);
  assert.equal(created.ok, true);

  const upsert = events.find((event) => event.type === "ensemble_upsert");
  assert.ok(upsert && upsert.type === "ensemble_upsert");
  assert.deepEqual(Object.keys(upsert.ensemble).sort(), [
    "activeStageId",
    "attention",
    "completedAt",
    "createdAt",
    "error",
    "id",
    "launchedMembers",
    "maxMembers",
    "memberCount",
    "outcomeKind",
    "readyArtifacts",
    "repoRoot",
    "selectedMemberId",
    "status",
    "strategyId",
    "strategyKey",
    "strategyLabel",
    "strategyVersion",
    "title",
    "unreadable",
    "updatedAt",
  ]);
  // The plan, the intent, the roster and every prompt stay off the wire.
  const serialized = JSON.stringify(upsert.ensemble);
  assert.doesNotMatch(serialized, /promptTemplate/);
  assert.doesNotMatch(serialized, /candidate-1/);
  assert.doesNotMatch(serialized, /Implement the feature/);
});

test("an idempotent create republishes the same run rather than adding a second card", () => {
  const registry = new Registry();
  const manager = new EnsembleManager(registry, new EnsembleStore(db));
  const first = manager.create(request, 100);
  const retry = manager.create(request, 200);
  assert.equal(first.ok && retry.ok, true);
  if (!first.ok || !retry.ok) return;
  assert.equal(retry.created, false);
  assert.equal(retry.run.id, first.run.id);
  assert.equal(registry.snapshot().ensembleSummaries.length, 1);
});

test("a create the strategy refuses persists nothing and publishes nothing", () => {
  const registry = new Registry();
  const manager = new EnsembleManager(registry, new EnsembleStore(db));
  const events: ServerEvent[] = [];
  registry.subscribe((event) => events.push(event));

  const oneCandidate = manager.create({ ...request, strategyConfig: { members: [{}] } }, 100);
  assert.equal(oneCandidate.ok, false);
  if (!oneCandidate.ok) assert.equal(oneCandidate.reason, "invalid_config");

  const unknown = manager.create({ ...request, strategyId: "tournament" as never }, 100);
  assert.equal(unknown.ok, false);

  const wrongVersion = manager.create({ ...request, strategyVersion: 99 }, 100);
  assert.equal(wrongVersion.ok, false);
  if (!wrongVersion.ok) assert.equal(wrongVersion.reason, "version_unavailable");

  assert.deepEqual(events, []);
  assert.deepEqual(registry.snapshot().ensembleSummaries, []);
});

test("a session's task summary names its ensemble member, and no Session field does", () => {
  const registry = new Registry();
  const store = new EnsembleStore(db);
  const manager = new EnsembleManager(registry, store);
  const created = manager.create(request, 100);
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const members = store.listMembers(created.run.id);
  store.setMemberStatus(members[0]!.id, ["pending"], "active", { taskId: "task-1", resultLabel: "rank 1" });
  // Registered rather than imported: the registry knows nothing about ensembles, and the
  // manager hands it one lookup.
  registry.registerEnsembleProjection((taskId) => store.taskLink(taskId));

  assert.deepEqual(store.taskLink("task-1"), {
    runId: created.run.id,
    strategyId: "best_of_n",
    strategyLabel: "Best of N",
    memberId: members[0]!.id,
    ordinal: 1,
    wave: 1,
    role: "candidate-1",
    launchedMembers: 1,
    maxMembers: 2,
    status: "active",
    resultLabel: "rank 1",
  });
  assert.equal(store.taskLink("task-unrelated"), null);
});
