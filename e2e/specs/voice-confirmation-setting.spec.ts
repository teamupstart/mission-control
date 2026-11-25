import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import { expect, test } from "../fixtures/test.ts";
import { enableVoice, say, voiceToken } from "../fixtures/voice.ts";
import { allowStreamDisconnect, captureCard, expectCardGeometry, runningAgent, setupCards } from "../fixtures/voice-cards.ts";

test("three placement previews persist across reload, with a toast fallback and reserved card-only routes", async ({ dashboard: page, daemon }) => {
  await enableVoice(daemon);
  await page.goto(daemon.baseURL + "/#/settings/voice");
  const choices = page.getByRole("group", { name: "Confirmation card" });
  await expect(choices.getByRole("radio")).toHaveCount(3);
  await expect(choices.getByText("Needs the desktop app")).toHaveCount(2);
  for (const placement of ["Corner toast", "Tray popover", "Floating pill"]) {
    const radio = choices.getByRole("radio", { name: new RegExp(placement) });
    await expect(radio).toHaveAccessibleDescription(`Save ${placement} as your preferred confirmation card placement`);
    await radio.click();
    await expect(radio).toBeEnabled();
    await expect(radio).toBeChecked();
    await page.reload();
    await expect(radio).toBeChecked();
  }
  await captureCard(choices, "placements");
  await page.request.post(daemon.baseURL + "/api/residents/profiles", { data: { settings: {
    identity: { name: "Steve", description: "Builds and releases" }, persona: { personaId: "builtin:code-risk-reviewer" },
  } } });
  await page.request.put(daemon.baseURL + "/api/voice/config", { data: { cancelWindow: { enabled: true, seconds: 30 } } });
  await say(daemon, "Steve, check the build");
  await expect(page.getByRole("status").filter({ hasText: "To Steve" })).toBeVisible();
  await page.goto(daemon.baseURL + "/#/voice/pill");
  await expect(page.getByRole("status").filter({ hasText: "To Steve" })).toBeVisible();
  await expect(page.locator(".app")).toHaveCount(0);
  await page.goto(daemon.baseURL + "/#/voice/popover");
  await expect(page.locator(".voice-standalone")).toHaveCount(1);
  await expect(page.locator(".app")).toHaveCount(0);
  const pending = page.getByRole("status").filter({ hasText: "To Steve" });
  await expect(pending.getByRole("button", { name: "Cancel", exact: true })).toBeVisible({ timeout: 3000 });
  await pending.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Cancelled");
});

test("visiting either standalone voice route preserves a closed Dispatch draft and attachment", async ({ dashboard: page, daemon }) => {
  await setupCards(page, daemon);
  const dispatch = page.getByRole("button", { name: "Dispatch", exact: true });
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  const intent = dialog.getByPlaceholder("What should this agent do?");
  const attachment = dialog.getByRole("button", { name: "Remove voice-draft.png" });
  await dispatch.click();
  await expectContentClearsBorder(dialog);
  await intent.fill("Keep my work across voice routes");
  const transfer = await page.evaluateHandle(() => {
    const data = new DataTransfer();
    const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), c => c.charCodeAt(0));
    data.items.add(new File([png], "voice-draft.png", { type: "image/png" }));
    return data;
  });
  await dialog.locator(".drop-zone").dispatchEvent("drop", { dataTransfer: transfer });
  await transfer.dispose();
  await expect(attachment).toBeVisible();
  for (const placement of ["pill", "popover"]) {
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await page.request.put(daemon.baseURL + "/api/voice/confirmation", { data: { confirmation: placement } });
    await page.goto(daemon.baseURL + "/#/voice/" + placement);
    await expect(page.locator(".voice-standalone")).toHaveCount(1);
    await expect(page.locator(".app")).toHaveCount(0);
    await page.goto(daemon.baseURL + "/#/fleet");
    await dispatch.click();
    await expectContentClearsBorder(dialog);
    await expect(intent).toHaveValue("Keep my work across voice routes", { timeout: 1000 });
    await expect(attachment).toBeVisible();
    await expect(dialog.locator('.drop-zone img').first()).toHaveJSProperty("naturalWidth", 1);
  }
});

