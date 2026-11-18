import { mkdirSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * The Console with the Line switched off, end to end: the rail's stage dock opens the same
 * drawers the strip would have.
 *
 * Disabling the Line removes the strip, and the strip was the only door to its drawers. The
 * Board keeps a Backlog column; the Console had nothing, so an operator who switched the Line
 * off there had no visible way to reach the queue (#1512). The dock is the strip's drawer
 * stages carried by the rail instead, and this is the layer that can see a press on it reach
 * App's stage handler, open the drawer between the top bar and the console, and hand the
 * keyboard back on the way out.
 *
 * Three places carry it, because the rail is not always there: an empty fleet has no rail, a
 * folded rail has no head, and an ordinary rail has both. Each is pressed here.
 *
 * No model tokens. The backlog task is filed through the task route and never dispatched; the
 * one session that gives the Console a rail runs against the fake agent like every other spec.
 */

const EVIDENCE = artifactsDir("line-dock-console");

async function shoot(page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  // Off every control first: `Tooltip` portals a bubble under a resting pointer.
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/line-dock-console/${name}.png`);
}

async function api<T>(daemon: DaemonHandle, path: string, body?: unknown, method = "POST"): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: body === undefined ? "GET" : method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${text}`);
  return JSON.parse(text) as T;
}

/** The Line, on or off, through the same key Settings writes. */
async function setLineHidden(page: Page, daemon: DaemonHandle, hidden: boolean): Promise<void> {
  await api(daemon, "/api/ui/config", { lineHidden: hidden }, "PUT");
  await page.reload();
  await expect(page.getByRole("button", { name: "Dispatch", exact: true })).toBeVisible();
}

const dock = (page: Page): Locator => page.getByRole("group", { name: "Line drawers" });
const dockStage = (page: Page, name: string): Locator =>
  dock(page).getByRole("button", { name: new RegExp(`^${name},`) });
const drawer = (page: Page, name: string): Locator =>
  page.getByRole("region", { name: `${name} drawer` });
const anyDrawer = (page: Page): Locator => page.locator(".line-drawer");
const rail = (page: Page): Locator => page.getByRole("navigation", { name: "Sessions" });

async function waitForIdleSession(daemon: DaemonHandle): Promise<void> {
  await expect.poll(async () => {
    const sessions = await api<Array<{ state: string }>>(daemon, "/api/sessions");
    return sessions.find((session) => session.state !== "exited")?.state ?? "";
  }, { timeout: 60_000 }).toBe("idle");
}

test("with the Line off, the Console reaches the Backlog drawer from the fleet", async ({
  dashboard,
  daemon,
}) => {
  const title = "Queued while the Line is off";
  await api(daemon, "/api/tasks", {
    repoRoot: daemon.repo,
    intent: "Sit in the backlog so the drawer has a row to show.",
    title,
    backlog: true,
    workflowId: null,
  });
  // The dashboard fixture pins the Console layout; this is the one other precondition.
  await setLineHidden(dashboard, daemon, true);
  await expect(dashboard.getByRole("navigation", { name: "The Line" })).toHaveCount(0);

  // ---- an empty fleet: no rail, so the dock sits where the strip would have ----
  await expect(rail(dashboard)).toHaveCount(0);
  await expect(dock(dashboard)).toBeVisible();
  // Exactly the stages that open a drawer. Working is the fleet itself.
  await expect(dock(dashboard).getByRole("button")).toHaveCount(5);
  await expect(dockStage(dashboard, "Working")).toHaveCount(0);
  const looseBacklog = dockStage(dashboard, "Backlog");
  await expect(looseBacklog).toHaveAccessibleName(/^Backlog, 1 task waiting/);
  await expect(looseBacklog).toHaveAttribute("aria-expanded", "false");

  await looseBacklog.click();
  await expect(drawer(dashboard, "Backlog")).toBeVisible();
  await expect(drawer(dashboard, "Backlog")).toContainText(title);
  await expect(looseBacklog).toHaveAttribute("aria-expanded", "true");
  await expect(looseBacklog).toHaveAttribute("aria-controls", "line-drawer");
  await expect(drawer(dashboard, "Backlog")).toBeFocused();
  await shoot(dashboard, "empty-fleet-backlog-open");
  // Escape closes it and hands the keyboard back to the button that opened it.
  await dashboard.keyboard.press("Escape");
  await expect(anyDrawer(dashboard)).toHaveCount(0);
  await expect(looseBacklog).toBeFocused();

  // ---- a session gives the Console its rail, and the dock moves under the rail's head ----
  await dashboard.getByRole("button", { name: "Dispatch", exact: true }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await dashboard.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill("give the console a rail");
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
  await waitForIdleSession(daemon);

  await expect(rail(dashboard)).toBeVisible();
  // One dock, in the rail: the loose one gave way when the rail arrived.
  await expect(dock(dashboard)).toHaveCount(1);
  await expect(rail(dashboard).getByRole("group", { name: "Line drawers" })).toBeVisible();
  const backlog = dockStage(dashboard, "Backlog");

  await backlog.click();
  await expect(drawer(dashboard, "Backlog")).toBeVisible();
  await expect(drawer(dashboard, "Backlog")).toContainText(title);
  // The drawer sits above the console, not inside the rail: the same drawer the strip opens.
  const panel = (await drawer(dashboard, "Backlog").boundingBox())!;
  const railBox = (await rail(dashboard).boundingBox())!;
  expect(railBox.y).toBeGreaterThanOrEqual(panel.y + panel.height - 1);
  await shoot(dashboard, "rail-backlog-open");

  // A second press on the same stage closes it.
  await backlog.click();
  await expect(anyDrawer(dashboard)).toHaveCount(0);
  await expect(backlog).toHaveAttribute("aria-expanded", "false");

  // A different stage swaps the content in place, one drawer at a time.
  await dockStage(dashboard, "Review").click();
  await expect(drawer(dashboard, "Review")).toBeVisible();
  await backlog.click();
  await expect(drawer(dashboard, "Backlog")).toBeVisible();
  await expect(anyDrawer(dashboard)).toHaveCount(1);
  await expect(dockStage(dashboard, "Review")).toHaveAttribute("aria-expanded", "false");
  // The drawer's own close button returns the keyboard to the dock.
  await dashboard.getByRole("button", { name: "Close the Backlog drawer" }).click();
  await expect(anyDrawer(dashboard)).toHaveCount(0);
  await expect(backlog).toBeFocused();

  // ---- with a session selected, Tab and Shift+Tab walk the dock ----
  // A rail row hands Tab to the reader and Shift+Tab to the permission mode. The dock's
  // buttons are ordinary controls, so the keyboard has to be able to move along them.
  await rail(dashboard).getByRole("button", { name: /give the console a rail/i }).click();
  await expect(dashboard.getByRole("tablist", { name: "Session detail" })).toBeVisible();
  await dockStage(dashboard, "Intake").focus();
  await dashboard.keyboard.press("Tab");
  await expect(backlog).toBeFocused();
  await dashboard.keyboard.press("Shift+Tab");
  await expect(dockStage(dashboard, "Intake")).toBeFocused();

  // ---- the folded rail keeps the stages at the foot of its strip ----
  await rail(dashboard).getByRole("button", { name: "Fold the session rail" }).click();
  await expect(rail(dashboard).getByRole("button", { name: /^Unfold All sessions/ })).toBeVisible();
  const folded = dockStage(dashboard, "Backlog");
  await expect(folded).toBeVisible();
  await folded.click();
  await expect(drawer(dashboard, "Backlog")).toContainText(title);
  await shoot(dashboard, "folded-rail-backlog-open");
  await dashboard.keyboard.press("Escape");
  await expect(anyDrawer(dashboard)).toHaveCount(0);
  await expect(folded).toBeFocused();

  // ---- a narrow window hides the rail's rows, but never the dock, folded or not ----
  const wide = dashboard.viewportSize()!;
  const narrowOpensBacklog = async (shot: string): Promise<void> => {
    await dashboard.setViewportSize({ width: 700, height: 800 });
    await expect(rail(dashboard).getByRole("button", { name: /give the console a rail/i })).toBeHidden();
    await expect(dockStage(dashboard, "Backlog")).toBeVisible();
    await dockStage(dashboard, "Backlog").click();
    await expect(drawer(dashboard, "Backlog")).toContainText(title);
    await shoot(dashboard, shot);
    await dashboard.keyboard.press("Escape");
    await expect(anyDrawer(dashboard)).toHaveCount(0);
    await dashboard.setViewportSize(wide);
  };
  await narrowOpensBacklog("narrow-folded-backlog-open");
  await rail(dashboard).getByRole("button", { name: /^Unfold All sessions/ }).click();
  await narrowOpensBacklog("narrow-backlog-open");

  // ---- switching the Line back on removes the dock: the strip is the door again ----
  await setLineHidden(dashboard, daemon, false);
  await expect(dashboard.getByRole("navigation", { name: "The Line" })).toBeVisible();
  await expect(dock(dashboard)).toHaveCount(0);
});

test("the See work tour borrows the strip, the dock stands down for it, and comes back after", async ({
  dashboard,
  daemon,
}) => {
  // With the Line off the tour draws the strip condensed for its first stop. For that stretch
  // the strip is the door to the drawers, so the dock must give way: two buttons for one
  // drawer would be two answers to which one is open, and the strip's would win the focus
  // registry. When the tour ends the strip goes, and the dock has to come back.
  await dashboard.emulateMedia({ reducedMotion: "reduce" });
  await setLineHidden(dashboard, daemon, true);
  const line = dashboard.getByRole("navigation", { name: "The Line" });
  await expect(line).toHaveCount(0);
  await expect(dock(dashboard)).toBeVisible();

  // ---- the tour starts and borrows the strip; the dock stands down ----
  const palette = dashboard.getByRole("dialog", { name: "Search everything" });
  await dashboard.keyboard.press("Meta+k");
  await expect(palette).toBeVisible();
  await palette.getByRole("combobox", { name: "Search everything" }).fill("See the work");
  await palette.getByRole("option", { name: /Start See the work tour, command/ }).click();
  const stop = dashboard
    .getByRole("dialog", { name: "Fleet and the Line" })
    .or(dashboard.getByRole("status", { name: "Fleet and the Line" }));
  await expect(stop).toBeVisible();
  await expect(line).toBeVisible();
  await expect(line.getByRole("button", { name: /^Backlog,/ })).toHaveCount(1);
  await expect(dock(dashboard)).toHaveCount(0);
  await shoot(dashboard, "tour-borrows-strip");

  // ---- the tour ends, the strip goes, and the dock is the door again ----
  await stop.getByRole("button", { name: "Exit tour" }).click();
  await expect(stop).toBeHidden();
  await expect(line).toHaveCount(0);
  await expect(dock(dashboard)).toBeVisible();
  await dockStage(dashboard, "Backlog").click();
  await expect(drawer(dashboard, "Backlog")).toBeVisible();
});
