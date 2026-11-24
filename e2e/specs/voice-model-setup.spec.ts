import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test as base } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { expectRowStatus, openSetupFamily, setupRow } from "../fixtures/setup-panel.ts";
import { beListener, voiceToken, startModelServer, type Listener, type ModelServer } from "../fixtures/voice.ts";

// Voice addressing's speech model and microphone in Setup (Phase 8), end to end: the Voice family's
// speech model row reads missing, Download shows a progress bar with its figures and Cancel and
// then reads verified with the files on disk; a corrupt file reads as the error with Retry; Cancel
// removes what was written; a file edited on disk without changing its size is refused at the next
// start. The microphone row reads "Not checked yet" until a listener reports, and Voice settings
// offers the built-in microphone, the system default and the listener's own devices.
//
// No spec downloads the real model: `startModelServer` stands in for Hugging Face with three small
// files and a manifest pinning them, and the daemon is pointed at both through `daemonEnv`.

const EVIDENCE = process.env.MC_E2E_EVIDENCE ? artifactsDir("voice-model-setup") : null;

async function capture(window: Page, name: string): Promise<void> {
  if (!EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await window.screenshot({ path: `${EVIDENCE}${name}.png`, fullPage: true });
}

// The model server has to exist before the daemon starts: its address and manifest are read at
// launch.
const test = base.extend<{ models: ModelServer }>({
  // eslint-disable-next-line no-empty-pattern -- Playwright requires destructured fixture dependencies.
  models: async ({}, use) => {
    const models = await startModelServer();
    try {
      await use(models);
    } finally {
      await models.close();
    }
  },
  daemonEnv: async ({ models }, use) => {
    await use(models.env);
  },
});

async function put(daemon: DaemonHandle, path: string, body: unknown): Promise<void> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.ok, `PUT ${path}`).toBe(true);
}

/** Voice and the three previews it needs, on the FluidAudio backend this phase publishes a model for. */
async function enableVoice(daemon: DaemonHandle): Promise<void> {
  for (const id of ["async-input", "inbox", "filed-plan-decisions", "voice"]) {
    await put(daemon, "/api/feature-flags", { kind: "flag", id, enabled: true });
  }
  await put(daemon, "/api/voice/config", { backend: "fluidaudio" });
}

async function openVoiceSetup(page: Page, daemon: DaemonHandle): Promise<void> {
  await page.goto(`${daemon.baseURL}/#/settings/setup`);
  await openSetupFamily(page, "voice");
}

const MODEL_ROW = "dependency-voice-model";
const MICROPHONE_ROW = "dependency-voice-microphone";

function revisionDir(daemon: DaemonHandle, models: ModelServer): string {
  return join(daemon.home, "voice", "models", "fluidaudio", models.manifest.revision);
}

test("the speech model downloads with visible progress, verifies, and is kept in the state home", async ({ dashboard: page, daemon, models }) => {
  await enableVoice(daemon);
  await openVoiceSetup(page, daemon);
  const row = setupRow(page, MODEL_ROW);

  await expectRowStatus(page, MODEL_ROW, "Missing");
  await expect(row).toContainText("Voice speech model");
  await expect(row).toContainText("Lets Mission Control hear spoken names and messages on this machine.");
  await expect(row).toContainText("4.0 MiB from Hugging Face");
  await expect(page.locator("#setup-family-voice")).toHaveAccessibleName("Voice: 1 of 3 ready");
  await capture(page, "model-missing");

  // Download, with the large file held half-way so the bar can be read mid-flight.
  models.serve(models.largeFile, "hold");
  await row.getByRole("button", { name: "Download" }).click();
  const bar = row.getByRole("progressbar", { name: "Downloading the speech model" });
  await expect(bar).toBeVisible();
  await expect(row.getByText("Downloading", { exact: true })).toBeVisible();
  await expect(row).toContainText("2.0 MiB of 4.0 MiB");
  await expect(bar).toHaveAttribute("aria-valuenow", "49");
  await expect(row.getByRole("button", { name: "Cancel" })).toBeVisible();
  await capture(page, "model-downloading");

  models.release();
  await expectRowStatus(page, MODEL_ROW, "Ready");
  // The path is shown from `~` when it is under the home, which a fixture daemon's state home is.
  await expect(row).toContainText(`voice/models/fluidaudio/${models.manifest.revision} · checksum verified`);
  await expect(row.getByRole("progressbar")).toHaveCount(0);
  await expect(page.locator("#setup-family-voice")).toHaveAccessibleName("Voice: 2 of 3 ready");
  for (const file of models.manifest.files) {
    expect(existsSync(join(revisionDir(daemon, models), file.path)), file.path).toBe(true);
  }
  await capture(page, "model-verified");
});

