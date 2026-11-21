import { mkdirSync } from "node:fs";

import type { Locator } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";

// Resident active hours, a preview feature: the days and hours a resident's loop may wake it.
// The editor draws the Active hours card only while the preview is on, a schedule saves with
// the profile, and a running resident whose next wake falls outside its window reads as asleep
// with the time its held wake goes out. No model tokens: every agent is the fixture fake.

const PERSONA_ID = "builtin:code-risk-reviewer";
const EVIDENCE = artifactsDir("residents-active-hours");

async function capture(target: Locator, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await target.page().mouse.move(0, 0);
  await target.screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/residents-active-hours/${name}.png`);
}

async function api<T>(daemon: DaemonHandle, path: string, body: unknown, method = "POST"): Promise<T> {
  const init: RequestInit = { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
  const response = await fetch(`${daemon.baseURL}${path}`, init);
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  return await response.json() as T;
}

const setActiveHours = (daemon: DaemonHandle, enabled: boolean) =>
  api(daemon, "/api/feature-flags", { kind: "flag", id: "resident-active-hours", enabled }, "PUT");

test("the Active hours card follows its preview flag live, and the schedule chosen in it is saved", async ({
  dashboard: page,
  context,
  daemon,
}) => {
  await page.setViewportSize({ width: 1500, height: 1100 });
  await page.goto(`${daemon.baseURL}/#/residents`);
  await page.getByRole("complementary", { name: "Resident profiles" }).getByRole("button", { name: "New" }).click();
  const editor = page.getByRole("region", { name: "New resident profile" });
  const card = editor.getByRole("region", { name: "Active hours", exact: true });
  await expect(editor.getByRole("region", { name: "Loop and guardrails", exact: true })).toBeVisible();
  await expect(card, "the preview is off by default, so the card is not drawn").toHaveCount(0);

  // Turning the preview on in Settings, in another window, draws the card here without a reload.
  const settings = await context.newPage();
  await settings.goto(`${daemon.baseURL}/#/settings/feature-flags`);
  await settings.getByRole("button", { name: /^Resident active hours:/ }).click();
  await expect(card).toBeVisible();

  // It takes the full-width band directly under the loop card.
  await expect(async () => {
    const loop = (await editor.getByRole("region", { name: "Loop and guardrails", exact: true }).boundingBox())!;
    const hours = (await card.boundingBox())!;
    expect(Math.abs(hours.x - loop.x)).toBeLessThan(2);
    expect(Math.abs(hours.width - loop.width)).toBeLessThan(2);
    expect(hours.y).toBeGreaterThan(loop.y + loop.height - 1);
    const mcp = (await editor.getByRole("region", { name: "MCP servers", exact: true }).boundingBox())!;
    expect(mcp.y).toBeGreaterThan(hours.y + hours.height - 1);
  }).toPass();

  // Off until chosen: the controls are dormant and the resident is always awake.
  const toggle = card.getByRole("checkbox", { name: "Sleep outside active hours" });
  await expect(toggle).not.toBeChecked();
  await expect(card.getByRole("button", { name: "Monday" })).toBeDisabled();
  await expect(card.getByRole("status")).toHaveText(/^Always awake/);

  await toggle.check();
  // Turning hours on names a zone, this browser's, rather than leaving the daemon's clock implied;
  // the unnamed choice stays available and claims no browser-derived zone.
  const zone = card.getByRole("combobox", { name: "Time zone" });
  await expect(zone).toHaveValue(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone));
  await expect(zone.locator('option[value=""]')).toHaveText("The Mission Control daemon's time zone");
  const days = card.getByRole("group", { name: "Active days" });
  for (const day of ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]) {
    await expect(days.getByRole("button", { name: day })).toHaveAttribute("aria-pressed", "true");
  }
  await expect(days.getByRole("button", { name: "Saturday" })).toHaveAttribute("aria-pressed", "false");
  await days.getByRole("button", { name: "Saturday" }).click();
  await expect(days.getByRole("button", { name: "Saturday" })).toHaveAttribute("aria-pressed", "true");
  await card.getByLabel("Wakes at").fill("08:30");
  await card.getByLabel("Sleeps at").fill("18:00");
  await card.getByRole("combobox", { name: "Time zone" }).selectOption("UTC");
  const week = card.getByRole("img", { name: /^Weekly active hours:/ });
  await expect(week).toHaveAttribute("aria-label", "Weekly active hours: Mon–Sat, 08:30–18:00 (UTC)");
  await expect(card.getByRole("status")).toHaveText(/^(Awake now, until .+|Asleep now\. Next window opens .+)\.$/);

  // Clearing every day is refused with the reason, then Weekdays restores Monday to Friday.
  for (const day of ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]) await days.getByRole("button", { name: day }).click();
  await editor.getByLabel("Name").fill("Office Hours");
  await editor.getByRole("combobox", { name: "Persona" }).selectOption(PERSONA_ID);
  await expect(editor.getByText("choose at least one day for active hours, or turn active hours off")).toBeVisible();
  await card.getByRole("button", { name: "Weekdays" }).click();
  await days.getByRole("button", { name: "Saturday" }).click();
  await expect(editor.getByText("choose at least one day for active hours, or turn active hours off")).toHaveCount(0);
  await capture(card, "01-active-hours-card");

  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(async () => {
    const response = await fetch(`${daemon.baseURL}/api/residents/profiles`);
    const profiles = await response.json() as Array<{ name: string; settings: { schedule: unknown } }>;
    return profiles.find((profile) => profile.name === "Office Hours")?.settings.schedule;
  }).toEqual({ enabled: true, days: [1, 2, 3, 4, 5, 6], start: "08:30", end: "18:00", timeZone: "UTC" });

  // Reloaded, the saved profile reads back the same schedule.
  const profileRegion = page.getByRole("region", { name: "Resident profile Office Hours" });
  await expect(profileRegion).toContainText("Revision 1");
  await page.reload();
  const saved = profileRegion.getByRole("region", { name: "Active hours", exact: true });
  await expect(saved.getByRole("checkbox", { name: "Sleep outside active hours" })).toBeChecked();
  await expect(saved.getByRole("img", { name: /^Weekly active hours:/ })).toHaveAttribute("aria-label", "Weekly active hours: Mon–Sat, 08:30–18:00 (UTC)");

  // Turning the preview off hides the card again, and keeps what was saved.
  await settings.getByRole("button", { name: /^Resident active hours:/ }).click();
  await expect(saved).toHaveCount(0);
});

