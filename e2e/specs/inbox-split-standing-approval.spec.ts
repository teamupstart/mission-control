import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { ManagedPlanRevision } from "../../src/shared/managed-plans.ts";
import type { Session, Task } from "../../src/shared/types.ts";

/**
 * What is at stake: a managed plan's final bundle, answered from the split inbox's pane
 * (`inbox-split` preview), offers "Approve all future bundles for this task" exactly as the
 * per-session review modal does, and ticking it there grants the standing approval, so the
 * task's next bundle is approved without a prompt. A `request_input` approval question and a plan
 * form bound to no managed plan never offer it: the daemon does not mark them eligible.
 */

const EVIDENCE = artifactsDir("inbox-split-standing-approval");
const STANDING = "Approve all future bundles for this task";

const token = (daemon: DaemonHandle) => readFileSync(join(daemon.home, "token"), "utf8").trim();

async function api<T>(daemon: DaemonHandle, path: string, body?: unknown, method?: string): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  return await response.json() as T;
}

async function setFlag(daemon: DaemonHandle, id: string, enabled: boolean): Promise<void> {
  const { config } = await api<{ config: { overrides: Record<string, boolean> } }>(
    daemon, "/api/feature-flags", { kind: "flag", id, enabled }, "PUT");
  expect(config.overrides[id]).toBe(enabled);
}

async function openInbox(page: Page): Promise<Locator> {
  const inbox = page.getByRole("dialog", { name: "Attention inbox" });
  const toAnswer = page.locator("button.pulse-seg", { hasText: "to answer" });
  await expect(async () => {
    if (!(await inbox.isVisible())) await toAnswer.click({ timeout: 3000 });
    await expect(inbox).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 45_000 });
  return inbox;
}

