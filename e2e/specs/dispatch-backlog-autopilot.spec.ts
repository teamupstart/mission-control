import { mkdirSync } from "node:fs";

import type { Locator, Page } from "@playwright/test";

import { artifactsDir } from "../fixtures/artifacts.ts";
import { expect, test } from "../fixtures/test.ts";

const EVIDENCE = artifactsDir("dispatch-backlog-autopilot");

async function shoot(page: Page, name: string, target: Locator): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await target.screenshot({ path: `${EVIDENCE}${name}.png`, animations: "disabled" });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/dispatch-backlog-autopilot/${name}.png`);
}

/** Put the dashboard on Board so the stored disabled state has a user-visible consequence. */
async function useBoard(page: Page, baseURL: string): Promise<void> {
  const response = await fetch(`${baseURL}/api/ui/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ layout: "board" }),
  });
  expect(response.ok, "the daemon should accept the Board layout").toBe(true);
  await page.reload();
  await expect(page.locator("main.board")).toBeVisible();
}

test("Add to backlog can create a task parked from autopilot", async ({ dashboard, daemon }) => {
  const title = "Review before scheduling";

  await dashboard.getByRole("button", { name: "Dispatch" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();

  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  // RepoCombobox portals its list over the form. Close it before reaching fields below.
  await dashboard.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(
    "Hold this task for a human backlog review before Foreman can schedule it.",
  );
  await dialog.getByRole("button", { name: /^Backlog details/ }).click();
  await dialog.getByPlaceholder("summarized from the task if left blank").fill(title);

  const autopilot = dialog.getByRole("switch", {
    name: "Allow backlog autopilot to schedule this task",
  });
  await expect(autopilot).toHaveAttribute("aria-checked", "true");
  await autopilot.click();
  await expect(autopilot).toHaveAttribute("aria-checked", "false");
  await expect(dialog.getByText("This task stays parked until you dispatch it or turn this back on."))
    .toBeVisible();
  await shoot(dashboard, "01-dispatch-toggle-off", dialog.locator(".dispatch-more-wrap"));

  const created = dashboard.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/tasks",
  );
  await dialog.getByRole("button", { name: "Add to backlog" }).click();
  const response = await created;
  expect(response.ok(), `creating the backlog task answered ${response.status()}`).toBe(true);
  await expect(dialog).toBeHidden();

  const task = (await response.json()) as { enabled?: boolean; status?: string; title?: string };
  expect(task).toMatchObject({ enabled: false, status: "backlog", title });

  await useBoard(dashboard, daemon.baseURL);
  const card = dashboard.locator(".bl-card", { hasText: title });
  await expect(card).toBeVisible();
  await expect(card.getByText("autopilot will skip this")).toBeVisible();
  await expect(card.getByRole("switch", { name: `Foreman may schedule ${title}` }))
    .toHaveAttribute("aria-checked", "false");
  await shoot(dashboard, "02-parked-backlog-card", card);

  // Reopening the stored task reads the same switch back, rather than resetting to the
  // fresh-form default and silently enabling it on the next save.
  await card.getByRole("button", { name: title, exact: true }).click();
  const editor = dashboard.getByRole("dialog", { name: "Edit a backlog task" });
  await expect(
    editor.getByRole("switch", { name: "Allow backlog autopilot to schedule this task" }),
  ).toHaveAttribute("aria-checked", "false");
});
