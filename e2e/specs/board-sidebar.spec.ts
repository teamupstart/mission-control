import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

test.use({ daemonEnv: { MC_E2E_HOLD_FIRST_TURN: "1" } });

interface LiveSession {
  id: string;
  cwd: string;
  agentSessionId: string | null;
}

async function sessions(daemon: DaemonHandle): Promise<LiveSession[]> {
  const res = await fetch(`${daemon.baseURL}/api/sessions`);
  expect(res.ok).toBe(true);
  return res.json();
}

async function dispatch(page: Page, daemon: DaemonHandle, goal: string): Promise<LiveSession> {
  const before = new Set((await sessions(daemon)).map((s) => s.id));
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(goal);
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
  let fresh: LiveSession | undefined;
  await expect.poll(async () => {
    fresh = (await sessions(daemon)).find((s) => !before.has(s.id));
    return Boolean(fresh?.agentSessionId);
  }, { timeout: 60_000 }).toBe(true);
  return fresh!;
}

async function hook(daemon: DaemonHandle, session: LiveSession, event: string): Promise<void> {
  const res = await fetch(`${daemon.baseURL}/hooks/${event}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-harness-token": readFileSync(join(daemon.home, "token"), "utf8").trim(),
    },
    body: JSON.stringify({
      agent: "claude", cwd: session.cwd, sessionId: session.agentSessionId, env: {},
      message: "Claude needs your permission to use Bash", prompt: "carry on",
    }),
  });
  expect(res.status).toBe(204);
}

async function capture(page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  const dir = artifactsDir("board-sidebar");
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `${name}.png`) });
}

test("Board sidebar opts into all state groups, persists, navigates and returns to the overview", async ({ dashboard: page, daemon }) => {
  const first = await dispatch(page, daemon, "Check application routing");
  const second = await dispatch(page, daemon, "Review sidebar accessibility");
  await hook(daemon, first, "Notification");
  const backlog = await fetch(`${daemon.baseURL}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repoRoot: daemon.repo, title: "Pending sidebar task", intent: "Later work", backlog: true }),
  });
  expect(backlog.ok).toBe(true);
  await page.goto(`${daemon.baseURL}/#/settings/display`);
  await page.getByRole("radiogroup", { name: "Dashboard layout" }).getByRole("radio", { name: /^Board/ }).check();
  const toggle = page.getByRole("checkbox", { name: "Show all sessions in sidebar" });
  await expect(toggle).not.toBeChecked();

  // Existing default: only the clicked state appears in the rail.
  await page.goto(`${daemon.baseURL}/#/fleet`);
  await expect(page.locator(".bl-card", { hasText: "Pending sidebar task" })).toBeVisible();
  await page.locator(".board-col.tone-attention .tile-name").click();
  await expect(page.locator(".board-col.is-rail .rail-row")).toHaveCount(1);
  await page.getByRole("button", { name: "Back to the board" }).click();
  await expect(page.locator(".board-col.tone-working .tile")).toHaveCount(1);

  await page.goto(`${daemon.baseURL}/#/settings/display`);
  await toggle.check();
  await expect.poll(async () => {
    const res = await fetch(`${daemon.baseURL}/api/ui/config`);
    return (await res.json()).config.boardSidebarAllSessions;
  }).toBe(true);
  await capture(page, "setting");
  await page.reload();
  await expect(toggle).toBeChecked();
  await page.goto(`${daemon.baseURL}/#/fleet`);
  await page.locator(".board-col.tone-attention .tile-name").click();

  const rail = page.getByRole("navigation", { name: "Sessions", exact: true });
  await expect(rail.locator(".rail-row")).toHaveCount(2);
  await expect(rail.locator(".rail-group.tone-attention")).toContainText("needs you");
  await expect(rail.locator(".rail-group.tone-working")).toContainText("working");
  await expect(page.getByRole("region", { name: "Session detail workspace" })).toBeVisible();
  await expect(page.locator(".board-backlog")).toHaveCount(0);
  await capture(page, "all-states");

  // Vertical navigation crosses state groups and puts focus on the new row.
  await rail.locator(".rail-row").first().click();
  await page.keyboard.press("ArrowDown");
  await expect(rail.locator(".rail-row").nth(1)).toHaveClass(/selected/);
  await expect(rail.locator(".rail-row").nth(1)).toBeFocused();
  await expect(page.locator(".console-detail .detail-title")).toContainText(/Review Sidebar Accessibility/i);
  await page.keyboard.press("ArrowUp");
  await expect(rail.locator(".rail-row").first()).toHaveClass(/selected/);
  await rail.locator(".rail-row").nth(1).click();
  await expect(rail.locator(".rail-row").nth(1)).toHaveClass(/selected/);

  // A live state move regroups the rail without dropping the selected detail.
  await hook(daemon, second, "Notification");
  await expect(rail.locator(".rail-group.tone-working")).toHaveCount(0);
  await expect(rail.locator(".rail-row")).toHaveCount(2);
  await expect(rail.locator(".rail-row.selected")).toHaveCount(1);
  await hook(daemon, second, "UserPromptSubmit");
  await expect(rail.locator(".rail-group.tone-working")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".board-col.tone-working .tile")).toHaveCount(1);
  await page.locator(".board-col.tone-working .tile-name").click();
  await page.getByRole("button", { name: "Back to the board" }).click();
  await expect(page.locator(".board-col.tone-attention .tile")).toHaveCount(1);

  // Turning it off restores the original state-scoped sidebar.
  await page.goto(`${daemon.baseURL}/#/settings/display`);
  await toggle.uncheck();
  await expect.poll(async () => {
    const res = await fetch(`${daemon.baseURL}/api/ui/config`);
    return (await res.json()).config.boardSidebarAllSessions;
  }).toBe(false);
  await page.goto(`${daemon.baseURL}/#/fleet`);
  await page.locator(".board-col.tone-working .tile-name").click();
  await expect(page.locator(".board-col.is-rail .rail-row")).toHaveCount(1);
});

