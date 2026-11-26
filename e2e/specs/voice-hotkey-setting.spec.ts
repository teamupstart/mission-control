import type { Locator } from "@playwright/test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "../fixtures/test.ts";
import { openSetupFamily, setupRow } from "../fixtures/setup-panel.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { fixtureSupervisorEnv } from "../../test/helpers/voice-supervisor.ts";
import { beSpeaker, enableVoice, voiceToken } from "../fixtures/voice.ts";
import { voiceHostTimeUs } from "../../src/server/voice/host-clock.ts";

test.use({ daemonEnv: fixtureSupervisorEnv });

test("Voice settings records a chord, explains refusal, and follows call and key reports", async ({ dashboard: page, daemon, context }) => {
  await enableVoice(daemon);
  const listener = await beSpeaker(daemon, { holdPlayback: true });
  try {
    await page.goto(daemon.baseURL + "/#/settings/voice");
    const row = page.locator('[data-anchor="voice/hotkey"]');
    const controls = page.locator(".voice-hardware-settings");
    const capture = row.getByRole("button", { name: "Mute hotkey" });
    const mode = page.getByRole("status", { name: "Voice mode" });
    const report = async (extra = {}) => {
      const response = await page.request.post(daemon.baseURL + "/voice/shell-report", {
        headers: { "x-harness-token": voiceToken(daemon) },
        data: { capabilities: { hotkey: { available: true }, "call-detection": { available: true } },
          registeredHotkey: "ctrl+k", reportedAtHostUs: voiceHostTimeUs(), ...extra },
      });
      expect(response.ok()).toBe(true);
    };
    let captureDir: string | undefined;
    if (process.env.MC_E2E_EVIDENCE) {
      const root = artifactsDir("voice-hardware/recorder");
      mkdirSync(root, { recursive: true });
      captureDir = mkdtempSync(join(root, "run-"));
    }
    const screenshot = async (name: string) => {
      if (captureDir) await controls.screenshot({ path: join(captureDir, name + ".png") });
    };
    await expect(row).toContainText("Needs the desktop app");
    await report({ registeredHotkey: "cmd+ctrl+alt+v" });
    await expect(capture).toHaveText("⌘⌃⌥V");
    await screenshot("default");
    const voiceOverReason = "macOS refused ⌘⌃⌥V: VoiceOver uses this shortcut for the next visited link. Choose a different mute shortcut.";
    await report({ registeredHotkey: null, hotkeyError: { reason: voiceOverReason, chordInForce: null } });
    await expect(row.getByRole("alert")).toHaveText(voiceOverReason + " No hotkey is in force.");
    await expect(capture).toBeEnabled();
    await screenshot("voiceover");
    await report({ registeredHotkey: "cmd+ctrl+alt+v" });
    await expect(row.getByRole("alert")).toHaveCount(0);
    await page.goto(daemon.baseURL + "/#/settings/setup");
    await openSetupFamily(page, "voice");
    const mic = setupRow(page, "dependency-voice-microphone");
    await expect(mic).toContainText("Tap ⌘⌃⌥V to mute voice from any app.");
    if (captureDir) await mic.screenshot({ path: join(captureDir, "setup.png") });
    await page.goto(daemon.baseURL + "/#/settings/voice");
    const mock = await context.newPage();
    await mock.goto(new URL("../../docs/plans/voice-addressing-for-agents/mockup-voice-settings.html", import.meta.url).href);
    const approved = mock.locator("#e .vs-grid2");
    await expect(controls.locator(".kb-row-label")).toHaveText(await approved.locator(".kb-row-label").allTextContents());
    await expect(controls.locator(".display-choice-option")).toHaveText(await approved.locator(".display-choice-option").allTextContents());
    // Compare all four cells at the same grid width, including their row/column offsets.
    const width = (await controls.boundingBox())!.width;
    await approved.evaluate((el, width) => { el.style.width = width + "px"; }, width);
    const cells = (grid: Locator) => grid.evaluate(el => {
      const origin = el.getBoundingClientRect();
      return Array.from(el.children, cell => {
        const rect = cell.getBoundingClientRect();
        return [rect.x - origin.x, rect.y - origin.y, rect.width, rect.height].map(Math.round);
      });
    });
    expect(await cells(controls)).toEqual(await cells(approved));
    await expect(controls.getByRole("combobox", { name: "Cancel window" })).toHaveValue("4");
    await expect(controls.getByRole("radiogroup", { name: "When routing is unsure" }).getByRole("radio", { name: "Show" })).toBeChecked();
    for (const selector of [".kb-capture", ".sc-switch-track"]) {
      expect((await controls.locator(selector).boundingBox())?.width).toEqual((await approved.locator(selector).boundingBox())?.width);
    }
    await mock.close();
    let previousRecording: string | null = null;
    const beginRecording = async () => {
      const opened = page.waitForResponse(r => r.url().endsWith("/api/voice/hotkey-recording"));
      await capture.click();
      const response = await opened;
      expect(response.status()).toBe(200);
      const id = await response.headerValue("x-voice-recording-id");
      expect(id).toBeTruthy();
      const release = (recordingId: string | null) => report({ registeredHotkey: null,
        capabilities: { hotkey: { available: true, recordingId }, "call-detection": { available: true } } });
      if (previousRecording) {
        await release(previousRecording);
        await expect(capture).toHaveAttribute("aria-busy", "true");
        await expect(capture).toHaveAttribute("aria-pressed", "false");
      }
      await release(id);
      previousRecording = id;
      await expect(capture).toHaveAttribute("aria-pressed", "true");
    };
    const saved = async () => (await (await page.request.get(daemon.baseURL + "/api/voice/config")).json()).config;
    const recordReplacement = async (keys: string, chord: string) => {
      await beginRecording();
      await page.keyboard.press(keys);
      await expect.poll(async () => {
        const { state } = await (await page.request.get(daemon.baseURL + "/api/voice/mute")).json();
        return !state.recordingHotkey && state.pendingHotkey;
      }).toBe(chord);
      const { state } = await (await page.request.get(daemon.baseURL + "/api/voice/mute")).json();
      expect(typeof state.pendingHotkeyId).toBe("string");
      return state.pendingHotkeyId as string;
    };
    await capture.focus();
    await expect(page.locator(".tooltip").filter({ hasText: /^Record a system-wide mute shortcut$/ })).toBeVisible();
    await beginRecording();
    await expect(capture).toHaveAccessibleDescription("Press a shortcut, or Escape to cancel");
    await expect(capture).toHaveText("Press a key…");
    await screenshot("capture");
    await page.keyboard.press("Escape");
    await expect(capture).toHaveAttribute("aria-pressed", "false");
    await recordReplacement("Control+k", "ctrl+k");
    expect((await saved()).hotkey).toBe("cmd+ctrl+alt+v");
    await report({ registeredHotkey: "ctrl+k" });
    await expect.poll(async () => (await saved()).hotkey).toBe("ctrl+k");
    await expect(capture).toHaveText("⌃K");
    await screenshot("configured");
    await beginRecording();
    await page.keyboard.press("Control+k");
    await expect(capture).toHaveAttribute("aria-pressed", "false");
    await expect(capture).toHaveText("⌃K");
    await expect(mode).toContainText("Listening");
    await recordReplacement("Control+Shift+Space", "ctrl+shift+Space");
    await report({ registeredHotkey: "ctrl+shift+Space" });
    await expect.poll(async () => (await saved()).hotkey).toBe("ctrl+shift+Space");
    await recordReplacement("Control+Shift+Equal", "ctrl+shift++");
    await report({ registeredHotkey: "ctrl+shift++" });
    await expect.poll(async () => (await saved()).hotkey).toBe("ctrl+shift++");
    await recordReplacement("Control+k", "ctrl+k");
    await report({ registeredHotkey: "ctrl+k" });
    const spaceTrial = await recordReplacement("Alt+Space", "alt+Space");
    expect((await saved()).hotkey).toBe("ctrl+k");
    const spaceError = { reason: "macOS refused ⌥Space: another app already owns it.", chordInForce: "ctrl+k", trialId: spaceTrial };
    await report({ hotkeyError: spaceError });
    await expect(row.getByRole("alert")).toHaveText("macOS refused ⌥Space: another app already owns it. ⌃K is still your hotkey.");
    await expect(capture).toHaveText("⌃K");
    await screenshot("refused");
    await page.reload();
    await expect(capture).toHaveText("⌃K");
    await expect(row.getByRole("alert")).toContainText("⌃K is still your hotkey.");
    expect((await saved()).hotkey).toBe("ctrl+k");
    await screenshot("refused-after-reload");
    await page.goto(daemon.baseURL + "/#/settings/setup");
    await openSetupFamily(page, "voice");
    await expect(mic).toContainText("Tap ⌃K to mute voice from any app.");
    if (captureDir) await mic.screenshot({ path: join(captureDir, "setup-after-refusal.png") });
    await page.goto(daemon.baseURL + "/#/settings/voice");
    const letterTrial = await recordReplacement("v", "v");
    await report({ hotkeyError: spaceError });
    await expect(row.getByRole("status")).toHaveText("Waiting for the desktop to confirm v.");
    await expect(row.getByRole("alert")).toHaveCount(0);
    await report({ hotkeyError: { reason: "macOS refused v: Use Command, Control, or Option with a typing key.", chordInForce: "ctrl+k", trialId: letterTrial } });
    await expect(row.getByRole("alert")).toContainText("Use Command, Control, or Option with a typing key. ⌃K is still your hotkey.");
    expect((await saved()).hotkey).toBe("ctrl+k");
    await expect(capture).toHaveText("⌃K");
    await beginRecording();
    await page.keyboard.press("Control+k");
    await expect.poll(async () => (await saved()).hotkey).toBe("ctrl+k");
    await report({ callActive: true });
    await expect(mode).toContainText("Muted for a call");
    await report({ callActive: true, capabilities: { hotkey: { available: true },
      "call-detection": { available: false, reason: "Retrying microphone check. CoreAudio input query failed." } } });
    await expect(controls).toContainText("CoreAudio input query failed.");
    await expect(mode).toContainText("Muted for a call");
    const autoMute = controls.getByRole("checkbox", { name: "Auto-mute on calls" });
    await expect(autoMute).toBeEnabled();
    await screenshot("poll-error");
    await autoMute.press("Space");
    await expect(autoMute).not.toBeChecked();
    await expect(mode).toContainText("Listening");
    await expect.poll(async () => (await saved()).autoMuteDuringCalls).toBe(false);
    await controls.locator("label.sc-switch").click();
    await expect(autoMute).toBeChecked();
    await expect(mode).toContainText("Muted for a call");
    const audition = await page.request.post(daemon.baseURL + "/api/voice/speech/audition");
    expect(audition.ok()).toBe(true);
    await expect.poll(() => listener.playing).toBe(true);
    await report({ callActive: true, pushToTalk: true });
    await expect(mode).toContainText("Push to talk");
    expect((await listener.poll()).capture).toBe(false);
    await listener.end();
    await expect.poll(async () => (await listener.poll()).capture).toBe(true);
    await report({ callActive: true, pushToTalk: false });
    await expect(mode).toContainText("Muted for a call");
    expect((await listener.poll()).capture).toBe(false);
    await report({ registeredHotkey: null, hotkeyError: { reason: "Reserved.", chordInForce: null },
      capabilities: { hotkey: { available: true }, "call-detection": { available: false, reason: "Call detection requires macOS 14.2 or later." } } });
    await expect(mode).toContainText("Listening");
    await expect(row.getByRole("alert")).toContainText("No hotkey is in force.");
    await expect(controls.getByRole("checkbox")).toBeDisabled();
    await expect(controls).toContainText("Call detection requires macOS 14.2 or later.");

    await recordReplacement("Control+j", "ctrl+j");
    await expect(row.getByRole("status")).toHaveText("Waiting for the desktop to confirm ⌃J.");
    await screenshot("pending-confirmation");
    // Simulate the desktop disconnecting: no more shell reports arrive.
    const expired = "The desktop did not confirm ⌃J. ⌃K is still saved.";
    await expect(row.getByRole("alert")).toHaveText(expired, { timeout: 25_000 });
    await expect(row).toContainText("Needs the desktop app");
    await screenshot("confirmation-expired");
    await page.reload();
    await expect(row.getByRole("alert")).toHaveText(expired);
    expect((await saved()).hotkey).toBe("ctrl+k");
  } finally {
    await listener.exit();
  }
});
