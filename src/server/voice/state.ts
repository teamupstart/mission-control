import { randomUUID } from "node:crypto";
import type { FeatureFlagId } from "@shared/feature-flags.ts";
import type { VoiceMicrophoneReading } from "@shared/voice-models.ts";
import {
  knownVoiceCapabilities,
  VOICE_FLAG,
  VOICE_MODEL_STATE_NONE,
  VOICE_HELLO_LAPSE_MS,
  VOICE_LISTENER_PROTOCOL_MAJOR,
  VOICE_LISTENER_PROTOCOL_VERSION,
  VOICE_REQUIRED_FLAGS,
  VOICE_SHELL_REPORT_LAPSE_MS,
  voiceMode,
  voiceCaptures,
  type VoiceListenerDirective,
  voiceProtocolMajor,
  voiceStateOff,
  voiceUnavailableReasons,
  type VoiceCapabilities,
  type VoiceConfig,
  type VoiceInputDevice,
  type VoiceListenerHello,
  type VoiceModelState,
  type VoiceShellReport,
  type VoiceState,
} from "@shared/voice.ts";
import type { SpokenName } from "@shared/voice-names.ts";
import { featureEnabled, onFeatureFlagsChanged } from "../feature-flags/index.ts";
import { getVoiceConfig, onVoiceConfigChanged } from "./config.ts";
import { voiceModelManager, type VoiceModelManager } from "./models.ts";

/** What the store reads. The defaults are the daemon's; a test hands in its own. */
export interface VoiceStateDeps {
  now(): number;
  enabled(id: FeatureFlagId): boolean;
  config(): VoiceConfig;
  /** The speech model's state (contract H's manager). Absent, the model reads as nothing known. */
  model?(): VoiceModelState;
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
  /**
   * The last microphone permission each source reported, kept past its lapse: whether macOS
   * allows the microphone does not change because a listener stopped, and the Setup row reads it.
   * See `microphoneReading` for how a lapsed denial gives way.
   */
  private microphone: Partial<Record<VoiceMicrophoneReading["source"], { at: number; reading: VoiceMicrophoneReading }>> = {};
  private readonly listeners = new Set<(state: VoiceState) => void>();
  private lastDirective?: VoiceListenerDirective;
  private timer: unknown = null;
  /** Where the roster comes from: the daemon's name registry, once it is wired. */
  private rosterSource: (() => readonly SpokenName[]) | null = null;

  constructor(private readonly deps: VoiceStateDeps) {}

  /** A fresh revision for each transition, even a mute/unmute between two GETs. */
  directive(state = this.state()): VoiceListenerDirective {
    const capture = voiceCaptures(state.mode);
    const roster = state.roster.map((entry) => entry.name);
    const inputDevice = this.deps.config().inputDevice;
    const last = this.lastDirective;
    if (!last || last.capture !== capture || last.inputDevice !== inputDevice ||
      last.roster.length !== roster.length || roster.some((name, i) => name !== last.roster[i])) {
      const next = { capture, inputDevice, roster, pauseMs: null, revision: randomUUID() };
      this.lastDirective = next;
      return next;
    }
    return last;
  }

  /**
   * Read the roster from `source` (`wireVoiceNameEvents` passes the name registry), or from
   * nowhere with null, which reads as an empty roster.
   */
  useRoster(source: (() => readonly SpokenName[]) | null): void {
    this.rosterSource = source;
  }

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
    // `listener` is the daemon's own reading and nobody else's: a shell's claim about it is
    // dropped, or a report could say a listener runs while `reasons` says none has said hello.
    // It is present for a live hello, or for a hello the daemon refused, which is how the state
    // says why a listener that is running cannot be heard; otherwise it is absent.
    delete capabilities.listener;
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
      model: this.deps.model?.() ?? { ...VOICE_MODEL_STATE_NONE },
      roster: [...(this.rosterSource?.() ?? [])],
    };
  }

  /**
   * The microphone permission the `voice-microphone` Setup row reports. A live denial from either
   * source wins, as it does for the `microphone` reason. Otherwise the newest reading counts, so
   * a denial that has lapsed gives way to a newer grant from the other source (the app was
   * allowed in System Settings and quit, then a listener said granted), while a lapsed denial
   * with nothing newer still stands. Null until one of them has said anything.
   */
  microphoneReading(): VoiceMicrophoneReading | null {
    const now = this.deps.now();
    const lapse: Record<VoiceMicrophoneReading["source"], number> = {
      listener: VOICE_HELLO_LAPSE_MS,
      shell: VOICE_SHELL_REPORT_LAPSE_MS,
    };
    const readings = Object.values(this.microphone).filter((entry) => entry !== undefined);
    const liveDenial = readings.find((entry) =>
      entry.reading.permission === "denied" && now - entry.at < lapse[entry.reading.source]);
    if (liveDenial) return { ...liveDenial.reading };
    const newest = readings.sort((a, b) => b.at - a.at)[0];
    return newest ? { ...newest.reading } : null;
  }

  /** The input devices the live listener listed, or null with no live hello. */
  listenerDevices(): VoiceInputDevice[] | null {
    const now = this.deps.now();
    if (!this.hello || now - this.hello.at >= VOICE_HELLO_LAPSE_MS) return null;
    return this.hello.hello.devices.map((device) => ({ ...device }));
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
    this.microphone.listener = { at, reading: { permission: hello.microphone, source: "listener" } };
    this.publish();
    return { ok: true, protocol: VOICE_LISTENER_PROTOCOL_VERSION };
  }

  /** Take the shell's report. The latest one wins whole. */
  acceptShellReport(report: VoiceShellReport): void {
    const at = this.deps.now();
    this.report = { at, report };
    if (report.microphone) this.microphone.shell = { at, reading: { permission: report.microphone, source: "shell" } };
    this.publish();
  }

  /** Recompute and tell every subscriber, then arm the timer for the next lapse. */
  publish(): VoiceState {
    const state = this.state();
    if (this.lastDirective) this.directive(state);
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
    this.lastDirective = undefined;
    this.hello = null;
    this.refused = null;
    this.report = null;
    this.microphone = {};
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
  model: () => voiceModelManager.state(),
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
  models: VoiceModelManager = voiceModelManager,
): () => void {
  const stopStore = store.onChange(emit);
  const stopModels = models.onChange(() => { store.publish(); });
  const stopFlags = onFeatureFlagsChanged(() => { models.sync(); store.publish(); });
  const stopConfig = onVoiceConfigChanged(() => { models.sync(); store.publish(); });
  models.sync();
  store.publish();
  return () => {
    stopStore();
    stopModels();
    stopFlags();
    stopConfig();
    store.reset();
    void models.stop();
  };
}