test("a confirmed placement stays selected without its stream update", async ({ dashboard: page, daemon }) => {
  await setupCards(page, daemon);
  await allowStreamDisconnect(page);
  await page.goto(daemon.baseURL + "/#/settings/voice");
  await page.reload(); // Install the disconnect listener on this document before the stream opens.
  const group = page.getByRole("group", { name: "Confirmation card" });
  const pill = group.getByRole("radio", { name: /Floating pill/ });
  await expect(group.getByRole("radio", { name: /Corner toast/ })).toBeChecked();
  await page.evaluate(() => window.dispatchEvent(new Event("disconnect-fixture-stream")));
  const saved = page.waitForResponse(response => response.url().endsWith("/api/voice/confirmation") && response.request().method() === "PUT");
  await pill.click();
  expect((await saved).ok()).toBe(true);
  await expect(pill).toBeEnabled();
  await expect(pill).toBeChecked({ timeout: 1000 });
  const persisted = await (await page.request.get(daemon.baseURL + "/api/ui/config")).json();
  expect(persisted.config.voice.confirmation).toBe("pill");
});

test("a stalled placement save releases the controls and can be retried", async ({ dashboard: page, daemon }) => {
  await setupCards(page, daemon);
  await page.goto(daemon.baseURL + "/#/settings/voice");
  const group = page.getByRole("group", { name: "Confirmation card" });
  const pill = group.getByRole("radio", { name: /Floating pill/ });
  let stalled = true;
  await page.route("**/api/voice/confirmation", route => {
    if (stalled) { stalled = false; return; }
    return route.continue();
  });
  await pill.click();
  await expect(pill).toBeDisabled();
  await expect(group.getByRole("alert")).toContainText("Could not save", { timeout: 8000 });
  await expect(pill).toBeEnabled();
  await expect(group.getByRole("radio", { name: /Corner toast/ })).toBeChecked();
  await page.mouse.move(0, 0);
  await captureCard(group, "placement-retry");
  await pill.click();
  await expect(pill).toBeEnabled();
  await page.reload();
  await expect(pill).toBeChecked();
});

for (const [placement, label] of [["popover", /Tray popover/], ["toast", /Corner toast/]] as const) {
  test(`a timed-out placement save cannot overwrite the operator’s later ${placement} choice`, async ({ dashboard: page, daemon }) => {
    await setupCards(page, daemon);
    await page.goto(daemon.baseURL + "/#/settings/voice");
    const group = page.getByRole("group", { name: "Confirmation card" });
    const pill = group.getByRole("radio", { name: /Floating pill/ });
    const choice = group.getByRole("radio", { name: label });
    const url = daemon.baseURL + "/api/voice/confirmation";
    // Keep the first request's actual body, including the version the operator saw.
    const delayed = page.waitForRequest(request => request.url() === url && request.method() === "PUT");
    await page.route(url, () => {}, { times: 1 });
    await pill.click();
    const first = await delayed;
    await expect(group.getByRole("alert")).toContainText("Could not save", { timeout: 8000 });
    if (placement === "toast") await expect(choice).toBeChecked();
    const [saved] = await Promise.all([
      page.waitForResponse(response => response.url() === url && response.request().method() === "PUT", { timeout: 5000 }),
      choice.click(),
    ]);
    expect(saved.ok()).toBe(true);
    await expect(choice).toBeEnabled();
    const late = await page.request.put(url, { data: first.postDataJSON() });
    expect(late.status()).toBe(409);
    expect((await (await page.request.get(daemon.baseURL + "/api/ui/config")).json()).config.voice.confirmation).toBe(placement);
    await page.reload();
    await expect(choice).toBeChecked();
    await expect(group.getByRole("radio")).toHaveCount(3);
    await page.mouse.move(0, 0);
    await captureCard(group, placement === "toast" ? "reaffirmed-toast-after-timeout" : "placement-after-stale-save");
    await runningAgent(page, daemon, "Steve");
    await say(daemon, "Steve, check the build and report back");
    const card = page.getByRole("status").filter({ hasText: "To Steve" });
    await expectCardGeometry(card, "confirmation-card", "#a .cc-card");
    await expect(card.getByRole("button", { name: "Send now" })).toBeEnabled();
    if (placement === "popover") await captureCard(card, "toast-after-stale-save");
    await card.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Cancelled" })).toBeVisible();
  });
}