test("a running resident whose next wake falls outside its active hours reads as asleep until the window opens", async ({
  dashboard,
  daemon,
}) => {
  await setActiveHours(daemon, true);
  // A one-hour window that opens three hours from now, every day: the first wake, five minutes
  // after the opening turn, always falls outside it.
  const hhmm = (at: number) => new Date(at).toISOString().slice(11, 16);
  const opens = Date.now() + 3 * 3_600_000;
  const profile = await api<{ id: string }>(daemon, "/api/residents/profiles", {
    settings: {
      identity: { name: "Night Owl" },
      persona: { personaId: PERSONA_ID },
      workspace: { defaultRepoRoot: daemon.repo },
      execution: { model: "claude-fable-5" },
      schedule: { enabled: true, days: [0, 1, 2, 3, 4, 5, 6], start: hhmm(opens), end: hhmm(opens + 3_600_000), timeZone: "UTC" },
    },
  });
  await api(daemon, `/api/residents/profiles/${profile.id}/launch`, { repoRoot: daemon.repo, requestId: "active-hours-asleep" });
  const run = () => withDaemonDb(daemon, (db) => db.prepare(
    "SELECT loop_state, iteration, next_wake_at FROM resident_runs WHERE ended_at IS NULL AND launch_state = 'launched'",
  ).get() as { loop_state: string; iteration: number; next_wake_at: number | null } | undefined);
  await expect.poll(() => {
    const row = run();
    return row?.loop_state === "waiting" && row.next_wake_at !== null;
  }, { timeout: 60_000 }).toBe(true);

  await dashboard.goto(`${daemon.baseURL}/#/fleet`);
  await dashboard.getByRole("button", { name: "Residents - 1 live", exact: true }).click();
  const dock = dashboard.getByRole("dialog", { name: "Residents", exact: true });
  const tags = dock.locator("li.residents-pop-card").getByLabel("Resident loop status").locator(".resident-loop-tag");
  await expect(tags.nth(0)).toHaveText("asleep");
  await expect(tags.nth(1)).toHaveText("iteration 1");
  const openingTime = (() => {
    const local = new Date(Math.floor(opens / 60_000) * 60_000);
    return `${String(local.getHours()).padStart(2, "0")}:${String(local.getMinutes()).padStart(2, "0")}`;
  })();
  await expect(tags.nth(2)).toHaveText(new RegExp(`^wakes (\\w{3} )?${openingTime}$`));
  await capture(dock, "02-dock-asleep");
  // Asleep is not paused: the run is still running and its due wake is unchanged.
  expect(run()!.loop_state).toBe("waiting");
  expect(run()!.iteration).toBe(1);

  // With the preview off the same resident reads as waiting on its ordinary countdown.
  await setActiveHours(daemon, false);
  await expect(tags.nth(0)).toHaveText("waiting");
  await expect(tags.nth(2)).toHaveText(/^next in \d+(s|m)$/);
});

