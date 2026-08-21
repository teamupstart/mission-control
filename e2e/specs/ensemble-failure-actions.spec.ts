import { mkdirSync } from "node:fs";

import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * A failed ensemble should be history, not an alarm that can only be removed by destroying it.
 * This spec reaches a real failed run through the public action route, proves one dismissal clears
 * both attention entry points over SSE, and then exercises the separate permanent-delete dialog.
 * No model tokens are spent: the fixture agents are withdrawn before evaluation begins.
 */

const EVIDENCE = artifactsDir("ensemble-failure-actions");

async function json<T>(
  daemon: DaemonHandle,
  path: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  expect(response.ok, `${path} answered ${response.status}: ${text}`).toBe(true);
  return JSON.parse(text) as T;
}

interface Detail {
  run: { id: string; status: string; failureAcknowledgedAt: number | null };
  members: Array<{ id: string; status: string }>;
}

async function failEnsemble(daemon: DaemonHandle): Promise<string> {
  const title = "Failed comparison to acknowledge";
  const created = await json<{ run: { id: string } }>(daemon, "/api/ensembles", {
    sourceKey: "e2e-failed-ensemble-actions",
    title,
    intent: "Exercise failed-run acknowledgment without asking a model to compare anything.",
    repoRoot: daemon.repo,
    strategyId: "best_of_n",
    strategyConfig: { members: [{}, {}] },
  });
  const id = created.run.id;

  await expect
    .poll(
      async () =>
        (await json<Detail>(daemon, `/api/ensembles/${id}`)).members.filter(
          (member) => member.status === "active",
        ).length,
      { message: "both fixture members should be withdrawable", timeout: 60_000 },
    )
    .toBe(2);

  const members = (await json<Detail>(daemon, `/api/ensembles/${id}`)).members;
  for (const member of members) {
    await json(daemon, `/api/ensembles/${id}/actions`, {
      kind: "withdraw_member",
      memberId: member.id,
    });
  }
  await expect
    .poll(async () => (await json<Detail>(daemon, `/api/ensembles/${id}`)).run.status, {
      message: "an impossible two-candidate barrier should fail the run",
      timeout: 60_000,
    })
    .toBe("failed");
  return id;
}

async function capture(page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/ensemble-failure-actions/${name}.png`);
}

test("a failed ensemble can be dismissed without deletion, then deleted through a simple modal", async ({
  dashboard,
  daemon,
}) => {
  const runId = await failEnsemble(daemon);
  const libraryShelf = () =>
    dashboard.getByRole("region", { name: "Not sure of the best approach?" });
  const decideStage = () =>
    dashboard
      .getByRole("navigation", { name: "The Line" })
      .getByRole("button", { name: /^Decide,/ });

  // The original defect: terminal failure attention leaks into both durable-state rollups even
  // though the Decide drawer has no live row a person can act on.
  await dashboard.goto(`${daemon.baseURL}/#/library`);
  await expect(libraryShelf().getByRole("button", { name: /1 need you/ })).toBeVisible();
  await dashboard.goto(`${daemon.baseURL}/#/fleet`);
  await decideStage().click();
  await expect(
    dashboard.getByRole("region", { name: "Decide drawer" }).locator(".line-drawer-att"),
  ).toHaveText("1 needs a look");

  // Dismissal keeps the failed run and clears the server-owned attention bit. The list remains
  // on screen, but the control and attention mark retire when the SSE update arrives.
  await dashboard.goto(`${daemon.baseURL}/#/ensembles/${runId}`);
  const dismiss = dashboard.getByRole("button", { name: "Dismiss failure" });
  await expect(dismiss).toBeVisible();
  const dismissedResponse = dashboard.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/ensembles/${runId}/actions`) &&
      response.request().method() === "POST",
  );
  await dismiss.click();
  expect((await dismissedResponse).ok()).toBe(true);
  await expect(dismiss).toHaveCount(0);
  await expect(dashboard.getByRole("button", { name: "Delete run…" })).toBeVisible();
  await expect
    .poll(
      async () => (await json<Detail>(daemon, `/api/ensembles/${runId}`)).run,
      { timeout: 30_000 },
    )
    .toMatchObject({ status: "failed", failureAcknowledgedAt: expect.any(Number) });

  await dashboard.goto(`${daemon.baseURL}/#/library`);
  await expect(libraryShelf().getByRole("button", { name: "1 run →" })).toBeVisible();
  await expect(libraryShelf().locator(".lib-shelf-live.is-attention")).toHaveCount(0);
  await dashboard.goto(`${daemon.baseURL}/#/fleet`);
  await decideStage().click();
  const decide = dashboard.getByRole("region", { name: "Decide drawer" });
  await expect(decide.locator(".line-drawer-count")).toHaveText("0 ensembles live");
  await expect(decide.locator(".line-drawer-att")).toHaveCount(0);

  // Permanent deletion is still deliberate, but identity is expressed in human terms. Escape
  // backs out; reopening and confirming removes the retained run without any GUID field.
  await dashboard.goto(`${daemon.baseURL}/#/ensembles/${runId}`);
  const openDelete = dashboard.getByRole("button", { name: "Delete run…" });
  await expect(openDelete).toHaveAttribute("aria-keyshortcuts", "d");
  await dashboard.keyboard.press("d");
  const modal = dashboard.getByRole("dialog", {
    name: "Delete ensemble run Failed comparison to acknowledge",
  });
  await expect(modal).toContainText("Failed comparison to acknowledge");
  await expect(modal).toContainText("private snapshot refs");
  await expect(modal.getByRole("textbox")).toHaveCount(0);
  await capture(dashboard, "delete-confirmation");
  await dashboard.keyboard.press("Escape");
  await expect(modal).toBeHidden();
  expect((await json<Detail>(daemon, `/api/ensembles/${runId}`)).run.status).toBe("failed");

  await openDelete.click();
  await expect(modal).toBeVisible();
  const deletedResponse = dashboard.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/ensembles/${runId}`) &&
      response.request().method() === "DELETE",
  );
  const confirmDelete = modal.getByRole("button", { name: "Delete run", exact: true });
  await expect(confirmDelete).toHaveAttribute("aria-keyshortcuts", "d");
  await dashboard.keyboard.press("d");
  expect((await deletedResponse).ok()).toBe(true);
  await expect(modal).toHaveCount(0);
  await expect(dashboard.getByText("No ensembles yet.")).toBeVisible();
});