test("an older split stop receipt keeps the newer standalone countdown selected", async ({ dashboard: page, daemon }) => {
  await setupCards(page, daemon);
  await runningAgent(page, daemon, "Steve");
  await runningAgent(page, daemon, "Will");
  await page.addInitScript(() => {
    window.EventSource = class extends EventSource {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(url, init);
        this.addEventListener("message", event => {
          if (!event.isTrusted) return;
          const frame = JSON.parse(event.data);
          if (frame.type !== "voice_card" || frame.card.id !== "earlier-split" || frame.card.state !== "pending" ||
            !frame.card.parts.some((part: { immediateStop?: boolean; outcome?: string }) => part.immediateStop && part.outcome)) return;
          event.stopImmediatePropagation();
          window.addEventListener("release-stop-receipt", () => this.dispatchEvent(new MessageEvent("message", { data: event.data })), { once: true });
          document.documentElement.dataset.stopReceipt = "buffered";
        });
      }
    };
  });
  await page.goto("about:blank");
  await page.goto(daemon.baseURL + "/#/voice/pill");
  const card = page.getByRole("status");
  await say(daemon, "Steve, inspect the build, and Will, stop", { id: "earlier-split" });
  await card.getByRole("button", { name: /Will/ }).click();
  await expect(card).toContainText("stopping");
  await say(daemon, "Steve, inspect the newer release", { id: "newer-message" });
  await expect(card).toContainText("inspect the newer release");
  await expect(page.locator("html")).toHaveAttribute("data-stop-receipt", "buffered");
  await page.evaluate(() => window.dispatchEvent(new Event("release-stop-receipt")));
  await expect(card).toContainText("inspect the newer release", { timeout: 3000 });
  await page.mouse.move(600, 400);
  await captureCard(page.locator(".voice-card-surface"), "newer-countdown-after-stop-receipt");
  const cancelled = page.waitForResponse(response => response.url().endsWith("/cards/newer-message/cancel"));
  await card.getByRole("button", { name: "Cancel", exact: true }).click();
  expect((await cancelled).ok()).toBe(true);
  await expect(card).toContainText("stop sent");
  await expect(card.getByRole("button", { name: "Send to Steve now" })).toBeEnabled();
});