test("inside its window a resident whose next wake falls after the window closes reads as waiting, not asleep", async ({
  dashboard,
  daemon,
}) => {
  await setActiveHours(daemon, true);
  // A window that opened an hour ago and closes about four minutes from now: the resident is
  // awake for the whole test, but its first wake, five minutes after the opening turn, is held.
  const hhmm = (at: number) => new Date(at).toISOString().slice(11, 16);
  const profile = await api<{ id: string }>(daemon, "/api/residents/profiles", {
    settings: {
      identity: { name: "Late Shift" },
      persona: { personaId: PERSONA_ID },
      workspace: { defaultRepoRoot: daemon.repo },
      execution: { model: "claude-fable-5" },
      schedule: { enabled: true, days: [0, 1, 2, 3, 4, 5, 6], start: hhmm(Date.now() - 3_600_000), end: hhmm(Date.now() + 4 * 60_000), timeZone: "UTC" },
    },
  });
  await api(daemon, `/api/residents/profiles/${profile.id}/launch`, { repoRoot: daemon.repo, requestId: "active-hours-awake-held" });
  await expect.poll(() => withDaemonDb(daemon, (db) => (db.prepare(
    "SELECT loop_state, next_wake_at FROM resident_runs WHERE ended_at IS NULL AND launch_state = 'launched'",
  ).get() as { loop_state: string; next_wake_at: number | null } | undefined)?.next_wake_at ?? null), { timeout: 60_000 }).not.toBeNull();

  await dashboard.goto(`${daemon.baseURL}/#/fleet`);
  await dashboard.getByRole("button", { name: "Residents - 1 live", exact: true }).click();
  const dock = dashboard.getByRole("dialog", { name: "Residents", exact: true });
  const tags = dock.locator("li.residents-pop-card").getByLabel("Resident loop status").locator(".resident-loop-tag");
  await expect(tags.nth(0), "still inside its window: awake, not asleep").toHaveText("waiting");
  await expect(tags.nth(2), "its held wake goes out when the next window opens").toHaveText(/^wakes (\w{3} )?\d{2}:\d{2}$/);
  await capture(dock, "03-dock-awake-held");
});

