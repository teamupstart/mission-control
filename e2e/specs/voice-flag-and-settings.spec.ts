import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import type { Page, Route } from "@playwright/test";
import { test, expect } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { expectRowStatus, openSetupFamily, setupRow } from "../fixtures/setup-panel.ts";
import { beListener, enableVoice, say, type Listener } from "../fixtures/voice.ts";

// Voice addressing's first phase, end to end against the shipped registry: the flag row toggles,
// the Voice category appears with it in every open window, a cancel window change persists across
// a reload, the Setup family's Voice previews row turns the three flags voice needs on and then
// passes, and the mode line reads unavailable until a stand-in listener says hello, then
// listening, with every change of state reaching a second window without a reload. No microphone,
// model or agent is involved: `beListener` posts hellos under the daemon's token.

const EVIDENCE = process.env.MC_E2E_EVIDENCE ? artifactsDir("voice-flag-and-settings") : null;

async function capture(window: Page, name: string): Promise<void> {
  if (!EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await window.screenshot({ path: `${EVIDENCE}${name}.png`, fullPage: true });
}

async function voiceConfig(daemon: DaemonHandle): Promise<{ cancelWindow: { enabled: boolean; seconds: number }; whenUnsure: string; planFormsByVoice: boolean }> {
  const response = await fetch(`${daemon.baseURL}/api/voice/config`);
  expect(response.status).toBe(200);
  return ((await response.json()) as { config: Awaited<ReturnType<typeof voiceConfig>> }).config;
}

async function storedFlags(daemon: DaemonHandle): Promise<Record<string, boolean>> {
  const response = await fetch(`${daemon.baseURL}/api/feature-flags`);
  return ((await response.json()) as { config: { overrides: Record<string, boolean> } }).config.overrides;
}

const rail = (window: Page) => window.getByRole("tablist", { name: "Settings categories" });
const voiceTab = (window: Page) => rail(window).getByRole("tab", { name: "Voice" });
const modeLine = (window: Page) => window.getByRole("status", { name: "Voice mode" });
const flagToggle = (window: Page) => window.getByRole("button", { name: /^Voice addressing:/ });

test("reopening Voice settings preserves pending Clear and indicator saves, their errors, and retry", async ({ dashboard: page, daemon }) => {
  await enableVoice(daemon);
  expect((await say(daemon, "Retained test utterance")).ok).toBe(true);
  await page.goto(daemon.baseURL + "/#/settings/voice");
  const history = page.getByRole("region", { name: "Recently heard" });
  const clear = history.getByRole("button", { name: "Clear" });
  const indicators = page.getByRole("group", { name: "In the window" });
  const edge = indicators.getByRole("checkbox", { name: "Edge light" });
  const heldClear = Promise.withResolvers<Route>();
  const heldSave = Promise.withResolvers<Route>();
  let deletes = 0;
  let saves = 0;
  await page.route("**/api/voice/heard", route => {
    if (route.request().method() === "DELETE" && ++deletes === 1) return heldClear.resolve(route);
    return route.continue();
  });
  await page.route("**/api/voice/indicators", route => {
    if (route.request().method() === "PUT" && ++saves === 1) return heldSave.resolve(route);
    return route.continue();
  });
  await clear.click();
  await edge.check();
  const [deletion, save] = await Promise.all([heldClear.promise, heldSave.promise]);
  async function reopen() {
    await page.getByRole("button", { name: "← Fleet" }).click();
    await expect(rail(page)).toHaveCount(0);
    await page.getByRole("button", { name: /^Settings\b/ }).click();
    await voiceTab(page).click();
  }
  await reopen();
  await expect.soft(clear).toBeDisabled({ timeout: 1000 });
  await expect.soft(indicators.getByRole("checkbox", { disabled: true })).toHaveCount(5, { timeout: 1000 });
  await expect(edge).toBeChecked({ timeout: 1000 });
  await clear.evaluate(button => (button as HTMLButtonElement).click());
  await edge.evaluate(box => (box as HTMLInputElement).click());
  expect([deletes, saves]).toEqual([1, 1]);
  await deletion.fulfill({ status: 503, json: { error: "History could not be cleared." } });
  await save.fulfill({ status: 503, json: { error: "save_failed" } });
  async function expectRefusals() {
    await expect(history.getByRole("alert")).toHaveText("History could not be cleared.");
    await expect(history.getByRole("cell", { name: "Retained test utterance" })).toBeVisible();
    await expect(indicators.getByRole("alert")).toHaveText("Could not save the indicator selection.");
    await expect(edge).not.toBeChecked();
  }
  await expectRefusals();
  await reopen();
  await expectRefusals();
  if (EVIDENCE) {
    mkdirSync(EVIDENCE, { recursive: true });
    const captureDir = mkdtempSync(join(EVIDENCE, "reopened-"));
    await page.mouse.move(0, 0);
    await voiceTab(page).blur();
    await expect(page.locator(".tooltip")).toHaveCount(0);
    await indicators.screenshot({ path: join(captureDir, "indicator-refusal.png") });
    await history.screenshot({ path: join(captureDir, "clear-refusal.png") });
  }
  await clear.click();
  await edge.check();
  await expect(history.getByRole("alert")).toHaveCount(0);
  await expect(history).toContainText("Nothing heard yet.");
  await expect(indicators.getByRole("alert")).toHaveCount(0);
  await expect(edge).toBeEnabled();
  await expect(edge).toBeChecked();
  expect([deletes, saves]).toEqual([2, 2]);
});

test("only Settings > Voice polls for voice config, and a pending save survives leaving Settings", async ({ dashboard: page, daemon }) => {
  await enableVoice(daemon);
  const endpoint = daemon.baseURL + "/api/voice/config";
  let reads = 0;
  page.on("request", request => {
    if (request.url() === endpoint && request.method() === "GET") reads++;
  });
  await page.clock.install();
  await page.reload();
  const settings = page.getByRole("button", { name: /^Settings\b/ });
  await expect(settings).toBeVisible();
  await page.clock.fastForward(6000);
  expect(reads, "the fleet does not read voice config").toBe(0);
  await settings.click();
  await expect(voiceTab(page)).toBeVisible();
  await page.clock.fastForward(6000);
  expect(reads, "the Display category does not read voice config").toBe(0);

  await voiceTab(page).click();
  const length = page.getByRole("combobox", { name: "Cancel window" });
  await expect(length).toHaveValue("4");
  expect((await page.request.put(endpoint, { data: { cancelWindow: { seconds: 6 } } })).ok()).toBe(true);
  await page.clock.fastForward(6000);
  await expect(length, "the open Voice panel picks up an external change").toHaveValue("6");

  const held = Promise.withResolvers<void>();
  await page.route(endpoint, async route => {
    if (route.request().method() === "PUT") {
      await held.promise;
      return route.fulfill({ status: 503, json: { error: "save_failed" } });
    }
    return route.continue();
  });
  const saving = page.waitForRequest(req => req.url() === endpoint && req.method() === "PUT");
  await length.selectOption("8");
  await saving;
  await page.getByRole("button", { name: "← Fleet" }).click();
  await expect(rail(page)).toHaveCount(0);
  const closedAt = reads;
  const refused = page.waitForResponse(response => response.url() === endpoint && response.status() === 503);
  held.resolve();
  await refused;
  await page.clock.fastForward(12_000);
  expect(reads, "the poll stops when the Voice panel closes").toBe(closedAt);
  await settings.click();
  await voiceTab(page).click();
  await expect(page.getByText("That change didn't stick: save_failed")).toBeVisible();
  await expect(length).toHaveValue("6");
  await expect.poll(() => reads).toBeGreaterThan(closedAt);
});

test("the voice flag brings Settings > Voice and the Setup family, and the mode line follows the voice state", async ({ dashboard: page, context, daemon }) => {
  test.setTimeout(120_000);
  let listener: Listener | null = null;
  try {
    await page.goto(`${daemon.baseURL}/#/settings/feature-flags`);
    await expect(page.locator('[data-anchor="feature-flags/voice"]')).toContainText("Voice addressing");
    await expect(flagToggle(page)).toHaveAttribute("aria-pressed", "false");
    await expect(rail(page).getByRole("tab", { name: "Feature flags" })).toBeVisible();
    await expect(voiceTab(page)).toHaveCount(0);
    expect((await fetch(`${daemon.baseURL}/api/voice/config`)).status, "the voice API is closed while the flag is off").toBe(404);

    const peer = await context.newPage();
    await peer.goto(`${daemon.baseURL}/#/settings/voice`);
    await expect(peer.getByRole("tab", { name: "Display", selected: true })).toBeVisible();
    await expect(voiceTab(peer)).toHaveCount(0);
    let peerNavigations = 0;
    peer.on("framenavigated", (frame) => { if (frame === peer.mainFrame()) peerNavigations++; });

    await flagToggle(page).click();
    await expect(flagToggle(page)).toHaveAccessibleName("Voice addressing: on");
    await expect(voiceTab(page)).toBeVisible();
    await expect(peer.getByRole("tab", { name: "Voice", selected: true })).toBeVisible();
    expect(peerNavigations, "the second window changed without navigating").toBe(0);

    await expect(modeLine(peer)).toContainText("Not listening");
    await expect(modeLine(peer)).toContainText("a preview it needs is off and no listener is running.");
    await expect(modeLine(peer).getByRole("button", { name: "Open Setup" })).toBeVisible();
    await capture(peer, "settings-unavailable");

    const panel = peer.getByRole("tabpanel", { name: "Voice" });
    await expect(panel.getByRole("checkbox", { name: "Auto-mute on calls" })).toBeChecked();
    await expect(panel.getByRole("combobox", { name: "Cancel window" })).toHaveValue("4");
    await expect(panel.getByRole("radio", { name: "Show" })).toBeChecked();
    await expect(panel.getByRole("checkbox", { name: "Plan forms by voice" })).toBeChecked();

    await panel.getByRole("combobox", { name: "Cancel window" }).selectOption("8");
    await expect.poll(async () => (await voiceConfig(daemon)).cancelWindow.seconds).toBe(8);
    await panel.getByRole("radio", { name: "Ask" }).check();
    await expect.poll(async () => (await voiceConfig(daemon)).whenUnsure).toBe("ask");
    await peer.reload();
    const reloaded = peer.getByRole("tabpanel", { name: "Voice" });
    await expect(reloaded.getByRole("combobox", { name: "Cancel window" })).toHaveValue("8");
    await expect(reloaded.getByRole("radio", { name: "Ask" })).toBeChecked();
    await reloaded.getByRole("combobox", { name: "Cancel window" }).selectOption("off");
    await expect(reloaded.getByRole("combobox", { name: "Cancel window" })).toHaveValue("off");
    await expect.poll(async () => (await voiceConfig(daemon)).cancelWindow).toEqual({ enabled: false, seconds: 8 });

    await modeLine(peer).getByRole("button", { name: "Open Setup" }).click();
    await expect(peer.getByRole("tab", { name: "Setup", selected: true })).toBeVisible();
    await expect(peer.locator("#setup-family-voice")).toHaveAttribute("aria-current", "true");
    const previews = setupRow(peer, "dependency-voice-previews");
    await expectRowStatus(peer, "dependency-voice-previews", "Needs setup");
    await expect(previews).toContainText("Ask without stopping, Reports and inbox upgrades and File plan decisions are off.");
    await capture(peer, "setup-voice-previews");
    await previews.getByRole("button", { name: "Turn on all three" }).click();
    await expectRowStatus(peer, "dependency-voice-previews", "Ready");
    await expect(previews).toContainText("Ask without stopping, Reports and inbox upgrades and File plan decisions are on");
    const flags = await storedFlags(daemon);
    expect([flags["async-input"], flags.inbox, flags["filed-plan-decisions"]]).toEqual([true, true, true]);
    // The previews row is ready; the microphone and the speech model are Phase 8's rows and are
    // not, on a machine with neither (`voice-model-setup.spec.ts` drives them).
    await expect(peer.locator("#setup-family-voice")).toHaveAccessibleName("Voice: 1 of 3 ready");
    await capture(peer, "setup-voice-ready");

    await page.goto(`${daemon.baseURL}/#/settings/voice`);
    await peer.goto(`${daemon.baseURL}/#/settings/voice`);
    peerNavigations = 0;
    await expect(modeLine(page)).toContainText("Not listening");
    await expect(modeLine(page)).toContainText("no listener is running.");
    await expect(modeLine(page)).not.toContainText("a preview it needs is off");

    listener = await beListener(daemon);
    await expect(modeLine(page)).toContainText("Listening");
    await expect(modeLine(peer)).toContainText("Listening");
    await expect(modeLine(page).getByRole("button", { name: "Open Setup" })).toHaveCount(0);
    await capture(page, "settings-listening");

    // Muted from anywhere - here the route the tray and the indicators will use - reaches both.
    const mute = await fetch(`${daemon.baseURL}/api/voice/mute`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ muted: true }),
    });
    expect(mute.status).toBe(200);
    await expect(modeLine(peer)).toContainText("Muted");
    await expect(modeLine(page)).toContainText("Muted");
    await fetch(`${daemon.baseURL}/api/voice/mute`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ muted: false }),
    });
    await expect(modeLine(peer)).toContainText("Listening");
    expect(peerNavigations, "every change reached the second window without a reload").toBe(0);

    // Off again, with the peer reading the Voice family. Its next Setup read is held, so the rows
    // it holds are the ones read while voice was on: the live flag alone must take the family,
    // its row and its repair button off the page, with no reload.
    await peer.goto(`${daemon.baseURL}/#/settings/setup`);
    await openSetupFamily(peer, "voice");
    await expect(setupRow(peer, "dependency-voice-previews")).toBeVisible();
    await peer.route("**/api/setup/checks*", () => { /* held: never answered */ });
    peerNavigations = 0;
    await page.goto(`${daemon.baseURL}/#/settings/feature-flags`);
    await flagToggle(page).click();
    await expect(flagToggle(page)).toHaveAccessibleName("Voice addressing: off");
    await expect(peer.locator("#setup-family-voice")).toHaveCount(0);
    await expect(setupRow(peer, "dependency-voice-previews")).toHaveCount(0);
    await expect(peer.locator("#setup-family-agents")).toHaveAttribute("aria-current", "true");
    await expect(voiceTab(peer)).toHaveCount(0);
    expect(peerNavigations, "the family left the second window without a reload").toBe(0);
    await capture(peer, "setup-voice-off");
    await expect.poll(async () => (await fetch(`${daemon.baseURL}/api/voice/config`)).status).toBe(404);
  } finally {
    listener?.stop();
  }
});