for (const [placement, label] of [["pill", "Floating pill"], ["popover", "Tray popover"]] as const) {
  test(`the ${label} keeps an unresolved recipient picker reachable ahead of a newer held result`, async ({ dashboard: page, daemon }) => {
    await setupCards(page, daemon);
    await runningAgent(page, daemon, "Steve");
    const will = await runningAgent(page, daemon, "Will");
    const question = "Which release should I inspect?";
    expect((await page.request.post(daemon.baseURL + "/mcp/reviews", {
      headers: { "x-harness-token": voiceToken(daemon) },
      data: { env: {}, cwd: will.cwd, kind: "input", title: question, body: question },
    })).ok()).toBe(true);
    expect((await page.request.put(daemon.baseURL + "/api/voice/confirmation", { data: { confirmation: placement } })).ok()).toBe(true);
    await page.goto(daemon.baseURL + "/#/voice/" + placement);
    const card = page.getByRole("status");
    await say(daemon, "Steven ask Will about the deployment");
    await expect(card).toContainText("Who is this for?");
    await say(daemon, "Will, inspect the release");
    await expect(card).toContainText("inspect the release");
    await card.getByRole("button", { name: "Send now" }).click();
    await expect(card.getByRole("button", { name: /Steve/ })).toBeVisible({ timeout: 3000 });
    await expect(card.getByRole("button", { name: /Will/ })).toBeVisible();
    await captureCard(card, "picker-before-held-" + placement);
    await card.getByRole("button", { name: /Steve/ }).click();
    await expect(card).toContainText("Will is mentioned");
    await page.clock.install();
    await card.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(card).toContainText("Cancelled");
    await page.clock.fastForward(9000);
    await expect(card).toContainText(question);
    await expect(card.getByRole("button", { name: "Cancel message" })).toBeEnabled();
  });

  test(`the ${label} route switches at the displayed deadline while disconnected`, async ({ dashboard: page, daemon }) => {
    await setupCards(page, daemon);
    await allowStreamDisconnect(page);
    expect((await page.request.put(daemon.baseURL + "/api/voice/confirmation", { data: { confirmation: placement } })).ok()).toBe(true);
    expect((await page.request.post(daemon.baseURL + "/api/residents/profiles", { data: { settings: {
      identity: { name: "Steve", description: "Builds and releases" }, persona: { personaId: "builtin:code-risk-reviewer" },
    } } })).ok()).toBe(true);
    await page.clock.install({ time: new Date(Date.now() + 120_000) });
    await page.goto("about:blank");
    await page.goto(daemon.baseURL + "/#/voice/" + placement);
    const card = page.getByRole("status");
    await say(daemon, "Steve, inspect the long window", { id: "long-window" });
    await expect(card).toContainText("inspect the long window");
    await expect(card.getByRole("button", { name: "Cancel", exact: true })).toBeVisible({ timeout: 3000 });
    await page.reload();
    await expect(card.getByRole("button", { name: "Cancel", exact: true })).toBeVisible({ timeout: 3000 });
    await page.clock.pauseAt(await page.evaluate(() => new Date(Date.now() + 500).toISOString()));
    expect((await page.request.put(daemon.baseURL + "/api/voice/config", { data: { cancelWindow: { enabled: true, seconds: 3 } } })).ok()).toBe(true);
    await say(daemon, "Steve, inspect the short window");
    await expect(card).toContainText("inspect the short window");
    await page.evaluate(() => window.dispatchEvent(new Event("disconnect-fixture-stream")));
    await page.clock.fastForward(3500);
    await expect(card).toContainText("inspect the long window", { timeout: 1500 });
    const cancelled = page.waitForResponse(response => response.url().endsWith("/cards/long-window/cancel"));
    await card.getByRole("button", { name: "Cancel", exact: true }).click();
    expect((await cancelled).ok()).toBe(true);
  });

  test(`the ${label} route immediately restores an older cancel window ahead of a newer outcome`, async ({ dashboard: page, daemon }) => {
    await enableVoice(daemon);
    expect((await page.request.put(daemon.baseURL + "/api/voice/confirmation", { data: { confirmation: placement } })).ok()).toBe(true);
    expect((await page.request.put(daemon.baseURL + "/api/voice/config", { data: { cancelWindow: { enabled: true, seconds: 30 } } })).ok()).toBe(true);
    expect((await page.request.post(daemon.baseURL + "/api/residents/profiles", { data: { settings: {
      identity: { name: "Steve", description: "Builds and releases" }, persona: { personaId: "builtin:code-risk-reviewer" },
    } } })).ok()).toBe(true);
    await page.goto(daemon.baseURL + "/#/voice/" + placement);
    const card = page.getByRole("status");
    await say(daemon, "Steve, inspect the older message", { id: "older" });
    await expect(card).toContainText("inspect the older message");
    await say(daemon, "Steve, inspect the newer message", { id: "newer" });
    await expect(card).toContainText("inspect the newer message");
    const choose = page.getByRole("combobox", { name: "Voice message" });
    await choose.selectOption("older");
    await say(daemon, "Steve, inspect the third message", { id: "third" });
    await expect(card).toContainText("inspect the third message", { timeout: 3000 });
    await card.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(choose).toHaveValue("older");
    await choose.selectOption("newer");
    await card.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(card).toContainText("inspect the older message", { timeout: 2000 });
    await page.mouse.move(640, 400);
    await captureCard(card, "priority-older-" + placement);
    const cancelled = page.waitForResponse(response => response.url().endsWith("/cards/older/cancel"));
    await card.getByRole("button", { name: "Cancel", exact: true }).click();
    expect((await cancelled).ok()).toBe(true);
    await expect(card).toContainText("Cancelled");
  });

  test(`a floating-window report keeps the ${label} preference actionable on the dashboard`, async ({ dashboard: page, daemon }) => {
    await enableVoice(daemon);
    await page.goto(daemon.baseURL + "/#/settings/voice");
    const choices = page.getByRole("group", { name: "Confirmation card" });
    const radio = choices.getByRole("radio", { name: new RegExp(label) });
    await radio.check();
    await expect(radio).toBeChecked();
    const resident = await page.request.post(daemon.baseURL + "/api/residents/profiles", { data: { settings: {
      identity: { name: "Steve", description: "Builds and releases" }, persona: { personaId: "builtin:code-risk-reviewer" },
    } } });
    expect(resident.ok(), await resident.text()).toBe(true);
    expect((await page.request.put(daemon.baseURL + "/api/voice/config", { data: { cancelWindow: { enabled: true, seconds: 30 } } })).ok()).toBe(true);
    await expect(choices.getByText("Needs the desktop app")).toHaveCount(2);
    const report = await page.request.post(daemon.baseURL + "/voice/shell-report", {
      headers: { "x-harness-token": voiceToken(daemon) }, data: { capabilities: { "floating-windows": { available: true } } },
    });
    expect(report.ok(), await report.text()).toBe(true);
    await expect(choices.getByText("Needs the desktop app")).toHaveCount(0);
    await choices.scrollIntoViewIfNeeded();
    await say(daemon, "Steve, check the build");
    const card = page.getByRole("status").filter({ hasText: "To Steve" });
    await expect(card).toContainText("check the build", { timeout: 7000 });
    await expect(card.getByRole("button", { name: "Cancel", exact: true })).toBeVisible();
    await expect(radio).toBeChecked();
    await expect(choices.getByText("Needs the desktop app")).toHaveCount(0);
    await captureCard(page, "desktop-fallback-" + placement);
    await card.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Cancelled" })).toBeVisible();
    await expect(page).toHaveURL(daemon.baseURL + "/#/settings/voice");
  });
}

