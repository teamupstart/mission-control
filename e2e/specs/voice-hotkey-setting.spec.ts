import type { Locator } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { test, expect } from "../fixtures/test.ts";
import { openSetupFamily, setupRow } from "../fixtures/setup-panel.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { beListener, enableVoice, voiceToken } from "../fixtures/voice.ts";
import { voiceHostTimeUs } from "../../src/server/voice/host-clock.ts";

test("Voice settings records a chord, explains refusal, and follows call and key reports", async ({ dashboard: page, daemon, context }) => {
  await enableVoice(daemon);
  const listener = await beListener(daemon);
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
    const screenshot = async (name: string) => {
      if (!process.env.MC_E2E_EVIDENCE) return;
      const dir = artifactsDir("voice-hardware/recorder");
      mkdirSync(dir, { recursive: true });
      await controls.screenshot({ path: dir + name + ".png" });
    };
    await expect(row).toContainText("Needs the desktop app");
    await report({ registeredHotkey: "cmd+ctrl+alt+v" });
    await expect(capture).toHaveText("⌘⌃⌥V");
    await screenshot("default");
    await page.goto(daemon.baseURL + "/#/settings/setup");
    await openSetupFamily(page, "voice");
    const mic = setupRow(page, "dependency-voice-microphone");
    await expect(mic).toContainText("Tap ⌘⌃⌥V to mute voice from any app.");
    if (process.env.MC_E2E_EVIDENCE) await mic.screenshot({ path: artifactsDir("voice-hardware/recorder") + "setup.png" });
    await page.goto(daemon.baseURL + "/#/settings/voice");
    const mock = await context.newPage();
    await mock.goto(new URL("../../docs/plans/voice-addressing-for-agents/mockup-voice-settings.html", import.meta.url).href);
    const approved = mock.locator("#e .vs-grid2");
    await expect(controls.locator(".kb-row-label")).toHaveText(await approved.locator(".kb-row-label").allTextContents());
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
    await expect(controls.getByRole("radiogroup", { name: "Unsure" }).getByRole("radio", { name: "Show" })).toBeChecked();
    for (const selector of [".kb-capture", ".sc-switch-track"]) {
      expect((await controls.locator(selector).boundingBox())?.width).toEqual((await approved.locator(selector).boundingBox())?.width);
    }
    await mock.close();
    const beginRecording = async () => {
      const opened = page.waitForResponse(r => r.url().endsWith("/api/voice/hotkey-recording"));
      await capture.click();
      expect((await opened).status()).toBe(200);
      // Carbon has released its reservation. The browser may now receive the same chord.
      await report({ registeredHotkey: null });
      await expect(capture).toHaveAttribute("aria-pressed", "true");
    };
    await capture.focus();
    await expect(page.locator(".tooltip")).toHaveText("Record a system-wide mute shortcut");
    await beginRecording();
    await expect(capture).toHaveAccessibleDescription("Press a shortcut, or Escape to cancel");
    await expect(capture).toHaveText("Press a key…");
    await screenshot("capture");
    await page.keyboard.press("Escape");
    await expect(capture).toHaveAttribute("aria-pressed", "false");
    await beginRecording();
    await page.keyboard.press("Control+k");
    await expect.poll(async () => (await (await page.request.get(daemon.baseURL + "/api/voice/config")).json()).config.hotkey).toBe("ctrl+k");
    await expect(capture).toHaveText("⌃K");
    await screenshot("configured");
    await report({ registeredHotkey: "ctrl+k" });
    await beginRecording();
    await page.keyboard.press("Control+k");
    await expect(capture).toHaveAttribute("aria-pressed", "false");
    await expect(capture).toHaveText("⌃K");
    await expect(mode).toContainText("Listening");
    await beginRecording();
    await page.keyboard.press("Control+Shift+Space");
    const saved = async () => (await (await page.request.get(daemon.baseURL + "/api/voice/config")).json()).config;
    await expect.poll(async () => (await saved()).hotkey).toBe("ctrl+shift+Space");
    await beginRecording();
    await page.keyboard.press("Alt+Space");
    await expect.poll(async () => (await saved()).hotkey).toBe("alt+Space");
    await report({ hotkeyError: { reason: "macOS refused ⌥Space: another app already owns it.", chordInForce: "ctrl+k" } });
    await expect(row.getByRole("alert")).toHaveText("macOS refused ⌥Space: another app already owns it. ⌃K is still your hotkey.");
    await expect(capture).toHaveText("⌃K");
    await screenshot("refused");
    await beginRecording();
    await page.keyboard.press("v");
    await expect.poll(async () => (await (await page.request.get(daemon.baseURL + "/api/voice/config")).json()).config.hotkey).toBe("v");
    await report({ hotkeyError: { reason: "macOS refused v: Use Command, Control, or Option with a typing key.", chordInForce: "ctrl+k" } });
    await expect(row.getByRole("alert")).toContainText("Use Command, Control, or Option with a typing key. ⌃K is still your hotkey.");
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
    await report({ callActive: true, pushToTalk: true });
    await expect(mode).toContainText("Push to talk");
    await report({ registeredHotkey: null, hotkeyError: { reason: "Reserved.", chordInForce: null },
      capabilities: { hotkey: { available: true }, "call-detection": { available: false, reason: "Call detection requires macOS 14.2 or later." } } });
    await expect(mode).toContainText("Listening");
    await expect(row.getByRole("alert")).toContainText("No hotkey is in force.");
    await expect(controls.getByRole("checkbox")).toBeDisabled();
    await expect(controls).toContainText("Call detection requires macOS 14.2 or later.");
  } finally {
    listener.stop();
  }
});
