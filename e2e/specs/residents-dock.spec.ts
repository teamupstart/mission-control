import { mkdirSync } from "node:fs";

import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";

// Residents are easy to find: a resident launched from the top bar's Residents dock glows in
// its profile's color with its label, sits at the top of its Board column ahead of a session
// that would otherwise sort first, carries a band in the Console header, and loses only its
// ink - not its pin - when Settings > Display hides the marker. No model tokens are spent:
// every agent binary is the fake from `fixtures/fake-agents.ts`.

const PERSONA = "Code Risk Reviewer";
// "Zulu" sorts after every name the neighbour session can get, so the alphabetical baseline
// would put the resident LAST in its column: first place is the pin's doing, not the alphabet's.
const PROFILE = "Zulu Watch";
const LABEL = "ZULU";
const EVIDENCE = artifactsDir("residents-dock");

async function capture(target: Page | Locator, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  if ("mouse" in target) await target.mouse.move(0, 0);
  await target.screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/residents-dock/${name}.png`);
}

async function api<T>(daemon: DaemonHandle, path: string): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`);
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  return await response.json() as T;
}

interface LiveSession {
  id: string;
  name: string;
  state: string;
  task: { id: string; kind: string } | null;
}

/** Dispatch one ordinary agent and wait for it to settle idle, so it shares the resident's column. */
async function dispatchNeighbour(page: Page, daemon: DaemonHandle): Promise<LiveSession> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill("audit the alpha column");
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
  let session: LiveSession | undefined;
  await expect.poll(async () => {
    session = (await api<LiveSession[]>(daemon, "/api/sessions")).find((s) => s.task?.kind === "ship");
    return session?.state ?? null;
  }, { timeout: 60_000 }).toBe("idle");
  return session!;
}

/** Author the profile on #/residents, choosing its marker color and label in the editor. */
async function authorProfile(page: Page, daemon: DaemonHandle): Promise<void> {
  await page.goto(`${daemon.baseURL}/#/residents`);
  const rail = page.getByRole("complementary", { name: "Resident profiles" });
  await rail.getByRole("button", { name: "New" }).click();
  const editor = page.getByRole("region", { name: "New resident profile" });
  await editor.getByLabel("Name").fill(PROFILE);
  await editor.getByRole("combobox", { name: "Persona" }).selectOption({ label: `${PERSONA} · built-in` });
  await editor.getByLabel("Default repository").fill(daemon.repo);
  await page.keyboard.press("Escape");

  const colors = editor.getByRole("radiogroup", { name: "Marker color" });
  await expect(colors.getByRole("radio", { name: "Cyan" })).toHaveAttribute("aria-checked", "true");
  await colors.getByRole("radio", { name: "Violet" }).click();
  await expect(colors.getByRole("radio", { name: "Violet" })).toHaveAttribute("aria-checked", "true");
  // The label defaults from the name until the operator types one.
  const label = editor.getByLabel("Marker label");
  await expect(label).toHaveAttribute("placeholder", "ZW");
  await label.fill(LABEL);
  await expect(editor.getByRole("checkbox", { name: "Pin to top of column" })).toBeChecked();
  await editor.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("region", { name: `Resident profile ${PROFILE}` })).toContainText("Revision 1");
  await capture(page.locator("main.residents-page"), "01-board-presence-section");
}

