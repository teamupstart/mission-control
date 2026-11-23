import type { FeatureFlagId } from "@shared/feature-flags.ts";
import {
  knownVoiceCapabilities,
  VOICE_FLAG,
  VOICE_HELLO_LAPSE_MS,
  VOICE_LISTENER_PROTOCOL_MAJOR,
  VOICE_LISTENER_PROTOCOL_VERSION,
  VOICE_REQUIRED_FLAGS,
  VOICE_SHELL_REPORT_LAPSE_MS,
  voiceMode,
  voiceProtocolMajor,
  voiceStateOff,
  voiceUnavailableReasons,
  type VoiceCapabilities,
  type VoiceConfig,
  type VoiceListenerHello,
  type VoiceShellReport,
  type VoiceState,
} from "@shared/voice.ts";
import { featureEnabled, onFeatureFlagsChanged } from "../feature-flags/index.ts";
import { getVoiceConfig, onVoiceConfigChanged } from "./config.ts";

/** What the store reads. The defaults are the daemon's; a test hands in its own. */
export interface VoiceStateDeps {
  now(): number;
  enabled(id: FeatureFlagId): boolean;
  config(): VoiceConfig;
  /** Schedules the recompute that publishes a lapse. Unref'd, so it never holds the process. */
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

export type VoiceHelloResult =
  | { ok: true; protocol: string }
  | { ok: false; reason: string; protocol: string };

/**
 * The daemon's voice state (contract B): computed from the flags, the voice config, the latest
 * listener hello and the latest shell report, and published to whoever subscribes.
 *
 * Nothing here is stored. A hello counts for `VOICE_HELLO_LAPSE_MS` and a shell report for
 * `VOICE_SHELL_REPORT_LAPSE_MS`; a timer set at the next lapse publishes the change a lapse
 * makes, so a listener that stops sending turns the mode to `unavailable` with no request.
 */
export class VoiceStateStore {
  private hello: { at: number; hello: VoiceListenerHello } | null = null;
  /** The latest hello refused for its protocol version, which the `listener` capability names. */
  private refused: { at: number; reason: string } | null = null;
  private report: { at: number; report: VoiceShellReport } | null = null;
  private readonly listeners = new Set<(state: VoiceState) => void>();
  private timer: unknown = null;

  constructor(private readonly deps: VoiceStateDeps) {}

  /** The state now. Lapsed readings are dropped here, so a read never returns a stale mode. */
  state(): VoiceState {
    if (!this.deps.enabled(VOICE_FLAG)) return voiceStateOff();
    const now = this.deps.now();
    const config = this.deps.config();
    const hello = this.hello && now - this.hello.at < VOICE_HELLO_LAPSE_MS ? this.hello.hello : null;
    const refused = this.refused && now - this.refused.at < VOICE_HELLO_LAPSE_MS ? this.refused : null;
    const report = this.report && now - this.report.at < VOICE_SHELL_REPORT_LAPSE_MS ? this.report.report : null;
    const reasons = voiceUnavailableReasons({
      requiredFlagsOn: VOICE_REQUIRED_FLAGS.every((id) => this.deps.enabled(id)),
      hello,
      shellMicrophone: report?.microphone ?? null,
    });
    const capabilities: VoiceCapabilities = report ? knownVoiceCapabilities(report.capabilities) : {};
    // `listener` is the daemon's own reading while it has one: a live hello, or a hello it
    // refused, which is how the state says why a listener that is running cannot be heard.
    if (hello) capabilities.listener = { available: true, reason: null };
    else if (refused) capabilities.listener = { available: false, reason: refused.reason };
    return {
      mode: voiceMode({
        enabled: true,
        reasons,
        muted: config.muted,
        callActive: report?.callActive ?? false,
        autoMuteDuringCalls: config.autoMuteDuringCalls,
        pushToTalk: report?.pushToTalk ?? false,
      }),
      reasons,
      capabilities,
      hotkeyError: report?.hotkeyError ?? null,
      model: { status: "missing" },
      roster: [],
    };
  }