test("outside its window a resident whose next wake is already due inside the next window reads as asleep", async ({
  dashboard,
  daemon,
}) => {
  await setActiveHours(daemon, true);
  // The window opens three hours from now; the cadence puts the first wake three and a half hours
  // out, inside that window. Nothing is held, yet the resident is asleep until the window opens.
  const hhmm = (at: number) => new Date(at).toISOString().slice(11, 16);
  const opens = Date.now() + 3 * 3_600_000;
  const profile = await api<{ id: string }>(daemon, "/api/residents/profiles", {
    settings: {
      identity: { name: "Early Bird" },
      persona: { personaId: PERSONA_ID },
      workspace: { defaultRepoRoot: daemon.repo },
      execution: { model: "claude-fable-5" },
      loop: { delaySeconds: 12_600 },
      schedule: { enabled: true, days: [0, 1, 2, 3, 4, 5, 6], start: hhmm(opens), end: hhmm(opens + 3_600_000), timeZone: "UTC" },
    },
  });
  await api(daemon, `/api/residents/profiles/${profile.id}/launch`, { repoRoot: daemon.repo, requestId: "active-hours-asleep-due-inside" });
  const nextWakeAt = () => withDaemonDb(daemon, (db) => (db.prepare(
    "SELECT next_wake_at FROM resident_runs WHERE ended_at IS NULL AND launch_state = 'launched'",
  ).get() as { next_wake_at: number | null } | undefined)?.next_wake_at ?? null);
  await expect.poll(nextWakeAt, { timeout: 60_000 }).not.toBeNull();
  const due = new Date(nextWakeAt()!);
  const dueTime = `${String(due.getHours()).padStart(2, "0")}:${String(due.getMinutes()).padStart(2, "0")}`;

  await dashboard.goto(`${daemon.baseURL}/#/fleet`);
  await dashboard.getByRole("button", { name: "Residents - 1 live", exact: true }).click();
  const dock = dashboard.getByRole("dialog", { name: "Residents", exact: true });
  const tags = dock.locator("li.residents-pop-card").getByLabel("Resident loop status").locator(".resident-loop-tag");
  await expect(tags.nth(0), "outside its window: asleep, though its wake is not held").toHaveText("asleep");
  await expect(tags.nth(2), "the wake goes out at its own time, inside the next window").toHaveText(new RegExp(`^wakes (\\w{3} )?${dueTime}$`));
  await capture(dock, "04-dock-asleep-due-inside");
});

test("turning the preview off while the schedule blocks saving keeps the card, so the draft can still be repaired and saved", async ({
  dashboard: page,
  context,
  daemon,
}) => {
  await setActiveHours(daemon, true);
  await page.setViewportSize({ width: 1500, height: 1100 });
  await page.goto(`${daemon.baseURL}/#/residents`);
  await page.getByRole("complementary", { name: "Resident profiles" }).getByRole("button", { name: "New" }).click();
  const editor = page.getByRole("region", { name: "New resident profile" });
  await editor.getByLabel("Name").fill("Repairable");
  await editor.getByRole("combobox", { name: "Persona" }).selectOption(PERSONA_ID);
  const card = editor.getByRole("region", { name: "Active hours", exact: true });
  await card.getByRole("checkbox", { name: "Sleep outside active hours" }).check();
  const days = card.getByRole("group", { name: "Active days" });
  for (const day of ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]) await days.getByRole("button", { name: day }).click();
  const problem = editor.getByText("choose at least one day for active hours, or turn active hours off");
  await expect(problem).toBeVisible();

  const settings = await context.newPage();
  await settings.goto(`${daemon.baseURL}/#/settings/feature-flags`);
  const flag = settings.getByRole("button", { name: /^Resident active hours:/ });
  await expect(flag).toHaveAttribute("aria-pressed", "true");
  await flag.click();
  await expect(flag).toHaveAttribute("aria-pressed", "false");

  // The preview is off, but the card holds the error that blocks saving, so it stays to fix it.
  await expect(card).toBeVisible();
  await expect(problem).toBeVisible();
  await days.getByRole("button", { name: "Monday" }).click();
  await expect(problem).toHaveCount(0);
  await expect(card, "repaired, the hidden preview section goes away").toHaveCount(0);
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("region", { name: "Resident profile Repairable" })).toContainText("Revision 1");
});
