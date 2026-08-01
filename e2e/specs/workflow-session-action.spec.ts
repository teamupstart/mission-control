import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * A session action node, drawn by the real builder against a real daemon.
 *
 * This phase ships the durable representation and deliberately no authoring surface: nothing
 * can execute an action yet, so the palette offers none and Publish refuses a graph that
 * contains one. That combination is exactly what no other layer can check. The SSR render
 * tests assert markup for a hand-built props object, and the HTTP tests assert routes against
 * an in-process app - neither one proves that a draft saved through `PATCH /api/workflows/:id`
 * survives the daemon's Zod boundary, reaches the browser over SSE, and paints as a stage
 * whose Publish button is off for a reason the operator can read.
 *
 * The scenario is the only way an action node can exist in this build: authored through the
 * raw draft API, since the builder has no control that makes one. That is the shape an
 * operator could hit, so it is the shape this drives.
 */

/** Ids this spec authors into the draft, so DOM and API assertions can name exact nodes. */
const NODE = { action: "action-node", session: "session-node", end: "end-node" };

async function api<T>(daemon: DaemonHandle, path: string, body?: unknown, method?: string): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as T;
}

/** A saved draft whose single stage is the shipped Pull Request action. */
async function seedActionDraft(daemon: DaemonHandle): Promise<string> {
  const created = await api<{ workflow: { id: string } }>(daemon, "/api/workflows", {
    // Named without the words the palette assertion below searches for, so a workflow in
    // the library list beside the palette cannot satisfy that assertion by accident.
    name: "E2E ship it",
    description: "One session action between Session and End",
  });
  const id = created.workflow.id;
  await api(
    daemon,
    `/api/workflows/${id}`,
    {
      expectedDraftRevision: 1,
      draft: {
        nodes: [
          { id: NODE.session, kind: "session", position: { x: 60, y: 60 } },
          {
            id: NODE.action,
            kind: "session_action",
            // The shipped built-in, addressable by its stable compiled id and never a row.
            sessionActionId: "builtin:pull-request",
            position: { x: 340, y: 60 },
          },
          { id: NODE.end, kind: "end", outcome: "Complete", position: { x: 620, y: 60 } },
        ],
        edges: [
          { id: "e-submit", source: NODE.session, sourcePort: "submitted", target: NODE.action, targetPort: "activate" },
          { id: "e-complete", source: NODE.action, sourcePort: "complete", target: NODE.end, targetPort: "terminal" },
        ],
      },
    },
    "PATCH",
  );
  return id;
}

test("the Pipeline draws a session action stage, and says why it cannot be published", async ({
  dashboard,
  daemon,
}) => {
  await seedActionDraft(daemon);
  await dashboard.goto(`${daemon.baseURL}/#/workflows`);
  await dashboard.getByRole("button", { name: /E2E ship it/ }).click();

  const pipeline = dashboard.locator(".wf-pipeline-strip");
  const row = pipeline.locator("li.wf-pipeline-reviewer");

  // The action names ITSELF from the catalog that arrived over SSE - not an id, and not
  // "Missing session action", which is what a broken catalog wire would produce.
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("Pull Request");
  // The badge separates it from the reviewers it sits among; it does the opposite of review.
  await expect(row).toContainText("Session action");
  // What the runtime will require, stated as the thing it PROVES rather than an adapter id.
  await expect(row).toContainText("Skill · pull-request");
  await expect(row).toContainText("Completes when a pull request is opened and verified");
  // The whole route, seam by seam: Session submits into the action, and the action emits
  // `complete` - never `pass`, because everything downstream of it reads NEW evidence.
  // Asserted on the seams' own elements, because "Completes when..." in the row above would
  // satisfy a substring match on the strip and prove nothing about the route.
  await expect(pipeline.locator(".wf-pipeline-gate")).toHaveText(["submitted", "complete"]);
  await expect(pipeline).toContainText("later stages review new evidence");

  // Publish is OFF, and the reason is in the same panel rather than behind a 409.
  await expect(dashboard.getByRole("button", { name: "Publish" })).toBeDisabled();
  await expect(dashboard.locator(".workflow-validation")).toContainText(
    "This build cannot run a session action yet, so a workflow containing one cannot be published.",
  );

  // No id may reach the screen. The whole builder migration exists to stop that.
  await expect(pipeline).not.toContainText(NODE.action);
  await expect(pipeline).not.toContainText("builtin:pull-request");
});

