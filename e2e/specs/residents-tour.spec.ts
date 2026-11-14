import { mkdirSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";

import { artifactsDir } from "../fixtures/artifacts.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { expectDashboardReady } from "../fixtures/dashboard-ready.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import { expectSpotlight } from "../fixtures/tour-spotlight.ts";
import { expect, test } from "../fixtures/test.ts";

/**
 * Meet your residents, driven through the real dashboard against a real daemon.
 *
 * The tour advertises the built-in Agent Shepherd, shows how a resident is duplicated or
 * authored, then opens the Residents drawer and points at its Pin. It writes nothing: no
 * profile is saved, no resident launches, and the stored pin is never touched. The last test
 * is the announcement: a profile that predates the tour sees the startup picker once more,
 * featuring it, even after opting out of the picker.
 */

const EVIDENCE = artifactsDir("residents-tour");
const TOUR_COMMAND = /Start Meet your residents tour, command/;
const SHEPHERD_HASH = "#/residents/builtin%3Aagent-shepherd";
const PICKER = "Explore Mission Control";

test.describe.configure({ timeout: 120_000 });

function tourStep(page: Page, title: string): Locator {
  return page.getByRole("dialog", { name: title }).or(page.getByRole("status", { name: title }));
}

const hash = (page: Page) => page.evaluate(() => location.hash);
const drawer = (page: Page) => page.getByRole("complementary", { name: "Residents", exact: true });
const residentsButton = (page: Page) => page.getByRole("button", { name: /^Residents - \d+ live$/ });

async function shoot(page: Page, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.screenshot({ path: `${EVIDENCE}${name}.png`, animations: "disabled" });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/residents-tour/${name}.png`);
}

async function uiConfig(daemon: DaemonHandle) {
  const response = await fetch(`${daemon.baseURL}/api/ui/config`);
  expect(response.ok).toBe(true);
  return (await response.json() as {
    config: {
      residentPlacement: string;
      residentDrawerPinned: boolean;
      showToursOnStartup: boolean;
      announcedTours: string[];
    };
  }).config;
}

async function putUiConfig(daemon: DaemonHandle, patch: object): Promise<void> {
  const response = await fetch(`${daemon.baseURL}/api/ui/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  expect(response.ok).toBe(true);
}

/**
 * Record every write the tour could make to a profile, a launch, a task or a tour recipe.
 *
 * Preferences are compared by value instead: finishing any tour replays the snapshot's layout,
 * and the layout setter persists what it is given even when it is unchanged.
 */
function recordWrites(page: Page): () => string[] {
  const writes: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "GET") return;
    const url = new URL(request.url());
    if (/^\/api\/(residents|tasks|tours)/.test(url.pathname)) {
      writes.push(`${request.method()} ${url.pathname} ${request.postData() ?? ""}`);
    }
  });
  return () => writes;
}

/**
 * Refuse every browser write of `announcedTours` with a 503, the way a daemon that cannot save
 * answers. Resolves once the first refusal has been sent; `release` lets writes through again.
 */
async function rejectAnnouncementWrites(page: Page): Promise<{
  rejected: Promise<void>;
  count: () => number;
  release: () => Promise<void>;
}> {
  let count = 0;
  let first!: () => void;
  const rejected = new Promise<void>((resolve) => { first = resolve; });
  await page.route("**/api/ui/config", async (route) => {
    const request = route.request();
    if (request.method() === "PUT" && "announcedTours" in (request.postDataJSON() ?? {})) {
      count += 1;
      await route.fulfill({ status: 503, json: { error: "temporarily unavailable" } });
      first();
    } else await route.continue();
  });
  return { rejected, count: () => count, release: () => page.unroute("**/api/ui/config") };
}

/** Every `announcedTours` write this page sends to the daemon, by method and body. */
function recordAnnouncementWrites(page: Page): () => string[] {
  const writes: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "GET" || !request.url().includes("/api/ui/config")) return;
    const body = request.postData() ?? "";
    if (body.includes("announcedTours")) writes.push(`${request.method()} ${body}`);
  });
  return () => writes;
}

