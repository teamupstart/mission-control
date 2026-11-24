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
  VoiceListenerIdSchema,
  VOICE_REQUIRED_FLAGS,
  VOICE_SHELL_REPORT_LAPSE_MS,
  voiceMode,
  voiceCaptures,
  type VoiceListenerDirective,
  voiceProtocolMajor,
  voiceStateOff,
  voiceUnavailableReasons,
  type VoiceBackend,
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
import { voiceHostTimeUs } from "./host-clock.ts";
import { voiceModelManager, type VoiceModelManager } from "./models.ts";

/** What the store reads. The defaults are the daemon's; a test hands in its own. */
export interface VoiceStateDeps {
  now(): number;
  hostNowUs?(): number;
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
  | { ok: false; error: "unsupported_protocol" | "listener_in_use" | "invalid_listener_id" | "backend_not_selected"; reason: string; protocol: string };

/**
 * The daemon's voice state (contract B): computed from the flags, the voice config, the latest
 * listener hello and the latest shell report, and published to whoever subscribes.
 *
 * Nothing here is stored. A hello counts for `VOICE_HELLO_LAPSE_MS` and a shell report for
 * `VOICE_SHELL_REPORT_LAPSE_MS`; a timer set at the next lapse publishes the change a lapse
 * makes, so a listener that stops sending turns the mode to `unavailable` with no request.
 */
export class VoiceStateStore {
  private hello: { at: number; ownerId: string | null; hello: VoiceListenerHello } | null = null;
  /** The latest hello refused for its protocol version, which the `listener` capability names. */
  private refused: { at: number; reason: string } | null = null;
  private report: { at: number; keyChangedHostUs: number | null; report: VoiceShellReport } | null = null;
  private lastReportHostUs = -1;
  private lastPhysicalKeyHostUs = -1;
  /**
   * The last microphone permission each source reported, kept past its lapse: whether macOS
   * allows the microphone does not change because a listener stopped, and the Setup row reads it.
   * See `microphoneReading` for how a lapsed denial gives way.
   */
  private microphone: Partial<Record<VoiceMicrophoneReading["source"], { at: number; reading: VoiceMicrophoneReading }>> = {};
  private readonly listeners = new Set<(state: VoiceState) => void>();
  private lastDirective?: { directive: VoiceListenerDirective; recipients: string; mode: VoiceState["mode"]; granted: boolean; press: number | null };
  private releases = new Map<string, { pressedAtUs: number; at: number }>();
  private latestRelease?: string;
  private timer: unknown = null;
  /** Where the roster comes from: the daemon's name registry, once it is wired. */
  private rosterSource: (() => readonly SpokenName[]) | null = null;

  constructor(private readonly deps: VoiceStateDeps) {}

  private backendSelected(backend: VoiceBackend): boolean {
    const configured = this.deps.config().backend;
    return configured === "auto" || configured === backend;
  }

  private liveHello() {
    return this.hello && this.deps.now() - this.hello.at < VOICE_HELLO_LAPSE_MS ? this.hello : null;
  }

  ownsCapture(id: string | undefined): boolean {
    return id !== undefined && this.liveHello()?.ownerId === id;
  }

  /** A fresh revision for each transition, even a mute/unmute between two GETs. */
  directive(state = this.state()): VoiceListenerDirective {
    const granted = this.liveHello()?.hello.microphone === "granted";
    const capture = voiceCaptures(state.mode) && granted;
    // Only names travel to the recognizer. Also bind the revision to the destinations
    // those names address, including a new session or run for the same resident.
    const recipients = JSON.stringify(state.roster.map(({ name, key, taskId, sessionId }) => [name, key, taskId, sessionId]));
    const inputDevice = this.deps.config().inputDevice;
    const press = state.mode === "push-to-talk" ? this.report?.keyChangedHostUs ?? null : null;
    const last = this.lastDirective;
    if (last && last.mode === state.mode && last.granted === granted && last.directive.inputDevice === inputDevice &&
      last.recipients === recipients && last.press === press) return last.directive;
    const directive = { capture, inputDevice, roster: state.roster.map(entry => entry.name), pauseMs: null, revision: randomUUID() };
    // Only successive key presses and releases share pending delivery rights.
    const keyTransition = ((last?.mode === "auto-muted" || last?.mode === "push-to-talk") && state.mode === "push-to-talk") ||
      (last?.mode === "push-to-talk" && state.mode === "auto-muted");
    if (!keyTransition || last?.granted !== granted || last.directive.inputDevice !== inputDevice ||
        last.recipients !== recipients) this.releases.clear();
    this.latestRelease = undefined;
    this.lastDirective = { directive, recipients, mode: state.mode, granted, press };
    return directive;
  }

  drainingRevisions() { return [...this.releases.keys()]; }