// The two write paths that can be refused. Each refusal is scripted in the browser, so the daemon
// is untouched by it and the stored state shows what reached it.
test("a refused Voice settings write rolls the control back and says why; a refused flag stops the Setup fix there", async ({ dashboard: page, daemon }) => {
  test.setTimeout(120_000);
  const voiceOn = await fetch(`${daemon.baseURL}/api/feature-flags`, {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "flag", id: "voice", enabled: true }),
  });
  expect(voiceOn.ok).toBe(true);

  // Settings > Voice: the daemon refuses every config write.
  await page.goto(`${daemon.baseURL}/#/settings/voice`);
  const panel = page.getByRole("tabpanel", { name: "Voice" });
  const length = panel.getByRole("combobox", { name: "Cancel window" });
  const planForms = panel.getByRole("checkbox", { name: "Plan forms by voice" });
  await expect(length).toHaveValue("4");
  let refusedWrites = 0;
  await page.route("**/api/voice/config", async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    refusedWrites++;
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "save_failed" }) });
  });
  await length.selectOption("8");
  await expect(panel.getByText("That change didn't stick: save_failed")).toBeVisible();
  await expect(length, "the length returns to the value the daemon holds").toHaveValue("4");
  // A click, not `uncheck()`: the switch is meant to spring back, which `uncheck()` reports as an error.
  await planForms.click();
  await expect(planForms, "the switch returns to the value the daemon holds").toBeChecked();
  expect(refusedWrites).toBe(2);
  expect(await voiceConfig(daemon)).toMatchObject({ cancelWindow: { enabled: true, seconds: 4 } });
  await capture(page, "settings-write-refused");

  await page.unroute("**/api/voice/config");
  await length.selectOption("6");
  await expect.poll(async () => (await voiceConfig(daemon)).cancelWindow.seconds).toBe(6);
  await expect(panel.getByText(/That change didn't stick/)).toHaveCount(0);
  await expect(length).toHaveValue("6");

  // Setup > Voice: the daemon refuses the middle flag. The first is turned on, the fix stops at
  // the refusal and says which flag it was, and the third is never written.
  const written: string[] = [];
  await page.route("**/api/feature-flags", async (route) => {
    const request = route.request();
    if (request.method() !== "PUT") return route.continue();
    const intent = request.postDataJSON() as { id?: string };
    written.push(intent.id ?? "");
    if (intent.id === "inbox") {
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "save_failed" }) });
      return;
    }
    await route.continue();
  });
  await page.goto(`${daemon.baseURL}/#/settings/setup`);
  await openSetupFamily(page, "voice");
  const previews = setupRow(page, "dependency-voice-previews");
  await expectRowStatus(page, "dependency-voice-previews", "Needs setup");
  await previews.getByRole("button", { name: "Turn on all three" }).click();
  // Named by its label, as Settings > Feature flags shows it, not by its id.
  await expect(previews.getByRole("status")).toContainText("Reports and inbox upgrades could not be turned on: save_failed");
  await expect(previews.getByRole("status")).toContainText("Switch it in Settings > Feature flags, then press Re-check.");
  expect(written).toEqual(["async-input", "inbox"]);
  const flags = await storedFlags(daemon);
  expect(flags["async-input"]).toBe(true);
  expect(flags.inbox).not.toBe(true);
  expect(flags["filed-plan-decisions"], "the flag after the refusal is never switched on").not.toBe(true);
  await expectRowStatus(page, "dependency-voice-previews", "Needs setup");
  await expect(previews).toContainText("Ask without stopping is on. Reports and inbox upgrades and File plan decisions are off.");
  await expect(previews.getByRole("button", { name: "Turn on the two that are off" })).toBeVisible();
  await capture(page, "setup-fix-refused");
});

