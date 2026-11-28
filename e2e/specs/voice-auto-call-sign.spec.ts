import { mkdirSync } from "node:fs";
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";
import { beListener, beVoiceShortcut, enableVoice, say, startSpeech, type VoiceShortcut } from "../fixtures/voice.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { AUTO_CALL_SIGN_DICTIONARY } from "../../src/shared/voice-call-signs.ts";
import { namesSoundAlike } from "../../src/shared/voice-names.ts";
import type { Session, Task } from "../../src/shared/types.ts";
import type { VoiceState } from "../../src/shared/voice.ts";

/**
 * Automatic call signs: tasks dispatched at once without a call sign each take a different,
 * distinctive name as they launch, an operator's own call sign is kept, and the names are what
 * Push-to-talk cards show and what voice routes to.
 *
 * No model tokens are spent: the agent binaries are faked (`e2e/fixtures/fake-agents.ts`), the
 * listener is the hello-only stand-in, and the desktop shortcut is a shell report.
 */

const EVIDENCE = artifactsDir("voice-auto-call-sign");
const EXPLICIT = "Captain";
const UNNAMED = ["Check the build", "Update the changelog", "Profile the parser"];

async function capture(page: Page, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${EVIDENCE}${name}.png` });
  // oxlint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/voice-auto-call-sign/${name}.png`);
}

async function json<T>(daemon: DaemonHandle, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(daemon.baseURL + path, { headers: { "content-type": "application/json" }, ...init });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response.json() as Promise<T>;
}

/** Launch a task through the dispatch route, optionally with the operator's own call sign. */
async function dispatch(daemon: DaemonHandle, title: string, callSign?: string): Promise<Task> {
  return json<Task>(daemon, "/api/tasks", { method: "POST", body: JSON.stringify({
    repoRoot: daemon.repo, intent: title, title, kind: "ship", agent: "claude", runtime: "sdk", workflowId: null,
    ...(callSign ? { callSign } : {}),
  }) });
}

async function idleSessions(daemon: DaemonHandle, tasks: readonly Task[]): Promise<Session[]> {
  let found: Session[] = [];
  await expect.poll(async () => {
    const sessions = await json<Session[]>(daemon, "/api/sessions");
    found = tasks.map((task) => sessions.find((session) => session.task?.id === task.id)!);
    return found.every((session) => session?.agentSessionId && session.state === "idle");
  }, { timeout: 90_000 }).toBe(true);
  return found;
}

async function voiceState(daemon: DaemonHandle): Promise<VoiceState> {
  return (await json<{ state: VoiceState }>(daemon, "/api/voice/mute")).state;
}