test("filtering an open session restores Board keyboard navigation until Enter opens a detail", async ({ dashboard: page, daemon }) => {
  const hidden = await dispatch(page, daemon, "Hidden routing investigation");
  const attention = await dispatch(page, daemon, "Keep prompt review");
  await dispatch(page, daemon, "Keep working session");
  await hook(daemon, hidden, "Notification");
  await hook(daemon, attention, "Notification");
  await page.goto(`${daemon.baseURL}/#/settings/display`);
  await page.getByRole("radiogroup", { name: "Dashboard layout" }).getByRole("radio", { name: /^Board/ }).check();
  await page.getByRole("checkbox", { name: "Show all sessions in sidebar" }).check();
  await page.goto(`${daemon.baseURL}/#/fleet`);
  await page.locator(".tile", { hasText: /Hidden routing investigation/i }).locator(".tile-name").click();
  const rail = page.getByRole("navigation", { name: "Sessions", exact: true });
  await expect(rail.locator(".rail-row")).toHaveCount(3);

  await page.locator(".filter-box").click();
  const filter = page.getByRole("textbox", { name: /Filter sessions/ });
  await filter.fill("Keep");
  await expect(rail).toHaveCount(0);
  // Clearing a filter without navigating still restores the original open detail.
  await filter.fill("");
  await expect(page.locator(".console-detail .detail-title")).toContainText(/Hidden Routing Investigation/i);
  await filter.fill("Keep");
  await expect(rail).toHaveCount(0);
  await expect(page.locator(".board-col.tone-attention .tile")).toHaveCount(1);
  await expect(page.locator(".board-col.tone-working .tile")).toHaveCount(1);
  await capture(page, "filtered-overview");

  // The hidden selection has no position in the filtered board. Arrow keys pick up and
  // move its tile cursor; only Enter promotes the new selection into an open detail.
  await page.locator("main.board").click({ position: { x: 4, y: 4 } });
  await page.keyboard.press("ArrowDown");
  await expect(page.locator(".board-col.tone-attention .tile.selected .tile-open")).toBeFocused();
  await expect(rail).toHaveCount(0);
  await page.keyboard.press("ArrowDown");
  await expect(page.locator(".board-col.tone-attention .tile.selected .tile-open")).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".board-col.tone-working .tile.selected .tile-open")).toBeFocused();
  await capture(page, "filtered-keyboard-selection");
  await page.keyboard.press("Enter");
  await expect(rail.locator(".rail-row")).toHaveCount(2);
  await expect(page.locator(".console-detail .detail-title")).toContainText(/Keep Working Session/i);
  await page.keyboard.press("ArrowUp");
  await expect(rail.locator(".rail-row").first()).toBeFocused();
  await expect(page.locator(".console-detail .detail-title")).toContainText(/Keep Prompt Review/i);
});

test("Board-only setting stays hidden in Console and rolls back a failed save", async ({ dashboard: page, daemon }) => {
  await page.goto(`${daemon.baseURL}/#/settings/display`);
  await page.getByRole("radiogroup", { name: "Dashboard layout" }).getByRole("radio", { name: /^Board/ }).check();
  const toggle = page.getByRole("checkbox", { name: "Show all sessions in sidebar" });
  await expect(toggle).toBeVisible();
  await toggle.hover();
  await expect(page.locator(".tooltip")).toHaveText("Show sessions from every state in the Board sidebar");
  await capture(page, "setting-tooltip");
  await toggle.check();
  await toggle.hover();
  await expect(page.locator(".tooltip")).toHaveText("Show only the selected session's state group");
  await toggle.uncheck();
  await page.getByRole("radio", { name: /^Console/ }).check();
  await expect(toggle).toHaveCount(0);
  await page.getByRole("radiogroup", { name: "Dashboard layout" }).getByRole("radio", { name: /^Board/ }).check();
  await page.route("**/api/ui/config", async (route) => {
    if (route.request().method() === "PUT" && "boardSidebarAllSessions" in route.request().postDataJSON()) {
      await route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"test refusal"}' });
    } else await route.continue();
  });
  await toggle.click();
  await expect(toggle).not.toBeChecked();
});
