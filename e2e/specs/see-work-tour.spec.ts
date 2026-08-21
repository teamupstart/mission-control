import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

const TOUR_COMMAND = /Start See the work tour, command/;

test.describe.configure({ timeout: 90_000 });

async function api<T>(daemon: DaemonHandle, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

async function startTour(page: Page): Promise<void> {
  const palette = page.getByRole("dialog", { name: "Search everything" });
  await page.keyboard.press("Meta+k");
  await expect(palette).toBeVisible();
  await palette.getByRole("combobox", { name: "Search everything" }).fill("See the work");
  await palette.getByRole("option", { name: TOUR_COMMAND }).click();
}

function step(page: Page, title: string) {
  return page.getByRole("dialog", { name: title }).or(page.getByRole("status", { name: title }));
}

async function expectTourButtonsCentered(surface: Locator): Promise<void> {
  const buttons = surface.getByRole("button");
  for (let index = 0; index < await buttons.count(); index++) {
    const button = buttons.nth(index);
    if (await button.getAttribute("hidden") !== null || !await button.isVisible()) continue;
    await expect(button).toHaveCSS("display", "flex");
    await expect(button).toHaveCSS("align-items", "center");
    await expect(button).toHaveCSS("justify-content", "center");
    await expect(button).toHaveCSS("text-align", "center");
  }
}

async function expectTourColumnHeaderForeground(page: Page, name: RegExp): Promise<void> {
  const heading = page.getByRole("heading", { name });
  const header = heading.locator("..");
  await expect(heading).toBeVisible();
  await expect(header).toHaveCSS("position", "relative");
  await expect(header).toHaveCSS("z-index", "10001");
  await expect(header).toHaveCSS("filter", "brightness(1.2) saturate(1.04)");
}

async function reachDispatchInput(page: Page): Promise<void> {
  for (const title of ["Fleet and the Line", "Board View", "Session detail"]) {
    await step(page, title).getByRole("button", { name: "Next" }).click();
  }
  await step(page, "Open Dispatch").getByRole("button", { name: "Open Dispatch" }).click();
  await step(page, "Choose the kind").getByRole("button", { name: "Write the brief" }).click();
}

async function dispatchTourTask(page: Page): Promise<void> {
  await reachDispatchInput(page);
  await step(page, "Brief ready").getByRole("button", { name: "Choose after work" }).click();
  await step(page, "Choose what follows").getByRole("button", { name: "Review dispatch" }).click();
  const modal = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(step(page, "Dispatch the task")).toBeVisible();
  await modal.getByRole("button", { name: "Dispatch now" }).click();
}

async function expectTourTasksCleaned(
  daemon: DaemonHandle,
  titles: readonly string[],
): Promise<void> {
  await expect.poll(async () => {
    const tasks = await api<Array<{ title: string; status: string; outcome: string | null }>>(
      daemon,
      "/api/tasks",
    );
    return Object.fromEntries(
      tasks
        .filter((task) => titles.includes(task.title))
        .map((task) => [task.title, { status: task.status, outcome: task.outcome }]),
    );
  }).toEqual(Object.fromEntries(titles.map((title) => [title, { status: "done", outcome: title }])));

  await expect.poll(async () => {
    const sessions = await api<Array<{ task?: { title: string }; state: string }>>(
      daemon,
      "/api/sessions",
    );
    return sessions
      .filter((session) => session.task?.title && titles.includes(session.task.title))
      .every((session) => session.state === "stopping" || session.state === "exited");
  }).toBe(true);
}

async function raiseTourReview(daemon: DaemonHandle): Promise<string> {
  let cwd: string | null = null;
  await expect.poll(async () => {
    const sessions = await api<Array<{ cwd: string | null; task?: { title: string } }>>(
      daemon,
      "/api/sessions",
    );
    cwd = sessions.find((session) => session.task?.title === "Tour demo")?.cwd ?? null;
    return cwd;
  }, { timeout: 30_000 }).toBeTruthy();

  // Stand in for the fake agent calling the bundled request_input tool. This is the exact
  // authenticated HTTP channel that tool uses; all agent binaries remain cost-free fakes.
  const token = readFileSync(join(daemon.home, "token"), "utf8").trim();
  const response = await fetch(`${daemon.baseURL}/mcp/reviews`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": token },
    body: JSON.stringify({
      env: {},
      cwd,
      kind: "input",
      title: "Which review path should this demo take?",
      body: "Which review path should this demo take?",
      decisions: [
        {
          id: "q",
          question: "Which review path should this demo take?",
          options: [
            { id: "o0", label: "Looks good", detail: "Continue the tour without doing more work." },
            { id: "o1", label: "Show me later", detail: "Acknowledge the choice and do nothing else." },
          ],
        },
      ],
    }),
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { id: string }).id;
}

test("the tour dispatches Terra, pauses for a real review, reaches Idle, and completes", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.emulateMedia({ reducedMotion: "reduce" });
  await dashboard.goto(`${daemon.baseURL}/#/settings/display`);
  const operatorDraft = "Keep this operator draft";
  await dashboard.getByRole("button", { name: "Dispatch" }).click();
  const dispatchDialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  await dispatchDialog.getByPlaceholder("What should this agent do?").fill(operatorDraft);
  await dispatchDialog.getByRole("button", { name: "Close" }).click();
  const helpAndTours = dashboard.getByRole("group", { name: "Help & tours" });
  const settingsTourStart = helpAndTours.getByRole("button", {
    name: "Start See the work tour",
  });
  await expect(helpAndTours.getByText("Help & tours", { exact: true })).toBeVisible();
  await expect(settingsTourStart).toContainText("See the work");
  await expect(settingsTourStart).toContainText("Start the guided tour");
  await settingsTourStart.click();

  let dialog = step(dashboard, "Fleet and the Line");
  await expect(dialog.getByText("See the work", { exact: true })).toBeVisible();
  await expect(dialog).toContainText("Step 1 of 14");
  const progressRail = dialog.getByRole("progressbar", { name: "See the work tour progress" });
  await expect(progressRail).toHaveAttribute("aria-valuenow", "1");
  await expect(dialog).toHaveCSS("background-image", /linear-gradient/);
  await expectTourButtonsCentered(dialog);
  const highlightedLine = dashboard.getByRole("navigation", { name: "The Line" });
  await expect(highlightedLine).toHaveCSS("outline-width", "2px");
  await expect(highlightedLine).toHaveCSS("outline-color", "rgb(246, 167, 51)");
  await expect(highlightedLine).toHaveCSS("border-radius", "8px");
  await expect(highlightedLine).toHaveCSS("z-index", "10001");
  await expect(highlightedLine).toHaveCSS("filter", "brightness(1.2) saturate(1.04)");
  for (const key of ["Tab", "Tab", "Shift+Tab"]) {
    await dashboard.keyboard.press(key);
    expect(await dialog.evaluate((root) => root.contains(document.activeElement))).toBe(true);
  }
  await dashboard.keyboard.press("Meta+k");
  await expect(dashboard.getByRole("dialog", { name: "Search everything" })).toBeHidden();

  await dialog.getByRole("button", { name: "Next" }).click();
  dialog = step(dashboard, "Board View");
  await expect(dialog).toContainText("Step 2 of 14");
  await expect(dialog.getByRole("progressbar", { name: "See the work tour progress" }))
    .toHaveAttribute("aria-valuenow", "2");
  await expectTourButtonsCentered(dialog);
  await dialog.getByRole("button", { name: "Next" }).click();

  dialog = step(dashboard, "Session detail");
  const sessionTabs = dashboard.getByRole("tablist", { name: "Session detail" });
  const sessionWorkspace = dashboard.getByRole("complementary", {
    name: "Session detail workspace",
  });
  await expect(sessionTabs).toBeVisible({ timeout: 30_000 });
  await expect(sessionWorkspace).toBeVisible();
  await expect(sessionWorkspace).toHaveCSS("outline-width", "2px");
  await expect(sessionWorkspace).toHaveCSS("outline-offset", "-2px");
  await expect(sessionWorkspace).toHaveCSS("border-radius", "8px");
  for (const name of ["Conversation", "Work queue", "Workflows", "Diff", "Files"]) {
    await expect(sessionTabs.getByRole("tab", { name: new RegExp(name, "i") })).toBeVisible();
  }
  await expect(dashboard.getByText("Tour conversation", { exact: true }).first()).toBeVisible();
  await expect(dialog).not.toContainText("No session is available");
  await expect.poll(async () => {
    const task = (await api<Array<{ title: string; kind: string }>>(daemon, "/api/tasks"))
      .find((candidate) => candidate.title === "Tour conversation");
    return task && { title: task.title, kind: task.kind };
  }).toEqual({ title: "Tour conversation", kind: "chat" });
  await dialog.getByRole("button", { name: "Next" }).click();

  dialog = step(dashboard, "Open Dispatch");
  await expect(dialog).toContainText("real form");
  const openDispatch = dialog.getByRole("button", { name: "Open Dispatch" });
  await expectTourButtonsCentered(dialog);
  await expect(openDispatch).toHaveCSS("white-space", "nowrap");
  await expect(dialog.getByRole("button", { name: "Exit tour" }))
    .toHaveCSS("white-space", "nowrap");
  await openDispatch.click();

  await expect(dispatchDialog).toBeVisible();
  dialog = step(dashboard, "Choose the kind");
  await expect(dialog).toContainText("Step 5 of 14");
  await expect(dialog).toContainText("Chat");
  await expect(dialog).toContainText("Scout");
  await expect(dialog).toContainText("Plan");
  await expect(dialog).toContainText("Ship");
  await expectTourButtonsCentered(dialog);
  const coachmarkBox = await dialog.boundingBox();
  const viewport = dashboard.viewportSize();
  expect(coachmarkBox).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(coachmarkBox!.y).toBeGreaterThanOrEqual(0);
  expect(coachmarkBox!.y + coachmarkBox!.height).toBeLessThanOrEqual(viewport!.height);
  const kind = dispatchDialog.getByRole("combobox", { name: "Kind" });
  await expect(dispatchDialog.getByRole("heading", { name: "Dispatch an agent" })).toBeVisible();
  await expect(dispatchDialog.getByPlaceholder("What should this agent do?")).toBeVisible();
  await expect(dispatchDialog.getByRole("combobox", { name: "After work" })).toBeVisible();
  const kindSelection = dispatchDialog.getByRole("group", { name: "Task type selection" });
  await expect(kindSelection).toHaveCSS("outline-width", "2px");
  await expect(kindSelection).toHaveCSS("outline-color", "rgb(246, 167, 51)");
  await expect(kindSelection).toHaveCSS("border-radius", "8px");
  await expect(kindSelection).toHaveCSS("filter", "brightness(1.2) saturate(1.04)");
  for (const name of ["chat", "scout", "plan", "ship"]) {
    await expect(kind.getByRole("option", { name })).toHaveCount(1);
  }
  for (const key of ["Tab", "Tab", "Shift+Tab"]) {
    await dashboard.keyboard.press(key);
    const focusContained = await Promise.all([
      dispatchDialog.evaluate((root) => root.contains(document.activeElement)),
      dialog.evaluate((root) => root.contains(document.activeElement)),
    ]);
    expect(focusContained.some(Boolean)).toBe(true);
  }
  await dashboard.keyboard.press("Escape");
  await expect(dispatchDialog).toBeHidden();
  dialog = step(dashboard, "Open Dispatch");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Open Dispatch" }).click();
  dialog = step(dashboard, "Choose the kind");
  await dialog.getByRole("button", { name: "Write the brief" }).click();

  dialog = step(dashboard, "Brief ready");
  await expect(dialog).toContainText("filled the real task input");
  await expect(dispatchDialog.getByPlaceholder("What should this agent do?")).toHaveValue(
    /\[Mission Control See the work tour demo\]/,
  );
  await expect(dispatchDialog.getByRole("combobox", { name: "Agent" })).toBeVisible();
  await expect(dispatchDialog.getByRole("combobox", { name: "Model" })).toBeVisible();
  await dialog.getByRole("button", { name: "Choose after work" }).click();

  dialog = step(dashboard, "Choose what follows");
  await expect(dialog).toContainText("Workflows run reusable review and follow-up steps");
  const afterWork = dispatchDialog.getByRole("combobox", { name: "After work" });
  await expect(afterWork).toHaveValue("__none");
  await expect(afterWork.getByRole("option", { name: /^None\b.*finish without a Workflow$/ }))
    .toHaveCount(1);
  await dialog.getByRole("button", { name: "Review dispatch" }).click();

  dialog = step(dashboard, "Dispatch the task");
  await expect(dialog).toContainText("Click Dispatch now in the modal");
  const dispatchNow = dispatchDialog.getByRole("button", { name: "Dispatch now" });
  await expect(dispatchDialog.getByRole("combobox", { name: "Kind" })).toHaveValue("ship");
  await expect(afterWork).toBeVisible();
  await expect(dispatchNow).toBeFocused();
  const [tourBox, dispatchBox] = await Promise.all([dialog.boundingBox(), dispatchNow.boundingBox()]);
  if (!tourBox || !dispatchBox) throw new Error("The Dispatch tour stop did not finish laying out");
  const tourCoversDispatch = !(
    tourBox.x + tourBox.width <= dispatchBox.x
    || dispatchBox.x + dispatchBox.width <= tourBox.x
    || tourBox.y + tourBox.height <= dispatchBox.y
    || dispatchBox.y + dispatchBox.height <= tourBox.y
  );
  expect(tourCoversDispatch).toBe(false);
  await dispatchNow.click();
  await expect(dispatchDialog).toBeHidden();

  dialog = step(dashboard, "Working");
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await expect(dialog).toContainText("Step 9 of 14");
  await expectTourColumnHeaderForeground(dashboard, /^working$/i);
  await expect(dashboard.getByText("Tour demo", { exact: true })).toBeVisible();

  const review = raiseTourReview(daemon);
  await dialog.getByRole("button", { name: "Next" }).click();
  dialog = step(dashboard, "Needs You");
  await expect(dialog.getByRole("button", { name: "Open review" })).toBeEnabled({ timeout: 30_000 });
  await expectTourColumnHeaderForeground(dashboard, /^needs you$/i);
  await review;
  await dialog.getByRole("button", { name: "Open review" }).click();

  const reviewDialog = dashboard.getByRole("dialog", { name: "Review request" });
  await expect(reviewDialog).toBeVisible();
  // Driver may retain focus on the adjacent Exit/Back coachmark controls after its own
  // render pass. Both surfaces are inside the tour's containment loop; the human still
  // makes the choice in the labelled real dialog.
  await reviewDialog.getByRole("radio", { name: /Looks good/ }).check();
  await reviewDialog.getByRole("button", { name: "Submit", exact: true }).click();
  await expect(reviewDialog).toBeHidden();

  dialog = step(dashboard, "Idle");
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await expectTourColumnHeaderForeground(dashboard, /^idle$/i);
  await dialog.getByRole("button", { name: "Show actions" }).click();

  dialog = step(dashboard, "Complete or run a retro");
  await expect(dialog).toContainText("will not run a retro");
  await expect(dashboard.getByRole("button", { name: "complete", exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Open Complete" }).click();

  const completeDialog = dashboard.getByRole("dialog", {
    name: "Complete task and close session",
  });
  await expect(completeDialog).toBeVisible();
  dialog = step(dashboard, "Complete the tour");
  await expect(dialog).toContainText("Tour demo");
  await expectTourButtonsCentered(dialog);
  await expect(
    completeDialog.getByRole("textbox", { name: "Outcome (optional)" }),
  ).toHaveValue("Tour demo");
  await expect(completeDialog.getByRole("button", { name: "Run a retro first" })).toBeDisabled();
  await expect(completeDialog.getByRole("button", { name: "Complete & close" })).toBeDisabled();

  await dashboard.keyboard.press("Escape");
  await expect(completeDialog).toBeHidden();
  dialog = step(dashboard, "Complete or run a retro");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Open Complete" }).click();
  dialog = step(dashboard, "Complete the tour");
  await dialog.getByRole("button", { name: "Complete tour" }).click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });

  await expect.poll(() => dashboard.evaluate(() => location.hash)).toBe("#/settings/display");
  await expect(
    dashboard.getByRole("button", { name: "Start See the work tour" }),
  ).toBeFocused();
  await dashboard.getByRole("button", { name: "Dispatch" }).click();
  await expect(dispatchDialog.getByPlaceholder("What should this agent do?")).toHaveValue(operatorDraft);
  await dispatchDialog.getByRole("button", { name: "Close" }).click();
  await expectTourTasksCleaned(daemon, ["Tour conversation", "Tour demo"]);
});

test("Exit during the live demo leaves the task done and no session behind", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.goto(`${daemon.baseURL}/#/settings/display`);
  const start = dashboard.getByRole("button", { name: "Start See the work tour" });
  await start.click();
  await dispatchTourTask(dashboard);
  const working = step(dashboard, "Working");
  await expect(working).toBeVisible({ timeout: 30_000 });
  await dashboard.route("**/api/tours/see-work/tasks/*/complete", async (route) => {
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "simulated cleanup refusal" }),
    });
  }, { times: 1 });
  await working.getByRole("button", { name: "Exit tour" }).click();

  const cleanup = step(dashboard, "Tour cleanup needs attention");
  await expect(cleanup).toContainText("simulated cleanup refusal");
  await expect(cleanup).toContainText("restored where you started");
  await expect.poll(() => dashboard.evaluate(() => location.hash)).toBe("#/settings/display");
  const retry = cleanup.getByRole("button", { name: "Retry cleanup" });
  await expect(retry).toBeFocused();
  await retry.click();
  await expect(cleanup).toBeHidden({ timeout: 30_000 });
  await expect(start).toBeFocused();

  await expectTourTasksCleaned(daemon, ["Tour conversation", "Tour demo"]);
});

test("an Idle session without a review explains the failure instead of waiting ambiguously", async ({
  dashboard,
  daemon,
}) => {
  await startTour(dashboard);
  await dispatchTourTask(dashboard);
  const working = step(dashboard, "Working");
  await expect(working).toBeVisible({ timeout: 30_000 });
  await working.getByRole("button", { name: "Next" }).click();

  const needsYou = step(dashboard, "Needs You");
  await expect(needsYou).toContainText(
    "The session became Idle without opening its review request",
    { timeout: 30_000 },
  );
  await expect(needsYou.getByRole("button", { name: "Back" })).toBeEnabled();
  await expect(needsYou.getByRole("button", { name: "Exit tour" })).toBeEnabled();
  await expect(needsYou.getByRole("button", { name: "Open review" })).toBeDisabled();
  await needsYou.getByRole("button", { name: "Exit tour" }).click();
  await expect(needsYou).toBeHidden({ timeout: 30_000 });
  await expectTourTasksCleaned(daemon, ["Tour conversation", "Tour demo"]);
});