/** Put the dashboard in the Board layout, where the cards and their columns are drawn. */
async function useBoardLayout(page: Page, daemon: DaemonHandle): Promise<void> {
  const response = await fetch(`${daemon.baseURL}/api/ui/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ layout: "board" }),
  });
  expect(response.ok).toBe(true);
  await page.reload();
  await expect(page.locator("main.board")).toBeVisible();
}

test("a resident launched from the dock glows, pins to the top of its column, carries a Console band, and keeps its pin when the marker is hidden", async ({
  dashboard,
  daemon,
}) => {
  const neighbour = await dispatchNeighbour(dashboard, daemon);
  await authorProfile(dashboard, daemon);
  await dashboard.goto(`${daemon.baseURL}/#/fleet`);

  // The button beside Foreman, with nothing live yet.
  const topbar = dashboard.locator("header.topbar");
  const dockButton = topbar.getByRole("button", { name: /^Residents - \d+ live$/ });
  await expect(dockButton).toHaveAccessibleName("Residents - 0 live");
  const foremanBox = await topbar.locator(".foremanbar").boundingBox();
  const dockBox = await dockButton.boundingBox();
  expect(dockBox!.x, "the Residents button sits immediately after Foreman").toBeGreaterThan(foremanBox!.x + foremanBox!.width - 1);
  await expect(topbar.locator(".foremanbar + .residents-dock")).toHaveCount(1);

  await dockButton.click();
  const dock = dashboard.getByRole("dialog", { name: "Residents" });
  await expect(dock).toContainText("No residents are running");
  await capture(dashboard, "02-dock-empty");

  // Launch through the dock: one click, in the profile's default repository.
  await dock.getByRole("button", { name: `Launch ${PROFILE}` }).click();
  await expect(dock.getByRole("button", { name: `Open ${PROFILE}` })).toBeEnabled({ timeout: 60_000 });
  await expect(dockButton).toHaveAccessibleName("Residents - 1 live");
  await expect(dock.locator(".residents-pop-row").first().locator(".resident-chip")).toContainText(LABEL);

  let resident: LiveSession | undefined;
  await expect.poll(async () => {
    resident = (await api<LiveSession[]>(daemon, "/api/sessions")).find((s) => s.task?.kind === "resident");
    return resident?.state ?? null;
  }, { timeout: 60_000 }).toBe("idle");
  await expect(dock.locator(".residents-pop-row").first()).toContainText("idle");
  await capture(dashboard, "03-dock-live");
  await dashboard.keyboard.press("Escape");
  await expect(dock).toBeHidden();

  // The Board: both cards in the idle column, the resident first though it sorts last by name.
  await useBoardLayout(dashboard, daemon);
  const idle = dashboard.locator("main.board section.board-col.tone-idle");
  const tiles = idle.locator(".tile");
  await expect(tiles).toHaveCount(2);
  expect(PROFILE.localeCompare(neighbour.name), "the neighbour would sort first without the pin").toBeGreaterThan(0);
  await expect(tiles.nth(0).locator(".tile-name")).toHaveText(PROFILE);
  await expect(tiles.nth(1).locator(".tile-name")).toHaveText(neighbour.name);
  // The glow: a resident class, the violet token as `--resident`, a chip with its label - and
  // the tone spine still the state's, untouched.
  await expect(tiles.nth(0)).toHaveClass(/\bis-resident\b/);
  await expect(tiles.nth(1)).not.toHaveClass(/\bis-resident\b/);
  await expect(tiles.nth(0).getByRole("img", { name: /^Resident Zulu Watch \(revision 1\), pinned/ })).toBeVisible();
  await expect(tiles.nth(0).locator(".resident-chip")).toHaveText(`⤒${LABEL}`);
  const glow = await tiles.nth(0).evaluate((el) => {
    const style = getComputedStyle(el);
    const root = getComputedStyle(document.documentElement);
    return {
      accent: style.getPropertyValue("--resident").trim(),
      violet: root.getPropertyValue("--resident-violet").trim(),
      shadow: style.boxShadow,
      spine: getComputedStyle(el, "::before").backgroundColor,
    };
  });
  // `--resident` resolves to the violet palette TOKEN, never an arbitrary value.
  expect(glow.violet).toBe("#b083f0");
  expect(glow.accent).toBe(glow.violet);
  expect(glow.shadow).toContain("18px");
  const neighbourSpine = await tiles.nth(1).evaluate((el) => getComputedStyle(el, "::before").backgroundColor);
  expect(glow.spine, "the tone spine is the state's color, not the marker's").toBe(neighbourSpine);
  await capture(dashboard, "04-board-glow-pinned");

  // Open from the dock: the Console header carries the resident band.
  await dashboard.getByRole("button", { name: "Residents - 1 live" }).click();
  await dock.getByRole("button", { name: `Open ${PROFILE}` }).click();
  await expect(dock).toBeHidden();
  const band = dashboard.getByRole("group", { name: `Resident ${PROFILE}` });
  await expect(band).toBeVisible();
  await expect(band).toContainText(`${PERSONA} · revision 1 · pinned`);
  await expect(band.locator(".resident-chip")).toContainText(LABEL);
  // The board's drill-in detail is narrow: the band wraps rather than clipping its action.
  // Polled, because Open starts the drill-in morph and the pane widens over a transition; a
  // single read can land mid-animation, on a pane no layout could fit a button into.
  await expect.poll(async () => band.evaluate((el) => {
    const action = el.querySelector("button")!.getBoundingClientRect();
    const host = (el.closest(".cdetail") ?? el.parentElement!).getBoundingClientRect();
    return action.width > 20 && action.right <= host.right + 0.5;
  }), { message: "the band's Profile button is drawn inside the detail pane once it settles" }).toBe(true);

  // The profile is edited in another window while the resident runs: the band says so, and in
  // this narrow pane the note wraps onto its own line rather than running past the edge.
  type Stored = { id: string; name: string; revision: number; settings: { instructions: { markdown: string } } & Record<string, unknown> };
  const stored = (await api<Stored[]>(daemon, "/api/residents/profiles")).find((p) => p.name === PROFILE)!;
  const edited = await fetch(`${daemon.baseURL}/api/residents/profiles/${stored.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      expectedRevision: stored.revision,
      settings: { ...stored.settings, instructions: { markdown: "Edited in another window." } },
    }),
  });
  expect(edited.status).toBe(200);
  const changed = band.getByRole("status");
  await expect(changed).toHaveText(`Profile changed since launch (now revision ${stored.revision + 1})`);
  // Narrower than the note's one-line width (about 256px): the width a Console detail pane is
  // left with when its rail is dragged wide. Set on the pane itself so the claim is about how
  // the band lays out at that width, whatever window the runner happens to have.
  const pane = band.locator("xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' cdetail ')][1]");
  await pane.evaluate((el) => {
    (el as HTMLElement).style.width = "220px";
    (el as HTMLElement).style.maxWidth = "220px";
  });
  await expect.poll(() => changed.evaluate((el) => {
    const note = el.getBoundingClientRect();
    const host = el.closest(".cdetail")!.getBoundingClientRect();
    const owner = el.closest(".resident-band")!.getBoundingClientRect();
    // Inside the pane across, inside its own band down - the band grows to hold it rather than
    // leaving it under the tab strip - and actually the thing painted where it sits.
    const hit = document.elementFromPoint(note.left + note.width / 2, note.top + note.height / 2);
    return note.width > 20
      && note.left >= host.left - 0.5 && note.right <= host.right + 0.5
      && note.top >= owner.top - 0.5 && note.bottom <= owner.bottom + 0.5
      && hit !== null && (hit === el || el.contains(hit));
  }), { message: "the changed-profile note wraps inside a 220px detail pane and stays visible" }).toBe(true);
  await capture(band, "05b-console-band-profile-changed-narrow");
  await pane.evaluate((el) => {
    (el as HTMLElement).style.width = "";
    (el as HTMLElement).style.maxWidth = "";
  });
  // The drilled-in rail row carries the accent edge too, and leads its column like the tile.
  const railRows = dashboard.locator(".rail-row");
  await expect(railRows.first()).toHaveClass(/\bis-resident\b/);
  await capture(dashboard, "05-console-band");

  // The band's Profile button and the dock's Manage residents both reach #/residents.
  await band.getByRole("button", { name: "Profile" }).click();
  await expect(dashboard).toHaveURL(/#\/residents\/[^/]+$/);
  await dashboard.goto(`${daemon.baseURL}/#/fleet`);
  await dashboard.getByRole("button", { name: "Residents - 1 live" }).click();
  await dock.getByRole("button", { name: "Manage residents" }).click();
  await expect(dashboard).toHaveURL(`${daemon.baseURL}/#/residents`);
  await expect(dock).toBeHidden();

  // Settings > Display hides the marker: the ink goes, the pin stays.
  await dashboard.goto(`${daemon.baseURL}/#/settings/display`);
  const marker = dashboard.getByRole("checkbox", { name: "Resident marker", exact: true });
  await expect(marker).toBeChecked();
  await marker.uncheck();
  // Reloaded so the Board is back on its columns: Open drilled the board into the resident.
  await dashboard.goto(`${daemon.baseURL}/#/fleet`);
  await dashboard.reload();
  await expect(tiles).toHaveCount(2);
  await expect(tiles.nth(0).locator(".tile-name")).toHaveText(PROFILE);
  await expect(idle.locator(".tile.is-resident")).toHaveCount(0);
  await expect(idle.locator(".resident-chip")).toHaveCount(0);
  await capture(dashboard, "06-marker-hidden-still-pinned");

  await dashboard.goto(`${daemon.baseURL}/#/settings/display`);
  await marker.check();
  await dashboard.goto(`${daemon.baseURL}/#/fleet`);
  await expect(idle.locator(".tile.is-resident")).toHaveCount(1);
});

test("the dock opens from its chord and from the palette, lists profiles, and a profile with no repository launches through Dispatch", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.goto(`${daemon.baseURL}/#/residents`);
  const rail = dashboard.getByRole("complementary", { name: "Resident profiles" });
  await rail.getByRole("button", { name: "New" }).click();
  const editor = dashboard.getByRole("region", { name: "New resident profile" });
  await editor.getByLabel("Name").fill("Docs Gardener");
  await editor.getByRole("combobox", { name: "Persona" }).selectOption({ label: `${PERSONA} · built-in` });
  await editor.getByRole("button", { name: "Save" }).click();
  await expect(dashboard.getByRole("region", { name: "Resident profile Docs Gardener" })).toContainText("Revision 1");

  await dashboard.goto(`${daemon.baseURL}/#/fleet`);
  await dashboard.locator("body").click({ position: { x: 5, y: 300 } });
  await dashboard.keyboard.press("Shift+H");
  const dock = dashboard.getByRole("dialog", { name: "Residents" });
  await expect(dock).toBeVisible();
  // Opened from the keyboard, focus is inside the dock.
  await expect(dock.locator(":focus")).toHaveCount(1);
  await expect(dock).toContainText("Docs Gardener");
  await dashboard.keyboard.press("Escape");
  await expect(dock).toBeHidden();
  // Escape hands focus back to the button the dock hangs off, not to the page body.
  await expect(dashboard.getByRole("button", { name: /^Residents - \d+ live$/ })).toBeFocused();

  await dashboard.keyboard.press("Meta+K");
  const palette = dashboard.getByRole("dialog").filter({ has: dashboard.getByRole("combobox") }).first();
  await dashboard.keyboard.type("Residents dock");
  // The command row, not the shortcut row of the same name, which opens its binding instead.
  await dashboard.getByRole("option", { name: "Open the Residents dock, command" }).click();
  await expect(palette).toBeHidden();
  await expect(dock).toBeVisible();

  // No default repository: Launch… hands the choice to Dispatch > Resident, on this profile.
  await dock.getByRole("button", { name: "Launch Docs Gardener" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog.getByRole("radio", { name: "Resident" })).toHaveAttribute("aria-checked", "true");
  await expect(dialog.getByRole("radio", { name: /Docs Gardener/ })).toHaveAttribute("aria-checked", "true");
  await expect(dialog.getByRole("combobox", { name: "Repository" })).toHaveValue("");
  await expect(dialog.getByRole("button", { name: "Launch resident" })).toBeEnabled();
});

/** Every launch request the page sends, polling replays included, and every answer it reads. */
function watchLaunches(page: Page): { sent: Array<Record<string, unknown>>; answered: string[] } {
  const sent: Array<Record<string, unknown>> = [];
  const answered: string[] = [];
  const isLaunch = (url: string, method: string) =>
    method === "POST" && /\/api\/residents\/profiles\/[^/]+\/launch$/.test(url);
  page.on("request", (request) => {
    if (isLaunch(request.url(), request.method())) sent.push(request.postDataJSON() as Record<string, unknown>);
  });
  page.on("response", async (response) => {
    if (!isLaunch(response.url(), response.request().method())) return;
    const body = await response.json().catch(() => ({})) as { state?: string };
    answered.push(body.state ?? `http ${response.status()}`);
  });
  return { sent, answered };
}

async function residentTaskCount(daemon: DaemonHandle): Promise<number> {
  return (await api<Array<{ kind: string }>>(daemon, "/api/tasks")).filter((task) => task.kind === "resident").length;
}

test.describe("a dock launch that is still starting, or whose answer is lost", () => {
  // Every launch answers "still starting" at once, so the dock's replay loop is the path taken.
  test.use({ daemonEnv: { MISSION_RESIDENT_LAUNCH_WAIT_MS: "0" } });

  test("replays a still-starting launch under one request id, and a lost answer is retried, never doubled", async ({
    dashboard,
    daemon,
  }) => {
    await authorProfile(dashboard, daemon);
    await dashboard.goto(`${daemon.baseURL}/#/fleet`);
    const { sent, answered } = watchLaunches(dashboard);
    const dockButton = dashboard.getByRole("button", { name: /^Residents - \d+ live$/ });
    const dock = dashboard.getByRole("dialog", { name: "Residents" });
    const launch = dock.getByRole("button", { name: `Launch ${PROFILE}` });

    // 1. Still starting: the daemon's first answer is "pending" and the dock replays the SAME
    //    request until the run has started - one resident, however many replays it took.
    //    The replays are held at the network until the row's in-progress state has been read,
    //    so "starting…" and the disabled Launch are asserted, not raced: the first answer is
    //    delivered (it is the pending one), every later request waits for `release`.
    const launchRoute = /\/api\/residents\/profiles\/[^/]+\/launch$/;
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let routed = 0;
    await dashboard.route(launchRoute, async (route) => {
      routed += 1;
      if (routed > 1) await held;
      await route.continue();
    });
    await dockButton.click();
    await launch.click();
    // The pending answer has arrived and its first replay is being held.
    await expect.poll(() => routed, { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
    expect(answered).toEqual(["pending"]);
    // `has` resolves its locator relative to each row, so it is rooted at the page rather than
    // at the dialog the rows are already inside.
    const row = dock.locator(".residents-pop-row")
      .filter({ has: dashboard.getByRole("button", { name: `Launch ${PROFILE}` }) });
    await expect(row.getByRole("status")).toHaveText("starting…");
    await expect(launch, "a launch in progress cannot be started twice").toBeDisabled();
    await expect(dock.getByRole("alert")).toHaveCount(0);
    await capture(dock, "07a-dock-launch-starting");
    release();
    await expect(dock.getByRole("button", { name: `Open ${PROFILE}` })).toBeEnabled({ timeout: 60_000 });
    await expect(row.getByRole("status")).toHaveText("launched");
    await expect(launch).toBeEnabled();
    await dashboard.unroute(launchRoute);
    await expect.poll(() => answered.at(-1), { timeout: 60_000 }).toBe("launched");
    expect(answered[0], "the first answer was still-starting, so the replay loop ran").toBe("pending");
    const first = sent.splice(0);
    expect(first.length).toBeGreaterThanOrEqual(2);
    expect(new Set(first.map((body) => body.requestId)).size, "every replay reused the request id").toBe(1);
    expect(first[0]).toMatchObject({ repoRoot: daemon.repo });
    await expect.poll(() => residentTaskCount(daemon), { timeout: 30_000 }).toBe(1);

    // 2. A lost answer: the launch REACHES the daemon and reserves its run, but nothing comes
    //    back. The dock says so on its own line and keeps the id, so the retry - even after
    //    closing the dock - replays that launch instead of starting a third resident.
    let dropped = false;
    await dashboard.route(/\/api\/residents\/profiles\/[^/]+\/launch$/, async (route) => {
      if (dropped) return route.continue();
      dropped = true;
      await route.fetch();
      await route.abort("failed");
    });
    await launch.click();
    await expect(dock.getByRole("alert")).toBeVisible();
    await expect(launch).toBeEnabled();
    await capture(dock, "07b-dock-launch-answer-lost");
    await dashboard.keyboard.press("Escape");
    await expect(dock).toBeHidden();
    await dockButton.click();
    await launch.click();
    await expect(dock.getByRole("alert")).toHaveCount(0);
    await expect.poll(() => answered.at(-1), { timeout: 60_000 }).toBe("launched");
    await expect(dockButton).toHaveAccessibleName("Residents - 2 live", { timeout: 30_000 });

    const second = sent.splice(0);
    expect(second.length).toBeGreaterThanOrEqual(2);
    expect(new Set(second.map((body) => body.requestId)).size, "the retry replayed the lost launch's id").toBe(1);
    expect(second[0]!.requestId, "a new launch after a definitive answer takes a new id").not.toBe(first[0]!.requestId);
    await expect.poll(() => residentTaskCount(daemon), { timeout: 30_000 }).toBe(2);
    expect(await residentTaskCount(daemon)).toBe(2);
  });
});

test("a failed or refused dock launch says why, and the next Launch is a new launch", async ({
  dashboard,
  daemon,
}) => {
  await authorProfile(dashboard, daemon);
  await dashboard.goto(`${daemon.baseURL}/#/fleet`);
  const { sent } = watchLaunches(dashboard);

  // Two definitive answers the daemon gives - a launch that did not start, and a refusal that
  // created nothing - then the real route. Answered here, because making a real agent fail its
  // first turn on cue is the Phase 1 launch spec's subject, not the dock's.
  const answers = [
    { status: 409, body: { state: "failed", run: { id: "run-x" }, error: "agent binary \"claude\" not found on PATH" } },
    { status: 400, body: { error: `not a git repository: ${daemon.repo}`, code: "invalid" } },
  ];
  await dashboard.route(/\/api\/residents\/profiles\/[^/]+\/launch$/, async (route) => {
    const next = answers.shift();
    if (!next) return route.continue();
    await route.fulfill({ status: next.status, contentType: "application/json", body: JSON.stringify(next.body) });
  });

  await dashboard.getByRole("button", { name: /^Residents - \d+ live$/ }).click();
  const dock = dashboard.getByRole("dialog", { name: "Residents" });
  const launch = dock.getByRole("button", { name: `Launch ${PROFILE}` });

  await launch.click();
  await expect(dock.getByRole("alert")).toHaveText("Did not start: agent binary \"claude\" not found on PATH");
  await expect(launch).toBeEnabled();
  await capture(dock, "08-dock-launch-failed");

  await launch.click();
  await expect(dock.getByRole("alert")).toHaveText(`not a git repository: ${daemon.repo}`);
  await expect(launch).toBeEnabled();
  expect(await residentTaskCount(daemon), "neither answer started a resident").toBe(0);

  // The third launch reaches the daemon and starts the resident; the error clears.
  await launch.click();
  await expect(dock.getByRole("button", { name: `Open ${PROFILE}` })).toBeEnabled({ timeout: 60_000 });
  await expect(dock.getByRole("alert")).toHaveCount(0);

  // A definitive answer retires its request id: three launches, three ids, one resident.
  expect(sent).toHaveLength(3);
  expect(new Set(sent.map((body) => body.requestId)).size).toBe(3);
  await expect.poll(() => residentTaskCount(daemon), { timeout: 30_000 }).toBe(1);
});

test("Settings > Display > Top bar describes the Residents button as it draws, and Minimized does that", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.setViewportSize({ width: 1920, height: 1000 });
  await dashboard.goto(`${daemon.baseURL}/#/settings/display`);
  const panel = dashboard.locator('[data-anchor="display/topbar"]');
  await panel.scrollIntoViewIfNeeded();
  const sizes = panel.getByRole("radiogroup", { name: "Top bar: Residents" });
  // `has` resolves relative to each row, so its locator is rooted at the page.
  const row = panel.locator(".display-choice")
    .filter({ has: dashboard.getByRole("radiogroup", { name: "Top bar: Residents" }) });
  await expect(row.locator(".settings-toggle-label")).toHaveText("Residents");
  // The count is promised only while something is running: with none, the button has no number.
  await expect(row.locator(".settings-toggle-desc")).toHaveText(
    "The Residents dock button. Minimized, it is drawn as its ⌂, plus the live count while any resident is running.",
  );
  await expect(sizes.getByRole("radio", { name: "Expanded" })).toBeChecked();
  await capture(row, "09-topbar-setting-residents");

  // Minimized: the preview's button sheds its word and keeps the ⌂. Nothing is running, so it
  // carries no count - which is exactly what the description says.
  const preview = panel.locator(".topbar-preview .residents-btn");
  await sizes.getByRole("radio", { name: "Minimized" }).check();
  await expect(preview).toHaveClass(/\btb-compact\b/);
  await expect(preview.locator(".residents-glyph")).toHaveText("⌂");
  await expect(preview.locator(".residents-count")).toHaveCount(0);

  // And the real bar follows the stored choice.
  await dashboard.goto(`${daemon.baseURL}/#/fleet`);
  const button = dashboard.locator("header.topbar").getByRole("button", { name: "Residents - 0 live" });
  await expect(button).toHaveClass(/\btb-compact\b/);
  await expect(button.locator(".residents-count")).toHaveCount(0);
});

test("a launch that stays starting past the dock's limit gives Launch back, and the retry checks the same launch", async ({
  dashboard,
  daemon,
}) => {
  await authorProfile(dashboard, daemon);
  // The page clock, so the dock's replay limit can be passed without waiting it out.
  await dashboard.clock.install();
  await dashboard.goto(`${daemon.baseURL}/#/fleet`);
  const { sent } = watchLaunches(dashboard);

  // A startup that never settles: every launch answers "still starting". Answered here so the
  // daemon never sees these requests - the stall is the subject, not a real launch.
  const launchRoute = /\/api\/residents\/profiles\/[^/]+\/launch$/;
  await dashboard.route(launchRoute, (route) => route.fulfill({
    status: 202,
    contentType: "application/json",
    body: JSON.stringify({ state: "pending", run: { id: "run-stalled" } }),
  }));

  await dashboard.getByRole("button", { name: /^Residents - \d+ live$/ }).click();
  const dock = dashboard.getByRole("dialog", { name: "Residents" });
  const launch = dock.getByRole("button", { name: `Launch ${PROFILE}` });
  const row = dock.locator(".residents-pop-row")
    .filter({ has: dashboard.getByRole("button", { name: `Launch ${PROFILE}` }) });

  await launch.click();
  await expect(row.getByRole("status")).toHaveText("starting…");
  await expect(launch).toBeDisabled();
  await expect.poll(() => sent.length).toBeGreaterThanOrEqual(1);

  // Past the limit, replay by replay: the dock stops, keeps the id and hands Launch back.
  for (let i = 0; i < 45 && (await launch.isDisabled()); i += 1) {
    await dashboard.clock.fastForward(1_500);
  }
  await expect(launch).toBeEnabled();
  await expect(row.getByRole("status")).toHaveText("still starting");
  await expect(row).toContainText("Launch checks on this same launch; it never starts a second resident.");
  await expect(dock.getByRole("alert")).toHaveCount(0);
  const stalled = sent.length;
  expect(stalled).toBeGreaterThanOrEqual(2);
  expect(new Set(sent.map((body) => body.requestId)).size, "every replay used one request id").toBe(1);
  await capture(dock, "10-dock-launch-still-starting");

  // The retry checks the SAME launch: same id. With the daemon answering again, that one id
  // starts the one resident.
  await dashboard.unroute(launchRoute);
  await launch.click();
  await expect(dock.getByRole("button", { name: `Open ${PROFILE}` })).toBeEnabled({ timeout: 60_000 });
  expect(sent.length).toBeGreaterThan(stalled);
  expect(new Set(sent.map((body) => body.requestId)).size, "the retry reused the stalled launch's id").toBe(1);
  await expect.poll(() => residentTaskCount(daemon), { timeout: 30_000 }).toBe(1);
});

/**
 * Another window moves the profile's default repository: a PATCH straight to the daemon, then
 * wait until this dashboard has the new revision, so a retry below is made with the edit in hand.
 */
async function moveDefaultRepo(page: Page, daemon: DaemonHandle, to: string): Promise<void> {
  type Stored = { id: string; name: string; revision: number; settings: { workspace: Record<string, unknown> } & Record<string, unknown> };
  const profile = (await api<Stored[]>(daemon, "/api/residents/profiles")).find((p) => p.name === PROFILE)!;
  const response = await fetch(`${daemon.baseURL}/api/residents/profiles/${profile.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      expectedRevision: profile.revision,
      settings: { ...profile.settings, workspace: { ...profile.settings.workspace, defaultRepoRoot: to } },
    }),
  });
  expect(response.status).toBe(200);
  await page.goto(`${daemon.baseURL}/#/residents/${profile.id}`);
  await expect(page.getByRole("region", { name: `Resident profile ${PROFILE}` }))
    .toContainText(`Revision ${profile.revision + 1}`);
}

test.describe("a dock launch is replayed exactly as it was sent until it has a definitive answer", () => {
  test("a pending launch, then a new default repository: the retry after closing the dock sends the original id and repository", async ({
    dashboard,
    daemon,
  }) => {
    await authorProfile(dashboard, daemon);
    await dashboard.clock.install();
    await dashboard.goto(`${daemon.baseURL}/#/fleet`);
    const { sent } = watchLaunches(dashboard);

    // Still starting, past the dock's replay limit: answered here, so the daemon never sees it.
    const launchRoute = /\/api\/residents\/profiles\/[^/]+\/launch$/;
    await dashboard.route(launchRoute, (route) => route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({ state: "pending", run: { id: "run-stalled" } }),
    }));
    const dockButton = dashboard.getByRole("button", { name: /^Residents - \d+ live$/ });
    const dock = dashboard.getByRole("dialog", { name: "Residents" });
    const launch = dock.getByRole("button", { name: `Launch ${PROFILE}` });
    await dockButton.click();
    await launch.click();
    await expect(launch).toBeDisabled();
    for (let i = 0; i < 45 && (await launch.isDisabled()); i += 1) {
      await dashboard.clock.fastForward(1_500);
    }
    await expect(launch).toBeEnabled();
    const original = sent[0]!;
    expect(original).toEqual({ repoRoot: daemon.repo, requestId: original.requestId });

    // The default moves while that launch is outstanding, and the dock is closed meanwhile.
    await dashboard.keyboard.press("Escape");
    await expect(dock).toBeHidden();
    await dashboard.unroute(launchRoute);
    await moveDefaultRepo(dashboard, daemon, `${daemon.repo}-moved`);

    // Reopened, Launch checks on the outstanding launch: same id, same repository.
    await dockButton.click();
    await launch.click();
    await expect(dock.getByRole("button", { name: `Open ${PROFILE}` })).toBeEnabled({ timeout: 60_000 });
    for (const body of sent) expect(body).toEqual(original);
    await expect.poll(() => residentTaskCount(daemon), { timeout: 30_000 }).toBe(1);
    await expect(dock.getByRole("alert")).toHaveCount(0);
  });

  test("a dropped response, then a new default repository: the retry after closing the dock replays the original launch, and one resident starts", async ({
    dashboard,
    daemon,
  }) => {
    await authorProfile(dashboard, daemon);
    await dashboard.goto(`${daemon.baseURL}/#/fleet`);
    const { sent, answered } = watchLaunches(dashboard);

    // The launch REACHES the daemon and reserves its run, but its answer is lost.
    const launchRoute = /\/api\/residents\/profiles\/[^/]+\/launch$/;
    await dashboard.route(launchRoute, async (route) => {
      await route.fetch();
      await route.abort("failed");
    });
    const dockButton = dashboard.getByRole("button", { name: /^Residents - \d+ live$/ });
    const dock = dashboard.getByRole("dialog", { name: "Residents" });
    const launch = dock.getByRole("button", { name: `Launch ${PROFILE}` });
    await dockButton.click();
    await launch.click();
    await expect(dock.getByRole("alert")).toBeVisible();
    await expect(launch).toBeEnabled();
    const original = sent[0]!;
    expect(original).toEqual({ repoRoot: daemon.repo, requestId: original.requestId });

    // The default moves, and the dock is closed and reopened.
    await dashboard.keyboard.press("Escape");
    await dashboard.unroute(launchRoute);
    await moveDefaultRepo(dashboard, daemon, `${daemon.repo}-moved`);
    await dockButton.click();

    // The retry replays exactly what the daemon recorded, so it is answered by that launch's
    // run - not refused as a different launch, and never a second resident.
    await launch.click();
    await expect(dock.getByRole("button", { name: `Open ${PROFILE}` })).toBeEnabled({ timeout: 60_000 });
    await expect(dock.getByRole("alert")).toHaveCount(0);
    // Every answer the page received was this launch's own: never a refusal (an http 4xx).
    expect(answered.every((state) => state === "pending" || state === "launched"), answered.join(", ")).toBe(true);
    expect(sent.length).toBeGreaterThanOrEqual(2);
    for (const body of sent) expect(body).toEqual(original);
    await expect.poll(() => residentTaskCount(daemon), { timeout: 30_000 }).toBe(1);
    expect(await residentTaskCount(daemon)).toBe(1);
  });
});