test("standalone held messages can be switched and recalled while a new countdown takes priority", async ({ dashboard: page, daemon }) => {
  await setupCards(page, daemon);
  const will = await runningAgent(page, daemon, "Will");
  const question = "Which release needs checking?";
  expect((await page.request.post(daemon.baseURL + "/mcp/reviews", { headers: { "x-harness-token": voiceToken(daemon) },
    data: { env: {}, cwd: will.cwd, kind: "input", title: question, body: question } })).ok()).toBe(true);
  expect((await page.request.put(daemon.baseURL + "/api/voice/confirmation", { data: { confirmation: "popover" } })).ok()).toBe(true);
  await page.goto(daemon.baseURL + "/#/voice/popover");
  const card = page.getByRole("status");
  const choose = page.getByRole("combobox", { name: "Voice message" });
  for (const id of ["first", "second"]) {
    await say(daemon, "Will, check the " + id + " release", { id });
    await card.getByRole("button", { name: "Send now" }).click();
    await expect(card).toContainText("Held for Will");
  }
  await expect(choose.getByRole("option", { name: /check the first release/ })).toHaveCount(1, { timeout: 3000 });
  await expect(choose).toHaveAccessibleDescription("Choose which message to view and act on");
  await choose.selectOption("first");
  await expect(card.getByRole("button", { name: "Open question" })).toBeEnabled();
  await captureCard(page.locator(".voice-card-surface"), "standalone-held-switcher");
  await say(daemon, "Will, another countdown", { id: "third" });
  await expect(card).toContainText("another countdown");
  await card.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(choose).toHaveValue("first");
  // Reopen a fresh dashboard against the restarted daemon so no local card can supply the picker.
  await daemon.crash();
  await daemon.restart();
  await page.reload();
  await expect(choose.getByRole("option", { name: /check the first release/ })).toHaveCount(1, { timeout: 7000 });
  await expect(choose.getByRole("option", { name: /check the second release/ })).toHaveCount(1);
  for (const id of ["first", "second"]) {
    await choose.selectOption(id);
    await expect(card).toContainText(question);
    await expect(card.getByRole("button", { name: "Open question" })).toBeEnabled();
    const recalled = page.waitForResponse(response => response.url().endsWith("/voice%3A" + id + "/recall"));
    await card.getByRole("button", { name: "Cancel message" }).click();
    expect(await (await recalled).json()).toEqual({ ok: true, text: "check the " + id + " release" });
  }
});

