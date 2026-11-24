import { mkdirSync, mkdtempSync } from "node:fs";
import type { Locator } from "@playwright/test";
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
          await expect(reply).toHaveAttribute("placeholder", /Reply to this session.*Enter to send, Shift\+Enter for newline, drop or paste images/);
          const composer = page.locator(".transcript-compose");
          await expect(composer.getByText("Voice is muted", { exact: true })).toBeVisible();
          if (capture) {
            await page.mouse.move(1, 200);
            await control.blur();
            await expect(page.locator(".tooltip")).toHaveCount(0);
            await composer.screenshot({ path: join(capture, "muted-reply-instructions.png") });
          }
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

test("two windows selecting different indicators preserve both choices in the daemon", async ({ dashboard: page, context, daemon }) => {
  await enableVoice(daemon);
  const peer = await context.newPage();
  const settings = daemon.baseURL + "/#/settings/voice";
  await Promise.all([page.goto(settings), peer.goto(settings)]);
  for (const window of [page, peer]) {
    await expect(window.getByRole("checkbox", { name: "Status line" })).toBeChecked();
    await expect(window.getByRole("checkbox", { name: "Floating button" })).not.toBeChecked();
    await expect(window.getByRole("checkbox", { name: "Edge light" })).not.toBeChecked();
  }
  await Promise.all([
    page.getByRole("checkbox", { name: "Edge light" }).check(),
    peer.getByRole("checkbox", { name: "Floating button" }).check(),
  ]);
  await expect.poll(async () => {
    const { config } = await (await page.request.get(daemon.baseURL + "/api/ui/config")).json();
    return config.voice.indicators.sort();
  }).toEqual(["edge", "floating", "status-line"]);
  await page.reload();
  for (const name of ["Edge light", "Floating button", "Status line"]) {
    await expect(page.getByRole("checkbox", { name })).toBeChecked();
  }
  if (process.env.MC_E2E_EVIDENCE) {
    const root = artifactsDir("voice-window");
    mkdirSync(root, { recursive: true });
    await page.getByRole("group", { name: "In the window" }).screenshot({ path: join(mkdtempSync(join(root, "merged-")), "choices.png") });
  }
});

test("a delayed indicator acknowledgement keeps the newer two-window configuration visible", async ({ page, context, daemon }) => {
  await enableVoice(daemon);
  const settings = daemon.baseURL + "/#/settings/voice";
  const peer = await context.newPage();
  await peer.goto(settings);
  const releaseRead = Promise.withResolvers<void>();
  const releaseSave = Promise.withResolvers<void>();
  const saved = Promise.withResolvers<string[]>();
  await page.route("**/api/ui/config", async route => {
    await releaseRead.promise;
    await route.continue();
  });
  await page.route("**/api/voice/indicators", async route => {
    const response = await route.fetch();
    saved.resolve((await response.json()).indicators);
    await releaseSave.promise;
    await route.fulfill({ response });
  });
  await page.goto(settings);
  const edge = page.getByRole("checkbox", { name: "Edge light" });
  const floating = page.getByRole("checkbox", { name: "Floating button" });
  await edge.check();
  expect(await saved.promise).toEqual(["status-line", "edge"]);
  await peer.getByRole("checkbox", { name: "Floating button" }).check();
  await expect(peer.getByRole("checkbox", { name: "Floating button" })).toBeEnabled();
  releaseRead.resolve();
  await expect(floating).toBeChecked();
  releaseSave.resolve();
  await expect(edge).toBeEnabled();
  await expect(edge).toBeChecked();
  await expect(floating).toBeChecked();
  if (process.env.MC_E2E_EVIDENCE) {
    const root = artifactsDir("voice-window");
    mkdirSync(root, { recursive: true });
    await page.mouse.move(1, 1);
    await edge.blur();
    await expect(page.locator(".tooltip")).toHaveCount(0);
    await page.getByRole("group", { name: "In the window" }).screenshot({ path: join(mkdtempSync(join(root, "late-save-")), "settings.png") });
  }
});

