import assert from "node:assert/strict";
import { test } from "node:test";
import { PlanPublicationContextSchema, type PlanPublicationContext } from "../src/shared/plan-publication.ts";
import { taskCompletionContract } from "../src/shared/task-completion.ts";
import { withPlanPublicationGuard } from "../src/server/foreman/plan-publication.ts";
import { ForemanClient } from "../src/server/foreman/client.ts";

const bound: PlanPublicationContext = {
  owner: "workflow", bindingId: "b1", workflowVersionId: "v1", triggerMode: "foreman_complete",
};

test("a plan verifier's completed result survives only the same binding and version", async () => {
  const contract = taskCompletionContract("plan", bound.owner === "workflow");
  assert.ok(contract?.deferred.some((action) => action.id === "pull-request"));
  const verdict = { complete: true, summary: "Approved plan and phase tasks are ready; PR deferred", gaps: [] };
  let verified = 0;
  assert.equal(await withPlanPublicationGuard(bound, async () => { verified++; return verdict; }, async () => bound), verdict);
  assert.equal(verified, 1, "verify exactly once while the workflow is waiting for the plan");
  for (const changed of [
    { owner: "skill" }, { owner: "unavailable", reason: "manager offline" },
    { ...bound, bindingId: "replacement" }, { ...bound, workflowVersionId: "v2" },
    { ...bound, triggerMode: "manual" },
  ] as PlanPublicationContext[]) {
    assert.equal(await withPlanPublicationGuard(bound, async () => verdict, async () => changed), null);
  }
  assert.equal(await withPlanPublicationGuard(bound, async () => verdict, async () => { throw new Error("offline"); }), null);
});

test("unbound plans cannot use a stale complete result after workflow attachment", async () => {
  const unbound: PlanPublicationContext = { owner: "skill" };
  const complete = { complete: true };
  assert.equal(taskCompletionContract("plan", false), null);
  assert.equal(await withPlanPublicationGuard(unbound, async () => complete, async () => bound), null);
  assert.equal(await withPlanPublicationGuard(unbound, async () => complete, async () => unbound), complete);
  const incomplete = { complete: false, gaps: ["Human approval is missing"] };
  assert.equal(await withPlanPublicationGuard(bound, async () => incomplete, async () => bound), incomplete);
});

test("unavailable ownership does not spend a verifier call; other kinds do not read it", async () => {
  const never = async (): Promise<never> => { assert.fail("must not be called"); };
  assert.equal(await withPlanPublicationGuard({ owner: "unavailable", reason: "binding pending" }, never, never), null);
  assert.equal(await withPlanPublicationGuard(null, async () => "unchanged", never), "unchanged");
});

test("Foreman validates the context response instead of treating an older daemon as unbound", async () => {
  const original = globalThis.fetch;
  const client = new ForemanClient();
  try {
    for (const invalid of [{}, { owner: "skill", bindingId: "b1" }, { ...bound, triggerMode: "future" }]) {
      globalThis.fetch = async () => Response.json(invalid);
      await assert.rejects(client.planPublicationContext("session"));
    }
    globalThis.fetch = async (url) => {
      assert.match(String(url), /\/api\/sessions\/session\/plan-publication$/);
      return Response.json(bound);
    };
    assert.deepEqual(await client.planPublicationContext("session"), bound);
    assert.deepEqual(PlanPublicationContextSchema.parse({ owner: "skill" }), { owner: "skill" });
  } finally { globalThis.fetch = original; }
});