test("a standalone relaunch keeps its feedback and retry ID while another card occupies the surface", async ({ dashboard: page, daemon }) => {
  await setupCards(page, daemon);
  expect((await page.request.put(daemon.baseURL + "/api/voice/confirmation", { data: { confirmation: "pill" } })).ok()).toBe(true);
  expect((await page.request.post(daemon.baseURL + "/api/residents/profiles", { data: { settings: {
    identity: { name: "Marlowe", description: "Reviews builds" }, persona: { personaId: "builtin:code-risk-reviewer" },
  } } })).ok()).toBe(true);
  const release = Promise.withResolvers<void>();
  const launches: string[] = [];
  await page.route("**/api/residents/profiles/*/launch", async route => {
    launches.push(route.request().postDataJSON().requestId);
    if (launches.length > 1) return route.continue();
    await release.promise;
    await route.fulfill({ status: 503, json: { error: "Try the launch again" } });
  });
  await page.goto(daemon.baseURL + "/#/voice/pill");
  await page.clock.install();
  const card = page.getByRole("status");
  await say(daemon, "Marlowe, check the build");
  await card.getByRole("button", { name: "Send now" }).click();
  const relaunch = card.getByRole("button", { name: "Relaunch Marlowe" });
  const failedLaunch = page.waitForResponse(response => response.url().endsWith("/launch") && response.status() === 503);
  await relaunch.click();
  try {
    await expect(relaunch).toBeDisabled();
    await say(daemon, "Marlowe, inspect another build");
    await expect(card).toContainText("inspect another build");
    await expect(relaunch).toHaveCount(0);
  } finally {
    release.resolve();
  }
  await (await failedLaunch).finished();
  // Let the hidden failure outlast an ordinary outcome, then give the newer Cancelled card its interval.
  await page.clock.fastForward(9000);
  await card.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(card).toContainText("Cancelled");
  await page.clock.fastForward(9000);
  await expect(card).toContainText("Try the launch again", { timeout: 3000 });
  await page.clock.fastForward(7000);
  await expect(relaunch).toBeEnabled();
  await captureCard(card, "standalone-relaunch-returned");
  await relaunch.click();
  await expect(card).toContainText("Relaunch requested.");
  expect(launches).toHaveLength(2);
  expect(launches[1]).toBe(launches[0]);
  // Leave the successful feedback behind a different card without returning to it.
  await say(daemon, "Marlowe, check a different release");
  await expect(card).toContainText("check a different release");
  await page.clock.fastForward(61_000);
  await expect(card).toContainText("Awaiting delivery confirmation");
  await expect(page.getByRole("combobox", { name: "Voice message" })).toHaveCount(0, { timeout: 3000 });
});

test("an accepted resident relaunch keeps its retry ID across dashboard and standalone routes", async ({ dashboard: page, daemon }) => {
  await setupCards(page, daemon);
  expect((await page.request.post(daemon.baseURL + "/api/residents/profiles", { data: { settings: {
    identity: { name: "Marlowe", description: "Reviews builds" }, persona: { personaId: "builtin:code-risk-reviewer" },
  } } })).ok()).toBe(true);
  const accepted = Promise.withResolvers<number>();
  const release = Promise.withResolvers<void>();
  const attempts: string[] = [];
  await page.route("**/api/residents/profiles/*/launch", async route => {
    attempts.push(route.request().postDataJSON().requestId);
    if (attempts.length > 1) return route.continue();
    const result = await route.fetch();
    accepted.resolve(result.status());
    await release.promise;
    await route.fulfill({ status: 503, json: { error: "The launch reply was lost" } });
  });
  await say(daemon, "Marlowe, check the build");
  const card = page.getByRole("status").filter({ hasText: "Marlowe" });
  await card.getByRole("button", { name: "Send now" }).click();
  const relaunch = card.getByRole("button", { name: "Relaunch Marlowe" });
  await relaunch.click();
  try {
    const status = await accepted.promise;
    expect(status).toBeGreaterThanOrEqual(200);
    expect(status).toBeLessThan(300);
    for (const placement of ["pill", "popover"]) {
      await page.goto(daemon.baseURL + "/#/voice/" + placement);
      await expect(page.locator(".voice-standalone")).toBeVisible();
      await expect(relaunch).toBeDisabled({ timeout: 2000 });
    }
  } finally {
    release.resolve();
  }
  await expect(card).toContainText("The launch reply was lost");
  await page.goto(daemon.baseURL + "/#/fleet");
  await expect(page.locator(".app")).toBeVisible();
  await expect(card).toContainText("The launch reply was lost");
  await captureCard(card, "relaunch-retry-after-route-changes");
  await relaunch.click();
  await expect(card).toContainText("Relaunch requested.");
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toBe(attempts[0]);
});

