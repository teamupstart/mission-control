import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startDevDashboard } from "../fixtures/dev-dashboard.ts";
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
    await test.step("The status tooltip is visible and inside the viewport on hover and focus", async () => {
      const bubble = page.locator(".tooltip").filter({ hasText: "Say a name, then your message." });
      await page.mouse.move(1, 200);
      await status.blur();
      await expect(bubble).toHaveCount(0);
      await status.hover();
      await expect(bubble).toBeVisible();
      await expect(bubble).toBeInViewport({ ratio: 1 });
      await page.mouse.move(1, 200);
      await expect(bubble).toHaveCount(0);
      await status.focus();
      await expect(bubble).toBeVisible();
      await expect(bubble).toBeInViewport({ ratio: 1 });
      if (capture) {
        const size = page.viewportSize()!;
        await page.screenshot({ path: join(capture, "status-tooltip.png"), clip: {
          x: 0, y: size.height - 100, width: size.width, height: 100,
        } });
      }
      await status.blur();
    });
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
    const reply = page.getByRole("textbox", { name: /^Reply to this session.*Enter to send, Shift\+Enter for newline/ });
    await expect(reply).toHaveAccessibleDescription('Message to send… or say "Will, …"');
    const peerStatus = peer.locator("button.vi-status-line");
    for (const style of ["status-line", "topbar", "floating", "edge", "composer"]) {
      await test.step(`Click ${style} in window A and observe Muted, then Listening, in window B`, async () => {
        const control = page.locator(`button.vi-${style}`);
        await expect(peerStatus).toHaveAccessibleName("Voice: listening. Mute");
        await control.click();
        await expect(peerStatus).toHaveAccessibleName("Voice: muted. Unmute");
        await expect(control).toHaveAccessibleName("Voice: muted. Unmute");
        if (style === "composer") await test.step("The muted reply box keeps its typing instructions, describes the voice state and accepts a newline", async () => {
          await expect(reply).toHaveAccessibleDescription("Voice is muted");
          await expect(reply).toHaveAttribute("placeholder", "Voice is muted");
          await reply.fill("Typed while muted");
          await reply.press("Shift+Enter");
          await expect(reply).toHaveValue("Typed while muted\n");
          await reply.fill("");
        });
        if (capture && style === "composer") {
          await page.mouse.move(1, 200);
          await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
          await page.screenshot({ path: join(capture, "live-muted.png") });
          await peer.screenshot({ path: join(capture, "peer-muted.png") });
        }
        await control.click();
        await expect(peerStatus).toHaveAccessibleName("Voice: listening. Mute");
        await expect(status).toHaveAccessibleName("Voice: listening. Mute");
        if (style === "composer") await expect(reply).toHaveAccessibleDescription('Message to send… or say "Will, …"');
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

test("a failed mute keeps the indicator listening until a peer retries, then the error stays cleared", async ({ dashboard: page, daemon, context }) => {
  await enableVoice(daemon);
  const listener = await beListener(daemon);
  try {
    const mute = page.getByRole("button", { name: "Voice: listening. Mute", exact: true });
    await page.route("**/api/voice/mute", route => {
      expect(route.request().method()).toBe("POST");
      expect(route.request().postDataJSON()).toEqual({ muted: true });
      return route.fulfill({ status: 503, json: { error: "Listener could not mute." } });
    }, { times: 1 });

    await mute.click();
    const error = page.getByRole("alert").filter({ hasText: "Listener could not mute." });
    await expect(error).toBeVisible();
    await expect(mute).toHaveText(/Listening/);
    const peer = await context.newPage();
    await peer.goto(daemon.baseURL);
    await peer.getByRole("button", { name: "Voice: listening. Mute" }).click();
    await expect(page.getByRole("button", { name: "Voice: muted. Unmute" })).toBeVisible();
    await expect(error).toHaveCount(0);
    await peer.getByRole("button", { name: "Voice: muted. Unmute" }).click();
    await expect(mute).toBeVisible();
    await expect(error).toHaveCount(0);
  } finally {
    listener.stop();
  }
});

test("a failed indicator save shows an alert and restores the previous selection and top bar", async ({ dashboard: page, daemon }) => {
  await enableVoice(daemon);
  await page.goto(daemon.baseURL + "/#/settings/voice");
  const settings = page.getByRole("group", { name: "In the window" });
  const statusLine = settings.getByRole("checkbox", { name: "Status line" });
  const topbar = settings.getByRole("checkbox", { name: "Top-bar segment" });
  const segment = page.locator("header.topbar").getByRole("button", { name: /^Voice:/ });
  await expect(statusLine).toBeChecked();
  await expect(topbar).not.toBeChecked();

  await page.route("**/api/ui/config", route => {
    const request = route.request();
    if (request.method() === "PUT" && request.postDataJSON().voice?.indicators?.includes("topbar")) {
      return route.fulfill({ status: 503, json: { error: "Settings could not be saved." } });
    }
    return route.continue();
  });
  await topbar.click();
  const error = settings.getByRole("alert");
  await expect(error).toHaveText("Could not save the indicator selection.");
  await expect(error).toBeVisible();
  await expect(topbar).not.toBeChecked();
  await expect(statusLine).toBeChecked();
  await expect(segment).toHaveCount(0);

  await page.unroute("**/api/ui/config");
  await topbar.check();
  await expect(error).toHaveCount(0);
  await expect(segment).toBeVisible();
});

// The console always sends the keyboard shortcut to the transcript. Mount the actual fallback
// with no transcript owner, using the same dev-dashboard fixture as dispatch-modes.spec.ts.
test("the Action Bar fallback keeps its message label and typed draft across mute changes", async ({ dashboard: page, daemon }) => {
  await enableVoice(daemon);
  const dev = await startDevDashboard(daemon);
  const listener = await beListener(daemon);
  try {
    const task = await page.request.post(daemon.baseURL + "/api/tasks", { data: {
      repoRoot: daemon.repo, intent: "Test the fallback composer", title: "Voice fixture",
      kind: "ship", agent: "claude", runtime: "sdk", workflowId: null, callSign: "Will",
    } });
    expect(task.ok(), await task.text()).toBe(true);
    await page.goto(dev.origin + "/#/settings/voice");
    const selection = page.getByRole("checkbox", { name: "Composer microphone" });
    await selection.check();
    await expect(selection).toBeEnabled();
    await page.goto(dev.origin);
    const fixture = fileURLToPath(new URL("../fixtures/voice-action-bar-mount.tsx", import.meta.url));
    await page.evaluate(async path => (await import(/* @vite-ignore */ `/@fs${path}`)).mountFallback(), fixture);
    const form = page.locator(".actions .compose");
    const message = form.getByRole("textbox", { name: "Message to send…", exact: true });
    await expect(message).toHaveAccessibleDescription('Message to send… or say "Will, …"');
    await form.getByRole("button", { name: "Voice: listening. Mute" }).click();
    await expect(message).toHaveAccessibleDescription("Voice is muted");
    await message.fill("A typed message");
    await message.press("Shift+Enter");
    await expect(message).toHaveValue("A typed message\n");
    if (process.env.MC_E2E_EVIDENCE) {
      const root = artifactsDir("voice-window");
      mkdirSync(root, { recursive: true });
      await form.screenshot({ path: join(mkdtempSync(join(root, "action-bar-")), "muted.png") });
    }
    await form.getByRole("button", { name: "Voice: muted. Unmute" }).click();
    await expect(message).toHaveAccessibleDescription('Message to send… or say "Will, …"');
    await expect(message).toHaveValue("A typed message\n");
  } finally {
    listener.stop();
    dev.stop();
  }
});
