import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type { WorkflowDefinition, WorkflowVersion, WorkflowVersionMetadata } from "../src/shared/workflow.ts";

const home = mkdtempSync(join(tmpdir(), "mission-builtin-round-limit-"));
process.env.HARNESS_HOME = join(home, "state");

const { openDb } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { WorkflowStore, clearWorkflowTables } = await import("../src/server/workflows/store.ts");
const { PersonaManager } = await import("../src/server/workflows/personas.ts");
const { WorkflowManager } = await import("../src/server/workflows/manager.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { BUILTIN_WORKFLOWS } = await import("../src/server/workflows/builtin-workflows.ts");
const { NO_MISTAKES_REVIEW_WORKFLOW_ID } = await import("../src/shared/builtin-workflow.ts");
const { WORKFLOW_LIMITS } = await import("../src/shared/workflow.ts");

const db = openDb();
after(() => rmSync(home, { recursive: true, force: true }));

const shipped = BUILTIN_WORKFLOWS.find((builtin) => builtin.definition.id === NO_MISTAKES_REVIEW_WORKFLOW_ID)!;
const SHIPPED_ROUNDS = shipped.definition.bindingDefaults.maxRepairRounds;

function fixture() {
  clearWorkflowTables(db);
  const registry = new Registry();
  const store = new WorkflowStore(db);
  const personas = new PersonaManager(registry, store);
  const workflows = new WorkflowManager(registry, store);
  const app = buildApp({
    registry,
    reviews: null as never,
    tasks: null as never,
    queues: null as never,
    personas,
    workflows,
  });
  const request = (path: string, init?: RequestInit) => app.request(path, {
    ...init,
    headers: { host: "127.0.0.1:7317", "content-type": "application/json", ...init?.headers },
  });
  const putRounds = (id: string, body: unknown) => request(`/api/workflows/${id}/round-limit`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
  return { request, putRounds, registry, store, workflows };
}

/** Everything about a built-in except the round budget, which is the one field allowed to move. */
function withoutRounds<T extends { bindingDefaults: { maxRepairRounds: number } }>(item: T) {
  const { maxRepairRounds: _rounds, ...bindingDefaults } = item.bindingDefaults;
  const { updatedAt: _updatedAt, shippedMaxRepairRounds: _shipped, ...rest } = item as T & {
    updatedAt?: number;
    shippedMaxRepairRounds?: number;
  };
  return { ...rest, bindingDefaults };
}

test("an unchanged built-in reads exactly as shipped", () => {
  const { store } = fixture();
  assert.deepEqual(store.getWorkflow(NO_MISTAKES_REVIEW_WORKFLOW_ID), shipped.definition);
  assert.equal(store.getWorkflow(NO_MISTAKES_REVIEW_WORKFLOW_ID)?.shippedMaxRepairRounds, undefined);
  assert.deepEqual(
    store.listWorkflowVersions(NO_MISTAKES_REVIEW_WORKFLOW_ID),
    [...shipped.versions].reverse(),
  );
});

test("a built-in's round limit reaches its definition and every version, and nothing else moves", () => {
  const { store } = fixture();
  const result = store.setBuiltinRoundLimit(NO_MISTAKES_REVIEW_WORKFLOW_ID, 9, 1_000);
  assert.equal(result.ok, true);

  const definition = store.getWorkflow(NO_MISTAKES_REVIEW_WORKFLOW_ID)!;
  assert.equal(definition.bindingDefaults.maxRepairRounds, 9);
  assert.equal(definition.shippedMaxRepairRounds, SHIPPED_ROUNDS);
  assert.equal(definition.updatedAt, 1_000);
  assert.deepEqual(withoutRounds(definition), withoutRounds(shipped.definition));
  assert.equal(
    store.listWorkflows().find((workflow) => workflow.id === NO_MISTAKES_REVIEW_WORKFLOW_ID)
      ?.bindingDefaults.maxRepairRounds,
    9,
  );

  for (const version of shipped.versions) {
    for (const read of [
      store.getWorkflowVersionById(version.id),
      store.getWorkflowVersion(NO_MISTAKES_REVIEW_WORKFLOW_ID, version.version),
      store.listWorkflowVersions(NO_MISTAKES_REVIEW_WORKFLOW_ID).find((item) => item.id === version.id),
    ]) {
      assert.ok(read, `version ${version.version} still resolves`);
      assert.equal(read.bindingDefaults.maxRepairRounds, 9);
      // Graph, completion, resumption, evidence policy, trigger and delivery are as shipped.
      assert.deepEqual(withoutRounds(read), withoutRounds(version));
    }
  }

  // Other built-ins keep their own shipped value.
  for (const other of BUILTIN_WORKFLOWS.filter((builtin) => builtin !== shipped)) {
    assert.deepEqual(store.getWorkflow(other.definition.id), other.definition);
  }
});

test("null or the shipped value restores the shipped built-in", () => {
  const { store } = fixture();
  store.setBuiltinRoundLimit(NO_MISTAKES_REVIEW_WORKFLOW_ID, 12, 1_000);
  const reset = store.setBuiltinRoundLimit(NO_MISTAKES_REVIEW_WORKFLOW_ID, null, 2_000);
  assert.equal(reset.ok, true);
  assert.equal(reset.ok && reset.workflow.updatedAt, 2_000, "a reset still dates the change it made");
  assert.deepEqual(store.getWorkflow(NO_MISTAKES_REVIEW_WORKFLOW_ID), shipped.definition);

  store.setBuiltinRoundLimit(NO_MISTAKES_REVIEW_WORKFLOW_ID, 12, 3_000);
  store.setBuiltinRoundLimit(NO_MISTAKES_REVIEW_WORKFLOW_ID, SHIPPED_ROUNDS, 4_000);
  assert.deepEqual(store.getWorkflow(NO_MISTAKES_REVIEW_WORKFLOW_ID), shipped.definition);
  assert.equal(
    db.prepare(`SELECT COUNT(*) AS n FROM workflow_builtin_round_limits`).get()?.n,
    0,
    "the shipped value is stored as no row, so a later build's default is followed",
  );
});

test("an unreadable round limit row reads as the shipped value", () => {
  const { store } = fixture();
  db.prepare(
    `INSERT INTO workflow_builtin_round_limits (workflow_id, max_repair_rounds, updated_at) VALUES (?, 99, 1)`,
  ).run(NO_MISTAKES_REVIEW_WORKFLOW_ID);
  assert.deepEqual(store.getWorkflow(NO_MISTAKES_REVIEW_WORKFLOW_ID), shipped.definition);
});

test("the round-limit route saves a built-in's rounds and refuses everything else", async () => {
  const { request, putRounds } = fixture();

  const saved = await putRounds(NO_MISTAKES_REVIEW_WORKFLOW_ID, { maxRepairRounds: 8 });
  assert.equal(saved.status, 200);
  const body = await saved.json() as { workflow: WorkflowDefinition; summary: { id: string } };
  assert.equal(body.workflow.bindingDefaults.maxRepairRounds, 8);
  assert.equal(body.workflow.shippedMaxRepairRounds, SHIPPED_ROUNDS);
  assert.equal(body.summary.id, NO_MISTAKES_REVIEW_WORKFLOW_ID);

  const detail = await (await request(`/api/workflows/${NO_MISTAKES_REVIEW_WORKFLOW_ID}`)).json() as {
    workflow: WorkflowDefinition;
    versions: WorkflowVersionMetadata[];
  };
  assert.equal(detail.workflow.bindingDefaults.maxRepairRounds, 8);
  assert.ok(detail.versions.every((version) => version.bindingDefaults.maxRepairRounds === 8));

  // The schema is the whole of what may change: any other field is refused, not ignored.
  for (const bad of [
    { maxRepairRounds: 8, triggerMode: "manual" },
    { maxRepairRounds: 8, bindingDefaults: { deliveryMode: "preview" } },
    { maxRepairRounds: 0 },
    { maxRepairRounds: 21 },
    { maxRepairRounds: 2.5 },
    {},
  ]) {
    assert.equal((await putRounds(NO_MISTAKES_REVIEW_WORKFLOW_ID, bad)).status, 400, JSON.stringify(bad));
  }

  // The draft route still refuses a built-in, rounds included.
  const patched = await request(`/api/workflows/${NO_MISTAKES_REVIEW_WORKFLOW_ID}`, {
    method: "PATCH",
    body: JSON.stringify({
      expectedDraftRevision: detail.workflow.draftRevision,
      bindingDefaults: { ...detail.workflow.bindingDefaults, maxRepairRounds: 3 },
    }),
  });
  assert.equal(patched.status, 409);
  assert.equal((await patched.json() as { code: string }).code, "workflow_builtin");

  const reset = await putRounds(NO_MISTAKES_REVIEW_WORKFLOW_ID, { maxRepairRounds: null });
  assert.equal(reset.status, 200);
  const resetBody = await reset.json() as { workflow: WorkflowDefinition };
  assert.equal(resetBody.workflow.bindingDefaults.maxRepairRounds, SHIPPED_ROUNDS);
  assert.equal(resetBody.workflow.shippedMaxRepairRounds, undefined);
});

test("the round-limit route is for built-ins only", async () => {
  const { request, putRounds } = fixture();
  const created = await (await request("/api/workflows", {
    method: "POST",
    body: JSON.stringify({ name: "Mine" }),
  })).json() as { workflow: { id: string } };
  const mine = await putRounds(created.workflow.id, { maxRepairRounds: 8 });
  assert.equal(mine.status, 409);
  const body = await mine.json() as { code: string; error: string };
  assert.equal(body.code, "workflow_not_builtin");
  assert.match(body.error, /edit this workflow's draft/);
  assert.equal((await putRounds("no-such-workflow", { maxRepairRounds: 8 })).status, 404);
});

test("a new binding of a built-in starts from the saved rounds; an existing one keeps its own", () => {
  const { registry, workflows } = fixture();
  const session = (id: string): DiscoveredSession => ({
    syntheticId: id, agent: "claude", name: id, nameSource: "process",
    cwd: `/repo-${id}`, gitBranch: "feature", gitRoot: `/repo-${id}`, repoRoot: `/repo-${id}`,
    pid: 1, tty: `tty-${id}`, terminals: [], startedAt: 1,
  } as DiscoveredSession);
  registry.applyDiscovery([session("before"), session("after")]);
  const versionId = shipped.definition.currentVersionId!;
  const bind = (sessionId: string) => workflows.createBinding({
    workflowVersionId: versionId,
    sessionId,
    triggerMode: "manual",
    deliveryMode: "preview",
  });

  const before = bind("before");
  assert.equal(before.ok, true);
  assert.equal(before.ok && before.value.maxRepairRounds, SHIPPED_ROUNDS);

  const saved = workflows.setBuiltinRoundLimit(NO_MISTAKES_REVIEW_WORKFLOW_ID, 11);
  assert.equal(saved.ok, true);
  const version: WorkflowVersion | null = workflows.store.getWorkflowVersionById(versionId);
  assert.equal(version?.bindingDefaults.maxRepairRounds, 11);

  const later = bind("after");
  assert.equal(later.ok, true);
  assert.equal(later.ok && later.value.maxRepairRounds, 11);
  assert.equal(
    before.ok && workflows.store.getBinding(before.value.id)?.maxRepairRounds,
    SHIPPED_ROUNDS,
    "a binding copies its budget when it is created",
  );
});

test("every shipped built-in saves and reads back its own rounds, at both accepted endpoints", async () => {
  const { putRounds, request } = fixture();
  assert.ok(BUILTIN_WORKFLOWS.length > 1, "the catalog ships more than one built-in");
  for (const builtin of BUILTIN_WORKFLOWS) {
    const id = builtin.definition.id;
    const shippedRounds = builtin.definition.bindingDefaults.maxRepairRounds;
    for (const rounds of [WORKFLOW_LIMITS.repairRoundsMin, WORKFLOW_LIMITS.repairRoundsMax]) {
      const saved = await putRounds(id, { maxRepairRounds: rounds });
      assert.equal(saved.status, 200, `${builtin.definition.name} accepts ${rounds}`);
      const detail = await (await request(`/api/workflows/${encodeURIComponent(id)}`)).json() as {
        workflow: WorkflowDefinition;
        versions: WorkflowVersionMetadata[];
      };
      assert.equal(detail.workflow.bindingDefaults.maxRepairRounds, rounds, `${builtin.definition.name} reads back ${rounds}`);
      assert.equal(detail.workflow.shippedMaxRepairRounds, rounds === shippedRounds ? undefined : shippedRounds);
      assert.ok(
        detail.versions.every((version) => version.bindingDefaults.maxRepairRounds === rounds),
        `every version of ${builtin.definition.name} carries ${rounds}`,
      );
      assert.equal(
        db.prepare(`SELECT max_repair_rounds AS n FROM workflow_builtin_round_limits WHERE workflow_id = ?`)
          .get(id)?.n ?? shippedRounds,
        rounds,
        `${builtin.definition.name} persisted ${rounds}`,
      );
    }
  }
  // Each built-in kept its own value: the last save for every one of them was the maximum.
  for (const builtin of BUILTIN_WORKFLOWS) {
    const detail = await (await request(`/api/workflows/${encodeURIComponent(builtin.definition.id)}`)).json() as {
      workflow: WorkflowDefinition;
    };
    assert.equal(detail.workflow.bindingDefaults.maxRepairRounds, WORKFLOW_LIMITS.repairRoundsMax);
  }
});
