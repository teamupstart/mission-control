import { join, resolve } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { _electron, type ElectronApplication, type JSHandle, type Locator, type Page } from "playwright";
import type { HeardEntry } from "../../src/shared/voice-routing.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { beListener, enableVoice, say } from "../fixtures/voice.ts";
import { assertElectronGuiLaunchAllowed } from "../../test/helpers/electron-gui.ts";

test.skip(process.platform !== "darwin", "the floating pill is a macOS desktop window");

const SEPARATED = "Steve, check the build, bagel, Carol, give me a report on the status of some project";

// Capture the native window: a CSS screenshot crops Electron's zoomed pixels.
async function captureWindow(win: JSHandle<Electron.BrowserWindow>, name: string) {
  if (!process.env.MC_E2E_EVIDENCE) return;
  const dir = artifactsDir("voice-pill-stack");
  mkdirSync(dir, { recursive: true });
  const png = await win.evaluate(async win => (await win.webContents.capturePage()).toPNG().toString("base64"));
  writeFileSync(join(dir, name + ".png"), Buffer.from(png, "base64"));
}

async function launch(daemon: DaemonHandle, seconds = 30) {
  assertElectronGuiLaunchAllowed();
  const app = await _electron.launch({
    args: [resolve("."), "--user-data-dir=" + join(daemon.home, "chromium")],
    env: { ...process.env, HOME: daemon.home, MISSION_HOME: daemon.home,
      MISSION_PORT: new URL(daemon.baseURL).port, MISSION_DEV_SERVER_URL: daemon.baseURL },
  });
  const dashboard = await app.firstWindow();
  await expect(dashboard.locator(".app")).toBeVisible();
  await enableVoice(daemon);
  expect((await dashboard.request.put(daemon.baseURL + "/api/voice/config", { data: {
    muted: false, listeningMode: "always-on", separatorWord: "bagel", cancelWindow: { enabled: true, seconds },
  } })).ok()).toBe(true);
  for (const name of ["Steve", "Carol", "Will"]) {
    expect((await dashboard.request.post(daemon.baseURL + "/api/residents/profiles", { data: { settings: {
      identity: { name, description: "Builds" }, persona: { personaId: "builtin:code-risk-reviewer" },
    } } })).ok()).toBe(true);
  }
  return { app, dashboard };
}

async function pillWindow(app: ElectronApplication) {
  await expect.poll(() => app.windows().find(w => w.url().endsWith("#/voice/pill"))?.url()).toBeTruthy();
  const page = app.windows().find(w => w.url().endsWith("#/voice/pill"))!;
  return { page, win: await app.browserWindow(page) };
}

/** The visible pending pills, top to bottom. */
const pills = (pill: Page) => pill.getByRole("status").filter({ has: pill.getByRole("button", { name: "Cancel", exact: true }) });
const seconds = async (card: Locator) => parseInt(await card.getByRole("button", { name: "Send now" }).innerText(), 10);

/** Every pending pill is fully inside the native window, below the one before it, with operable controls. */
async function expectStacked(pill: Page, win: JSHandle<Electron.BrowserWindow>, names: string[]) {
  const cards = pills(pill);
  await expect(cards).toHaveCount(names.length);
  let previousBottom = -Infinity;
  for (const [index, name] of names.entries()) {
    const card = cards.nth(index);
    await expect(card).toContainText("To " + name);
    for (const control of [card.getByRole("button", { name: "Send now" }), card.getByRole("button", { name: "Cancel", exact: true })]) {
      await expect(control).toBeEnabled();
      await expect(control).toBeInViewport({ ratio: 1 });
    }
    await expect(card.getByRole("button", { name: "Send now" })).toHaveText(/^\d+$/);
    const box = (await card.boundingBox())!;
    expect(box.y, `${name} starts below the pill above it`).toBeGreaterThanOrEqual(previousBottom);
    // Spoken "cancel" acts on the newest message, so its hint sits once, under the bottom pill.
    const hint = card.getByText("to stop.");
    if (index === names.length - 1) await expect(hint).toBeVisible();
    else await expect(hint).toBeHidden();
    // The pointer must reach the controls through the transparent window.
    const hit = await pill.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest(".voice-card"),
      { x: box.x + box.width / 2, y: box.y + box.height / 2 });
    expect(hit).toBe(true);
    previousBottom = box.y + box.height;
  }
  // The native window grows to the whole stack, the last pill's hint included.
  const content = await pill.locator("#root").evaluate(el => el.getBoundingClientRect().height);
  expect(content).toBeGreaterThanOrEqual(previousBottom);
  await expect.poll(async () => (await win.evaluate(win => win.getContentBounds())).height).toBe(Math.ceil(content));
  await expect(pill.getByRole("combobox", { name: "Voice message" })).toHaveCount(0);
}

async function heard(daemon: DaemonHandle): Promise<HeardEntry[]> {
  return (await (await fetch(daemon.baseURL + "/api/voice/heard")).json()).entries;
}
const outcomeOf = async (daemon: DaemonHandle, words: RegExp) => (await heard(daemon)).find(entry => words.test(entry.text))?.outcome;

