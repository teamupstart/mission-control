import { createRequire } from "node:module";
import { join } from "node:path";
import { loadVoiceHostClock } from "../server/voice/native-clock.ts";
import { formatChord } from "../shared/keyboard-chords.ts";
import { VOICE_LIMITS, type VoiceCapability, type VoiceHotkeyError, type VoiceMode } from "../shared/voice.ts";

type Edge = (down: boolean, hostUs: number) => void;
interface Registrar {
  register(chord: string, onEdge: Edge): void;
  unregister(): void;
}
interface InputActivity { running(listenerPid: number): boolean }
type Binding<T> = { value: T; reason?: never } | { value?: never; reason: string };

const available = { available: true, reason: null };
const unavailable = (reason: string): VoiceCapability => ({ available: false, reason });
const reasonOf = (error: unknown) => String(error instanceof Error ? error.message : error).slice(0, VOICE_LIMITS.reasonChars);

export class VoiceHardware {
  private desired?: string | null;
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
    this.callCapability = activity.value ? available : unavailable(activity.reason);
  }

  update(chord: string | null, mode: VoiceMode) {
    this.mode = mode;
    if (mode !== "auto-muted" && mode !== "push-to-talk" && this.pushToTalk) this.cancelPress();
    if (this.activity.value && !this.poll) {
      this.sample();
      this.poll = setInterval(() => this.sample(), 500);
    }
    if (this.desired === chord) return;
    this.desired = chord;
    if (!this.registrar.value) return;
    try {
      if (chord !== this.registeredHotkey) {
        if (chord) this.registrar.value.register(chord, this.edge);
        else this.registrar.value.unregister();
        this.cancelPress();
        this.registeredHotkey = chord;
      }
      this.hotkeyError = null;
    } catch (error) {
      const reason = `macOS refused ${formatChord(chord ?? "")}: ${reasonOf(error)}`;
      this.hotkeyError = { reason: reason.slice(0, VOICE_LIMITS.reasonChars), chordInForce: this.registeredHotkey };
    }
  }

  private sample() {
    if (!this.activity.value) return;
    let active = false;
    let capability: VoiceCapability = available;
    try { active = this.activity.value.running(this.listenerPid()); }
    catch (error) { capability = unavailable(reasonOf(error)); }
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
      if (this.mode === "auto-muted" && this.callActive) {
        this.holdTimer = setTimeout(() => {
          if (this.mode !== "auto-muted" || !this.callActive) return;
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

  report() {
    return {
      capabilities: {
        hotkey: this.registrar.value ? available : unavailable(this.registrar.reason),
        "call-detection": this.callCapability,
      },
      reportedAtHostUs: this.clock(), registeredHotkey: this.registeredHotkey, hotkeyError: this.hotkeyError,
      callActive: this.callActive, pushToTalk: this.pushToTalk,
      pushToTalkPressedAtHostUs: this.pushToTalk ? this.press : undefined,
      pushToTalkReleasedAtHostUs: this.release,
    };
  }

  stop() {
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
