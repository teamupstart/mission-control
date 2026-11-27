import { mkdirSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";
import { test, expect } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";
import { beListener, beVoiceShortcut, enableVoice, type VoiceShortcut } from "../fixtures/voice.ts";
import { runningAgent } from "../fixtures/voice-cards.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { ResidentProfile } from "../../src/shared/residents.ts";
import type { Session } from "../../src/shared/types.ts";
import type { VoiceState } from "../../src/shared/voice.ts";

/**
 * No model tokens are spent: the agent binaries are faked (`e2e/fixtures/fake-agents.ts`), the
 * listener is the hello-only stand-in, and the desktop shortcut is a shell report.
 */

const EVIDENCE = artifactsDir("voice-push-to-talk-card-names");
const RESIDENT = "Drawer watcher";
const REFERENCE = "Marlowe";
const CALL_SIGN = "Atlas";

async function capture(page: Page, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${EVIDENCE}${name}.png` });
  // oxlint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/voice-push-to-talk-card-names/${name}.png`);
}

async function request<T>(daemon: DaemonHandle, path: string, body?: unknown, method = "POST"): Promise<T> {
  const response = await fetch(daemon.baseURL + path, body === undefined && method === "GET" ? {} : {
    method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response.json() as Promise<T>;
}

function waitingResidents(daemon: DaemonHandle): number {
  return withDaemonDb(daemon, (db) => (db.prepare(
    "SELECT COUNT(*) AS n FROM resident_runs WHERE ended_at IS NULL AND launch_state = 'launched' AND loop_state = 'waiting'",
  ).get() as { n: number }).n);
}

/** Author and launch one resident through the real routes, and wait until its loop is waiting. */
async function launchResident(daemon: DaemonHandle): Promise<ResidentProfile> {
  const personas = await request<Array<{ id: string; name: string }>>(daemon, "/api/personas", undefined, "GET");
  const profile = await request<ResidentProfile>(daemon, "/api/residents/profiles", { settings: {
    identity: { name: RESIDENT, referenceName: REFERENCE },
    persona: { personaId: personas.find((p) => p.name === "Code Risk Reviewer")!.id },
    workspace: { defaultRepoRoot: daemon.repo },
    execution: { model: "claude-fable-5" },
    // A long cadence keeps the resident waiting between steps instead of iterating under the test.
    loop: { delaySeconds: 3600, minDelaySeconds: 60, maxDelaySeconds: 3600 },
  } });
  await request(daemon, `/api/residents/profiles/${profile.id}/launch`, { repoRoot: daemon.repo, requestId: "launch-ptt-names" });
  await expect.poll(() => waitingResidents(daemon), { timeout: 60_000 }).toBe(1);
  return profile;
}

async function voiceState(daemon: DaemonHandle): Promise<VoiceState> {
  return (await request<{ state: VoiceState }>(daemon, "/api/voice/mute", undefined, "GET")).state;
}

interface Surfaces { session: Locator; resident: Locator }

function boardTitles(page: Page): Surfaces {
  const board = page.locator("main.board");
  return {
    session: board.locator(".tile:not(.is-resident) .tile-name"),
    resident: board.locator(".tile.is-resident .tile-name"),
  };
}

/**
 * The Console rail names each row by its title, and prints it after the resident's chip: the
 * row's accessible name is the title alone, and its visible title holds it after the chip text.
 */
async function expectRailTitles(page: Page, session: string, resident: string): Promise<void> {
  const rail = page.getByRole("navigation", { name: "Sessions" });
  for (const [row, title] of [[rail.locator(".rail-row:not(.is-resident)"), session], [rail.locator(".rail-row.is-resident"), resident]] as const) {
    await expect(row).toHaveAccessibleName(title);
    await expect(row.locator(".rail-name")).toHaveText(new RegExp(`${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
  }
}

async function useLayout(page: Page, daemon: DaemonHandle, layout: "board" | "console"): Promise<void> {
  await request(daemon, "/api/ui/config", { layout }, "PUT");
  await page.reload();
  await expect(page.getByRole("button", { name: "Dispatch", exact: true })).toBeVisible();
}

/** The separate call-sign element an Always-on session card draws beside its title. */
function callSignOf(page: Page): Locator {
  return page.locator("main.board .tile:not(.is-resident) .cs-mark");
}

async function expectTitles(surfaces: Surfaces, session: string, resident: string): Promise<void> {
  await expect(surfaces.session).toHaveText(session);
  await expect(surfaces.resident).toHaveText(resident);
}

test("Always-on keeps the session title with its call sign beside it, and Push-to-talk titles cards by call signs and quoted reference names", async ({ dashboard: page, daemon }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 960 });
  await enableVoice(daemon);
  const profile = await launchResident(daemon);
  const session: Session = await runningAgent(page, daemon, CALL_SIGN);
  expect(session.task?.callSign).toBe(CALL_SIGN);
  expect(session.name, "the session's ordinary name is not its call sign").not.toBe(CALL_SIGN);
  const listener = await beListener(daemon);
  let shortcut: VoiceShortcut | undefined;
  const status = page.locator(".app > .vi-status-line");
  try {
    await useLayout(page, daemon, "board");
    await expect(status).toHaveAccessibleName("Voice: listening. Mute");
    // Always-on: the session keeps its title and draws its call sign under it (Subtitle line,
    // the default Call sign style). A resident still answers to its quoted reference name.
    await expectTitles(boardTitles(page), session.name, `"${REFERENCE}"`);
    await expect(callSignOf(page)).toHaveText(`Call sign Say ${CALL_SIGN}`);
    await expect(page.locator("main.board").getByRole("button", { name: `Open ${session.name}`, exact: true })).toBeVisible();
    await capture(page, "01-always-on-listening-board");
    await status.click();
    await expect(status).toHaveAccessibleName("Voice: muted. Unmute");
    await expectTitles(boardTitles(page), session.name, RESIDENT);
    await expect(callSignOf(page)).toHaveCount(0);
    await capture(page, "02-always-on-muted-board");
    await status.click();
    await expect(status).toHaveAccessibleName("Voice: listening. Mute");
    await expectTitles(boardTitles(page), session.name, `"${REFERENCE}"`);
    await expect(callSignOf(page)).toHaveText(`Call sign Say ${CALL_SIGN}`);

    await request(daemon, "/api/voice/config", { listeningMode: "push-to-talk" }, "PUT");
    const state = await voiceState(daemon);
    expect(state.pushToTalkSession, "the dedicated mode opens a shortcut session").toBeTruthy();
    shortcut = await beVoiceShortcut(daemon, state);
    for (const [index, phase] of (["waiting", "held", "released"] as const).entries()) {
      const held = phase === "held";
      await shortcut.set(held);
      await expect(status).toContainText(held ? "Listening while held" : "Waiting for hotkey");
      await expect(status).toHaveClass(held ? /vi-push-to-talk/ : /vi-waiting-for-key/);
      await expectTitles(boardTitles(page), CALL_SIGN, `"${REFERENCE}"`);
      // Push-to-talk makes the call sign the title, so no second copy is drawn beside it.
      await expect(callSignOf(page)).toHaveCount(0);
      await expect(page.locator("main.board").getByRole("button", { name: `Open ${CALL_SIGN}`, exact: true })).toBeVisible();
      await capture(page, `0${index + 3}-push-to-talk-${phase}-board`);
    }

    await page.locator(".filter-box").click();
    await page.getByRole("textbox", { name: /Filter sessions/ }).fill(CALL_SIGN);
    await expect(boardTitles(page).session).toHaveText(CALL_SIGN);
    await expect(boardTitles(page).resident).toHaveCount(0);
    await page.getByRole("textbox", { name: /Filter sessions/ }).fill("");

    await useLayout(page, daemon, "console");
    for (const held of [false, true]) {
      await shortcut.set(held);
      await expect(status).toContainText(held ? "Listening while held" : "Waiting for hotkey");
      await expectRailTitles(page, CALL_SIGN, `"${REFERENCE}"`);
    }
    await capture(page, "06-push-to-talk-held-console");
    await shortcut.set(false);

    await request(daemon, "/api/feature-flags", { kind: "flag", id: "voice", enabled: false }, "PUT");
    await expect(status).toHaveCount(0);
    await expectRailTitles(page, session.name, RESIDENT);
    await useLayout(page, daemon, "board");
    await expectTitles(boardTitles(page), session.name, RESIDENT);
    await capture(page, "07-voice-off-board");

    await request(daemon, "/api/feature-flags", { kind: "flag", id: "voice", enabled: true }, "PUT");
    await request(daemon, `/api/tasks/${session.task!.id}/update`, { callSign: null });
    await request(daemon, `/api/residents/profiles/${profile.id}`, {
      expectedRevision: profile.revision,
      settings: { ...profile.settings, identity: { ...profile.settings.identity, referenceName: "" } },
    }, "PATCH");
    await shortcut.set(false, await voiceState(daemon));
    await expect(status).toContainText("Waiting for hotkey");
    await expectTitles(boardTitles(page), session.name, RESIDENT);
    await capture(page, "08-push-to-talk-no-spoken-names-board");
  } finally {
    shortcut?.stop();
    listener.stop();
  }
});

test("the Residents drawer keeps a quoted reference name in Push-to-talk between holds and while one is held", async ({ dashboard: page, daemon }) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 1440, height: 960 });
  await enableVoice(daemon);
  await launchResident(daemon);
  await request(daemon, "/api/ui/config", { residentPlacement: "drawer", residentDrawerPinned: true, layout: "board" }, "PUT");
  await page.evaluate((next) => {
    const raw = JSON.parse(window.localStorage.getItem("mission-control.ui") ?? "{}") as Record<string, unknown>;
    window.localStorage.setItem("mission-control.ui", JSON.stringify({ ...raw, ...next }));
  }, { residentPlacement: "drawer", residentDrawerPinned: true, layout: "board" });
  await page.reload();
  const listener = await beListener(daemon);
  let shortcut: VoiceShortcut | undefined;
  const status = page.locator(".app > .vi-status-line");
  try {
    const drawer = page.getByRole("complementary", { name: "Residents", exact: true });
    const title = drawer.locator(".residents-drawer-name");
    await expect(status).toHaveAccessibleName("Voice: listening. Mute");
    await expect(title).toHaveText(`"${REFERENCE}"`);

    await request(daemon, "/api/voice/config", { listeningMode: "push-to-talk" }, "PUT");
    shortcut = await beVoiceShortcut(daemon, await voiceState(daemon));
    for (const held of [false, true, false]) {
      await shortcut.set(held);
      await expect(status).toContainText(held ? "Listening while held" : "Waiting for hotkey");
      await expect(title).toHaveText(`"${REFERENCE}"`);
      await expect(drawer.getByRole("button", { name: new RegExp(`^"${REFERENCE}", `) })).toBeVisible();
      if (held) await capture(page, "09-push-to-talk-held-drawer");
    }
    await capture(page, "10-push-to-talk-waiting-drawer");

    await request(daemon, "/api/voice/config", { listeningMode: "always-on" }, "PUT");
    await expect(status).toHaveAccessibleName("Voice: listening. Mute");
    await expect(title).toHaveText(`"${REFERENCE}"`);
    await status.click();
    await expect(status).toHaveAccessibleName("Voice: muted. Unmute");
    await expect(title).toHaveText(RESIDENT);
  } finally {
    shortcut?.stop();
    listener.stop();
  }
});