for (const failure of ["unavailable", "stalled"] as const) {
  test(`an acknowledged save recovers without a reload when the reconciliation read is ${failure}`, async ({ page, daemon }) => {
    await enableVoice(daemon);
    const endpoint = daemon.baseURL + "/api/voice/indicators";
    const preference = (id: string) => page.request.put(endpoint, { data: { id, enabled: true } });
    expect((await preference("floating")).ok()).toBe(true);
    const snapshotReady = Promise.withResolvers<void>();
    const releaseSnapshot = Promise.withResolvers<void>();
    const saved = Promise.withResolvers<void>();
    const releaseSave = Promise.withResolvers<void>();
    const firstReconciliation = Promise.withResolvers<void>();
    const releaseStalled = Promise.withResolvers<void>();
    let reads = 0;
    await page.route("**/api/ui/config", async route => {
      reads++;
      if (reads === 1) {
        const snapshot = await route.fetch();
        snapshotReady.resolve();
        await releaseSnapshot.promise;
        return route.fulfill({ response: snapshot });
      }
      if (reads === 2) {
        firstReconciliation.resolve();
        if (failure === "unavailable") return route.fulfill({ status: 503 });
        await releaseStalled.promise;
        return route.abort();
      }
      return route.continue();
    });
    await page.route("**/api/voice/indicators", async route => {
      const result = await route.fetch();
      saved.resolve();
      await releaseSave.promise;
      await route.fulfill({ response: result });
    });
    try {
      await page.goto(daemon.baseURL + "/#/settings/voice");
      await snapshotReady.promise;
      const edge = page.getByRole("checkbox", { name: "Edge light" });
      await edge.check();
      await saved.promise;
      releaseSnapshot.resolve();
      await expect(page.getByRole("checkbox", { name: "Floating button" })).toBeChecked();
      releaseSave.resolve();
      await firstReconciliation.promise;
      expect((await preference("topbar")).ok()).toBe(true);
      await expect(edge).toBeEnabled();
      await expect(edge).toBeChecked();
      await expect(page.locator("button.vi-edge")).toBeVisible();
      await expect(page.getByRole("checkbox", { name: "Top-bar segment" })).toBeChecked();
      expect(reads).toBeGreaterThanOrEqual(3);
    } finally {
      releaseSnapshot.resolve();
      releaseSave.resolve();
      releaseStalled.resolve();
    }
  });
}

test("indicator labels and captions match neighboring Voice settings and the history table matches variant E", async ({ dashboard: page, context, daemon }) => {
  await enableVoice(daemon);
  await page.goto(daemon.baseURL + "/#/settings/voice");
  const group = page.getByRole("group", { name: "In the window" });
  const typography = (locator: Locator) => locator.evaluate(element => {
    const style = getComputedStyle(element);
    return { size: style.fontSize, weight: style.fontWeight, family: style.fontFamily };
  });
  const label = page.getByText("Auto-mute during calls", { exact: true });
  const description = page.locator('[data-anchor="voice/auto-mute"] .kb-row-desc');
  const sampleCaption = group.locator(".vi-sample").filter({ has: page.locator(".vi-floating") }).first();
  const history = page.getByRole("region", { name: "Recently heard" });
  const option = await typography(group.getByText("Status line", { exact: true }));
  const reference = await typography(label);
  const caption = await typography(sampleCaption.getByText("Listening", { exact: true }).last());
  const referenceCaption = await typography(description);
  expect(option).toEqual(reference);
  expect(caption).toEqual(referenceCaption);
  const mock = await context.newPage();
  await mock.goto(new URL("../../docs/plans/voice-addressing-for-agents/mockup-recently-heard.html", import.meta.url).href);
  const referenceTable = mock.locator("#e .rh-dialog").first();
  const tableSizes = (panel: Locator) => Promise.all([".rh-dialog-head strong", ".rh-table", ".rh-table th"].map(async selector =>
    (await typography(panel.locator(selector).first())).size));
  const actual = await tableSizes(history);
  const approved = await tableSizes(referenceTable);
  expect(actual).toEqual(approved);
  await mock.close();
  if (process.env.MC_E2E_EVIDENCE) {
    console.log("Typography measured in CSS pixels", JSON.stringify({
      indicator: option, neighbor: reference, preview: caption, description: referenceCaption, table: actual, variantE: approved,
    }));
    const root = artifactsDir("voice-window");
    mkdirSync(root, { recursive: true });
    const dir = mkdtempSync(join(root, "settings-type-"));
    await group.scrollIntoViewIfNeeded();
    await group.screenshot({ path: join(dir, "indicators.png") });
    await page.getByText("Plan forms by voice", { exact: true }).first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(dir, "in-context.png") });
  }
});