test("a file that fails its checksum reads as the error with Retry, and Retry fetches only that file", async ({ dashboard: page, daemon, models }) => {
  await enableVoice(daemon);
  await openVoiceSetup(page, daemon);
  const row = setupRow(page, MODEL_ROW);
  await expectRowStatus(page, MODEL_ROW, "Missing");

  models.serve(models.smallFile, "corrupt");
  await row.getByRole("button", { name: "Download" }).click();
  await expectRowStatus(page, MODEL_ROW, "Needs setup");
  await expect(row).toContainText(`The download of ${models.smallFile} did not match its checksum and was deleted.`);
  const retry = row.getByRole("button", { name: "Retry" });
  await expect(retry).toBeVisible();
  expect(existsSync(join(revisionDir(daemon, models), models.smallFile))).toBe(false);
  await capture(page, "model-checksum-failed");

  models.serve(models.smallFile, "ok");
  models.requests.length = 0;
  await retry.click();
  await expectRowStatus(page, MODEL_ROW, "Ready");
  await expect(row).toContainText("checksum verified");
  expect(models.requests, "the two files that verified were kept").toEqual([models.smallFile]);
});

test("Cancel stops the download, removes what it wrote, and the row reads missing again", async ({ dashboard: page, daemon, models }) => {
  await enableVoice(daemon);
  await openVoiceSetup(page, daemon);
  const row = setupRow(page, MODEL_ROW);

  models.serve(models.largeFile, "hold");
  await row.getByRole("button", { name: "Download" }).click();
  await expect(row.getByRole("progressbar", { name: "Downloading the speech model" })).toBeVisible();
  await expect(row).toContainText("2.0 MiB of 4.0 MiB");
  await row.getByRole("button", { name: "Cancel" }).click();

  await expectRowStatus(page, MODEL_ROW, "Missing");
  await expect(row.getByRole("button", { name: "Download" })).toBeVisible();
  await expect(row.getByRole("progressbar")).toHaveCount(0);
  expect(existsSync(revisionDir(daemon, models)), "nothing of the cancelled download is left").toBe(false);
});

test("a model file edited on disk without changing its size is refused at the next start", async ({ dashboard: page, daemon, models }) => {
  test.setTimeout(120_000);
  await enableVoice(daemon);
  await openVoiceSetup(page, daemon);
  const row = setupRow(page, MODEL_ROW);
  await row.getByRole("button", { name: "Download" }).click();
  await expectRowStatus(page, MODEL_ROW, "Ready");

  // Same size, one byte different: only hashing the file again can tell.
  await daemon.shutdown();
  const target = join(revisionDir(daemon, models), models.largeFile);
  const bytes = readFileSync(target);
  bytes[1234] = bytes[1234]! ^ 0x01;
  writeFileSync(target, bytes);
  await daemon.restart();

  await openVoiceSetup(page, daemon);
  await expectRowStatus(page, MODEL_ROW, "Needs setup");
  await expect(row).toContainText(`${models.largeFile} does not match its pinned SHA-256 checksum. Download it again.`);
  await capture(page, "model-tampered");

  models.requests.length = 0;
  await row.getByRole("button", { name: "Retry" }).click();
  await expectRowStatus(page, MODEL_ROW, "Ready");
  expect(models.requests, "only the edited file is fetched again").toEqual([models.largeFile]);
});

