import { createRequire } from "node:module";
import { join } from "node:path";
import { loadVoiceHostClock } from "../server/voice/native-clock.ts";
import { formatChord } from "../shared/keyboard-chords.ts";
import { VOICE_CALL_POLL_RETRY, VOICE_LIMITS, type VoiceCapability, type VoiceHotkeyError, type VoiceMode } from "../shared/voice.ts";

type Edge = (down: boolean, hostUs: number) => void;
interface Registrar {
  /** False when the same physical key and modifiers are already registered. */
  register(chord: string, onEdge: Edge): boolean;
  unregister(): void;
  watchVoiceOver?(changed?: () => void): void;
}
interface InputActivity { running(listenerPid: number): boolean }
type Binding<T> = { value: T; reason?: never } | { value?: never; reason: string };

const available = { available: true, reason: null };
const unavailable = (reason: string): VoiceCapability => ({ available: false, reason });
const reasonOf = (error: unknown) => String(error instanceof Error ? error.message : error).slice(0, VOICE_LIMITS.reasonChars);

export class VoiceHardware {
  private desired?: string | null;
  private trialId?: string;
  private recordingId?: string;
  private suspended?: string | null;
  private registeredHotkey: string | null = null;
  private hotkeyError: VoiceHotkeyError | null = null;
  private press?: number;
  private release?: number;
  private holdTimer?: NodeJS.Timeout;
  private pushToTalk = false;
  private callActive = false;
  private callCapability: VoiceCapability;
  private poll?: NodeJS.Timeout;
  private mode: VoiceMode = "off";

  constructor(private registrar: Binding<Registrar>, private activity: Binding<InputActivity>,
    private listenerPid: () => number, private toggle: () => void, private changed: () => void,
    private clock: () => number) {
    registrar.value?.watchVoiceOver?.(() => this.refreshRegistration());
    this.callCapability = activity.value ? available : unavailable(activity.reason);
  }

  update(saved: string | null, mode: VoiceMode, recording: boolean | string = false, pending?: string, trialId?: string) {
    const chord = pending ?? saved;
    this.mode = mode;
    if (mode !== "auto-muted" && mode !== "push-to-talk" && this.pushToTalk) this.cancelPress();
    if (this.activity.value && !this.poll) {
      this.sample();
      this.poll = setInterval(() => this.sample(), 500);
    }
    this.recordingId = typeof recording === "string" ? recording : undefined;
    if (recording) {
      if (this.suspended === undefined) {
        this.suspended = this.trialId && this.desired === this.registeredHotkey ? saved : this.registeredHotkey;
        this.bind(null);
      }
      return;
    }
    if (this.suspended === undefined && this.desired === chord && this.trialId === trialId) return;
    // An unconfirmed reservation belongs only to its trial. Drop it before restoring
    // the saved shortcut so even a failed restoration cannot keep the trial active.
    if (this.trialId && this.registeredHotkey === this.desired && this.registeredHotkey !== saved && this.registeredHotkey !== pending) {
      this.bind(null);
    }
    const fallback = pending ? saved : this.suspended;
    this.suspended = undefined;
    // Restore the durable fallback before trying a replacement after recording or restart.
    if (chord && fallback !== undefined && fallback !== chord && fallback !== this.registeredHotkey) this.bind(fallback);
    const retained = !pending && this.hotkeyError && chord === this.registeredHotkey;
    this.desired = chord;
    this.trialId = trialId;
    // Ending a refused trial keeps its warning while this binding remains in force.
    if (retained) return;
    this.bind(chord, false, trialId);
  }

  refreshRegistration() {
    if (!this.desired || this.suspended !== undefined) return;
    const previous = this.registeredHotkey;
    // A refused preference may have left a different shortcut in force. Remap it too.
    if (previous) this.bind(previous, true, previous === this.desired ? this.trialId : undefined);
    if (this.desired !== previous) this.bind(this.desired, false, this.trialId);
    this.changed();
  }

