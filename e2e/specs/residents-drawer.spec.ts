import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { test, expect } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";
import { beListener, enableVoice } from "../fixtures/voice.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import type { ResidentProfile } from "../../src/shared/residents.ts";
import type { ServerEvent } from "../../src/shared/types.ts";

/**
 * The Residents drawer: residents leave the Board columns and the Console rail for a drawer on
 * the right edge, which is the shipped default (Settings → Display → Residents).
 *
 * The `dashboard` fixture pins `residentPlacement: "fleet"` for the specs written before the
 * drawer; this spec opts into the drawer itself, and proves the shipped default through the raw
 * `page` fixture. No model tokens are spent: every agent binary is redirected by
 * `e2e/fixtures/fake-agents.ts`, and the resident's question is posted on `POST /mcp/reviews`,
 * the channel its own `request_input` tool uses.
 */

const EVIDENCE = artifactsDir("residents-drawer");
const NAME = "Drawer watcher";

async function capture(page: Page, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${EVIDENCE}${name}.png` });
}

async function request<T>(daemon: DaemonHandle, path: string, body?: unknown, method = "POST"): Promise<T> {
  const response = await fetch(daemon.baseURL + path, body === undefined && method === "GET" ? {} : {
    method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response.json() as Promise<T>;
}

interface ProfileOptions {
  referenceName?: string;
  repo?: boolean;
  controlOtherSessions?: boolean;
}

/** Author a resident profile through the real route, with or without a default repository. */
async function createProfile(
  daemon: DaemonHandle, name: string, { repo = true, controlOtherSessions = false, referenceName }: ProfileOptions = {},
): Promise<ResidentProfile> {
  const personas = await request<Array<{ id: string; name: string }>>(daemon, "/api/personas", undefined, "GET");
  return request<ResidentProfile>(daemon, "/api/residents/profiles", { settings: {
    identity: { name, referenceName }, persona: { personaId: personas.find((p) => p.name === "Code Risk Reviewer")!.id },
    ...(repo ? { workspace: { defaultRepoRoot: daemon.repo } } : {}),
    authority: { controlOtherSessions },
    execution: { model: "claude-fable-5" },
    // A long cadence keeps the resident waiting between steps instead of iterating under the test.
    loop: { delaySeconds: 3600, minDelaySeconds: 60, maxDelaySeconds: 3600 },
  } });
}

/** How many launched residents are waiting between iterations. */
function waitingResidents(daemon: DaemonHandle): number {
  return withDaemonDb(daemon, (db) => (db.prepare(
    "SELECT COUNT(*) AS n FROM resident_runs WHERE ended_at IS NULL AND launch_state = 'launched' AND loop_state = 'waiting'",
  ).get() as { n: number }).n);
}

/** Launch one resident through the real routes and wait until its loop is waiting. */
async function launch(daemon: DaemonHandle, name = NAME, options?: ProfileOptions): Promise<ResidentProfile> {
  const before = waitingResidents(daemon);
  const profile = await createProfile(daemon, name, options);
  await request(daemon, `/api/residents/profiles/${profile.id}/launch`, {
    repoRoot: daemon.repo, requestId: `launch-${name.toLowerCase().replace(/\W+/g, "-")}`,
  });
  await expect.poll(() => waitingResidents(daemon), { timeout: 60_000 }).toBe(before + 1);
  return profile;
}

async function* residentEventFrames(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const decoder = new TextDecoder();
  let partial = "";
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) return;
    const frames = (partial + decoder.decode(chunk.value, { stream: true })).split("\n\n");
    partial = frames.pop() ?? "";
    for (const frame of frames) {
      const data = frame.split("\n").find((line) => line.startsWith("data: "));
      if (data) yield { frame, event: JSON.parse(data.slice(6)) as ServerEvent };
    }
  }
}

/** Capture the daemon's snapshot and the run reservation before a session joins it. */
async function startingResidentFrames(daemon: DaemonHandle, profile: ResidentProfile): Promise<string> {
  const stream = await fetch(`${daemon.baseURL}/events`, { signal: AbortSignal.timeout(60_000) });
  expect(stream.ok).toBe(true);
  const reader = stream.body!.getReader();
  let snapshot: string | undefined;
  try {
    await request(daemon, `/api/residents/profiles/${profile.id}/launch`, {
      repoRoot: daemon.repo, requestId: "launch-starting-filter-resident", answerWhen: "accepted",
    });
    for await (const { frame, event } of residentEventFrames(reader)) {
      if (event.type === "snapshot") snapshot = frame;
      if (snapshot && event.type === "resident_run_upsert" && event.run.profileId === profile.id
        && event.run.launchState === "pending") return `${snapshot}\n\n${frame}\n\n`;
    }
    throw new Error("SSE closed before the pending resident run arrived");
  } finally {
    await reader.cancel();
  }
}

async function residentSnapshot(daemon: DaemonHandle): Promise<Extract<ServerEvent, { type: "snapshot" }>> {
  const stream = await fetch(`${daemon.baseURL}/events`, { signal: AbortSignal.timeout(20_000) });
  expect(stream.ok).toBe(true);
  const reader = stream.body!.getReader();
  try {
    for await (const { event } of residentEventFrames(reader)) {
      if (event.type === "snapshot") return event;
    }
    throw new Error("SSE closed before the snapshot arrived");
  } finally {
    await reader.cancel();
  }
}

/** Stand in for the resident calling its bundled request_input tool. Returns the review id. */
async function askResident(daemon: DaemonHandle): Promise<string> {
  const sessions = await request<Array<{ cwd: string | null; task?: { kind?: string } }>>(daemon, "/api/sessions", undefined, "GET");
  const cwd = sessions.find((s) => s.task?.kind === "resident")?.cwd;
  expect(cwd, "the resident session has a workspace to bind the question to").toBeTruthy();
  const token = readFileSync(join(daemon.home, "token"), "utf8").trim();
  const response = await fetch(`${daemon.baseURL}/mcp/reviews`, {
    method: "POST", headers: { "content-type": "application/json", "x-harness-token": token },
    body: JSON.stringify({
      env: {}, cwd, kind: "input", title: "Ship the nightly migration?", body: "Ship the nightly migration?",
      decisions: [{ id: "q", question: "Ship the nightly migration?", options: [
        { id: "yes", label: "Ship it" }, { id: "no", label: "Hold it" },
      ], allowOther: false }],
    }),
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { id: string }).id;
}

/** Opt this spec's dashboard into the drawer, in one layout, and land on the fleet. */
async function selectResidentDrawer(page: Page, daemon: DaemonHandle, layout: "board" | "console"): Promise<void> {
  await request(daemon, "/api/ui/config", { residentPlacement: "drawer", residentDrawerPinned: false, layout }, "PUT");
  await page.evaluate((next) => {
    const raw = JSON.parse(window.localStorage.getItem("mission-control.ui") ?? "{}") as Record<string, unknown>;
    window.localStorage.setItem("mission-control.ui", JSON.stringify({ ...raw, ...next }));
  }, { residentPlacement: "drawer", residentDrawerPinned: false, layout });
  await page.goto(`${daemon.baseURL}/#/fleet`);
  await page.reload();
  await expect(page.getByRole("button", { name: "Dispatch", exact: true })).toBeVisible();
}

/** The drawer: a column beside the fleet, pinned or not, never a dialog over the page. */
const drawerOf = (page: Page): Locator => page.getByRole("complementary", { name: "Residents", exact: true });
const closeDrawer = async (page: Page): Promise<void> => {
  await drawerOf(page).getByRole("button", { name: "Close", exact: true }).click();
  await expect(drawerOf(page)).toHaveCount(0);
};
const cardOf = (scope: Locator, name = NAME): Locator =>
  scope.getByRole("listitem").filter({ has: scope.page().getByRole("button", { name: new RegExp(`^${name}, `) }) });
const headOf = (scope: Locator, name = NAME): Locator => scope.getByRole("button", { name: new RegExp(`^${name}, `) });
const band = (page: Page, name = NAME): Locator => page.getByRole("group", { name: `Resident ${name}` });
const edgeTab = (page: Page): Locator => page.getByRole("button", { name: /^Open the Residents drawer - / });