test("the microphone row reads not checked until a listener reports, and the input device offers the listener's devices", async ({ dashboard: page, daemon }) => {
  let listener: Listener | null = null;
  try {
    await enableVoice(daemon);

    await page.goto(`${daemon.baseURL}/#/settings/voice`);
    const panel = page.getByRole("tabpanel", { name: "Voice" });
    const input = panel.getByRole("combobox", { name: "Input device" });
    await expect(input).toHaveValue("built-in");
    await expect(input.getByRole("option")).toHaveText(["Built-in microphone", "macOS default input"]);
    await expect(panel).toContainText("Other inputs are listed while the listener is running.");

    await openVoiceSetup(page, daemon);
    const microphone = setupRow(page, MICROPHONE_ROW);
    await expectRowStatus(page, MICROPHONE_ROW, "Unknown");
    await expect(microphone).toContainText("Microphone access");
    await expect(microphone).toContainText("Not checked yet.");
    await expect(microphone).toContainText("System Settings > Privacy & Security > Microphone");
    await capture(page, "microphone-not-checked");

    listener = await beListener(daemon, {
      backend: "fluidaudio",
      devices: [
        { id: "BuiltInMicrophoneDevice", name: "MacBook Pro Microphone", builtIn: true },
        { id: "usb-desk-mic", name: "Desk USB microphone", builtIn: false },
      ],
    });
    await microphone.getByRole("button", { name: "Check again" }).click();
    await expectRowStatus(page, MICROPHONE_ROW, "Ready");
    await expect(microphone).toContainText("Allowed, as the voice listener reports");
    await capture(page, "microphone-allowed");

    await page.goto(`${daemon.baseURL}/#/settings/voice`);
    await expect(input.getByRole("option")).toHaveText(
      ["Built-in microphone", "macOS default input", "MacBook Pro Microphone (built in)", "Desk USB microphone"],
      { timeout: 15_000 },
    );
    await expect(panel).not.toContainText("Other inputs are listed while the listener is running.");
    await input.selectOption("usb-desk-mic");
    await expect.poll(async () => {
      const response = await fetch(`${daemon.baseURL}/api/voice/config`);
      return ((await response.json()) as { config: { inputDevice: string } }).config.inputDevice;
    }).toBe("usb-desk-mic");
    await capture(page, "input-device");
    await page.reload();
    await expect(input).toHaveValue("usb-desk-mic");
  } finally {
    listener?.stop();
  }
});

test("desktop Setup asks for microphone access, reflects a shell grant and offers System Settings after denial", async ({ dashboard: page, daemon }) => {
  await enableVoice(daemon);
  const report = async (microphone: string) => {
    const response = await fetch(daemon.baseURL + "/voice/shell-report", {
      method: "POST",
      headers: { "content-type": "application/json", "x-harness-token": voiceToken(daemon) },
      body: JSON.stringify({ microphone, capabilities: { microphone: { available: microphone === "granted" } } }),
    });
    expect(response.ok).toBe(true);
  };
  let repairs = 0;
  await page.exposeFunction("fixtureMicrophone", async () => {
    repairs++;
    if (repairs === 1) await report("granted");
  });
  await page.addInitScript(() => {
    Object.defineProperty(window, "missionDesktop", {value: {
      ...window.missionDesktop, onOpenSettings: () => () => {}, fixVoiceMicrophone: () => Reflect.get(window, "fixtureMicrophone")(),
    }, configurable: true});
  });
  await page.reload(); // Install the fixture preload before hash-only Settings navigation.
  await report("not-determined");
  await openVoiceSetup(page, daemon);
  const row = setupRow(page, MICROPHONE_ROW);
  await row.getByRole("button", {name: "Ask macOS"}).click();
  await expectRowStatus(page, MICROPHONE_ROW, "Ready");
  await expect(row).toContainText("Allowed, as the desktop app reports");
  await report("denied");
  await expectRowStatus(page, MICROPHONE_ROW, "Needs setup");
  await expect(row.getByRole("button", {name: "Check again"})).toBeVisible();
  await row.getByRole("button", {name: "Open System Settings"}).click();
  await expect.poll(() => repairs).toBe(2);
  await expect(row.getByRole("button", {name: "Open System Settings"})).toBeEnabled();
  await capture(page, "shell-microphone-denied");
  await page.goto(daemon.baseURL + "/#/settings/voice");
  await expect(page.getByRole("status", { name: "Voice mode" })).toContainText("microphone access is denied");
});
