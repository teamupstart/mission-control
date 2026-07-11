// A short alert chime synthesized with the Web Audio API - no asset file, so no
// bundle/CSP concerns. Two rising notes for "attention", one soft note for "info".

import type { AlertSeverity } from "./alerts.ts";

const RATE_MS = 1200;
let ctx: AudioContext | null = null;
let lastPlayed = 0;
let lastSeverity: AlertSeverity = "info";

/**
 * Rate-limit decision, but severity-aware: an urgent "attention" tone is allowed to
 * cut through a recent "info" chime (e.g. an AFK task-done at t=0 then a needs-input
 * at t=400ms), so the important sound is never masked by a trivial one. Pure, tested.
 */
export function chimeGate(
  now: number,
  since: number,
  severity: AlertSeverity,
  prevSeverity: AlertSeverity,
): boolean {
  if (now - since >= RATE_MS) return true;
  return severity === "attention" && prevSeverity === "info";
}

function context(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const AC =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;
  if (!ctx) ctx = new AC();
  return ctx;
}

/** Resume the AudioContext from a user gesture, satisfying the autoplay policy. */
export function unlockAudio(): void {
  void context()?.resume();
}

/** Play the chime. Rate-limited (severity-aware) so a burst doesn't machine-gun. */
export function playChime(severity: AlertSeverity): void {
  const ac = context();
  if (!ac) return;
  const now = Date.now();
  if (!chimeGate(now, lastPlayed, severity, lastSeverity)) return;
  lastPlayed = now;
  lastSeverity = severity;

  const t0 = ac.currentTime;
  const notes = severity === "attention" ? [880, 1174.7] : [660];
  notes.forEach((freq, i) => {
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    const start = t0 + i * 0.12;
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(0.15, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, start + 0.22);
    osc.connect(gain).connect(ac.destination);
    osc.start(start);
    osc.stop(start + 0.24);
  });
}