// Two edits while the first is still being saved: the first is held and then refused, the second
// is kept. The panel must end on what the daemon holds - the first edit gone, the second shown -
// rather than letting the first answer roll the panel back over the second.
test("Voice settings edits are saved in order, and a refused first edit leaves a kept second one on screen", async ({ dashboard: page, daemon }) => {
  test.setTimeout(120_000);
  const voiceOn = await fetch(`${daemon.baseURL}/api/feature-flags`, {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "flag", id: "voice", enabled: true }),
  });
  expect(voiceOn.ok).toBe(true);
  await page.goto(`${daemon.baseURL}/#/settings/voice`);
  const panel = page.getByRole("tabpanel", { name: "Voice" });
  const length = panel.getByRole("combobox", { name: "Cancel window" });
  const planForms = panel.getByRole("checkbox", { name: "Plan forms by voice" });
  await expect(length).toHaveValue("4");
  await expect(planForms).toBeChecked();

  // The first write is held until released, then refused. Every later one reaches the daemon.
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  const writes: Array<{ body: unknown; at: number }> = [];
  let firstAnsweredAt = Number.POSITIVE_INFINITY;
  await page.route("**/api/voice/config", async (route) => {
    const request = route.request();
    if (request.method() !== "PUT") return route.continue();
    writes.push({ body: request.postDataJSON(), at: Date.now() });
    if (writes.length === 1) {
      await held;
      firstAnsweredAt = Date.now();
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "save_failed" }) });
      return;
    }
    await route.continue();
  });

  await length.selectOption("8");
  await expect.poll(() => writes.length).toBe(1);
  await expect(length, "the first edit shows while it is being saved").toHaveValue("8");
  await planForms.click();
  await expect(planForms, "the second edit shows at once too").not.toBeChecked();
  await expect(length).toHaveValue("8");

  release();
  await expect(panel.getByText("That change didn't stick: save_failed")).toBeVisible();
  await expect(length, "the refused first edit leaves the panel").toHaveValue("4");
  await expect(planForms, "the kept second edit stays on screen").not.toBeChecked();
  await expect.poll(async () => (await voiceConfig(daemon)).planFormsByVoice).toBe(false);
  expect((await voiceConfig(daemon)).cancelWindow.seconds, "the daemon never took the refused edit").toBe(4);
  // In order, one at a time: the second request left only after the first was answered.
  expect(writes.map((write) => write.body)).toEqual([{ cancelWindow: { seconds: 8 } }, { planFormsByVoice: false }]);
  expect(writes[1]!.at).toBeGreaterThanOrEqual(firstAnsweredAt);
  await capture(page, "settings-edits-in-order");

  await length.selectOption("6");
  await expect.poll(async () => (await voiceConfig(daemon)).cancelWindow.seconds).toBe(6);
  await expect(panel.getByText(/That change didn't stick/)).toHaveCount(0);
  await expect(planForms).not.toBeChecked();
});