test("the 720 by 480 dashboard keeps the last console row above its bottom status line", async ({ dashboard: page, daemon }) => {
  await enableVoice(daemon);
  const task = await page.request.post(daemon.baseURL + "/api/tasks", { data: {
    repoRoot: daemon.repo, intent: "Measure the console", title: "Status line geometry",
    kind: "ship", agent: "claude", runtime: "sdk", workflowId: null,
  } });
  expect(task.ok(), await task.text()).toBe(true);
  await page.goto(daemon.baseURL);
  const session = page.getByRole("navigation", { name: "Sessions" }).getByRole("button", { name: /Status line geometry/ });
  await session.click();
  await page.setViewportSize({ width: 720, height: 480 });
  const content = page.locator(".console");
  const status = page.locator("button.vi-status-line");
  await expect(content).toBeVisible();
  const actions = content.locator(".actions");
  await expect(actions).toBeInViewport();
  await expect(status).toBeInViewport({ ratio: 1 });
  const line = (await status.boundingBox())!;
  const consoleBounds = (await content.boundingBox())!;
  expect(line.height).toBe(26);
  expect(line.y + line.height).toBe(480);
  expect(consoleBounds.y + consoleBounds.height).toBeLessThanOrEqual(line.y);
  const lastRow = (await actions.boundingBox())!;
  expect(lastRow.y + lastRow.height).toBeLessThanOrEqual(line.y);
  if (process.env.MC_E2E_EVIDENCE) {
    const root = artifactsDir("voice-window");
    mkdirSync(root, { recursive: true });
    await page.mouse.move(1, 1);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await expect(page.locator(".tooltip")).toHaveCount(0);
    await page.screenshot({
      path: join(mkdtempSync(join(root, "last-row-")), "dashboard.png"),
      mask: [page.locator(".detail-sub .kv").filter({ has: page.locator("dt", { hasText: /^path$/i }) }).locator("dd"), page.locator(".transcript-log")],
      maskColor: "#1b2029",
    });
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

  await page.route("**/api/voice/indicators", route => {
    const request = route.request();
    if (request.method() === "PUT" && request.postDataJSON().id === "topbar") {
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

  await page.unroute("**/api/voice/indicators");
  await topbar.check();
  await expect(error).toHaveCount(0);
  await expect(segment).toBeVisible();
});

for (const applied of [false, true]) {
  test(`a stalled indicator save unlocks all five choices and reconciles a write the daemon ${applied ? "applied" : "did not receive"}`, async ({ dashboard: page, daemon }) => {
    await enableVoice(daemon);
    await page.goto(daemon.baseURL + "/#/settings/voice");
    const settings = page.getByRole("group", { name: "In the window" });
    const edge = settings.getByRole("checkbox", { name: "Edge light" });
    const alert = settings.getByRole("alert");
    await expect(settings.getByRole("checkbox", { name: "Status line" })).toBeChecked();
    const writing = Promise.withResolvers<void>();
    const releaseRead = Promise.withResolvers<void>();
    await page.route("**/api/voice/indicators", async route => {
      if (applied) expect((await route.fetch()).ok()).toBe(true);
      // Withhold the response until the dashboard aborts its request.
      writing.resolve();
    }, { times: 1 });
    try {
      await edge.check();
      await writing.promise;
      await expect(settings.getByRole("checkbox", { disabled: true })).toHaveCount(5);
      await page.route("**/api/ui/config", async route => {
        await releaseRead.promise;
        await route.continue();
      }, { times: 1 });
      await expect(alert).toHaveText(/save timed out.*could not be confirmed/i, { timeout: 10_000 });
      await expect(settings.getByRole("checkbox", { disabled: false })).toHaveCount(5);
      const refreshed = page.waitForResponse(daemon.baseURL + "/api/ui/config");
      releaseRead.resolve();
      const response = await refreshed;
      expect(response.ok()).toBe(true);
      expect((await response.json()).config.voice.indicators.includes("edge")).toBe(applied);
      await expect(edge).toBeChecked({ checked: applied });
      await expect(page.locator("button.vi-edge")).toHaveCount(applied ? 1 : 0);
      if (applied && process.env.MC_E2E_EVIDENCE) {
        const root = artifactsDir("voice-window");
        mkdirSync(root, { recursive: true });
        await page.mouse.move(1, 1);
        await edge.blur();
        await expect(page.locator(".tooltip")).toHaveCount(0);
        await settings.screenshot({ path: join(mkdtempSync(join(root, "save-timeout-")), "settings.png") });
      }
      await edge.setChecked(!applied);
      await expect(alert).toHaveCount(0);
      await expect(page.locator("button.vi-edge")).toHaveCount(applied ? 0 : 1);
    } finally {
      releaseRead.resolve();
    }
  });
}

// The console always sends the keyboard shortcut to the transcript. Mount the actual fallback
// with no transcript owner, using the same dev-dashboard fixture as dispatch-modes.spec.ts.
test("the Action Bar fallback keeps its visible typing prompt and draft alongside its voice hint", async ({ dashboard: page, daemon }) => {
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
    await expect(message).toHaveAttribute("placeholder", "Message to send…");
    await expect(form.getByText('Message to send… or say "Will, …"', { exact: true })).toBeVisible();
    await form.getByRole("button", { name: "Voice: listening. Mute" }).click();
    await expect(message).toHaveAccessibleDescription("Voice is muted");
    await expect(message).toHaveAttribute("placeholder", "Message to send…");
    await expect(form.getByText("Voice is muted", { exact: true })).toBeVisible();
    if (process.env.MC_E2E_EVIDENCE) {
      const root = artifactsDir("voice-window");
      mkdirSync(root, { recursive: true });
      await form.screenshot({ path: join(mkdtempSync(join(root, "action-bar-")), "muted.png") });
    }
    await message.fill("A typed message");
    await message.press("Shift+Enter");
    await expect(message).toHaveValue("A typed message\n");
    await form.getByRole("button", { name: "Voice: muted. Unmute" }).click();
    await expect(message).toHaveAccessibleDescription('Message to send… or say "Will, …"');
    await expect(message).toHaveValue("A typed message\n");
  } finally {
    listener.stop();
    dev.stop();
  }
});

test("failed window mute controls share one alert without moving the header, fleet, or status line", async ({ dashboard: page, daemon }) => {
  await enableVoice(daemon);
  const listener = await beListener(daemon);
  try {
    await page.goto(daemon.baseURL + "/#/settings/voice");
    for (const name of ["Edge light", "Floating button", "Top-bar segment"]) {
      await page.getByRole("checkbox", { name }).check();
    }
    await page.goto(daemon.baseURL);
    await page.setViewportSize({ width: 720, height: 480 });
    const header = page.locator("header.topbar");
    const fleet = page.locator(".app .line").first();
    const status = page.locator("button.vi-status-line");
    await expect(status).toHaveAccessibleName("Voice: listening. Mute");
    await expect(fleet).toBeVisible();
    const geometry = () => Promise.all([header.boundingBox(), fleet.boundingBox(), status.boundingBox()]);
    const before = await geometry();
    expect(before[2]!.y + before[2]!.height).toBe(480);
    const alert = page.getByRole("alert");
    for (const kind of ["status-line", "edge", "floating", "topbar"]) {
      const message = `The listener refused the ${kind} mute request.`;
      await page.route("**/api/voice/mute", route => route.fulfill({ status: 503, json: { error: message } }), { times: 1 });
      await page.locator(`button.vi-${kind}`).click();
      await expect(alert).toHaveCount(1);
      await expect(alert).toHaveText(message);
      await expect(alert).toBeInViewport({ ratio: 1 });
      expect(await geometry(), `layout after refusing ${kind}`).toEqual(before);
    }
    if (process.env.MC_E2E_EVIDENCE) {
      const root = artifactsDir("voice-window");
      mkdirSync(root, { recursive: true });
      await page.mouse.move(1, 200);
      await page.locator("button.vi-topbar").blur();
      await expect(page.locator(".tooltip")).toHaveCount(0);
      await page.screenshot({ path: join(mkdtempSync(join(root, "window-feedback-")), "anchored.png") });
    }
    await page.getByRole("button", { name: "Dismiss voice error" }).click();
    await expect(alert).toHaveCount(0);
    await status.click();
    await expect(status).toHaveAccessibleName("Voice: muted. Unmute");
  } finally {
    listener.stop();
  }
});
