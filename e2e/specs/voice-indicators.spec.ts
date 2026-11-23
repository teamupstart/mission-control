import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "../fixtures/test.ts";
import { beListener, enableVoice, voiceToken } from "../fixtures/voice.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";

test("five selected indicators follow the daemon and advertise only a registered chord", async ({ dashboard: page, context, daemon }) => {
  const root = artifactsDir("voice-window");
  let capture: string | undefined;
  if (process.env.MC_E2E_EVIDENCE) {
    mkdirSync(root, { recursive: true });
    capture = mkdtempSync(join(root, "dashboard-"));
  }
  const status = page.locator("button.vi-status-line");
  await expect(status).toHaveCount(0);
  await enableVoice(daemon);
  await expect(status).toHaveAccessibleName("Voice: not listening. Open Setup");
  await status.click();
  await expect(page.locator("#setup-family-voice")).toHaveAttribute("aria-current", "true");
  const listener = await beListener(daemon);
  try {
    await page.goto(daemon.baseURL + "/#/settings/voice");
    await expect(status).toHaveAccessibleName("Voice: listening. Mute");
    const peer = await context.newPage();
    await peer.goto(daemon.baseURL);
    await status.click();
    await expect(peer.locator("button.vi-status-line")).toHaveAccessibleName("Voice: muted. Unmute");
    await status.click();
    const settings = page.getByRole("group", { name: "In the window" });
    await expect(settings.getByRole("checkbox", { name: "Status line" })).toBeChecked();
    for (const name of ["Top-bar segment", "Floating button", "Edge light", "Composer microphone"]) {
      await settings.getByRole("checkbox", { name }).check();
    }
    await expect(page.locator(".pulse .vi-topbar")).toBeVisible();
    await expect(page.locator("button.vi .kb-hint")).toHaveCount(0);
    await expect(status).not.toContainText("⌃");
    const report = (hotkeyError: unknown, callActive = false, pushToTalk = false) => page.request.post(daemon.baseURL + "/voice/shell-report", {
      headers: { "x-harness-token": voiceToken(daemon) }, data: { capabilities: { hotkey: { available: true } }, hotkeyError, callActive, pushToTalk },
    });
    expect((await report(null)).ok()).toBe(true);
    await expect(status.locator("kbd")).toHaveText("⌃⌥M");
    expect((await report(null, true)).ok()).toBe(true);
    await expect(status).toHaveAccessibleName("Voice: on a call. Mute");
    await expect(status).toContainText("Hold ⌃⌥M to talk");
    expect((await report(null, true, true)).ok()).toBe(true);
    await expect(status).toHaveAccessibleName("Voice: talk. Mute");
    expect((await report({ reason: "Already in use", chordInForce: null })).ok()).toBe(true);
    await expect(status.locator("kbd")).toHaveCount(0);
    if (capture) {
      await page.mouse.move(1, 200);
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await expect(page.locator(".tooltip")).toHaveCount(0);
      await settings.screenshot({ path: join(capture, "previews.png") });
    }
    const task = await page.request.post(daemon.baseURL + "/api/tasks", { data: {
      repoRoot: daemon.repo, intent: "Show the voice composer", title: "Voice fixture", kind: "ship", agent: "claude", runtime: "sdk", workflowId: null, callSign: "Will",
    } });
    expect(task.ok(), await task.text()).toBe(true);
    await page.goto(daemon.baseURL);
    const session = page.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first();
    await expect(session).toHaveClass(/tone-idle/);
    await session.click();
    await expect(page.getByPlaceholder('Message to send… or say "Will, …"')).toBeVisible();
    const peerStatus = peer.locator("button.vi-status-line");
    for (const style of ["status-line", "topbar", "floating", "edge", "composer"]) {
      await test.step(`Click ${style} in window A and observe Muted, then Listening, in window B`, async () => {
        const control = page.locator(`button.vi-${style}`);
        await expect(peerStatus).toHaveAccessibleName("Voice: listening. Mute");
        await control.click();
        await expect(peerStatus).toHaveAccessibleName("Voice: muted. Unmute");
        await expect(control).toHaveAccessibleName("Voice: muted. Unmute");
        if (capture && style === "composer") {
          await expect(page.getByPlaceholder("Voice is muted")).toBeVisible();
          await page.mouse.move(1, 200);
          await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
          await page.screenshot({ path: join(capture, "live-muted.png") });
          await peer.screenshot({ path: join(capture, "peer-muted.png") });
        }
        await control.click();
        await expect(peerStatus).toHaveAccessibleName("Voice: listening. Mute");
        await expect(status).toHaveAccessibleName("Voice: listening. Mute");
      });
    }
    if (capture) {
      await page.setViewportSize({ width: 1800, height: 860 });
      await page.locator("button.vi-floating").hover();
      await page.screenshot({ path: join(capture, "all-five.png") });
    }
    const toggle = (enabled: boolean) => page.request.put(daemon.baseURL + "/api/feature-flags", {
      data: { kind: "flag", id: "voice", enabled },
    });
    await test.step("Disable voice: all five controls disappear while the session rail, Dispatch and ordinary reply composer remain", async () => {
      await expect(page.locator("button.vi")).toHaveCount(5);
      expect((await toggle(false)).ok()).toBe(true);
      await expect(page.locator("button.vi")).toHaveCount(0);
      await expect(peerStatus).toHaveCount(0);
      await expect(session).toBeVisible();
      await expect(page.getByRole("button", { name: "Dispatch", exact: true })).toBeVisible();
      await expect(page.getByPlaceholder(/^Reply to this session/)).toBeEnabled();
      if (capture) await page.screenshot({ path: join(capture, "flag-off.png") });
    });
    expect((await toggle(true)).ok()).toBe(true);
    await page.goto(daemon.baseURL + "/#/settings/voice");
    for (const box of await settings.getByRole("checkbox").all()) await box.uncheck();
    await expect(page.locator("button.vi")).toHaveCount(0);
    await page.reload();
    await expect(settings.getByRole("checkbox", { checked: true })).toHaveCount(0);
  } finally { listener.stop(); }
});