test("disabled voice links open Fleet and disabling voice closes an active standalone route", async ({ dashboard: page, daemon }) => {
  const fleet = page.getByRole("navigation", { name: "Pages" }).getByRole("button", { name: "Fleet" });
  for (const placement of ["pill", "popover"]) {
    const url = daemon.baseURL + "/#/voice/" + placement;
    await page.goto("about:blank");
    await page.goto(url);
    await expect(page).toHaveURL(daemon.baseURL + "/#/fleet");
    await expect(fleet).toBeVisible();
    await expect(page.locator(".voice-standalone")).toHaveCount(0);
    await enableVoice(daemon);
    await page.goto("about:blank");
    await page.goto(url);
    await expect(page.locator(".voice-standalone")).toHaveCount(1);
    const disabled = await page.request.put(daemon.baseURL + "/api/feature-flags", { data: { kind: "flag", id: "voice", enabled: false } });
    expect(disabled.ok(), await disabled.text()).toBe(true);
    await expect(page).toHaveURL(daemon.baseURL + "/#/fleet");
    await expect(fleet).toBeVisible();
    await expect(page.locator(".voice-standalone")).toHaveCount(0);
  }
  await captureCard(page, "disabled-route-fleet");
});

for (const [scenario, title] of [
  ["lost", "one selection retries a committed placement whose reply was lost"],
  ["reaffirmed", "a delayed retry preserves another dashboard’s reaffirmed placement"],
  ["offline", "a retry remembers the committed placement after an intervening network failure"],
] as const) {
  test(title, async ({ dashboard: page, daemon }) => {
    await setupCards(page, daemon);
    await allowStreamDisconnect(page);
    await page.goto(daemon.baseURL + "/#/settings/voice");
    await page.reload();
    const group = page.getByRole("group", { name: "Confirmation card" });
    await expect(group.getByRole("radio", { name: /Corner toast/ })).toBeChecked();
    await page.evaluate(() => window.dispatchEvent(new Event("disconnect-fixture-stream")));
    const url = daemon.baseURL + "/api/voice/confirmation";
    await page.route(url, async route => { expect((await route.fetch()).ok()).toBe(true); }, { times: 1 });
    // Keep the background reconciliation from observing the new revision before the retry.
    await page.route("**/api/ui/config", () => {});
    await group.getByRole("radio", { name: /Floating pill/ }).click();
    await expect(group.getByRole("alert")).toContainText("Could not save", { timeout: 8000 });
    const popover = group.getByRole("radio", { name: /Tray popover/ });
    if (scenario === "offline") {
      await page.route(url, route => route.abort("connectionfailed"), { times: 1 });
      const failed = page.waitForEvent("requestfailed", request => request.url() === url);
      await popover.click();
      await failed;
      await expect(popover).toBeEnabled();
    }
    if (scenario === "reaffirmed") {
      await page.route(url, async route => {
        // Another dashboard saves the same value after the retry has already left this one.
        const other = await page.request.put(url, { data: { confirmation: "pill" } });
        expect(other.ok()).toBe(true);
        await route.continue();
      }, { times: 1 });
    }
    await popover.click();
    await expect(popover).toBeEnabled();
    const persisted = (await (await page.request.get(daemon.baseURL + "/api/ui/config")).json()).config.voice.confirmation;
    if (scenario === "reaffirmed") {
      expect(persisted).toBe("pill");
      await expect(group.getByRole("radio", { name: /Floating pill/ })).toBeChecked();
      await expect(group.getByRole("alert")).toContainText("Could not save");
      await page.mouse.move(0, 0);
      await captureCard(group, "followup-reaffirmed-placement");
      return;
    }
    await expect(popover).toBeChecked();
    await expect(group.getByRole("alert")).toHaveCount(0);
    expect(persisted).toBe("popover");
    await page.mouse.move(0, 0);
    await captureCard(group, "followup-placement-retry");
  });
}