test("the action stage offers no authoring control this build cannot honour", async ({
  dashboard,
  daemon,
}) => {
  await seedActionDraft(daemon);
  await dashboard.goto(`${daemon.baseURL}/#/workflows`);
  await dashboard.getByRole("button", { name: /E2E ship it/ }).click();

  const pipeline = dashboard.locator(".wf-pipeline-strip");
  // An action runs ALONE, so the add picker is absent rather than disabled: a control
  // listing four reviewers and refusing every one of them reads as a bug, not as a rule.
  await expect(
    pipeline.getByLabel("Add a reviewer or check to Stage 1"),
  ).toHaveCount(0);
  // And no Remove on the stage: this build has no half of an authoring loop to offer.
  await expect(pipeline.getByRole("button", { name: "Remove Stage 1" })).toHaveCount(0);

  // The Graph palette cannot create one either - it offers exactly the four it always did.
  await dashboard.getByRole("button", { name: "Graph" }).click();
  // Scoped to the palette SECTION, not the complementary that also holds the workflow list.
  const palette = dashboard.locator("section.workflow-palette");
  await expect(palette.getByRole("button", { name: "＋ Persona" })).toBeVisible();
  await expect(palette.getByRole("button")).toHaveText([
    "＋ Persona",
    "＋ All-pass Join",
    "＋ Check",
    "＋ End",
  ]);
});

test("the Graph draws the node with one complete port, and the daemon refuses to publish it", async ({
  dashboard,
  daemon,
}) => {
  const workflowId = await seedActionDraft(daemon);
  await dashboard.goto(`${daemon.baseURL}/#/workflows`);
  await dashboard.getByRole("button", { name: /E2E ship it/ }).click();
  await dashboard.getByRole("button", { name: "Graph" }).click();

  const node = dashboard.locator('[data-node-kind="session_action"]');
  await expect(node).toHaveCount(1);
  await expect(node).toContainText("Pull Request");
  // ONE source port. A `fail` handle here would invite a route back to Session for what is
  // a delivery problem, and a `pass` handle would let a Join read it as a favourable verdict.
  await expect(node.getByLabel("Complete output")).toHaveCount(1);
  await expect(node.getByLabel("Fail output")).toHaveCount(0);
  await expect(node.getByLabel("Pass output")).toHaveCount(0);
  await expect(node.getByLabel("Activate input")).toHaveCount(1);

  // Selecting it opens a read-only rail with NO affordance for the node: nothing to
  // configure it with, and no Delete to remove it. Half an authoring loop is still
  // authoring, and this node can only have arrived through the raw draft API.
  await node.click();
  const rail = dashboard.getByRole("complementary", { name: "Workflow properties and validation" });
  await expect(rail).toContainText("Pull Request");
  await expect(rail).toContainText("Requires the pull-request skill");
  await expect(rail.getByRole("button", { name: "Delete node" })).toHaveCount(0);

  // The rail names the route by its real port rather than folding it into pass.
  await expect(dashboard.getByRole("region", { name: "Workflow connections" }))
    .toContainText("Pull Request (complete) → Complete (terminal)");

  // And the durable answer behind the disabled button: publish is refused by the SERVER,
  // with the diagnostic the panel is showing, and no version is minted.
  const refused = await fetch(`${daemon.baseURL}/api/workflows/${workflowId}/publish`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedDraftRevision: 2 }),
  });
  expect(refused.status).toBe(422);
  const body = (await refused.json()) as { diagnostics: Array<{ code: string; nodeId?: string }> };
  expect(body.diagnostics.some((item) =>
    item.code === "session_action_runtime_unavailable" && item.nodeId === NODE.action)).toBe(true);

  const versions = await api<unknown[]>(daemon, `/api/workflows/${workflowId}/versions`);
  expect(versions).toEqual([]);
});
