// The dashboard's two pure readings for Phase 8: the speech model's progress figures, and the
// input devices Voice settings offers.
import assert from "node:assert/strict";
import test from "node:test";
import { voiceModelProgressText } from "../src/web/components/VoiceModelProgress.tsx";
import { voiceInputChoices } from "../src/web/components/VoiceSettingsPanel.tsx";

const MiB = 1024 * 1024;

test("the progress figures say how much, how fast and how long is left", () => {
  assert.equal(voiceModelProgressText({ status: "downloading", doneBytes: 0, totalBytes: 542 * MiB, bytesPerSecond: null }), "0 B of 542 MiB");
  assert.equal(
    voiceModelProgressText({ status: "downloading", doneBytes: 212 * MiB, totalBytes: 542 * MiB, bytesPerSecond: 8.4 * MiB }),
    "212 MiB of 542 MiB · 8.4 MiB/s · 39 s left",
  );
  assert.equal(
    voiceModelProgressText({ status: "downloading", doneBytes: 12 * MiB, totalBytes: 542 * MiB, bytesPerSecond: 2 * MiB }),
    "12 MiB of 542 MiB · 2.0 MiB/s · 4 min left",
  );
  assert.equal(voiceModelProgressText({ status: "verifying", doneBytes: 100 * MiB, totalBytes: 542 * MiB, bytesPerSecond: null }), "Checked 100 MiB of 542 MiB");
});

test("the input menu offers the built-in microphone, the system default, then the listener's devices", () => {
  const fixed = [
    { id: "built-in", label: "Built-in microphone" },
    { id: "system-default", label: "macOS default input" },
  ];
  assert.deepEqual(voiceInputChoices([], "built-in"), fixed, "with no listener, only the two");
  assert.deepEqual(
    voiceInputChoices([
      { id: "built-in", name: "Built-in microphone", builtIn: true },
      { id: "mbp", name: "MacBook Pro Microphone", builtIn: true },
      { id: "usb", name: "Desk USB microphone" },
    ], "usb"),
    [...fixed, { id: "mbp", label: "MacBook Pro Microphone (built in)" }, { id: "usb", label: "Desk USB microphone" }],
    "a device reusing a fixed id is not listed twice",
  );
  assert.deepEqual(
    voiceInputChoices([], "usb"),
    [...fixed, { id: "usb", label: "Saved device (not connected)" }],
    "a saved device that is not listed stays offered, so the menu never shows a choice that was not made",
  );
});