  private bind(chord: string | null, remap = false, trialId?: string) {
    const registrar = this.registrar.value;
    if (!registrar) return;
    try {
      if (chord) {
        if (registrar.register(chord, this.edge)) this.cancelPress();
      } else if (this.registeredHotkey) {
        registrar.unregister();
        this.cancelPress();
      }
      this.registeredHotkey = chord;
      this.hotkeyError = null;
    } catch (error) {
      if (remap) {
        // The old physical key no longer represents the advertised shortcut on this layout.
        registrar.unregister();
        this.registeredHotkey = null;
        this.cancelPress();
      }
      const reason = `macOS refused ${formatChord(chord ?? "")}: ${reasonOf(error)}`;
      this.hotkeyError = { reason: reason.slice(0, VOICE_LIMITS.reasonChars), chordInForce: this.registeredHotkey, ...(trialId && { trialId }) };
    }
  }

  private sample() {
    if (!this.activity.value) return;
    let active = this.callActive;
    let capability: VoiceCapability = available;
    try { active = this.activity.value.running(this.listenerPid()); }
    catch (error) { capability = unavailable((VOICE_CALL_POLL_RETRY + reasonOf(error)).slice(0, VOICE_LIMITS.reasonChars)); }
    if (active === this.callActive && capability.reason === this.callCapability.reason) return;
    this.callActive = active;
    this.callCapability = capability;
    if (!active && this.pushToTalk) this.cancelPress();
    this.changed();
  }

  private edge: Edge = (down, eventUs) => {
    const at = Math.floor(eventUs);
    if (down) {
      if (this.press !== undefined) return;
      this.press = at;
      this.release = undefined;
      if (this.canTalkThroughCall()) {
        this.holdTimer = setTimeout(() => {
          if (!this.canTalkThroughCall()) return;
          this.pushToTalk = true;
          this.changed();
        }, Math.max(0, 350 - (this.clock() - at) / 1000));
      }
      return;
    }
    if (this.press === undefined) return;
    const tap = at - this.press < 350_000;
    this.cancelPress();
    this.release = at;
    if (tap) this.toggle();
    this.changed();
  };

  private cancelPress() {
    clearTimeout(this.holdTimer);
    this.press = undefined;
    this.release = undefined;
    this.pushToTalk = false;
  }

  private canTalkThroughCall() {
    return this.callActive && (this.mode === "auto-muted" || this.mode === "push-to-talk");
  }

  get holdingToTalk() { return this.pushToTalk; }

  report() {
    return {
      capabilities: {
        hotkey: this.registrar.value ? { ...available, ...(this.recordingId && this.registeredHotkey === null && { recordingId: this.recordingId }) } : unavailable(this.registrar.reason),
        "call-detection": this.callCapability,
      },
      reportedAtHostUs: this.clock(), registeredHotkey: this.registeredHotkey, hotkeyError: this.hotkeyError,
      callActive: this.callActive, pushToTalk: this.pushToTalk,
      pushToTalkPressedAtHostUs: this.pushToTalk ? this.press : undefined,
      pushToTalkReleasedAtHostUs: this.release,
    };
  }

  stop() {
    this.desired = undefined;
    this.registrar.value?.watchVoiceOver?.();
    clearInterval(this.poll);
    this.registrar.value?.unregister();
    this.cancelPress();
  }
}

export function macVoiceHardware(directory: string, listenerPid: () => number, toggle: () => void, changed: () => void) {
  const require = createRequire(join(directory, "voice-hardware.cjs"));
  function load<T>(name: string): Binding<T> {
    try { return { value: require(join(directory, name + ".node")) as T }; }
    catch { return { reason: `The desktop app could not load ${name}.` }; }
  }
  const [major, minor] = process.getSystemVersion().split(".").map(Number);
  const supported = major! > 14 || (major === 14 && minor! >= 2);
  return new VoiceHardware(load<Registrar>("voice-hotkey"), supported ? load<InputActivity>("mic-activity")
    : { reason: "Call detection requires macOS 14.2 or later." }, listenerPid, toggle, changed, loadVoiceHostClock(join(directory, "state-lock.node")));
}