/** The `announcedTours` this browser's own cache holds: where a refused write's rollback lands. */
const cachedAnnouncedTours = (page: Page) => page.evaluate(() =>
  (JSON.parse(localStorage.getItem("mission-control.ui") ?? "{}") as { announcedTours?: string[] })
    .announcedTours);

/** What this browser owes because the daemon refused the write that would have owed it there. */
const owedAnnouncements = (page: Page) => page.evaluate(() => Object.keys(
  (JSON.parse(localStorage.getItem("mission.tourAnnouncementsOwed") ?? "{}") as { owed?: object })
    .owed ?? {}));

const PREFERENCE_ERROR = "Could not save your tour preference";

async function startFromPalette(page: Page): Promise<void> {
  await page.keyboard.press("Meta+k");
  const palette = page.getByRole("dialog", { name: "Search everything" });
  await palette.getByRole("combobox").fill("Meet your residents");
  await palette.getByRole("option", { name: TOUR_COMMAND }).click();
}

test("the tour advertises Agent Shepherd, walks authoring, and hands over the open drawer", async ({
  dashboard: page,
  daemon,
}) => {
  // The shipped placement. The dashboard fixture pins Board and Console for older specs.
  await putUiConfig(daemon, { residentPlacement: "drawer" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.reload();
  await expectDashboardReady(page);
  const writes = recordWrites(page);
  const before = await uiConfig(daemon);

  // Discovery: the Settings rail's Help & tours footer draws a row for it from the registry.
  await page.goto(`${daemon.baseURL}/#/settings/display`);
  await page.getByRole("button", { name: "Start Meet your residents tour" }).click();

  let step = tourStep(page, "Agents that stay on the job");
  await expect(step).toBeVisible();
  await expect(step).toContainText("Step 1 of 10");
  await expect(step).toContainText("A resident is a long-running agent with a standing role.");
  // Behind the opening card is the page the next six stops read: the built-in, read-only.
  await expect.poll(() => hash(page)).toBe(SHEPHERD_HASH);

  await step.getByRole("button", { name: "Next" }).click();
  step = tourStep(page, "Agent Shepherd ships ready to launch");
  await expect(step).toBeVisible();
  await expect(step).toContainText("Unblocks stuck work");
  await expect(step).toContainText("Asks you when it matters");
  const rail = page.getByRole("complementary", { name: "Resident profiles" });
  const shepherdRow = rail.getByRole("button", { name: /^Agent Shepherd/ });
  await expectSpotlight(shepherdRow);
  await expect(shepherdRow).toHaveAttribute("aria-current", "true");
  await shoot(page, "residents-tour-agent-shepherd");

  await step.getByRole("button", { name: "Next" }).click();
  step = tourStep(page, "A profile is the resident's role");
  await expect(step).toBeVisible();
  await expect(step).toContainText("Loop and guardrails");
  const editor = page.getByRole("region", { name: "Resident profile Agent Shepherd" });
  await expectSpotlight(editor.locator(".resident-editor-head"));
  await expect(editor).toContainText("ships with Mission Control and is read-only");
  await shoot(page, "residents-tour-profile");

  await step.getByRole("button", { name: "Next" }).click();
  step = tourStep(page, "Make Agent Shepherd your own");
  await expect(step).toBeVisible();
  await expect(step).toContainText(
    "Duplicate Agent Shepherd to customize it for your specific use case. The shipped default is a good starting point.",
  );
  await expectSpotlight(editor.getByRole("button", { name: "Duplicate to edit" }));
  await shoot(page, "residents-tour-duplicate");

  await step.getByRole("button", { name: "Next" }).click();
  step = tourStep(page, "Or author one from scratch");
  await expect(step).toBeVisible();
  await expect(step).toContainText(
    "Create your own custom persona's and apply them to Residents. Keep your Resident's scoped to specific domains for best results and to avoid context bloat.",
  );
  await expectSpotlight(rail.getByRole("button", { name: "New", exact: true }));

  await step.getByRole("button", { name: "Next" }).click();
  step = tourStep(page, "How a resident keeps working");
  await expect(step).toBeVisible();
  await expectSpotlight(editor.getByRole("region", { name: "Loop and guardrails" }));
  await shoot(page, "residents-tour-loop");

  await step.getByRole("button", { name: "Next" }).click();
  step = tourStep(page, "Launch it");
  await expect(step).toBeVisible();
  await expectSpotlight(editor.getByRole("button", { name: "Launch", exact: true }));
  // Still on the built-in: no stop opened a copy or a blank profile.
  expect(await hash(page)).toBe(SHEPHERD_HASH);

  await step.getByRole("button", { name: "Next" }).click();
  step = tourStep(page, "Open the Residents sidebar");
  await expect(step).toBeVisible();
  await expect.poll(() => hash(page)).toBe("#/fleet");
  await expectSpotlight(residentsButton(page));
  await expect(drawer(page)).toBeHidden();
  await shoot(page, "residents-tour-open-sidebar");

  await step.getByRole("button", { name: "Open the sidebar" }).click();
  step = tourStep(page, "Every resident at a glance");
  await expect(step).toBeVisible();
  await expect(drawer(page)).toBeVisible();
  await expectSpotlight(drawer(page));
  // The drawer lists Agent Shepherd's profile to launch, and the tour launched nothing.
  await expect(drawer(page).getByRole("button", { name: /Launch/ }).first()).toBeVisible();
  await shoot(page, "residents-tour-sidebar");

  // Back puts away the drawer the tour opened, and Next opens it again.
  await step.getByRole("button", { name: "Back" }).click();
  await expect(tourStep(page, "Open the Residents sidebar")).toBeVisible();
  await expect(drawer(page)).toBeHidden();
  await tourStep(page, "Open the Residents sidebar").getByRole("button", { name: "Open the sidebar" }).click();
  await expect(drawer(page)).toBeVisible();

  step = tourStep(page, "Every resident at a glance");
  await step.getByRole("button", { name: "Next" }).click();
  step = tourStep(page, "Pin it open");
  await expect(step).toBeVisible();
  await expect(step).toContainText("Step 10 of 10");
  const pin = drawer(page).getByRole("button", { name: "Pin", exact: true });
  await expectSpotlight(pin);
  await expect(pin).toHaveAttribute("aria-pressed", "false");
  await shoot(page, "residents-tour-pin");

  await step.getByRole("button", { name: "Finish tour" }).click();
  await expect(step).toBeHidden();
  // Handed over: the fleet with the drawer still open beside it, unpinned, and the keyboard
  // on the button that opens and closes it.
  await expect.poll(() => hash(page)).toBe("#/fleet");
  await expect(drawer(page)).toBeVisible();
  await expect(residentsButton(page)).toBeFocused();
  await shoot(page, "residents-tour-handover");
  expect(writes()).toEqual([]);
  const config = await uiConfig(daemon);
  expect(config).toEqual(before);
  expect(config.residentDrawerPinned).toBe(false);
  expect(config.residentPlacement).toBe("drawer");
  expect(await (await fetch(`${daemon.baseURL}/api/tasks`)).json()).toEqual([]);

  // The Pin the tour pointed at is the real one, and it is the operator's to press.
  await pin.click();
  await expect(drawer(page).getByRole("button", { name: "Unpin", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => (await uiConfig(daemon)).residentDrawerPinned).toBe(true);
  await page.reload();
  await expect(drawer(page)).toBeVisible();
});

test("under Board and Console the tour borrows the drawer and gives it back", async ({
  dashboard: page,
  daemon,
}) => {
  // The dashboard fixture's placement: residents on the Board and Console, with the dock.
  expect((await uiConfig(daemon)).residentPlacement).toBe("fleet");
  await expect(drawer(page)).toBeHidden();
  await startFromPalette(page);
  for (const title of [
    "Agents that stay on the job",
    "Agent Shepherd ships ready to launch",
    "A profile is the resident's role",
    "Make Agent Shepherd your own",
    "Or author one from scratch",
    "How a resident keeps working",
    "Launch it",
    "Open the Residents sidebar",
    "Every resident at a glance",
  ]) {
    const stop = tourStep(page, title);
    await expect(stop).toBeVisible();
    await stop.getByRole("button", { name: /^(Next|Open the sidebar)$/ }).click();
  }
  const step = tourStep(page, "Pin it open");
  await expect(step).toBeVisible();
  await expect(drawer(page)).toBeVisible();
  await expectSpotlight(drawer(page).getByRole("button", { name: "Pin", exact: true }));
  await expect(step).toContainText("Settings > Display > Residents chooses where residents live");

  await step.getByRole("button", { name: "Exit tour" }).click();
  await expect(step).toBeHidden();
  await expect.poll(() => hash(page)).toBe("#/fleet");
  // Borrowed, not kept: the placement is unchanged and the drawer goes with the tour.
  await expect(drawer(page)).toBeHidden();
  const config = await uiConfig(daemon);
  expect(config.residentPlacement).toBe("fleet");
  expect(config.residentDrawerPinned).toBe(false);
  // Exit on the last stop is seeing it through, not dismissing it midway: still announced.
  expect(config.announcedTours).toEqual(["residents"]);
  // The top bar's button still opens the dock in this placement.
  await residentsButton(page).click();
  await expect(page.getByRole("button", { name: "Manage residents" })).toBeVisible();
  await expect(drawer(page)).toBeHidden();
});

test("a profile that opted out before the tour shipped is shown it once in the picker", async ({
  page,
  daemon,
}) => {
  // A record an older build wrote: it opted out of the startup picker, and it has no
  // `announcedTours`, because that key did not exist yet.
  withDaemonDb(daemon, (db) => {
    db.prepare(
      `INSERT INTO app_config (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    ).run("ui", JSON.stringify({ showToursOnStartup: false, residentPlacement: "drawer" }));
  });
  const picker = page.getByRole("dialog", { name: PICKER });
  await page.goto(`${daemon.baseURL}/#/fleet`);
  await expect(picker).toBeVisible();
  await expectContentClearsBorder(picker);
  await expect(picker).toContainText("New tour: Meet your residents.");
  // Featured: preselected, focused, and the only row marked New. Setup keeps its badge.
  const residents = picker.getByRole("radio", { name: "Meet your residents", exact: true });
  await expect(residents).toBeChecked();
  await expect(residents).toBeFocused();
  await expect(picker.getByText("New", { exact: true })).toHaveCount(1);
  await expect(picker.getByText("Recommended first")).toBeVisible();
  const preview = picker.getByRole("region", { name: "Meet your residents preview" });
  await expect(preview.getByRole("listitem")).toHaveText([
    "See what the built-in Agent Shepherd does for you",
    "Duplicate a resident to edit it, or author your own",
    "Open the Residents sidebar and pin it",
  ]);
  await expect(picker.getByText("10 stops", { exact: true })).toBeVisible();
  // The opt-out still reads as the operator left it.
  await expect(picker.getByRole("checkbox", { name: "Show tours when Mission Control opens" })).not.toBeChecked();
  await shoot(page, "residents-tour-announcement");

  // Opening it was the announcement: recorded, with the preference untouched.
  await expect.poll(async () => (await uiConfig(daemon)).announcedTours).toEqual(["residents"]);
  expect((await uiConfig(daemon)).showToursOnStartup).toBe(false);

  await picker.getByRole("button", { name: "Dismiss", exact: true }).click();
  await expect(picker).toBeHidden();
  await page.reload();
  await expectDashboardReady(page);
  // Back to honoring the opt-out.
  await expect(page.getByRole("button", { name: "Dispatch", exact: true })).toBeVisible();
  await expect(picker).toBeHidden();

  // Browse tours still offers it, now as an ordinary row.
  await page.keyboard.press("Meta+k");
  const palette = page.getByRole("dialog", { name: "Search everything" });
  await palette.getByRole("combobox").fill("Browse tours");
  await palette.getByRole("option", { name: /Browse tours, command/ }).click();
  await expect(picker).toBeVisible();
  await expect(picker.getByText("New", { exact: true })).toHaveCount(0);
  await expect(picker.getByRole("radio", { name: "Set up this machine", exact: true })).toBeChecked();
  await picker.getByRole("radio", { name: "Meet your residents", exact: true }).check();
  await picker.getByRole("button", { name: "Start this tour" }).click();
  await expect(tourStep(page, "Agents that stay on the job")).toBeVisible();
  await expect.poll(() => hash(page)).toBe(SHEPHERD_HASH);
});

test("dismissing the tour midway shows it again in the next window, and seeing it through does not", async ({
  dashboard: page,
  daemon,
}) => {
  // The dashboard fixture's profile: picker opted out, every tour already announced.
  const picker = page.getByRole("dialog", { name: PICKER });
  expect((await uiConfig(daemon)).announcedTours).toEqual(["residents"]);
  const writes = recordAnnouncementWrites(page);
  await startFromPalette(page);
  await tourStep(page, "Agents that stay on the job").getByRole("button", { name: "Next" }).click();
  const midway = tourStep(page, "Agent Shepherd ships ready to launch");
  await expect(midway).toContainText("Step 2 of 10");
  await midway.getByRole("button", { name: "Exit tour" }).click();
  await expect(midway).toBeHidden();
  // Dismissed midway: owed again in this browser. Nothing is sent to the daemon, whose record
  // still reads the tour as announced, and nothing else about the profile changes.
  await expect.poll(() => owedAnnouncements(page)).toEqual(["residents"]);
  await expect.poll(() => hash(page)).toBe("#/fleet");
  expect(writes()).toEqual([]);
  expect((await uiConfig(daemon)).announcedTours).toEqual(["residents"]);
  expect((await uiConfig(daemon)).showToursOnStartup).toBe(false);
  await expect(picker).toBeHidden();

  // The next window's startup picker features it again, past the opt-out.
  await page.reload();
  await expect(picker).toBeVisible();
  await expect(picker).toContainText("New tour: Meet your residents.");
  await expect(picker.getByRole("radio", { name: "Meet your residents", exact: true })).toBeChecked();
  await shoot(page, "residents-tour-shown-again");
  // Opening it is the announcement: saved, which settles this browser's debt.
  await expect.poll(() => owedAnnouncements(page)).toEqual([]);
  await picker.getByRole("button", { name: "Start this tour" }).click();

  // Seen through this time: every stop to Finish, which records nothing new to owe.
  for (const title of [
    "Agents that stay on the job",
    "Agent Shepherd ships ready to launch",
    "A profile is the resident's role",
    "Make Agent Shepherd your own",
    "Or author one from scratch",
    "How a resident keeps working",
    "Launch it",
    "Open the Residents sidebar",
    "Every resident at a glance",
  ]) {
    const stop = tourStep(page, title);
    await expect(stop).toBeVisible();
    await stop.getByRole("button", { name: /^(Next|Open the sidebar)$/ }).click();
  }
  const last = tourStep(page, "Pin it open");
  await last.getByRole("button", { name: "Finish tour" }).click();
  await expect(last).toBeHidden();
  expect((await uiConfig(daemon)).announcedTours).toEqual(["residents"]);
  await page.reload();
  await expectDashboardReady(page);
  await expect(page.getByRole("button", { name: "Dispatch", exact: true })).toBeVisible();
  await expect(picker).toBeHidden();
});

test("a refused announcement write leaves the tour owed, so the next window features it again", async ({
  page,
  daemon,
}) => {
  // The same pre-upgrade, opted-out record as above: owed the residents announcement.
  withDaemonDb(daemon, (db) => {
    db.prepare(
      `INSERT INTO app_config (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    ).run("ui", JSON.stringify({ showToursOnStartup: false, residentPlacement: "drawer" }));
  });
  const writes = await rejectAnnouncementWrites(page);
  const picker = page.getByRole("dialog", { name: PICKER });
  await page.goto(`${daemon.baseURL}/#/fleet`);
  await expect(picker).toBeVisible();
  await expect(picker).toContainText("New tour: Meet your residents.");
  await writes.rejected;
  expect(writes.count()).toBe(1);

  // Refused: nothing reached the daemon, and the browser rolled its optimistic copy back.
  expect((await uiConfig(daemon)).announcedTours).toEqual([]);
  await expect.poll(() => cachedAnnouncedTours(page)).toEqual([]);
  // The picker stays as it opened, featured, and the refusal is not reported as a broken
  // preference: the startup checkbox is untouched and no tour-preference alert appears.
  await expect(picker.getByRole("radio", { name: "Meet your residents", exact: true })).toBeChecked();
  await expect(page.getByText(PREFERENCE_ERROR)).toHaveCount(0);
  await picker.getByRole("button", { name: "Dismiss", exact: true }).click();
  await expect(picker).toBeHidden();
  await expect(page.getByText(PREFERENCE_ERROR)).toHaveCount(0);
  // Still one offer per document: the rolled-back announcement does not reopen it here, and
  // nothing retried the write behind the operator's back.
  await page.getByRole("navigation", { name: "Pages" }).getByRole("button", { name: /Library/ }).click();
  await expect(picker).toBeHidden();
  expect(writes.count()).toBe(1);

  // The next window is owed it still, and features it again; this time the write lands.
  await writes.release();
  await page.reload();
  await expect(picker).toBeVisible();
  await expect(picker).toContainText("New tour: Meet your residents.");
  await expect(picker.getByRole("radio", { name: "Meet your residents", exact: true })).toBeChecked();
  await expect.poll(async () => (await uiConfig(daemon)).announcedTours).toEqual(["residents"]);
  await picker.getByRole("button", { name: "Dismiss", exact: true }).click();
  await page.reload();
  await expectDashboardReady(page);
  await expect(page.getByRole("button", { name: "Dispatch", exact: true })).toBeVisible();
  await expect(picker).toBeHidden();
});

test("a midway dismissal in one window cannot undo another window's announcement", async ({
  dashboard: page,
  daemon,
  context,
}) => {
  // Window A leaves the tour midway. A whole-list write from it landing late could take the
  // tour back off `announcedTours` after window B had already announced it; there is no such
  // write to land, because the debt lives in this browser only.
  const writes = recordAnnouncementWrites(page);
  await startFromPalette(page);
  await tourStep(page, "Agents that stay on the job").getByRole("button", { name: "Next" }).click();
  const midway = tourStep(page, "Agent Shepherd ships ready to launch");
  await expect(midway).toBeVisible();
  await midway.getByRole("button", { name: "Exit tour" }).click();
  await expect(midway).toBeHidden();
  await expect.poll(() => owedAnnouncements(page)).toEqual(["residents"]);

  // Window B opens, features the tour, and records it; that settles the debt for this browser.
  const second = await context.newPage();
  const secondPicker = second.getByRole("dialog", { name: PICKER });
  await second.goto(`${daemon.baseURL}/#/fleet`);
  await expect(secondPicker).toBeVisible();
  await expect(secondPicker).toContainText("New tour: Meet your residents.");
  await expect.poll(() => owedAnnouncements(second)).toEqual([]);
  await secondPicker.getByRole("button", { name: "Dismiss", exact: true }).click();

  // Window A never sent anything that could arrive afterwards, so the announcement stands: the
  // daemon still reads it as seen, and the next window honors the opt-out.
  expect(writes()).toEqual([]);
  expect((await uiConfig(daemon)).announcedTours).toEqual(["residents"]);
  const third = await context.newPage();
  await third.goto(`${daemon.baseURL}/#/fleet`);
  await expectDashboardReady(third);
  await expect(third.getByRole("button", { name: "Dispatch", exact: true })).toBeVisible();
  await expect(third.getByRole("dialog", { name: PICKER })).toBeHidden();
  await third.close();

  // Window A still holds the copy of the debt it read when it owed it. Browse tours there
  // reads the shared debt afresh, so the settled tour is an ordinary row: not featured, not
  // tagged New, and not recorded a second time.
  await page.bringToFront();
  await page.keyboard.press("Meta+k");
  const palette = page.getByRole("dialog", { name: "Search everything" });
  await palette.getByRole("combobox").fill("Browse tours");
  await palette.getByRole("option", { name: /Browse tours, command/ }).click();
  const firstPicker = page.getByRole("dialog", { name: PICKER });
  await expect(firstPicker).toBeVisible();
  await expect(firstPicker.getByText("New", { exact: true })).toHaveCount(0);
  await expect(firstPicker).not.toContainText("New tour:");
  await expect(firstPicker.getByRole("radio", { name: "Set up this machine", exact: true })).toBeChecked();
  expect(writes()).toEqual([]);
  await firstPicker.getByRole("button", { name: "Dismiss", exact: true }).click();
  expect(writes()).toEqual([]);
  expect((await uiConfig(daemon)).announcedTours).toEqual(["residents"]);
});

test("a picker save still in flight cannot clear a midway dismissal made after it began", async ({
  page,
  daemon,
}) => {
  // A profile owed the announcement: the picker features the tour and writes the record.
  withDaemonDb(daemon, (db) => {
    db.prepare(
      `INSERT INTO app_config (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    ).run("ui", JSON.stringify({ showToursOnStartup: false, residentPlacement: "drawer" }));
  });
  // Hold that record write unanswered, as a slow daemon would.
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  let arrived!: () => void;
  const held = new Promise<void>((resolve) => { arrived = resolve; });
  await page.route("**/api/ui/config", async (route) => {
    const request = route.request();
    if (request.method() === "PUT" && "announcedTours" in (request.postDataJSON() ?? {})) {
      arrived();
      await released;
    }
    await route.continue();
  });
  const picker = page.getByRole("dialog", { name: PICKER });
  await page.goto(`${daemon.baseURL}/#/fleet`);
  await expect(picker).toBeVisible();
  await expect(picker).toContainText("New tour: Meet your residents.");
  await held;

  // While it is in flight, the operator starts the tour from that picker and leaves it midway.
  await picker.getByRole("button", { name: "Start this tour" }).click();
  await tourStep(page, "Agents that stay on the job").getByRole("button", { name: "Next" }).click();
  const midway = tourStep(page, "Agent Shepherd ships ready to launch");
  await expect(midway).toBeVisible();
  await midway.getByRole("button", { name: "Exit tour" }).click();
  await expect(midway).toBeHidden();
  await expect.poll(() => owedAnnouncements(page)).toEqual(["residents"]);

  // The held write now lands and is saved. It settles only what was owed when it began, which
  // was nothing in this browser, so the newer midway dismissal is still owed.
  const landed = page.waitForResponse((response) =>
    response.request().method() === "PUT" && response.url().includes("/api/ui/config"));
  release();
  expect((await landed).ok()).toBe(true);
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)));
  expect((await uiConfig(daemon)).announcedTours).toEqual(["residents"]);
  expect(await owedAnnouncements(page)).toEqual(["residents"]);
  await page.unroute("**/api/ui/config");

  // So the next window features it again, past the opt-out.
  await page.reload();
  await expect(picker).toBeVisible();
  await expect(picker).toContainText("New tour: Meet your residents.");
  await expect.poll(() => owedAnnouncements(page)).toEqual([]);
});

test("a startup opening that waited behind a dialog honors a debt another window settled", async ({
  dashboard: page,
  daemon,
  context,
}) => {
  // Window A owes the residents announcement from an earlier midway dismissal, and its saved
  // preference has the picker switched off: the debt is the only reason to open it.
  await page.evaluate(() => localStorage.setItem(
    "mission.tourAnnouncementsOwed",
    JSON.stringify({ seq: 1, owed: { residents: 1 } }),
  ));
  expect((await uiConfig(daemon)).showToursOnStartup).toBe(false);
  // Hold A's settings until a dialog is open, so its startup opening has to wait behind it.
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let holding = true;
  await page.route("**/api/ui/config", async (route) => {
    if (holding && route.request().method() === "GET") {
      holding = false;
      await held;
    }
    await route.continue();
  });
  await page.reload();
  await expectDashboardReady(page);
  await page.keyboard.press("Meta+k");
  const palette = page.getByRole("dialog", { name: "Search everything" });
  await expect(palette).toBeVisible();
  release();
  const picker = page.getByRole("dialog", { name: PICKER });
  await expect(picker).toBeHidden();

  // Meanwhile window B features the tour, records it, and settles the shared debt.
  const second = await context.newPage();
  const secondPicker = second.getByRole("dialog", { name: PICKER });
  await second.goto(`${daemon.baseURL}/#/fleet`);
  await expect(secondPicker).toBeVisible();
  await expect(secondPicker).toContainText("New tour: Meet your residents.");
  await expect.poll(() => owedAnnouncements(second)).toEqual([]);
  await second.close();

  // A's dialog closes. Its opening re-reads what is owed, finds nothing, and honors the opt-out
  // rather than opening an ordinary picker nobody asked for.
  await page.bringToFront();
  await page.keyboard.press("Escape");
  await expect(palette).toBeHidden();
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 500)));
  await expect(picker).toBeHidden();
  // Settled for the document: a later dialog closing does not open it either.
  await page.keyboard.press("Meta+k");
  await expect(palette).toBeVisible();
  await page.keyboard.press("Escape");
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)));
  await expect(picker).toBeHidden();
});

test("a startup opening that waited behind a dialog re-reads an announcement another window made", async ({
  page,
  daemon,
  context,
}) => {
  // A profile saved before the tour shipped, opted out of the picker: owed the announcement.
  withDaemonDb(daemon, (db) => {
    db.prepare(
      `INSERT INTO app_config (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    ).run("ui", JSON.stringify({ showToursOnStartup: false, residentPlacement: "drawer" }));
  });
  // Window A loads that record, but its settings arrive only once a dialog is open, so its
  // startup opening has to wait behind it.
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let holding = true;
  await page.route("**/api/ui/config", async (route) => {
    if (holding && route.request().method() === "GET") {
      holding = false;
      await held;
    }
    await route.continue();
  });
  const writes = recordAnnouncementWrites(page);
  await page.goto(`${daemon.baseURL}/#/fleet`);
  await expectDashboardReady(page);
  await page.keyboard.press("Meta+k");
  const palette = page.getByRole("dialog", { name: "Search everything" });
  await expect(palette).toBeVisible();
  release();
  await expect.poll(() => cachedAnnouncedTours(page)).toEqual([]);
  const picker = page.getByRole("dialog", { name: PICKER });
  await expect(picker).toBeHidden();

  // Window B opens, announces the tour, and records it with the daemon.
  const second = await context.newPage();
  const secondPicker = second.getByRole("dialog", { name: PICKER });
  await second.goto(`${daemon.baseURL}/#/fleet`);
  await expect(secondPicker).toBeVisible();
  await expect(secondPicker).toContainText("New tour: Meet your residents.");
  await expect.poll(async () => (await uiConfig(daemon)).announcedTours).toEqual(["residents"]);
  await second.close();

  // A's dialog closes. Its loaded record still says the tour is owed, but the opening confirms
  // with the daemon first, finds it announced, and honors the opt-out: no picker, no second write.
  await page.bringToFront();
  await page.keyboard.press("Escape");
  await expect(palette).toBeHidden();
  await expect.poll(() => cachedAnnouncedTours(page)).toEqual(["residents"]);
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)));
  await expect(picker).toBeHidden();
  expect(writes()).toEqual([]);
  expect((await uiConfig(daemon)).announcedTours).toEqual(["residents"]);
  expect((await uiConfig(daemon)).showToursOnStartup).toBe(false);
});

test.describe("a fresh profile", () => {
  // The product's own startup default: no preference pinned and no UI record written, so the
  // picker opens on its ordinary first-run path.
  test.use({ startupPicker: true });

  test("is offered the ordinary picker, not told a tour is new", async ({ page, daemon }) => {
    const before = await fetch(`${daemon.baseURL}/api/ui/config`);
    expect(((await before.json()) as { configured: boolean }).configured).toBe(false);
    const writes = recordAnnouncementWrites(page);
    const picker = page.getByRole("dialog", { name: PICKER });
    await page.goto(`${daemon.baseURL}/#/fleet`);
    await expect(picker).toBeVisible();
    // Every tour is news to someone opening the catalog for the first time, so none is
    // announced: no New tag, no "New tour:" header, and the recommendation is previewed.
    await expect(picker.getByRole("radio", { name: "Meet your residents", exact: true })).toBeVisible();
    await expect(picker.getByText("New", { exact: true })).toHaveCount(0);
    await expect(picker).not.toContainText("New tour:");
    await expect(picker.getByRole("radio", { name: "Set up this machine", exact: true })).toBeChecked();
    await expect(picker.getByRole("radio", { name: "Set up this machine", exact: true })).toBeFocused();
    await picker.getByRole("button", { name: "Dismiss", exact: true }).click();
    await expect(picker).toBeHidden();
    // Nothing was owed, so nothing was recorded.
    expect(writes()).toEqual([]);
    expect((await uiConfig(daemon)).announcedTours).toEqual(["residents"]);
  });
});