test("concurrent and staggered pills stack oldest first, and cancel or send only their own message", async ({ daemon }) => {
  const { app } = await launch(daemon);
  const listener = await beListener(daemon);
  try {
    expect(await (await say(daemon, SEPARATED, { id: "two-messages" })).json()).toEqual({ accepted: true });
    const { page: pill, win } = await pillWindow(app);
    await expectStacked(pill, win, ["Steve", "Carol"]);
    await expect(pills(pill).first()).toContainText("check the build");
    await expect(pills(pill).last()).toContainText("give me a report on the status of some project");
    await captureWindow(win, "two-concurrent-separated");

    // A later phrase opens its own, longer countdown beneath the two.
    await pill.waitForTimeout(3000);
    await say(daemon, "Will, run the release checklist", { id: "staggered" });
    await expectStacked(pill, win, ["Steve", "Carol", "Will"]);
    const [steve, carol, will] = [0, 1, 2].map(i => pills(pill).nth(i));
    expect(await seconds(will!)).toBeGreaterThan(await seconds(steve!));
    await captureWindow(win, "three-staggered");

    // Cancel the middle pill: Steve and Will keep their own clocks and Will moves up.
    const beforeCancel = { steve: await seconds(steve!), will: await seconds(will!) };
    await carol!.getByRole("button", { name: "Cancel", exact: true }).click();
    await expectStacked(pill, win, ["Steve", "Will"]);
    expect(await seconds(pills(pill).first())).toBeLessThanOrEqual(beforeCancel.steve);
    expect(await seconds(pills(pill).last())).toBeLessThanOrEqual(beforeCancel.will);
    expect(await seconds(pills(pill).last())).toBeGreaterThan(await seconds(pills(pill).first()));
    await expect.poll(() => outcomeOf(daemon, /give me a report/)).toBe("cancelled");
    expect(await outcomeOf(daemon, /check the build/)).toBe("pending");
    expect(await outcomeOf(daemon, /release checklist/)).toBe("pending");
    await captureWindow(win, "after-middle-cancel");

    // Send the top pill now: only Steve's message leaves, and Will moves to the top.
    const willBefore = await seconds(pills(pill).last());
    await pills(pill).first().getByRole("button", { name: "Send now" }).click();
    await expectStacked(pill, win, ["Will"]);
    expect(await seconds(pills(pill).first())).toBeLessThanOrEqual(willBefore);
    await expect.poll(() => outcomeOf(daemon, /check the build/)).not.toBe("pending");
    expect(await outcomeOf(daemon, /check the build/)).not.toBe("cancelled");
    expect(await outcomeOf(daemon, /release checklist/)).toBe("pending");
    await captureWindow(win, "after-top-send-now");

    await pills(pill).first().getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(pill.getByRole("status")).toContainText("Cancelled");
    expect(await outcomeOf(daemon, /release checklist/)).toBe("cancelled");
  } finally { listener.stop(); await app.close(); }
});

test("pills leave the stack when their own countdown ends, and the rest move up without restarting", async ({ daemon }) => {
  const { app } = await launch(daemon, 6);
  const listener = await beListener(daemon);
  try {
    await say(daemon, "Steve, check the build", { id: "first" });
    const { page: pill, win } = await pillWindow(app);
    await expectStacked(pill, win, ["Steve"]);
    await pill.waitForTimeout(3000);
    await say(daemon, "Carol, give me a report", { id: "second" });
    await expectStacked(pill, win, ["Steve", "Carol"]);
    const carolBefore = await seconds(pills(pill).last());
    expect(carolBefore).toBeGreaterThan(await seconds(pills(pill).first()));
    await captureWindow(win, "staggered-before-expiry");
    // Steve's window closes first; Carol's pill moves up and keeps counting from where it was.
    await expectStacked(pill, win, ["Carol"]);
    const carolAfter = await seconds(pills(pill).first());
    expect(carolAfter).toBeLessThan(carolBefore);
    expect(carolAfter).toBeGreaterThan(0);
    await captureWindow(win, "staggered-after-first-expiry");
    await expect.poll(() => outcomeOf(daemon, /check the build/)).not.toBe("pending");
    expect(await outcomeOf(daemon, /give me a report/)).toBe("pending");
    await expect(pills(pill)).toHaveCount(0, { timeout: 10_000 });
    await expect.poll(() => outcomeOf(daemon, /give me a report/)).not.toBe("pending");
  } finally { listener.stop(); await app.close(); }
});

test("a single pending message keeps the single-pill design", async ({ daemon }) => {
  const { app } = await launch(daemon);
  const listener = await beListener(daemon);
  try {
    await say(daemon, "Steve, check the keyboard");
    const { page: pill, win } = await pillWindow(app);
    await expectStacked(pill, win, ["Steve"]);
    await expect(pill.getByRole("status")).toHaveCount(1);
    await expect(pill.getByRole("status")).toHaveCSS("border-radius", "999px");
    await expect(pill.getByText("Say cancel to stop.")).toBeVisible();
    await captureWindow(win, "single-pill");
    await pill.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(pill.getByRole("status")).toContainText("Cancelled");
    await captureWindow(win, "single-pill-cancelled");
  } finally { listener.stop(); await app.close(); }
});