  /**
   * Take a listener's hello. One naming a protocol major this daemon does not speak is refused,
   * and replaces any earlier hello: the listener that is running now is the one that cannot be
   * heard, and the state says why until the refusal lapses.
   */
  acceptHello(hello: VoiceListenerHello): VoiceHelloResult {
    const at = this.deps.now();
    const major = voiceProtocolMajor(hello.version);
    if (major !== VOICE_LISTENER_PROTOCOL_MAJOR) {
      const reason = `The listener speaks protocol ${hello.version}, and this Mission Control speaks ${VOICE_LISTENER_PROTOCOL_VERSION}. Update whichever is older.`;
      this.hello = null;
      this.refused = { at, reason };
      this.publish();
      return { ok: false, reason, protocol: VOICE_LISTENER_PROTOCOL_VERSION };
    }
    this.hello = { at, hello };
    this.refused = null;
    this.publish();
    return { ok: true, protocol: VOICE_LISTENER_PROTOCOL_VERSION };
  }

  /** Take the shell's report. The latest one wins whole. */
  acceptShellReport(report: VoiceShellReport): void {
    this.report = { at: this.deps.now(), report };
    this.publish();
  }

  /** Recompute and tell every subscriber, then arm the timer for the next lapse. */
  publish(): VoiceState {
    const state = this.state();
    for (const listener of Array.from(this.listeners)) {
      try { listener(state); }
      catch (error) { console.warn("[voice] state listener failed:", error); }
    }
    this.arm();
    return state;
  }

  onChange(listener: (state: VoiceState) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Drop every reading and timer. For a test's teardown and the daemon's shutdown. */
  reset(): void {
    this.hello = null;
    this.refused = null;
    this.report = null;
    this.disarm();
  }

  private arm(): void {
    this.disarm();
    if (!this.deps.enabled(VOICE_FLAG)) return;
    const now = this.deps.now();
    const lapses = [
      this.hello ? this.hello.at + VOICE_HELLO_LAPSE_MS : null,
      this.refused ? this.refused.at + VOICE_HELLO_LAPSE_MS : null,
      this.report ? this.report.at + VOICE_SHELL_REPORT_LAPSE_MS : null,
    ].filter((at): at is number => at !== null && at > now);
    if (lapses.length === 0) return;
    const wait = Math.min(...lapses) - now;
    const set = this.deps.setTimer ?? ((fn: () => void, ms: number) => {
      const handle = setTimeout(fn, ms);
      handle.unref?.();
      return handle;
    });
    this.timer = set(() => {
      this.timer = null;
      this.publish();
    }, wait);
  }

  private disarm(): void {
    if (this.timer === null) return;
    (this.deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>)))(this.timer);
    this.timer = null;
  }
}

/** The daemon's one store. Routes, the registry's snapshot and the event wiring read this. */
export const voiceStateStore = new VoiceStateStore({
  now: () => Date.now(),
  enabled: featureEnabled,
  config: getVoiceConfig,
});

/**
 * The one bridge from the voice state to open windows, wired once at daemon start: any flag
 * change or config write recomputes the state, and every recompute reaches `emit`. The emitter
 * drops a frame that restates the last one, so a change to an unrelated flag sends nothing, and
 * switching `voice` off sends one `off` frame, which is how the shell learns voice is off.
 *
 * Returns the unsubscribe the daemon calls at shutdown.
 */
export function wireVoiceStateEvents(
  emit: (state: VoiceState) => void,
  store: VoiceStateStore = voiceStateStore,
): () => void {
  const stopStore = store.onChange(emit);
  const stopFlags = onFeatureFlagsChanged(() => { store.publish(); });
  const stopConfig = onVoiceConfigChanged(() => { store.publish(); });
  store.publish();
  return () => {
    stopStore();
    stopFlags();
    stopConfig();
    store.reset();
  };
}