/** No Board column, drill-in rail row or Console rail row names the resident. */
async function expectOffFleet(page: Page, name = NAME): Promise<void> {
  await expect(page.locator(".board-col", { hasText: name })).toHaveCount(0);
  await expect(page.locator(".console-rail", { hasText: name })).toHaveCount(0);
}

test("a listening resident card shows its quoted reference name with spoken names disabled", async ({ dashboard: page, daemon }) => {
  await enableVoice(daemon);
  await launch(daemon, NAME, { referenceName: '"Marlowe"' });
  await selectResidentDrawer(page, daemon, "board");
  const listener = await beListener(daemon);
  try {
    const indicator = page.locator("button.vi-status-line");
    await expect(indicator).toHaveAccessibleName("Voice: listening. Mute");
    const snapshot = await residentSnapshot(daemon);
    expect(snapshot.voice?.mode).toBe("listening");

    // App resolves spokenNames from the voice flag. Replay the listening snapshot with
    // that flag disabled so the test controls the two inputs independently.
    const featureFlags = {
      ...snapshot.featureFlags,
      overrides: { ...snapshot.featureFlags.overrides, voice: false },
    };
    await page.route("**/events", route => route.fulfill({
      contentType: "text/event-stream",
      body: `data: ${JSON.stringify({ ...snapshot, featureFlags })}\n\n`,
    }));
    await page.reload();
    await edgeTab(page).click();
    await expect(indicator).toHaveCount(0);
    await expect(drawerOf(page).locator(".residents-drawer-name")).toHaveText('"Marlowe"');
    await capture(page, "listening-title-spoken-names-disabled");
  } finally {
    listener.stop();
  }
});

test("resident card titles follow listening mode and the current reference name", async ({ dashboard: page, daemon }) => {
  await enableVoice(daemon);
  const profile = await launch(daemon);
  await selectResidentDrawer(page, daemon, "board");
  await edgeTab(page).click();
  const drawer = drawerOf(page);
  const title = drawer.locator(".residents-drawer-name");
  const status = page.locator("button.vi-status-line");
  const listener = await beListener(daemon);
  try {
    await expect(status).toHaveAccessibleName("Voice: listening. Mute");
    await expect(title).toHaveText(NAME);
    const updated = await request<ResidentProfile>(daemon, `/api/residents/profiles/${profile.id}`, { expectedRevision: profile.revision, settings: {
      ...profile.settings, identity: { ...profile.settings.identity, referenceName: "Marlowe" },
    } }, "PATCH");
    await expect(title).toHaveText('"Marlowe"');
    await expect(headOf(drawer, '"Marlowe"')).toBeVisible();
    await capture(page, "listening-reference-title");
    await status.click();
    await expect(status).toHaveAccessibleName("Voice: muted. Unmute");
    await expect(title).toHaveText(NAME);
    await capture(page, "muted-resident-title");
    await status.click();
    await expect(title).toHaveText('"Marlowe"');
    await request(daemon, `/api/residents/profiles/${profile.id}`, {
      expectedRevision: updated.revision,
      settings: { ...updated.settings, identity: { ...updated.settings.identity, referenceName: "" } },
    }, "PATCH");
    await expect(title).toHaveText(NAME);
    await capture(page, "listening-resident-title");
  } finally {
    listener.stop();
  }
});

test("listening titles identify and filter resident cards on the Board and in the Console rail", async ({ dashboard: page, daemon }) => {
  await enableVoice(daemon);
  await launch(daemon, NAME, { referenceName: "Marlowe" });
  const other = "Release sentinel";
  await launch(daemon, other);
  const listener = await beListener(daemon);
  try {
    await expect(page.locator("button.vi-status-line")).toHaveAccessibleName("Voice: listening. Mute");
    const rail = page.getByRole("navigation", { name: "Sessions" });
    for (const name of ['"Marlowe"', other]) {
      const row = rail.getByRole("button", { name, exact: true });
      const title = row.locator(".rail-name");
      await expect(title).toBeVisible();
      await expect(title).toContainText(name);
    }
    await capture(page, "review-listening-rail");
    await request(daemon, "/api/ui/config", { layout: "board" }, "PUT");
    await page.reload();
    const board = page.locator("main.board");
    const named = board.getByText('"Marlowe"', { exact: true });
    const fallback = board.getByText(other, { exact: true });
    await expect(named).toBeVisible();
    await expect(fallback).toBeVisible();
    await capture(page, "review-listening-board");
    await page.locator(".filter-box").click();
    await page.getByRole("textbox", { name: /Filter sessions/ }).fill("Marlowe");
    await expect(board.getByRole("button", { name: 'Open "Marlowe"', exact: true })).toBeVisible();
    await expect(named).toBeVisible();
    await expect(fallback).toHaveCount(0);
    await capture(page, "review-listening-board-filter");
  } finally {
    listener.stop();
  }
});

