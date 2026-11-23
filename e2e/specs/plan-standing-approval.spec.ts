import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import type { ManagedPlanRevision } from "../../src/shared/managed-plans.ts";

const evidence = artifactsDir("plan-standing-approval");

test("approve all future bundles for this task approves later bundles without prompting and logs them", async ({ dashboard, daemon }) => {
  const config = await fetch(`${daemon.baseURL}/api/skills/config`, { method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ planStorage: "local", enabled: true, skills: { "html-plans": true } }) });
  expect(config.ok).toBe(true);
  await dashboard.goto(`${daemon.baseURL}/#/fleet`);
  await dashboard.getByRole("button", { name: "Dispatch", exact: true }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo); await dashboard.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill("Plan a documentation update");
  await dialog.getByRole("combobox", { name: "Kind", exact: true }).selectOption("plan");
  await dialog.getByRole("combobox", { name: "After work", exact: true }).selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click(); await expect(dialog).toBeHidden();
  let session!: { id: string; cwd: string; agentSessionId: string | null; state: string };
  await expect.poll(async () => { const snapshot = await (await fetch(`${daemon.baseURL}/api/sessions`)).json(); session = snapshot.sessions?.[0] ?? snapshot[0]; return Boolean(session?.agentSessionId && session.state === "idle"); }).toBe(true);

  const token = readFileSync(join(daemon.home, "token"), "utf8").trim();
  const post = (route: string, body: object) => fetch(`${daemon.baseURL}${route}`, { method: "POST", headers: { "content-type": "application/json", "x-harness-token": token }, body: JSON.stringify({ env: {}, sessionId: session.id, cwd: session.cwd, ...body }) });
  const save = async (expectedRevision: number, heading: string, planId?: string) => {
    const response = await post("/mcp/plans/save", { repoSlot: "repo-01", slug: "documentation", planId, requestId: randomUUID(), expectedRevision, files: [
      { name: "plan.md", content: `# ${heading}` }, { name: "plan.html", content: `<h1>${heading}</h1>` },
    ] });
    expect(response.status, await response.clone().text()).toBe(200);
    return await response.json() as ManagedPlanRevision;
  };
  const ask = async (revision: number, decisions?: object[]) => {
    const response = await post("/mcp/v2/reviews", { kind: "plan-decisions", title: `Approve documentation plan revision ${revision}`, body: "Review the complete bundle.", decisions,
      managedPlan: { repoSlot: "repo-01", planId: first.manifest.planId, revision } });
    expect(response.status, await response.clone().text()).toBe(200);
  };

  // The first bundle asks, and offers the standing approval beside Submit.
  const first = await save(0, "Documentation plan");
  // A form carrying the same question but bound to no managed plan cannot keep the grant.
  const unboundResponse = await post("/mcp/reviews", { kind: "plan-decisions", title: "Unbound bundle question", body: "Not a managed plan.",
    decisions: [{ id: "approve-final-bundle", question: "Approve this bundle?", options: [{ id: "approve", label: "Approve" }] }] });
  expect(unboundResponse.status).toBe(200);
  await ask(1);
  await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  const detail = dashboard.locator(".console-detail");
  await detail.getByRole("button", { name: "to review" }).click();
  const form = dashboard.locator(".review-modal");
  await expectContentClearsBorder(form);
  const unbound = form.locator("section.review", { hasText: "Unbound bundle question" });
  await expect(unbound.getByRole("radio", { name: "Approve", exact: true })).toBeVisible();
  await expect(unbound.getByRole("checkbox", { name: "Approve all future bundles for this task" })).toHaveCount(0);
  await expect(form.getByRole("checkbox", { name: "Approve all future bundles for this task" })).toHaveCount(1);
  await unbound.getByRole("button", { name: "Dismiss", exact: true }).click();
  await expect(unbound).toHaveCount(0);
  const standing = form.getByRole("checkbox", { name: "Approve all future bundles for this task" });
  await expect(standing).toBeVisible();
  await expect(standing).not.toBeChecked();
  const resolveResponse = () => dashboard.waitForResponse((response) => /\/api\/reviews\/[^/]+\/resolve$/.test(response.url()));

  // "Needs revision" with the box ticked sends the revision and grants nothing.
  await form.getByRole("radio", { name: "Needs revision", exact: true }).check();
  await standing.check();
  const revised = resolveResponse();
  await form.getByRole("button", { name: "Submit", exact: true }).click();
  const revision = await revised;
  expect(revision.ok()).toBe(true);
  expect(revision.request().postDataJSON().approveFutureBundles).toBe(false);
  await expect(form).toBeHidden();

  // So when the agent asks again, the operator is prompted again.
  await ask(1);
  await expect(form.getByRole("radio", { name: "Approve final bundle", exact: true })).toBeVisible();
  await expect(standing).not.toBeChecked();
  await form.getByRole("radio", { name: "Approve final bundle", exact: true }).check();
  await standing.check();
  mkdirSync(evidence, { recursive: true }); await dashboard.setViewportSize({ width: 1440, height: 1000 });
  await dashboard.screenshot({ path: `${evidence}standing-approval-checkbox.png` });
  const resolved = resolveResponse();
  await form.getByRole("button", { name: "Submit", exact: true }).click();
  const resolution = await resolved;
  expect(resolution.ok()).toBe(true);
  expect(resolution.request().postDataJSON().approveFutureBundles).toBe(true);
  await expect(form).toBeHidden();

  // A later bundle for the same task is approved without a prompt and logged in the session.
  await save(1, "Documentation plan, revised", first.manifest.planId);
  await ask(2);
  await expect(detail.getByText("auto-approved (all future bundles for this task)")).toBeVisible();
  await expect(detail.getByRole("button", { name: "to review" })).toHaveCount(0);
  await expect(form).toBeHidden();
  await dashboard.screenshot({ path: `${evidence}standing-approval-logged.png` });

  // A later bundle sent with another open question asks only that question; the bundle is auto-approved.
  await save(2, "Documentation plan, scoped", first.manifest.planId);
  await ask(3, [{ id: "scope", question: "Which scope should the docs cover?", options: [{ id: "api", label: "API reference" }, { id: "guide", label: "User guide" }] }]);
  await expect(detail.getByText("auto-approved (all future bundles for this task)")).toHaveCount(2);
  // The open session raises its new question by itself, so nothing needs clicking.
  await expect(form.getByText("Which scope should the docs cover?")).toBeVisible();
  await expect(form.getByRole("radio", { name: "Approve final bundle", exact: true })).toHaveCount(0);
  await expect(form.getByRole("checkbox", { name: "Approve all future bundles for this task" })).toHaveCount(0);
  await expect(form).toContainText("approved automatically by your standing approval");
  await dashboard.screenshot({ path: `${evidence}standing-approval-remaining-question.png` });
  await form.getByRole("radio", { name: "User guide", exact: true }).check();
  await form.getByRole("button", { name: "Submit", exact: true }).click();
  await expect(form).toBeHidden();

  // And the daemon's publication gate accepts the standing approval of revision 3.
  const publication = await post("/mcp/plans/publish", { repoSlot: "repo-01", planId: first.manifest.planId, revision: 3 });
  expect(publication.status, await publication.clone().text()).toBe(200);
});