test("the split inbox offers and grants approve all future bundles on a managed final bundle, and only there", async ({ dashboard: page, daemon }) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 1400, height: 900 });
  const config = await fetch(`${daemon.baseURL}/api/skills/config`, { method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ planStorage: "local", enabled: true, skills: { "html-plans": true } }) });
  expect(config.ok).toBe(true);
  const task = await api<Task>(daemon, "/api/tasks", {
    repoRoot: daemon.repo, title: "Plan a documentation update", intent: "Plan a documentation update",
    kind: "plan", agent: "claude", runtime: "sdk", workflowId: null,
  });
  let session!: Session;
  await expect.poll(async () => {
    session = (await api<Session[]>(daemon, "/api/sessions")).find((s) => s.task?.id === task.id)!;
    return session?.agentSessionId ? session.state : null;
  }, { timeout: 60_000 }).toBe("idle");
  await setFlag(daemon, "inbox-split", true);

  const post = (route: string, body: object) => fetch(`${daemon.baseURL}${route}`, { method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": token(daemon) },
    body: JSON.stringify({ env: {}, sessionId: session.id, cwd: session.cwd, ...body }) });
  const save = async (expectedRevision: number, heading: string, planId?: string) => {
    const response = await post("/mcp/plans/save", { repoSlot: "repo-01", slug: "documentation", planId, requestId: randomUUID(), expectedRevision, files: [
      { name: "plan.md", content: `# ${heading}` }, { name: "plan.html", content: `<h1>${heading}</h1>` },
    ] });
    expect(response.status, await response.clone().text()).toBe(200);
    return await response.json() as ManagedPlanRevision;
  };
  const ask = async (planId: string, revision: number) => {
    const response = await post("/mcp/v2/reviews", { kind: "plan-decisions", title: `Approve documentation plan revision ${revision}`,
      body: "Review the complete bundle.", managedPlan: { repoSlot: "repo-01", planId, revision } });
    expect(response.status, await response.clone().text()).toBe(200);
    return await response.json() as { id: string; wait?: string };
  };

  // Two questions that read like a bundle approval but cannot carry a standing grant: a
  // `request_input` question asking for an approval, and a plan form with the final-bundle question
  // that is bound to no managed plan. The box is offered only on the task-bound final bundle.
  const approvalQuestion = "Will you approve the current commit of the docs pull request?";
  const input = await post("/mcp/reviews", { kind: "input", title: approvalQuestion, body: approvalQuestion, snoozable: true });
  expect(input.status, await input.clone().text()).toBe(200);
  const unbound = await post("/mcp/reviews", { kind: "plan-decisions", title: "Unbound bundle question", body: "Not a managed plan.",
    decisions: [{ id: "approve-final-bundle", question: "Approve this bundle?", options: [{ id: "approve", label: "Approve" }] }] });
  expect(unbound.status, await unbound.clone().text()).toBe(200);
  const first = await save(0, "Documentation plan");
  await ask(first.manifest.planId, 1);
  // The daemon's own marking, which the pane reads: only the task-bound final bundle is eligible.
  const pending = await api<{ kind: string; title: string; standingApprovalEligible?: boolean }[]>(daemon, "/api/reviews");
  expect(pending.map((r) => [r.kind, r.title, r.standingApprovalEligible === true]).sort()).toEqual([
    ["input", approvalQuestion, false],
    ["plan-decisions", "Approve documentation plan revision 1", true],
    ["plan-decisions", "Unbound bundle question", false],
  ]);

  const inbox = await openInbox(page);
  const list = inbox.getByRole("listbox", { name: "Inbox items" });
  const pane = inbox.getByRole("region", { name: "Selected item" });
  const standing = pane.getByRole("checkbox", { name: STANDING });

  const inputRow = list.getByRole("option", { name: new RegExp(approvalQuestion.replace(/[?.]/g, "\\$&")) });
  await expect(inputRow).toHaveAttribute("aria-selected", "true");
  await expect(pane.getByRole("button", { name: "Send answer" })).toBeVisible();
  await expect(standing).toHaveCount(0);
  if (process.env.MC_E2E_EVIDENCE === "1") {
    mkdirSync(EVIDENCE, { recursive: true });
    await page.mouse.move(0, 0);
    await inbox.screenshot({ path: join(EVIDENCE, "split-pane-input-approval-no-standing.png") });
    console.log("CAPTURED e2e/.artifacts/inbox-split-standing-approval/split-pane-input-approval-no-standing.png");
  }
  await list.getByRole("option", { name: /Unbound bundle question/ }).click();
  await expect(pane.getByRole("radio", { name: "Approve", exact: true })).toBeVisible();
  await expect(standing).toHaveCount(0);

  await list.getByRole("option", { name: /Approve documentation plan revision 1/ }).click();
  await expect(list.getByRole("option", { name: /Approve documentation plan revision 1/ })).toHaveAttribute("aria-selected", "true");
  await expect(standing).toBeVisible();
  await expect(standing).not.toBeChecked();

  await pane.getByRole("radio", { name: "Approve final bundle", exact: true }).check();
  await standing.check();
  if (process.env.MC_E2E_EVIDENCE === "1") {
    mkdirSync(EVIDENCE, { recursive: true });
    await page.mouse.move(0, 0);
    await inbox.screenshot({ path: join(EVIDENCE, "split-pane-standing-approval.png") });
    console.log("CAPTURED e2e/.artifacts/inbox-split-standing-approval/split-pane-standing-approval.png");
  }
  const resolved = page.waitForResponse((response) => /\/api\/reviews\/[^/]+\/resolve$/.test(response.url()));
  await pane.getByRole("button", { name: "Submit", exact: true }).click();
  const resolution = await resolved;
  expect(resolution.ok()).toBe(true);
  expect(resolution.request().postDataJSON().approveFutureBundles).toBe(true);
  await expect(list.getByRole("option", { name: /Approve documentation plan revision 1/ })).toHaveCount(0);

  // The grant holds: the task's next bundle is approved without reaching the inbox.
  await save(1, "Documentation plan, revised", first.manifest.planId);
  const later = await ask(first.manifest.planId, 2);
  expect(later.wait).toBe("call");
  const approved = await api<{ status: string; resolvedBy?: string | null }>(daemon, `/api/reviews/${encodeURIComponent(later.id)}`);
  expect(approved.resolvedBy).toBe("standing-approval");
  await expect(list.getByRole("option", { name: /Approve documentation plan revision 2/ })).toHaveCount(0);
});