test("simultaneous dispatches get distinct automatic call signs, kept on the task, routable by voice and shown in Push-to-talk", async ({ dashboard: page, daemon }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1440, height: 960 });
  await enableVoice(daemon);
  // A cancel window holds a routed message on its card, so where it went can be read back.
  await json(daemon, "/api/voice/config", { method: "PUT", body: JSON.stringify({ muted: false, cancelWindow: { enabled: true, seconds: 30 } }) });

  // Four launches at once, one carrying the operator's own call sign.
  const tasks = await Promise.all([...UNNAMED.map((title) => dispatch(daemon, title)), dispatch(daemon, "Name the release", EXPLICIT)]);
  const sessions = await idleSessions(daemon, tasks);
  const signs = sessions.map((session) => session.task!.callSign!);
  expect(signs.at(-1), "an operator's own call sign is kept").toBe(EXPLICIT);
  const assigned = signs.slice(0, -1);
  expect(new Set(assigned).size, assigned.join(", ")).toBe(UNNAMED.length);
  for (const [i, name] of assigned.entries()) {
    expect(AUTO_CALL_SIGN_DICTIONARY as readonly string[]).toContain(name);
    for (const other of signs.slice(i + 1)) expect(namesSoundAlike(name, other), `${name} and ${other}`).toBe(false);
  }
  // Stored on the task rows, so a restart or another window reads the same names.
  const stored = withDaemonDb(daemon, (db) => tasks.map((task) =>
    (db.prepare("SELECT call_sign FROM tasks WHERE id = ?").get(task.id) as { call_sign: string | null }).call_sign));
  expect(stored).toEqual(signs);

  const listener = await beListener(daemon);
  let shortcut: VoiceShortcut | undefined;
  const status = page.locator(".app > .vi-status-line");
  const board = page.locator("main.board");
  const titles = board.locator(".tile:not(.is-resident) .tile-name");
  try {
    await json(daemon, "/api/ui/config", { method: "PUT", body: JSON.stringify({ layout: "board" }) });
    await page.reload();
    await expect(page.getByRole("button", { name: "Dispatch", exact: true })).toBeVisible();
    // Every name is on the roster voice routes by, beside any resident's.
    await expect.poll(async () => (await voiceState(daemon)).roster.map((entry) => entry.name))
      .toEqual(expect.arrayContaining(signs));

    // Addressed by its assigned name, a message is routed to that agent. Routing reads the same
    // roster in either listening mode; a Push-to-talk capture needs the native listener.
    const [target] = assigned;
    expect(await (await say(daemon, `${target}, check the build`, { id: "auto-sign" })).json()).toEqual({ accepted: true });
    await expect.poll(async () => {
      const entries = (await json<{ entries: { id: string; matchedName: string | null }[] }>(daemon, "/api/voice/heard")).entries;
      return entries.find((entry) => entry.id === "auto-sign")?.matchedName ?? null;
    }, { timeout: 30_000 }).toBe(target);
    await capture(page, "00-routed-to-assigned-sign");

    await json(daemon, "/api/voice/config", { method: "PUT", body: JSON.stringify({ listeningMode: "push-to-talk" }) });
    const state = await voiceState(daemon);
    expect(state.pushToTalkSession, "the dedicated mode opens a shortcut session").toBeTruthy();
    shortcut = await beVoiceShortcut(daemon, state);
    for (const [index, phase] of (["waiting", "held", "released"] as const).entries()) {
      const held = phase === "held";
      await shortcut.set(held);
      await expect(status).toContainText(held ? "Listening while held" : "Waiting for hotkey");
      await expect.poll(async () => (await titles.allTextContents()).sort()).toEqual([...signs].sort());
      for (const name of signs) {
        await expect(board.getByRole("button", { name: `Open ${name}`, exact: true })).toBeVisible();
      }
      await capture(page, `0${index + 1}-push-to-talk-${phase}-board`);
    }

    // Routed in Push-to-talk: words captured while the shortcut is held, addressed to another
    // assigned name, are sent on release to that agent. The daemon holds the capture until the
    // key is up and accepts it only inside that press, as it does for the native listener.
    const pttTarget = assigned[1]!;
    await shortcut.set(true);
    await expect(status).toContainText("Listening while held");
    const speech = await startSpeech(daemon);
    const sent = speech.finish(`${pttTarget}, check the build`, "ptt-auto-sign");
    // The capture ends before the key is released, as a person's words do.
    await page.waitForTimeout(100);
    await shortcut.set(false);
    expect(await (await sent).json()).toEqual({ accepted: true });
    await expect.poll(async () => {
      const entries = (await json<{ entries: { id: string; matchedName: string | null }[] }>(daemon, "/api/voice/heard")).entries;
      return entries.find((entry) => entry.id === "ptt-auto-sign")?.matchedName ?? null;
    }, { timeout: 30_000 }).toBe(pttTarget);
    await expect(status).toContainText("Waiting for hotkey");
    await expect(page.getByText(`To ${pttTarget}`, { exact: true })).toBeVisible();
    await capture(page, "04-push-to-talk-routed-to-assigned-sign");

    // The names survive a reload of the dashboard unchanged.
    await page.reload();
    await expect(status).toContainText("Waiting for hotkey");
    await expect.poll(async () => (await titles.allTextContents()).sort()).toEqual([...signs].sort());
  } finally {
    shortcut?.stop();
    listener.stop();
  }
});

test("with Voice off a dispatched task is still given a call sign, stored but not drawn, and the same name appears once Voice listens", async ({ dashboard: page, daemon }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 960 });
  // A fresh daemon starts with the `voice` preview off, and nothing here turns it on yet.
  await expect(page.locator(".app > .vi-status-line")).toHaveCount(0);

  const task = await dispatch(daemon, "Check the build");
  const [session] = await idleSessions(daemon, [task]);
  const sign = session!.task!.callSign!;
  expect(AUTO_CALL_SIGN_DICTIONARY as readonly string[]).toContain(sign);
  const stored = () => withDaemonDb(daemon, (db) =>
    (db.prepare("SELECT call_sign FROM tasks WHERE id = ?").get(task.id) as { call_sign: string | null }).call_sign);
  expect(stored()).toBe(sign);

  // Voice off: the card keeps its title and draws no call sign.
  await json(daemon, "/api/ui/config", { method: "PUT", body: JSON.stringify({ layout: "board" }) });
  await page.reload();
  const card = page.locator("main.board .tile").filter({ has: page.getByRole("button", { name: `Open ${session!.name}`, exact: true }) });
  await expect(card.locator(".tile-name")).toHaveText(session!.name);
  await expect(card.locator(".cs-mark")).toHaveCount(0);
  await expect(page.getByText(sign, { exact: true })).toHaveCount(0);

  // Voice on and listening: the same stored name is drawn beside the title and is on the roster.
  await enableVoice(daemon);
  const listener = await beListener(daemon);
  try {
    await page.reload();
    await expect(page.locator(".app > .vi-status-line")).toHaveAccessibleName("Voice: listening. Mute");
    await expect(card.locator(".cs-mark")).toHaveText(`Call sign Say ${sign}`);
    await expect.poll(async () => (await voiceState(daemon)).roster.map((entry) => entry.name)).toContain(sign);
    expect(stored(), "turning Voice on does not rename the task").toBe(sign);
    await capture(page, "05-voice-off-assigned-then-on");
  } finally {
    listener.stop();
  }
});