  releasedCapture(revision = this.latestRelease) {
    if (!revision) return undefined;
    const bounds = this.releases.get(revision);
    return bounds && { revision, ...bounds };
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
    const hello = this.liveHello()?.hello ?? null;
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

  routingState() {
    const { mode, roster } = this.state();
    const reported = this.liveHello()?.hello.backend ?? null;
    const backend = reported && this.backendSelected(reported) ? reported : null;
    return { mode, roster, backend };
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
    return this.liveHello()?.hello.devices.map((device) => ({ ...device })) ?? null;
  }

  /**
   * A granted listener can replace a helper still waiting for access. Once granted, only
   * that process can renew its lease until it reports denial or its heartbeat lapses.
   */
  acceptHello(id: string | undefined, hello: VoiceListenerHello): VoiceHelloResult {
    const at = this.deps.now();
    const live = this.liveHello();
    const ownerId = live?.ownerId;
    const protocol = VOICE_LISTENER_PROTOCOL_VERSION;
    const major = voiceProtocolMajor(hello.version);
    if (major !== VOICE_LISTENER_PROTOCOL_MAJOR) {
      const reason = `The listener speaks protocol ${hello.version}, and this Mission Control speaks ${VOICE_LISTENER_PROTOCOL_VERSION}. Update whichever is older.`;
      if (!ownerId || ownerId === id) {
        this.hello = null;
        this.refused = { at, reason };
        this.publish();
      }
      return { ok: false, error: "unsupported_protocol", reason, protocol };
    }
    if (!id || !VoiceListenerIdSchema.safeParse(id).success) {
      return { ok: false, error: "invalid_listener_id", reason: "Send a UUID for this listener process.", protocol };
    }
    if (!this.backendSelected(hello.backend)) {
      return { ok: false, error: "backend_not_selected", reason: "A different voice backend is selected.", protocol };
    }
    const takesOver = hello.microphone === "granted" && live?.hello.microphone !== "granted";
    if (ownerId && ownerId !== id && !takesOver) {
      return { ok: false, error: "listener_in_use", reason: "Another voice listener is active.", protocol };
    }
    // A denied helper exits immediately. Keep its permission reading but release its capture.
    const nextOwnerId = hello.microphone === "denied" ? null : id;
    if (!ownerId || ownerId !== nextOwnerId || live?.hello.backend !== hello.backend) {
      this.lastDirective = undefined;
      this.releases.clear();
      this.latestRelease = undefined;
    }
    this.hello = { at, ownerId: nextOwnerId, hello };
    this.refused = null;
    this.microphone.listener = { at, reading: { permission: hello.microphone, source: "listener" } };
    this.publish();
    return { ok: true, protocol: VOICE_LISTENER_PROTOCOL_VERSION };
  }

  /** Apply dated key events in capture order, independently of heartbeat or request arrival time. */
  acceptShellReport(report: VoiceShellReport): void {
    const at = this.deps.now();
    const order = report.reportedAtHostUs;
    if (this.lastReportHostUs >= 0 && (order === undefined || order <= this.lastReportHostUs)) return;
    if (order !== undefined) {
      if (order > (this.deps.hostNowUs ?? voiceHostTimeUs)()) return;
      this.lastReportHostUs = order;
    }
    // Apply a missed lapse before a new snapshot can restore the previous mode.
    // This revokes its held and released revisions just as the timer would.
    const expired = this.report && at - this.report.at >= VOICE_SHELL_REPORT_LAPSE_MS;
    if (expired) this.directive();
    const pushToTalk = report.pushToTalk && order !== undefined;
    const lastChange = this.report?.keyChangedHostUs ?? null;
    const heldSince = this.report?.report.pushToTalk && !expired ? lastChange : null;
    const stamp = pushToTalk ? report.pushToTalkPressedAtHostUs : report.pushToTalkReleasedAtHostUs;
    const eventAt = stamp !== undefined && order !== undefined && stamp <= order ? stamp : undefined;
    const latestKey = Math.max(lastChange ?? -1, this.lastPhysicalKeyHostUs);
    const staleKey = eventAt !== undefined && (eventAt < latestKey ||
      (eventAt === latestKey && pushToTalk && !this.report?.report.pushToTalk));
    // Snapshot order was already checked. A recovered old key event cannot undo
    // a newer transition, but the call, permission and lease readings are fresh.
    // A snapshot can date a hold after the physical key is already up. Only a
    // known physical event proves that an earlier key-up belongs to an old hold.
    const ambiguousRelease = staleKey && !pushToTalk && heldSince !== null && eventAt > this.lastPhysicalKeyHostUs;
    const down = staleKey ? heldSince !== null && !ambiguousRelease : pushToTalk;
    const held = !down && heldSince !== null && this.state().mode === "push-to-talk"
      ? this.directive() : null;
    let keyChangedHostUs = lastChange;
    if (!staleKey && eventAt !== undefined) keyChangedHostUs = eventAt;
    else if (down !== (heldSince !== null)) keyChangedHostUs = order ?? null;
    if (eventAt !== undefined && (!staleKey || ambiguousRelease)) this.lastPhysicalKeyHostUs = eventAt;
    this.report = { at, keyChangedHostUs, report: { ...report, pushToTalk: down } };
    if (report.microphone) this.microphone.shell = { at, reading: { permission: report.microphone, source: "shell" } };
    if (held?.capture && !staleKey && heldSince !== null && eventAt !== undefined && this.state().mode === "auto-muted") {
      this.directive();
      // Keep the wire header and drain backlog bounded even if a client never posts.
      if (this.releases.size >= 8) this.releases.delete(this.releases.keys().next().value!);
      // Only the wire cutoff rounds down. Event ordering keeps the full host timestamp.
      this.releases.set(held.revision, { pressedAtUs: heldSince, at: Math.floor(eventAt / 1000) });
      this.latestRelease = held.revision;
    }
    this.publish();
  }

  /** Recompute and tell every subscriber, then arm the timer for the next lapse. */
  publish(): VoiceState {
    if (this.hello && !this.backendSelected(this.hello.hello.backend)) {
      this.hello = null;
      this.lastDirective = undefined;
    }
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
    this.lastReportHostUs = -1;
    this.lastPhysicalKeyHostUs = -1;
    this.releases.clear();
    this.latestRelease = undefined;
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
  now: () => performance.now(),
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