test("Console rows distinguish residents sharing a listening title", async ({ dashboard: page, daemon }) => {
  await enableVoice(daemon);
  await launch(daemon, NAME, { referenceName: "Marlowe" });
  const other = await launch(daemon, "Release sentinel", { referenceName: "Marlowe" });
  const listener = await beListener(daemon);
  try {
    await expect(page.locator("button.vi-status-line")).toHaveAccessibleName("Voice: listening. Mute");
    const rail = page.getByRole("navigation", { name: "Sessions" });
    for (const ordinaryName of [NAME, other.name]) {
      const name = `"Marlowe" (${ordinaryName})`;
      const title = rail.getByRole("button", { name, exact: true }).locator(".rail-name");
      await expect(title).toBeVisible();
      await expect(title).toContainText(name);
      expect(await title.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    }
    await capture(page, "shared-listening-title-console");
    await request(daemon, `/api/residents/profiles/${other.id}`, {
      expectedRevision: other.revision,
      settings: { ...other.settings, identity: { ...other.settings.identity, referenceName: "" } },
    }, "PATCH");
    await expect(rail.getByRole("button", { name: '"Marlowe"', exact: true })).toBeVisible();
    await expect(rail.getByRole("button", { name: other.name, exact: true })).toBeVisible();
  } finally {
    listener.stop();
  }
});

test("Board and drawer Open buttons distinguish residents sharing a listening title", async ({ dashboard: page, daemon }) => {
  await enableVoice(daemon);
  await launch(daemon, NAME, { referenceName: "Marlowe" });
  const other = await launch(daemon, "Release sentinel", { referenceName: "Marlowe" });
  const listener = await beListener(daemon);
  try {
    await request(daemon, "/api/ui/config", { layout: "board" }, "PUT");
    await page.reload();
    const board = page.locator("main.board");
    for (const ordinaryName of [NAME, other.name]) {
      await expect(board.getByRole("button", { name: `Open "Marlowe" (${ordinaryName})`, exact: true })).toBeVisible();
    }
    await selectResidentDrawer(page, daemon, "board");
    await edgeTab(page).click();
    const drawer = drawerOf(page);
    for (const ordinaryName of [NAME, other.name]) {
      await expect(drawer.getByRole("button", { name: `Open "Marlowe" (${ordinaryName})`, exact: true })).toBeVisible();
    }
    await capture(page, "shared-listening-title-drawer-actions");
    await drawer.getByRole("button", { name: `Open "Marlowe" (${other.name})`, exact: true }).click();
    await expect(band(page, other.name)).toBeVisible();
  } finally {
    listener.stop();
  }
});

test("listening titles identify a visitor card and filter residents in the drawer", async ({ dashboard: page, daemon }) => {
  await enableVoice(daemon);
  const profile = await launch(daemon, NAME);
  await askResident(daemon);
  const other = "Release sentinel";
  await launch(daemon, other);
  await selectResidentDrawer(page, daemon, "board");
  const listener = await beListener(daemon);
  try {
    await expect(page.locator("button.vi-status-line")).toHaveAccessibleName("Voice: listening. Mute");
    const visitorTitle = page.locator(".resident-visitor-name");
    await expect(visitorTitle).toHaveText(NAME);
    await capture(page, "review-listening-visitor-fallback");
    await request(daemon, `/api/residents/profiles/${profile.id}`, {
      expectedRevision: profile.revision,
      settings: { ...profile.settings, identity: { ...profile.settings.identity, referenceName: "Marlowe" } },
    }, "PATCH");
    await expect(visitorTitle).toHaveText('"Marlowe"');
    await capture(page, "review-listening-visitor");
    await edgeTab(page).click();
    const drawer = drawerOf(page);
    await expect(cardOf(drawer, other)).toBeVisible();
    await expect(cardOf(drawer, '"Marlowe"')).toBeVisible();
    await page.locator(".filter-box").click();
    const filter = page.getByRole("textbox", { name: /Filter sessions/ });
    await filter.fill("Marlowe");
    await expect(cardOf(drawer, '"Marlowe"')).toBeVisible();
    await expect(cardOf(drawer, other)).toHaveCount(0);
    await capture(page, "review-listening-drawer-filter");
  } finally {
    listener.stop();
  }
});

test("a new installation keeps residents in the drawer, off the Board", async ({ page, daemon }) => {
  await launch(daemon);
  const stored = await request<{ config: { residentPlacement: string } }>(daemon, "/api/ui/config", undefined, "GET");
  expect(stored.config.residentPlacement).toBe("drawer");

  await page.goto(`${daemon.baseURL}/#/fleet`);
  await expect(page.locator(".board")).toBeVisible();
  await expect(edgeTab(page)).toHaveAccessibleName("Open the Residents drawer - 1 live");
  await expectOffFleet(page);
  await page.getByRole("button", { name: "Residents - 1 live", exact: true }).click();
  await expect(cardOf(drawerOf(page))).toBeVisible();
  await expect(drawerOf(page).getByRole("heading", { name: "Live", exact: true })).toHaveCount(0);
  await capture(page, "01-default-drawer");
});

test("the fleet filter searches resident card questions and loop text in the drawer", async ({ dashboard: page, daemon }) => {
  const other = "Release sentinel";
  await launch(daemon);
  await askResident(daemon);
  await launch(daemon, other);
  await selectResidentDrawer(page, daemon, "board");
  await page.getByRole("button", { name: "Residents - 2 live", exact: true }).click();

  const drawer = drawerOf(page);
  const matching = cardOf(drawer);
  const nonmatching = cardOf(drawer, other);
  const filter = page.getByRole("textbox", { name: /Filter sessions/ });
  await expect(matching).toContainText("Ship the nightly migration?");
  await expect(matching).toContainText("Hold it");
  await expect(matching).toContainText("iteration 1");
  await expect(nonmatching).toBeVisible();

  await page.locator(".filter-box").click();
  await filter.fill("  NIGHTLY Hold iteration  ");
  await expect(matching).toBeVisible();
  await expect(nonmatching).toHaveCount(0);
  await expect(page.getByText(/^Nothing matches/)).toHaveCount(0);
  await filter.fill("nightly hold");
  await expect(matching).toBeVisible();
  await expect(nonmatching).toHaveCount(0);
  await capture(page, "filtered-resident-card");

  await headOf(drawer).click();
  await expect(headOf(drawer)).toHaveAttribute("aria-expanded", "false");
  await expect(matching).toBeVisible();
  await expect(matching.getByText("Hold it", { exact: false })).toHaveCount(0);
  await page.locator(".filter-box").click();
  await filter.fill("nightly sentinel");
  await expect(matching).toHaveCount(0);
  await expect(nonmatching).toHaveCount(0);
  await expect(drawer.getByText("No residents match the filter.")).toBeVisible();
  await expect(drawer.getByRole("heading", { name: "Profiles", exact: true })).toBeVisible();

  await filter.press("Escape");
  await expect(matching).toBeVisible();
  await expect(nonmatching).toBeVisible();
  await expect(headOf(drawer)).toHaveAttribute("aria-expanded", "false");

  const latest = nonmatching.getByLabel(`Latest from ${other}`);
  await expect(latest).toBeVisible();
  const latestText = await latest.innerText();
  await filter.fill(`${latestText} ⌥2 Run now`);
  await expect(nonmatching).toBeVisible();
  await expect(nonmatching.getByRole("button", { name: "Run now" })).toBeVisible();
  await expect(matching).toHaveCount(0);
});

test("the fleet filter searches a starting resident and the paused card's Resume action", async ({ dashboard: page, daemon }) => {
  await launch(daemon);
  await selectResidentDrawer(page, daemon, "board");
  await page.getByRole("button", { name: "Residents - 1 live", exact: true }).click();
  const drawer = drawerOf(page);
  const paused = cardOf(drawer);
  const resume = paused.getByRole("button", { name: "Resume", exact: true });
  await paused.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(resume).toBeVisible();

  const name = "Warmup sentinel";
  const profile = await createProfile(daemon, name);
  const frames = await startingResidentFrames(daemon, profile);
  // Replay the real pre-session frames so launch completion cannot race the search assertions.
  await page.route("**/events", (route) => route.fulfill({ contentType: "text/event-stream", body: frames }));
  await page.reload();
  await page.getByRole("button", { name: "Residents - 2 live", exact: true }).click();

  const starting = cardOf(drawer, name);
  const startingHead = starting.getByRole("button", { name: `${name}, starting`, exact: true });
  await expect(startingHead).toBeVisible();
  await expect(startingHead).toBeDisabled();
  await expect(resume).toBeVisible();

  const filter = page.getByRole("textbox", { name: /Filter sessions/ });
  await page.locator(".filter-box").click();
  await filter.fill("STARTING");
  await expect(startingHead).toBeVisible();
  await expect(paused).toHaveCount(0);
  await capture(page, "filtered-starting-resident");

  await filter.fill("Resume");
  await expect(resume).toBeVisible();
  await expect(starting).toHaveCount(0);
  await capture(page, "filtered-resume-resident");
});

test("the fleet filter searches queued and restart actions and resident control badges", async ({ dashboard: page, daemon }) => {
  const profile = await launch(daemon, NAME, { controlOtherSessions: true });
  const other = "Release sentinel";
  await launch(daemon, other);
  await selectResidentDrawer(page, daemon, "board");
  await page.getByRole("button", { name: "Residents - 2 live", exact: true }).click();

  const drawer = drawerOf(page);
  const matching = cardOf(drawer);
  const unrelated = cardOf(drawer, other);
  const runNow = matching.getByRole("button", { name: "Run now", exact: true });
  const cancel = matching.getByRole("button", { name: "Cancel queued run", exact: true });
  const restart = matching.getByRole("button", { name: "Restart on new profile", exact: true });
  const noControl = matching.getByRole("status", { name: "control not granted", exact: true });
  const filter = page.getByRole("textbox", { name: /Filter sessions/ });
  await expect(unrelated).toBeVisible();
  await expect(noControl).toBeVisible();
  await expect(noControl).toHaveText("No control");
  await expect(cancel).toHaveCount(0);
  await expect(restart).toHaveCount(0);

  await matching.getByRole("button", { name: `Open ${NAME}`, exact: true }).click();
  const detail = page.locator(".board-detail");
  const reply = detail.getByPlaceholder(/^Reply to this session/);
  await reply.fill("E2E_HOLD_TURN_UNTIL_RELEASED while the operator queues a run");
  await reply.press("Enter");
  try {
    await expect(matching.getByLabel("Resident loop status")).toContainText("working");
    await detail.getByRole("button", { name: "Back to the board" }).click();
    await runNow.click();
    await expect(cancel).toBeVisible();

    await page.locator(".filter-box").click();
    await filter.fill("Cancel queued run");
    await expect(cancel).toBeVisible();
    await expect(unrelated).toHaveCount(0);
    await capture(page, "filtered-resident-cancel-queued");

    await filter.press("Escape");
    await expect(unrelated).toBeVisible();
    await cancel.click();
    await expect(runNow).toBeVisible();
    await request(daemon, `/api/residents/profiles/${profile.id}`, {
      expectedRevision: profile.revision,
      settings: { ...profile.settings, instructions: { markdown: "Watch the updated fleet." } },
    }, "PATCH");
    await expect(restart).toBeVisible();

    await page.locator(".filter-box").click();
    await filter.fill("Restart on new profile");
    await expect(restart).toBeVisible();
    await expect(unrelated).toHaveCount(0);
    await capture(page, "filtered-resident-restart-profile");

    await filter.fill("No control");
    await expect(noControl).toBeVisible();
    await expect(unrelated).toHaveCount(0);
    await capture(page, "filtered-resident-no-control");
  } finally {
    writeFileSync(join(daemon.recordDir, "e2e-release-held-turn"), "");
  }

  // Project the already-granted state into the browser. Desktop authorization is covered
  // separately, and this browser test exercises only the badge text and the filter.
  const snapshot = await residentSnapshot(daemon);
  const taskId = snapshot.residentRuns?.find((run) => run.profileId === profile.id)?.taskId;
  expect(taskId).toBeTruthy();
  const sessions = snapshot.sessions.map((session) => session.task?.id === taskId
    ? { ...session, sessionControlEnabled: true }
    : session);
  await page.route("**/events", (route) => route.fulfill({
    contentType: "text/event-stream",
    body: `data: ${JSON.stringify({ ...snapshot, sessions })}\n\n`,
  }));
  await page.reload();
  await page.getByRole("button", { name: "Residents - 2 live", exact: true }).click();
  const control = matching.getByRole("status", { name: "control granted", exact: true });
  await expect(control).toBeVisible();
  await expect(control).toHaveText("Control");
  await expect(unrelated).toBeVisible();

  await page.locator(".filter-box").click();
  await filter.fill("Control");
  await expect(control).toBeVisible();
  await expect(unrelated).toHaveCount(0);
  await capture(page, "filtered-resident-control");
});

test("the fleet filter searches a resident card's inline action alert", async ({ dashboard: page, daemon }) => {
  const other = "Release sentinel";
  await launch(daemon);
  await launch(daemon, other);
  await selectResidentDrawer(page, daemon, "board");
  await page.getByRole("button", { name: "Residents - 2 live", exact: true }).click();

  const drawer = drawerOf(page);
  const matching = cardOf(drawer);
  const nonmatching = cardOf(drawer, other);
  const alert = matching.getByRole("alert");
  const runNow = matching.getByRole("button", { name: "Run now", exact: true });
  const path = "**/api/residents/runs/*/run-now";
  const message = "Wake quota unavailable";
  await page.route(path, (route) => route.fulfill({ status: 503, json: { error: message } }), { times: 1 });
  await runNow.click();
  await expect(alert).toHaveText(message);
  await expect(nonmatching).toBeVisible();

  const filter = page.getByRole("textbox", { name: /Filter sessions/ });
  await page.locator(".filter-box").click();
  await filter.fill("wake QUOTA");
  await expect(alert).toBeVisible();
  await expect(nonmatching).toHaveCount(0);
  await capture(page, "filtered-resident-alert");

  await filter.fill("quota sentinel");
  await expect(matching).toHaveCount(0);
  await expect(nonmatching).toHaveCount(0);
  await filter.fill("quota");
  await expect(alert).toHaveText(message);

  const [retry] = await Promise.all([page.waitForResponse(path), runNow.click()]);
  expect(retry.ok()).toBe(true);
  await expect(matching).toHaveCount(0);
  await page.locator(".filter-box").click();
  await filter.press("Escape");
  await expect(matching).toBeVisible();
  await expect(alert).toHaveCount(0);
  await expect(nonmatching).toBeVisible();
});

test("the drawer opens three ways as a column beside the Board, dims nothing, and stays beside the drill-in", async ({ dashboard: page, daemon }) => {
  await launch(daemon);
  await selectResidentDrawer(page, daemon, "board");
  await expectOffFleet(page);
  const boardWidth = async (): Promise<number> => (await page.locator(".board").boundingBox())!.width;
  const before = await boardWidth();

  await page.getByRole("button", { name: "Residents - 1 live", exact: true }).click();
  const drawer = drawerOf(page);
  await expect(drawer).toBeVisible();
  // Unpinned, it looks just as it does pinned: the Board narrows beside it, and nothing is
  // dimmed or covered.
  await expect(drawer.getByRole("button", { name: "Pin", exact: true })).toHaveAttribute("aria-pressed", "false");
  await expect.poll(boardWidth).toBeLessThan(before - 200);
  await expect(page.locator(".modal-backdrop")).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expectContentClearsBorder(drawer);
  const card = cardOf(drawer);
  await expect(card).toHaveCount(1);
  expect(await card.evaluate((el) => (el as HTMLElement).style.getPropertyValue("--resident"))).toMatch(/^var\(--resident-/);
  await expect(card).toContainText("⌥1");
  await expect(headOf(drawer)).toBeFocused();
  await capture(page, "02-drawer-open");

  // A column, not an overlay: Escape and a click on the Board leave it where it is.
  await page.keyboard.press("Escape");
  await page.mouse.click(40, 400);
  await expect(drawer).toBeVisible();
  await closeDrawer(page);
  await expect.poll(boardWidth).toBe(before);

  await page.keyboard.press("Shift+KeyH");
  await expect(drawer).toBeVisible();
  await expect(headOf(drawer)).toBeFocused();
  await page.keyboard.press("Shift+KeyH");
  await expect(drawer).toHaveCount(0);

  await edgeTab(page).click();
  await expect(drawer).toBeVisible();
  await expect(edgeTab(page)).toHaveCount(0);
  await expect(headOf(drawer)).toHaveAttribute("aria-expanded", "true");
  await drawer.getByRole("button", { name: `Open ${NAME}` }).click();
  await expect(page.locator(".board-detail").getByRole("group", { name: `Resident ${NAME}` })).toBeVisible();
  await expect(drawer).toBeVisible();
  await expectOffFleet(page);
  await capture(page, "03-board-drill-in");

  // Escape leaves the detail and puts the keyboard back on the resident's card.
  await page.locator("body").press("Escape");
  await expect(band(page)).toBeHidden();
  await expect(headOf(drawer)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(band(page)).toBeVisible();
  await page.locator("body").press("Escape");
  await expect(band(page)).toBeHidden();
  await expect(drawer).toBeVisible();

  // Open is for this page load only: a reload closes an unpinned drawer.
  await page.reload();
  await expect(edgeTab(page)).toBeVisible();
  await expect(drawer).toHaveCount(0);

  // The tab draws before the reloaded page has heard from the resident, and ⌥1 opens the
  // first LIVE resident - pressed while the tab still reads "0 live", it has nothing to open.
  await expect(edgeTab(page)).toHaveAccessibleName("Open the Residents drawer - 1 live");
  await page.keyboard.press("Alt+Digit1");
  await expect(page.locator(".board-detail").getByRole("group", { name: `Resident ${NAME}` })).toBeVisible();
  await expectOffFleet(page);
  await page.keyboard.press("Escape");
  await expect(band(page)).toBeHidden();
  await expect(drawer).toHaveCount(0);
});

test("in Console the drawer is a column beside the rail, and a resident opens in the detail pane beside it", async ({ dashboard: page, daemon }) => {
  await launch(daemon);
  // A fleet session to move to: dispatched straight over the API, opted out of Workflows.
  await request(daemon, "/api/tasks", {
    repoRoot: daemon.repo, title: "Fleet neighbour", intent: "settle and wait", workflowId: null,
  });
  await selectResidentDrawer(page, daemon, "console");
  const rail = page.locator(".console-rail");
  await expect(rail.getByRole("button", { name: /Fleet neighbour/ })).toBeVisible({ timeout: 60_000 });
  await expectOffFleet(page);

  await page.keyboard.press("Shift+KeyH");
  const drawer = drawerOf(page);
  await expect(drawer).toBeVisible();
  await expect(page.locator(".modal-backdrop")).toHaveCount(0);
  await drawer.getByRole("button", { name: `Open ${NAME}` }).click();
  await expect(page.locator(".console-detail").getByRole("group", { name: `Resident ${NAME}` })).toBeVisible();
  await expect(drawer).toBeVisible();
  await expect(page.locator(".board")).toHaveCount(0);
  await expectOffFleet(page);
  await capture(page, "04-console-detail");

  // A fleet session opens beside it as any other would, and the drawer stays.
  await rail.getByRole("button", { name: /Fleet neighbour/ }).click();
  await expect(band(page)).toBeHidden();
  await expect(drawer).toBeVisible();
  await closeDrawer(page);

  await page.keyboard.press("Alt+Digit1");
  await expect(page.locator(".console-detail").getByRole("group", { name: `Resident ${NAME}` })).toBeVisible();
  await expectOffFleet(page);
});

test("Pin keeps the drawer open through a reload, and Unpin leaves it open until the next one", async ({ dashboard: page, daemon }) => {
  await launch(daemon);
  await selectResidentDrawer(page, daemon, "board");
  const storedPin = async (): Promise<boolean> => (await request<{ config: { residentDrawerPinned: boolean } }>(
    daemon, "/api/ui/config", undefined, "GET")).config.residentDrawerPinned;

  await page.keyboard.press("Shift+KeyH");
  const drawer = drawerOf(page);
  await expect(drawer).toBeVisible();
  const box = await drawer.boundingBox();
  await drawer.getByRole("button", { name: "Pin", exact: true }).click();
  // Pinning changes nothing on screen: the same column, the same place.
  await expect(drawer.getByRole("button", { name: "Unpin", exact: true })).toHaveAttribute("aria-pressed", "true");
  expect(await drawer.boundingBox()).toEqual(box);
  await expect(edgeTab(page)).toHaveCount(0);
  await expect.poll(storedPin).toBe(true);
  await capture(page, "05-pinned");

  await page.reload();
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole("button", { name: "Unpin", exact: true })).toBeVisible();
  // Restored by a reload, it does not take the keyboard on its own.
  await expect(headOf(drawer)).not.toBeFocused();

  await drawer.getByRole("button", { name: `Open ${NAME}` }).click();
  await expect(page.locator(".board-detail").getByRole("group", { name: `Resident ${NAME}` })).toBeVisible();
  await expect(drawer).toBeVisible();
  await expectOffFleet(page);
  await page.locator("body").press("Escape");
  await expect(band(page)).toBeHidden();
  await expect(headOf(drawer)).toBeFocused();

  await drawer.getByRole("button", { name: "Unpin", exact: true }).click();
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole("button", { name: "Pin", exact: true })).toHaveAttribute("aria-pressed", "false");
  await expect.poll(storedPin).toBe(false);
  await page.reload();
  await expect(edgeTab(page)).toBeVisible();
  await expect(drawer).toHaveCount(0);

  // Closing a pinned drawer unpins it too, so it stays closed after a reload.
  await page.keyboard.press("Shift+KeyH");
  await drawer.getByRole("button", { name: "Pin", exact: true }).click();
  await expect.poll(storedPin).toBe(true);
  await closeDrawer(page);
  await expect.poll(storedPin).toBe(false);
  await page.reload();
  await expect(edgeTab(page)).toBeVisible();
  await expect(drawer).toHaveCount(0);
});

test("a resident that needs you is a visitor card while the drawer is closed, and a click opens its conversation", async ({ dashboard: page, daemon }) => {
  await launch(daemon);
  await selectResidentDrawer(page, daemon, "board");
  const reviewId = await askResident(daemon);

  const needsYou = page.locator(".board-col.tone-attention");
  const visitor = needsYou.getByRole("button", { name: `${NAME} needs you - resident, opens its conversation` });
  await expect(visitor).toBeVisible();
  await expect(needsYou).toContainText("Resident · opens its conversation");
  await expect(edgeTab(page)).toHaveClass(/needs-you/);
  // The Need you count still includes the resident.
  await expect(page.locator("button.pulse-seg", { hasText: "to answer" })).toBeVisible();
  await capture(page, "06-visitor-card");

  await page.keyboard.press("Shift+KeyH");
  const drawer = drawerOf(page);
  await expect(drawer).toBeVisible();
  await expect(page.locator(".resident-visitor")).toHaveCount(0);
  await page.keyboard.press("Shift+KeyH");
  await expect(visitor).toBeVisible();

  // The tile is the click target: its conversation opens, and the drawer stays closed.
  await page.locator(".resident-visitor").click();
  await expect(band(page)).toBeVisible();
  await expect(page.locator(".board-detail").getByRole("tab", { name: "Conversation", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(drawer).toHaveCount(0);
  await expect(page.locator(".resident-visitor")).toHaveCount(0);
  await capture(page, "06b-visitor-opens-conversation");
  await page.keyboard.press("Escape");
  await expect(band(page)).toBeHidden();
  await expect(visitor).toBeVisible();

  // While its conversation is open the resident is an ordinary row in the Needs you rail, not a
  // visitor card, so it can be swapped to and from like any session asking.
  await page.keyboard.press("Alt+Digit1");
  await expect(band(page)).toBeVisible();
  await expect(page.locator(".resident-visitor")).toHaveCount(0);
  await expect(page.locator(".board-col.is-rail.tone-attention button.rail-row", { hasText: NAME })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(band(page)).toBeHidden();
  await expect(visitor).toBeVisible();

  await request(daemon, `/api/reviews/${reviewId}/resolve`, { action: "dismiss" });
  await expect(page.locator(".resident-visitor")).toHaveCount(0);
  await expectOffFleet(page);
});

test("the fleet filter searches the Board visitor card's note", async ({ dashboard: page, daemon }) => {
  await launch(daemon);
  await askResident(daemon);
  await request(daemon, "/api/tasks", {
    repoRoot: daemon.repo, title: "Fleet neighbour", intent: "settle and wait", workflowId: null,
  });
  await selectResidentDrawer(page, daemon, "board");

  const board = page.locator("main.board");
  const visitor = board.getByRole("button", { name: `${NAME} needs you - resident, opens its conversation`, exact: true });
  const note = board.getByText("Resident · opens its conversation", { exact: true });
  const unrelated = board.getByRole("button", { name: "Open Fleet neighbour", exact: true });
  await expect(visitor).toBeVisible();
  await expect(note).toBeVisible();
  await expect(unrelated).toBeVisible({ timeout: 60_000 });
  await expect(drawerOf(page)).toHaveCount(0);

  await page.locator(".filter-box").click();
  await page.getByRole("textbox", { name: /Filter sessions/ }).fill("opens its");
  await expect(visitor).toBeVisible();
  await expect(note).toBeVisible();
  await expect(unrelated).toHaveCount(0);
  await expect(drawerOf(page)).toHaveCount(0);
  await capture(page, "filtered-board-visitor-note");
});

test("Board and Console placement restores the fleet placement and the dock, live, and ⌥1 still opens", async ({ dashboard: page, daemon }) => {
  await launch(daemon);
  await selectResidentDrawer(page, daemon, "board");
  await expectOffFleet(page);

  await page.goto(`${daemon.baseURL}/#/settings/display`);
  const picker = page.getByRole("radiogroup", { name: "Where residents live" });
  await expect(picker.getByRole("radio", { name: "Drawer" })).toBeChecked();
  await picker.getByRole("radio", { name: "Board and Console" }).check();
  await expect(picker.locator("label.is-on")).toHaveText(/^Board and Console/);
  await capture(page, "07-settings");
  await page.getByRole("button", { name: /Fleet/ }).first().click();

  await expect(page.locator(".board-col", { hasText: NAME })).toHaveCount(1);
  await expect(edgeTab(page)).toHaveCount(0);
  await page.getByRole("button", { name: "Residents - 1 live", exact: true }).click();
  const dock = page.getByRole("dialog", { name: "Residents", exact: true });
  await expect(dock.getByRole("heading", { name: "Live", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dock).toBeHidden();

  await page.keyboard.press("Alt+Digit1");
  await expect(page.locator(".board-detail").getByRole("group", { name: `Resident ${NAME}` })).toBeVisible();
});

test("the ⌘K palette finds a live resident by name or label and opens its full detail", async ({ dashboard: page, daemon }) => {
  await launch(daemon);
  await selectResidentDrawer(page, daemon, "board");
  const palette = page.getByRole("dialog").filter({ has: page.getByRole("combobox") }).first();
  const row = page.getByRole("option", { name: `${NAME}, resident` });

  await page.keyboard.press("Meta+K");
  await page.keyboard.type("DW");
  await expect(row).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(palette).toBeHidden();

  await page.keyboard.press("Meta+K");
  await page.keyboard.type(NAME);
  await row.click();
  await expect(palette).toBeHidden();
  await expect(page.locator(".board-detail").getByRole("group", { name: `Resident ${NAME}` })).toBeVisible();
  await expectOffFleet(page);
  await page.keyboard.press("Escape");
  await expect(band(page)).toBeHidden();
  await expect(drawerOf(page)).toHaveCount(0);
});

test("the arrow keys move the drawer's selection and Enter opens the selected resident", async ({ dashboard: page, daemon }) => {
  const FIRST = "Alpha keeper";
  const SECOND = "Bravo keeper";
  await launch(daemon, FIRST);
  await launch(daemon, SECOND);
  await selectResidentDrawer(page, daemon, "board");

  // Both residents have reached the dashboard before the drawer opens, so both cards are there
  // to walk from the first press.
  await expect(page.getByRole("button", { name: "Residents - 2 live", exact: true })).toBeVisible();
  await page.keyboard.press("Shift+KeyH");
  const drawer = drawerOf(page);
  await expect(cardOf(drawer, FIRST)).toBeVisible();
  await expect(cardOf(drawer, SECOND)).toBeVisible();
  await expect(headOf(drawer, FIRST)).toHaveAttribute("aria-current", "true");
  await expect(headOf(drawer, FIRST)).toBeFocused();
  await expect(cardOf(drawer, FIRST)).toContainText("⌥1");
  await expect(cardOf(drawer, SECOND)).toContainText("⌥2");
  // The selection is not the fold: both cards are open, and moving the selection keeps them so.
  await expect(headOf(drawer, SECOND)).toHaveAttribute("aria-expanded", "true");

  // The selection stops at the ends; it does not wrap.
  await page.keyboard.press("ArrowUp");
  await expect(headOf(drawer, FIRST)).toHaveAttribute("aria-current", "true");
  await expect(headOf(drawer, SECOND)).not.toHaveAttribute("aria-current");
  await expect(headOf(drawer, FIRST)).toBeFocused();

  await page.keyboard.press("ArrowDown");
  await expect(headOf(drawer, SECOND)).toHaveAttribute("aria-current", "true");
  await expect(headOf(drawer, FIRST)).not.toHaveAttribute("aria-current");
  await expect(headOf(drawer, SECOND)).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(headOf(drawer, SECOND)).toHaveAttribute("aria-current", "true");
  await expect(headOf(drawer, FIRST)).not.toHaveAttribute("aria-current");
  await expect(headOf(drawer, SECOND)).toBeFocused();
  await expect(headOf(drawer, FIRST)).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Enter");
  await expect(band(page, SECOND)).toBeVisible();
  await expect(drawer).toBeVisible();
  await expectOffFleet(page, SECOND);

  await page.locator("body").press("Escape");
  await expect(band(page, SECOND)).toBeHidden();
  await expect(headOf(drawer, SECOND)).toBeFocused();
  await expect(headOf(drawer, SECOND)).toHaveAttribute("aria-current", "true");
  await page.keyboard.press("ArrowUp");
  await expect(headOf(drawer, FIRST)).toHaveAttribute("aria-current", "true");
  await page.keyboard.press("Enter");
  await expect(band(page, FIRST)).toBeVisible();
  await expectOffFleet(page, FIRST);
});

test("Enter on a visitor card opens its resident's conversation, not the drawer", async ({ dashboard: page, daemon }) => {
  await launch(daemon);
  await selectResidentDrawer(page, daemon, "board");
  await askResident(daemon);
  const visitorOpen = page.getByRole("button", { name: `${NAME} needs you - resident, opens its conversation` });
  await expect(visitorOpen).toBeVisible();
  const drawer = drawerOf(page);

  await page.locator("body").click({ position: { x: 5, y: 400 } });
  await page.keyboard.press("ArrowDown");
  await expect(visitorOpen).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(band(page)).toBeVisible();
  await expect(drawer).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(band(page)).toBeHidden();
  await expect(visitorOpen).toBeVisible();

  // With the cursor on the visitor but the keyboard nowhere in particular, App's own Enter arm
  // opens the same conversation.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Enter");
  await expect(band(page)).toBeVisible();
  await expect(drawer).toHaveCount(0);
});

test("opened before any resident has arrived, the drawer puts the keyboard on the first card once it does", async ({ dashboard: page, daemon }) => {
  await selectResidentDrawer(page, daemon, "board");
  await expect(page.getByRole("button", { name: "Residents - 0 live", exact: true })).toBeVisible();

  await page.keyboard.press("Shift+KeyH");
  const drawer = drawerOf(page);
  await expect(drawer).toContainText("No residents are running. Launch one from a profile below.");

  // The resident arrives while the drawer is open and nobody has touched anything since.
  await launch(daemon);
  await expect(cardOf(drawer)).toBeVisible({ timeout: 60_000 });
  await expect(headOf(drawer)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(band(page)).toBeVisible();
});

test("a click elsewhere while the drawer waits for its first resident keeps the keyboard where it went", async ({ dashboard: page, daemon }) => {
  await selectResidentDrawer(page, daemon, "board");
  await expect(page.getByRole("button", { name: "Residents - 0 live", exact: true })).toBeVisible();

  await page.keyboard.press("Shift+KeyH");
  const drawer = drawerOf(page);
  await expect(drawer).toContainText("No residents are running. Launch one from a profile below.");
  // The operator moves on to the page beside it before any resident arrives. (With no session
  // anywhere the Board has nothing to draw, so this is its empty state.)
  await page.mouse.click(40, 400);

  await launch(daemon);
  await expect(cardOf(drawer)).toBeVisible({ timeout: 60_000 });
  await expect(headOf(drawer)).toBeEnabled();
  // Given every chance to land, it never pulls the keyboard into the drawer.
  await page.waitForTimeout(500);
  await expect(headOf(drawer)).not.toBeFocused();
  expect(await drawer.evaluate((el) => el.contains(document.activeElement))).toBe(false);
});

test("reopened after the selected resident has ended, the drawer puts the keyboard on a live card", async ({ dashboard: page, daemon }) => {
  const FIRST = "Alpha keeper";
  const SECOND = "Bravo keeper";
  await launch(daemon, FIRST);
  await launch(daemon, SECOND);
  await selectResidentDrawer(page, daemon, "board");
  await expect(page.getByRole("button", { name: "Residents - 2 live", exact: true })).toBeVisible();

  // Alpha is selected, and the drawer is closed with that selection left on it.
  await page.keyboard.press("Shift+KeyH");
  const drawer = drawerOf(page);
  await expect(headOf(drawer, FIRST)).toBeFocused();
  await expect(headOf(drawer, FIRST)).toHaveAttribute("aria-current", "true");
  const firstId = await cardOf(drawer, FIRST).getAttribute("data-resident-card");
  await page.keyboard.press("Shift+KeyH");
  await expect(drawer).toHaveCount(0);

  // Alpha's run ends while the drawer is closed; Bravo is still live.
  const sessions = await request<Array<{ id: string; task?: { id: string } }>>(daemon, "/api/sessions", undefined, "GET");
  const firstTask = sessions.find((s) => s.id === firstId)?.task?.id;
  expect(firstTask, "the selected resident's session carries its task").toBeTruthy();
  await request(daemon, `/api/tasks/${firstTask}/complete`, { outcome: "Stood down" });
  await expect(page.getByRole("button", { name: "Residents - 1 live", exact: true })).toBeVisible({ timeout: 60_000 });

  await page.keyboard.press("Shift+KeyH");
  await expect(cardOf(drawer, FIRST)).toHaveCount(0);
  await expect(headOf(drawer, SECOND)).toBeFocused();
  await expect(headOf(drawer, SECOND)).toHaveAttribute("aria-current", "true");
  await page.keyboard.press("Enter");
  await expect(band(page, SECOND)).toBeVisible();
});

for (const width of [1024, 900]) {
  test(`at ${width}px the Board drill-in stays whole beside the open drawer`, async ({ dashboard: page, daemon }) => {
    await page.setViewportSize({ width, height: 800 });
    await launch(daemon);
    await selectResidentDrawer(page, daemon, "board");
    await page.keyboard.press("Shift+KeyH");
    const drawer = drawerOf(page);
    await drawer.getByRole("button", { name: `Open ${NAME}` }).click();
    await expect(band(page)).toBeVisible();
    await expect(drawer).toBeVisible();

    // A drawer resident is not a card in any column, so its column is empty and no rail is drawn:
    // an empty column never renders, not even as the drill-in rail. The reader takes the whole
    // Board beside the 330px drawer - flush with its left edge, short of its right one - and
    // nothing of it runs past the Board's edge into its hidden overflow.
    await expect(page.locator(".board-col.is-rail")).toHaveCount(0);
    await expect(page.locator("main.board section.board-col")).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => {
      const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
      const board = document.querySelector(".board")!;
      const reader = box(".board-detail > .cdetail");
      return {
        overflow: board.scrollWidth - board.clientWidth,
        readerFromBoardLeft: Math.round(reader.left - box(".board").left),
        readerPastBoard: Math.round(reader.right - box(".board").right),
        readerPastDrawer: Math.round(reader.right - box(".residents-drawer").left),
        // The track that clips the reader, settled: it reveals the reader's whole width.
        trackShortOfBoard: Math.round(box(".board").right - box(".board-detail").right),
      };
    })).toMatchObject({
      overflow: 0, readerFromBoardLeft: 0, readerPastBoard: 0, readerPastDrawer: 0, trackShortOfBoard: 0,
    });
    // With no rail head beside it, the reader's own head carries the way back to the board.
    const back = page.locator(".board-detail .detail-head").getByRole("button", { name: "Back to the board" });
    await expect(back).toBeVisible();
    // The reply box sits whole across the reader's width, short of the drawer. Horizontal only:
    // how much height the composer gets is the window's height and the top bar's wrapping (on
    // Linux's wider fonts the top bar takes two rows at 900px), which the drawer does not change.
    const reply = page.locator(".board-detail").getByPlaceholder(/^Reply to this session/);
    await expect(reply).toBeVisible();
    const replyBox = (await reply.boundingBox())!;
    const readerBox = (await page.locator(".board-detail > .cdetail").boundingBox())!;
    const drawerBox = (await drawer.boundingBox())!;
    expect(replyBox.x).toBeGreaterThanOrEqual(readerBox.x);
    expect(replyBox.x + replyBox.width).toBeLessThanOrEqual(readerBox.x + readerBox.width);
    expect(replyBox.x + replyBox.width).toBeLessThanOrEqual(drawerBox.x);
    await capture(page, `10-drill-in-beside-drawer-${width}`);
    await back.click();
    await expect(page.locator(".board-detail .cdetail")).toHaveCount(0);
    await expect(page.locator("main.board")).toHaveAttribute("data-focus", "none");
  });
}

test("asked for from a profile with unsaved edits, the drawer opens only if the operator leaves for Fleet", async ({ dashboard: page, daemon }) => {
  const profile = await launch(daemon);
  await selectResidentDrawer(page, daemon, "board");
  const drawer = drawerOf(page);
  const gate = page.getByRole("dialog", { name: "Leave with unsaved changes" });
  const dirtyProfile = async (): Promise<void> => {
    await page.goto(`${daemon.baseURL}/#/residents/${profile.id}`);
    const instructions = page.getByRole("region", { name: `Resident profile ${NAME}` }).getByLabel("Profile instructions");
    await instructions.fill("A draft I am not done with.");
    // Out of the text box, so the drawer's chord is a command rather than typing.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  };

  // Stay: the drawer is not left waiting for the next visit to Fleet.
  await dirtyProfile();
  await page.keyboard.press("Shift+KeyH");
  await expect(gate).toBeVisible();
  await gate.getByRole("button", { name: "Cancel" }).click();
  await expect(page).toHaveURL(new RegExp(`#/residents/${profile.id}$`));
  await page.evaluate(() => { window.location.hash = "#/fleet"; });
  await gate.getByRole("button", { name: "Discard and leave" }).click();
  await expect(page).toHaveURL(/#\/fleet$/);
  await expect(edgeTab(page)).toBeVisible();
  await expect(drawer).toHaveCount(0);

  // Leave: the drawer opens on Fleet with the keyboard on a card, as any other open does.
  await dirtyProfile();
  await page.keyboard.press("Shift+KeyH");
  await gate.getByRole("button", { name: "Discard and leave" }).click();
  await expect(page).toHaveURL(/#\/fleet$/);
  await expect(drawer).toBeVisible();
  await expect(headOf(drawer)).toBeFocused();
});

test("the drawer's footer launches a profile, and a profile with no repository launches through Dispatch", async ({ dashboard: page, daemon }) => {
  const WITH_REPO = "Footer launcher";
  const NO_REPO = "Footer gardener";
  await createProfile(daemon, WITH_REPO);
  await createProfile(daemon, NO_REPO, { repo: false });
  await selectResidentDrawer(page, daemon, "board");

  await expect(edgeTab(page)).toHaveAccessibleName("Open the Residents drawer - 0 live");
  await expect(edgeTab(page).locator(".residents-edge-count")).toHaveCount(0);
  await expect(edgeTab(page)).toHaveText("⌂");

  await page.keyboard.press("Shift+KeyH");
  const drawer = drawerOf(page);
  await expect(drawer).toContainText("No residents are running. Launch one from a profile below.");
  await expect(drawer.getByRole("heading", { level: 2 })).toHaveText("Residents · 0 live");
  await expect(drawer.getByRole("list", { name: "Live residents" })).toHaveCount(0);
  const footer = drawer.locator(".residents-drawer-foot");
  const row = (name: string): Locator => footer.getByRole("listitem").filter({ hasText: name });
  await expect(row(WITH_REPO).getByRole("button", { name: `Launch ${WITH_REPO}` })).toHaveText("Launch");
  await expect(row(NO_REPO).getByRole("button", { name: `Launch ${NO_REPO}` })).toHaveText("Launch…");

  await row(WITH_REPO).getByRole("button", { name: `Launch ${WITH_REPO}` }).click();
  await expect(row(WITH_REPO).getByRole("status")).toHaveText("launched", { timeout: 60_000 });
  await expect(cardOf(drawer, WITH_REPO)).toBeVisible({ timeout: 60_000 });
  await capture(page, "08-footer-launched");

  await row(NO_REPO).getByRole("button", { name: `Launch ${NO_REPO}` }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog.getByRole("radio", { name: "Resident" })).toHaveAttribute("aria-checked", "true");
  await expect(dialog.getByRole("radio", { name: new RegExp(NO_REPO) })).toHaveAttribute("aria-checked", "true");
  await expect(dialog.getByRole("combobox", { name: "Repository" })).toHaveValue("");
});

test("behind its preview, the Profiles heading's chevron folds the launch list away from the keyboard, and the live residents take the room", async ({ dashboard: page, daemon }) => {
  const SPARE = "Spare launcher";
  await launch(daemon);
  await createProfile(daemon, SPARE);
  await selectResidentDrawer(page, daemon, "board");
  await expect(page.getByRole("button", { name: "Residents - 1 live", exact: true })).toBeVisible();
  await page.keyboard.press("Shift+KeyH");
  const drawer = drawerOf(page);
  await expect(cardOf(drawer)).toBeVisible();

  const heading = drawer.getByRole("heading", { level: 3, name: "Profiles" });
  const toggle = heading.getByRole("button", { name: "Profiles", exact: true });
  const launchSpare = drawer.getByRole("button", { name: `Launch ${SPARE}` });
  const launchWatcher = drawer.getByRole("button", { name: `Launch ${NAME}` });
  const body = drawer.locator(".residents-drawer-body");
  const chevron = toggle.locator("svg.brh-chevron");
  // Open, the chevron is unturned and points down. Folded, it is turned a quarter anticlockwise
  // to point right: rotate(-90deg) computes to matrix(cos, sin, -sin, cos) = (~0, -1, 1, ~0).
  const POINTS_DOWN = "none";
  const POINTS_RIGHT = /^matrix\([-\d.e]+, -1, 1, [-\d.e]+, 0, 0\)$/;

  // Previews start off in the suite.
  await expect(heading).toBeVisible();
  await expect(toggle).toHaveCount(0);
  await expect(heading.locator("svg.brh-chevron")).toHaveCount(0);
  await expect(launchSpare).toBeVisible();
  await capture(page, "10a-profiles-flag-off");
  await request(daemon, "/api/feature-flags", { kind: "flag", id: "resident-profiles-fold", enabled: true }, "PUT");
  await expect(toggle).toBeVisible();

  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(chevron).toBeVisible();
  await expect(chevron).toHaveCSS("transform", POINTS_DOWN);
  await expect(launchSpare).toBeVisible();
  await expect(launchWatcher).toBeVisible();
  const openBodyHeight = (await body.boundingBox())!.height;
  await capture(page, "10-profiles-open");

  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(heading).toBeVisible();
  await expect(toggle.locator("svg.brh-chevron")).toBeVisible();
  await expect(launchSpare).toBeHidden();
  await expect(launchWatcher).toBeHidden();
  await expect(drawer.locator(".residents-drawer-foot").getByRole("listitem")).toHaveCount(0);
  await expect(chevron).toHaveCSS("transform", POINTS_RIGHT);
  await expect(toggle).toBeFocused();
  await expect.poll(async () => (await body.boundingBox())!.height).toBeGreaterThan(openBodyHeight);
  await expect(cardOf(drawer)).toBeVisible();
  await capture(page, "11-profiles-folded");

  await closeDrawer(page);
  await page.keyboard.press("Shift+KeyH");
  await expect(drawer.getByRole("button", { name: "Profiles", exact: true })).toHaveAttribute("aria-expanded", "false");
  await expect(chevron).toHaveCSS("transform", POINTS_RIGHT);
  await expect(launchSpare).toBeHidden();

  await toggle.focus();
  await page.keyboard.press("Space");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(chevron).toHaveCSS("transform", POINTS_DOWN);
  await expect(launchSpare).toBeVisible();
  await expect(launchWatcher).toBeVisible();
  await expect.poll(async () => (await body.boundingBox())!.height).toBeLessThan(openBodyHeight + 1);

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(chevron).toHaveCSS("transform", POINTS_RIGHT);
  await expect(launchSpare).toBeHidden();
  await toggle.click();
  await expect(chevron).toHaveCSS("transform", POINTS_DOWN);
  await expect(launchSpare).toBeVisible();

  await toggle.click();
  await expect(launchSpare).toBeHidden();
  await request(daemon, "/api/feature-flags", { kind: "flag", id: "resident-profiles-fold", enabled: false }, "PUT");
  await expect(toggle).toHaveCount(0);
  await expect(launchSpare).toBeVisible();
});

test("Manage residents sits on its own row at the top, above the cards, and opens the Residents page", async ({ dashboard: page, daemon }) => {
  const FIRST = "Alpha keeper";
  const SECOND = "Bravo keeper";
  await launch(daemon, FIRST);
  await launch(daemon, SECOND);
  await selectResidentDrawer(page, daemon, "board");

  // Both residents have reached the dashboard before the drawer opens, so the layout measured
  // below is the one with both cards in it.
  await expect(page.getByRole("button", { name: "Residents - 2 live", exact: true })).toBeVisible();
  await page.keyboard.press("Shift+KeyH");
  const drawer = drawerOf(page);
  await expect(cardOf(drawer, SECOND)).toBeVisible();
  const manage = drawer.getByRole("button", { name: "Manage residents" });
  await expect(manage).toHaveCount(1);
  // The new row does not take the keyboard: opening the drawer still lands on the selected card.
  await expect(headOf(drawer, FIRST)).toBeFocused();
  await expect(manage).toBeInViewport();
  // Under the title, before the first card, and no longer in the footer under the profiles.
  const title = await drawer.getByRole("heading", { level: 2 }).boundingBox();
  const button = await manage.boundingBox();
  const firstCard = await cardOf(drawer, FIRST).boundingBox();
  expect(title && button && firstCard).toBeTruthy();
  expect(button!.y).toBeGreaterThan(title!.y + title!.height);
  // Close under the title, as one band with it: no more than a few pixels of air between them.
  expect(button!.y - (title!.y + title!.height)).toBeLessThanOrEqual(12);
  expect(button!.y + button!.height).toBeLessThanOrEqual(firstCard!.y);
  await expect(drawer.locator(".residents-drawer-foot").getByRole("button", { name: "Manage residents" })).toHaveCount(0);
  await expectContentClearsBorder(drawer);
  await capture(page, "09-manage-at-top");

  // The drawer is a column on Fleet, so it is not drawn over the Residents page.
  await manage.click();
  await expect(drawer).toHaveCount(0);
  await expect(page).toHaveURL(`${daemon.baseURL}/#/residents`);
});

test("the Keyboard panel refuses ⌥1 as macOS delivers it, and drops a binding stored as its symbol", async ({ dashboard: page, daemon }) => {
  await page.goto(`${daemon.baseURL}/#/settings/keyboard`);
  const panel = page
    .locator("section.settings-section")
    .filter({ has: page.getByRole("heading", { name: "Shortcuts", exact: true }) });
  const diffRow = panel.locator('[data-anchor="keyboard/diff"]');
  await diffRow.getByRole("button", { name: /^Change shortcut for Open diff/ }).click();
  await expect(diffRow.getByRole("button", { name: /^Recording/ })).toBeVisible();

  // What a US-layout Mac delivers for Option+1: the symbol it types as `key`, the digit as `code`.
  // Playwright's key table cannot produce the symbol, so the event is dispatched as the OS sends it.
  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "¡", code: "Digit1", altKey: true, bubbles: true, cancelable: true,
    }));
  });
  await expect(panel.locator(".settings-error")).toHaveText("⌥1 is reserved for the resident jump shortcuts.");
  await expect(diffRow.getByRole("button", { name: /^Recording/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(diffRow.getByRole("button", { name: /^Change shortcut for Open diff \(currently ⇧D\)/ })).toBeVisible();

  // A binding an earlier build recorded as the symbol is dropped on read: the action keeps its own key.
  await request(daemon, "/api/ui/config", { keybindings: { diff: "alt+¡" } }, "PUT");
  await page.reload();
  await expect(
    panel.locator('[data-anchor="keyboard/diff"]').getByRole("button", { name: /^Change shortcut for Open diff \(currently ⇧D\)/ }),
  ).toBeVisible();
});

test("opening or pinning from another page lands on Fleet with the keyboard on a card", async ({ dashboard: page, daemon }) => {
  await launch(daemon);
  await selectResidentDrawer(page, daemon, "board");
  const drawer = drawerOf(page);
  await expect(page.getByRole("button", { name: "Residents - 1 live", exact: true })).toBeVisible();

  await page.goto(`${daemon.baseURL}/#/settings/display`);
  await page.keyboard.press("Shift+KeyH");
  await expect(page).toHaveURL(/#\/fleet/);
  await expect(drawer).toBeVisible();
  await expect(headOf(drawer)).toBeFocused();
  await drawer.getByRole("button", { name: "Pin", exact: true }).click();
  await expect(drawer.getByRole("button", { name: "Unpin", exact: true })).toBeVisible();

  // The drawer mounts on Fleet with the palette's focus request already set.
  await page.goto(`${daemon.baseURL}/#/settings/display`);
  await expect(drawer).toHaveCount(0);
  await page.keyboard.press("Meta+K");
  await page.keyboard.type("Residents drawer or dock");
  await page.getByRole("option", { name: "Open the Residents drawer or dock, command" }).click();
  await expect(page).toHaveURL(/#\/fleet/);
  await expect(headOf(drawer)).toBeFocused();
});
