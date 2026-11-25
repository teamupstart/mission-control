import { dirname, join } from "node:path";
import { stateDir } from "../../shared/harness-runtime.mjs";
import { askAloudPossible, resolveSpeechVoice, type VoiceSpeechCatalog } from "@shared/voice-speech.ts";
import { VoiceSpeechManager, type VoiceSynthesizer } from "./speech.ts";
import { CaptureGrants } from "./capture-grants.ts";
import { voiceProcessBirth } from "./process-birth.ts";
import { watchCaptureProcess } from "./capture-process.ts";
import { SpeechHolds } from "./speech-holds.ts";
import { randomInt, randomUUID } from "node:crypto";
import type { FeatureFlagId } from "@shared/feature-flags.ts";
import { VOICE_SPEECH_NEURAL_VOICES, type VoiceMicrophoneReading } from "@shared/voice-models.ts";
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
  transcriptTail, type TranscriptSample,
  type VoiceConfig,
  type VoiceInputDevice,
  type VoiceListenerHello,
  type VoiceModelState,
  type VoiceShellReport,
  type VoiceState,
} from "@shared/voice.ts";
import type { SpokenName } from "@shared/voice-names.ts";
import { featureEnabled, onFeatureFlagsChanged } from "../feature-flags/index.ts";
import { getVoiceConfig, onVoiceConfigChanged, setVoiceConfig } from "./config.ts";
import { voiceHostTimeUs } from "./host-clock.ts";
import { NeuralSynthesizer } from "./synthesizer.ts";
import { speechModelManager, voiceModelManager, type VoiceModelManager } from "./models.ts";

/** What the store reads. The defaults are the daemon's; a test hands in its own. */
export interface VoiceStateDeps {
  now(): number;
  hostNowUs?(): number;
  speechDirectory?: string;
  wallNow?(): number;
  speechBackend?: { neural(): VoiceSpeechCatalog["neural"]; model(): VoiceModelState; synthesizer: VoiceSynthesizer };
  enabled(id: FeatureFlagId): boolean;
  config(): VoiceConfig;
  saveHotkey?(chord: string): void;
  /** The speech model's state (contract H's manager). Absent, the model reads as nothing known. */
  model?(): VoiceModelState;
  /** Schedules the recompute that publishes a lapse. Unref'd, so it never holds the process. */
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

export type VoiceHelloResult =
  | { ok: true; protocol: string; captureOffset?: number }
  | { ok: false; error: "unsupported_protocol" | "listener_in_use" | "invalid_listener_id" | "backend_not_selected" | "listener_exited" | "launch_unavailable"; reason: string; protocol: string };

/**
 * The daemon's voice state (contract B): computed from the flags, the voice config, the latest
 * listener hello and the latest shell report, and published to whoever subscribes.
 *
 * Readings and shortcut trials are transient. Only a confirmed shortcut edit is saved.
 * Microphone grants outlive a daemon restart. A hello counts for `VOICE_HELLO_LAPSE_MS` and a shell report for
 * `VOICE_SHELL_REPORT_LAPSE_MS`; a timer set at the next lapse publishes the change a lapse
 * makes, so a listener that stops sending turns the mode to `unavailable` with no request.
 */
export class VoiceStateStore {
  private recorder?: string;
  private hotkeyTrial?: { id: string; chord: string; previous: string | null; requestedAtUs: number; expiresAt: number };

  proposeHotkey(chord: string | null) {
    const previous = this.deps.config().hotkey;
    this.hotkeyTrial = chord && chord !== previous ? {
      id: randomUUID(), chord, previous, requestedAtUs: this.hostNowUs(), expiresAt: this.deps.now() + VOICE_SHELL_REPORT_LAPSE_MS,
    } : undefined;
    this.publish();
  }

  beginHotkeyRecording() {
    if (this.recorder || !this.deps.enabled(VOICE_FLAG)) return;
    this.hotkeyTrial = undefined;
    const id = this.recorder = randomUUID();
    this.publish();
    return { id, end: () => {
      if (this.recorder !== id) return;
      this.recorder = undefined;
      this.publish();
    } };
  }
  private readonly source = randomUUID();
  private lastMode: VoiceState["mode"] = "off";
  private modeRevision = 0;
  private hello: { at: number; ownerId: string | null; speechInstance?: string; captureProof?: { pid: number; offset: number }; hello: VoiceListenerHello } | null = null;
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
  private lastDirective?: { issuedAt?: number; holderRevision: string; speechKey: string; directive: VoiceListenerDirective; recipients: string; mode: VoiceState["mode"]; granted: boolean; press: number | null };
  private cancelWindowOpen = false;
  private timingRevision = 0;
  private releases = new Map<string, { issuedAt?: number; pressedAtUs: number; at: number }>();
  private latestRelease?: string;
  // Heartbeat expiry transfers the lease but cannot close a previous owner's microphone.
  private grants?: CaptureGrants;
  private get captureGrants() { return this.grants ??= new CaptureGrants(this.speechDirectory); }
  private timer: unknown = null;
  /** Where the roster comes from: the daemon's name registry, once it is wired. */
  private rosterSource: (() => readonly SpokenName[]) | null = null;

  private manager?: VoiceSpeechManager;
  private muted = false;
  private get speechDirectory() { return this.deps.speechDirectory ?? join(stateDir(), "voice"); }

  /** An authenticated drain request can be the first request after restarting with Voice off. */
  disabledSpeech(): VoiceSpeechManager | undefined {
    if (!this.manager && !new SpeechHolds(this.speechDirectory).hasRecoveryEvidence()) return;
    const manager = this.speech;
    manager.setEnabled(false);
    return manager;
  }

  warmForAsk(): void {
    const state = this.state();
    if (state.speech.voice?.engine === "neural" && askAloudPossible(this.deps.config(), state)) {
      this.deps.speechBackend?.synthesizer.warm();
    }
  }

  get speech(): VoiceSpeechManager {
    return this.manager ??= new VoiceSpeechManager({
      directory: this.speechDirectory,
      now: this.deps.now, wallNow: this.deps.wallNow, setTimer: this.deps.setTimer, clearTimer: this.deps.clearTimer,
      synthesizer: this.deps.speechBackend?.synthesizer,
      target: purpose => {
        const state = this.state();
        const instance = this.liveHello()?.speechInstance;
        if (!instance || !state.speech.voice || (purpose === "ask" && !askAloudPossible(this.deps.config(), state))) return null;
        return { instance, voice: state.speech.voice };
      },
      changed: () => this.publish(),
    });
  }

  constructor(private readonly deps: VoiceStateDeps) {}

  hostNowUs(): number { return (this.deps.hostNowUs ?? voiceHostTimeUs)(); }

  /** Model lookup and hello must agree on which listeners the daemon can admit. */
  backendSelected(backend: VoiceBackend): boolean {
    const configured = this.deps.config().backend;
    return configured === "auto" || configured === backend;
  }

  private liveHello() {
    return this.hello && this.deps.now() - this.hello.at < VOICE_HELLO_LAPSE_MS ? this.hello : null;
  }

  ownsCapture(id: string | undefined): boolean {
    return id !== undefined && this.liveHello()?.ownerId === id;
  }

  private preview?: { grant: string; owner: string; at: number; committed: string; interim: string; onset: number;
    finalOnset: number; phase: TranscriptSample["phase"]; text: string };

  reportTranscript(owner: string | undefined, revision: string | undefined, sample: TranscriptSample) {
    const directive = this.directive();
    if (!owner || !this.ownsCapture(owner) || !directive.capture ||
        this.resolveCaptureRevision(revision, directive) !== directive.revision || !this.deps.config().showTranscript) return false;
    const grant = directive.captureRevision ?? directive.revision;
    const now = this.deps.now();
    const previous = this.preview;
    const preview = previous?.grant === grant && previous.owner === owner ? previous :
      { grant, owner, at: now, committed: "", interim: "", onset: -1, finalOnset: -1, phase: "ready" as TranscriptSample["phase"], text: "" };
    const previousText = previous?.text;
    const previousPhase = previous?.phase;
    if (sample.phase === "ready") {
      preview.phase = "ready";
    } else if (sample.onset <= preview.finalOnset) {
      return true;
    } else if (sample.phase === "words" && sample.final) {
      // The next onset can arrive while the previous phrase's final decode is pending.
      preview.committed = transcriptTail(preview.committed + " " + sample.text);
      preview.finalOnset = sample.onset;
      if (sample.onset >= preview.onset) {
        preview.interim = "";
        preview.onset = sample.onset;
        preview.phase = "words";
      }
    } else if (sample.onset >= preview.onset) {
      if (sample.onset !== preview.onset) preview.interim = "";
      preview.onset = sample.onset;
      if (sample.phase === "words") preview.interim = sample.text;
      preview.phase = preview.interim ? "words" : "audio";
    } else {
      return true;
    }
    preview.text = transcriptTail(preview.committed + " " + preview.interim);
    preview.at = now;
    this.preview = preview;
    if (previousText === preview.text && previousPhase === preview.phase) this.arm();
    else this.publish();
    return true;
  }

  setCancelWindowOpen(open: boolean): void {
    if (this.cancelWindowOpen === open) return;
    this.cancelWindowOpen = open;
    this.publish();
  }

  /** A fresh revision for each transition, even a mute/unmute between two GETs. */
  directive(state = this.state()): VoiceListenerDirective {
    const hello = this.liveHello()?.hello;
    const granted = hello?.microphone === "granted";
    const speechKey = this.manager?.directiveKey ?? "";
    const capture = voiceCaptures(state.mode) && granted && !this.manager?.held;
    // Only names travel to the recognizer. Also bind the revision to the destinations
    // those names address, including a new session or run for the same resident.
    const recipients = JSON.stringify(state.roster.map(({ name, key, taskId, sessionId }) => [name, key, taskId, sessionId]));
    const { inputDevice, endOfSpeechMs: configuredDelay } = this.deps.config();
    const automaticDelay = this.cancelWindowOpen ? 500 : configuredDelay;
    // An automatic timing edit must not interrupt a hold or revoke its pending key-up delivery.
    const endOfSpeechMs = state.mode === "push-to-talk" || state.mode === "auto-muted" ? 800 : automaticDelay;
    const press = state.mode === "push-to-talk" ? this.report?.keyChangedHostUs ?? null : null;
    const last = this.lastDirective;
    const sameCapture = last && last.speechKey === speechKey && last.mode === state.mode && last.granted === granted &&
      last.directive.capture === capture && last.directive.inputDevice === inputDevice && last.recipients === recipients && last.press === press;
    // Protocol 4.0 reopens its microphone on every revision, dropping the unfinished phrase.
    const canUpdateTiming = Number(hello?.version.split(".")[1] ?? 0) >= 1;
    if (sameCapture && (!canUpdateTiming || last.directive.endOfSpeechMs === endOfSpeechMs)) return last.directive;
    // A timing edit wakes pollers but keeps the same authorization for automatic audio already captured.
    const automatic = capture && state.mode === "listening";
    const previousGrant = sameCapture ? last.directive.captureRevision : undefined;
    const captureRevision = automatic ? previousGrant ?? randomUUID() : undefined;
    this.timingRevision = sameCapture ? this.timingRevision + 1 : 0;
    const directive = { capture, speak: null, inputDevice, endOfSpeechMs, roster: state.roster.map(entry => entry.name),
      pauseMs: null, revision: captureRevision ? `${captureRevision}:${this.timingRevision}` : randomUUID(),
      ...(captureRevision && { captureRevision }) };
    // Only successive key presses and releases share pending delivery rights.
    const keyTransition = ((last?.mode === "auto-muted" || last?.mode === "push-to-talk") && state.mode === "push-to-talk") ||
      (last?.mode === "push-to-talk" && state.mode === "auto-muted");
    if (!keyTransition || last?.speechKey !== speechKey || last?.granted !== granted || last.directive.inputDevice !== inputDevice ||
        last.recipients !== recipients) this.releases.clear();
    this.latestRelease = undefined;
    this.lastDirective = { holderRevision: randomUUID(), speechKey, directive, recipients, mode: state.mode, granted, press,
      issuedAt: automatic && sameCapture ? last.issuedAt : undefined };
    return directive;
  }

  /** Only the holder sees the playback command, so its long-poll revision is distinct too. */
  directiveFor(instance?: string, state = this.state()): VoiceListenerDirective {
    const speak = this.manager?.speak(instance);
    const base = this.directive(state);
    return speak && ("stop" in speak || !this.capturePausePending)
      ? { ...base, speak, revision: this.lastDirective!.holderRevision } : base;
  }

  /** Older listeners submit the poll revision. Timing edits share one capture grant until capture is revoked. */
  resolveCaptureRevision(submitted: string | undefined, directive: VoiceListenerDirective): string | undefined {
    const grant = directive.captureRevision;
    if (!submitted || !grant) return submitted;
    if (submitted === grant) return directive.revision;
    const index = Number(submitted.slice(grant.length + 1));
    if (submitted === `${grant}:${index}` && Number.isSafeInteger(index) && index >= 0 && index <= this.timingRevision) {
      return directive.revision;
    }
    return submitted;
  }

  drainingRevisions() { return [...this.releases.keys()]; }

  get capturePausePending() {
    if (!this.captureGrants.load()) return true;
    this.captureGrants.reap();
    return this.captureGrants.entries.size > 0;
  }

  formerOwnerPause(owner: string | undefined): VoiceListenerDirective | undefined {
    const grant = owner && this.captureGrants.load() && this.captureGrants.entries.get(owner);
    if (!grant || this.ownsCapture(owner) || !this.manager?.held) return;
    grant.pauseRevision ??= randomUUID();
    return { capture: false, speak: null, roster: [], inputDevice: "", revision: grant.pauseRevision };
  }

  acknowledgeDirective(owner: string | undefined, revision: string | undefined) {
    if (owner && revision && this.captureGrants.load() && this.captureGrants.entries.get(owner)?.pauseRevision === revision) {
      if (!this.captureGrants.release(owner)) return false;
      if (this.manager?.held) this.publish();
    }
  }

  retireCapture(instance: string) {
    if (this.hello?.speechInstance === instance) {
      this.hello = null;
      this.publish(); // Wake outstanding directive polls to recheck the lease.
    }
    if (!this.captureGrants.load()) return false;
    for (const [owner, grant] of this.captureGrants.entries) {
      if (grant.instance === instance && !this.captureGrants.release(owner)) return false;
    }
    if (this.manager?.held) this.publish();
  }

  directiveServed(owner: string | undefined, directive: VoiceListenerDirective, processHeader?: string) {
    if (!owner) return;
    if (!directive.capture) {
      const grant = this.captureGrants.entries.get(owner);
      if (grant) grant.pauseRevision = directive.revision;
      return;
    }
    if (!this.ownsCapture(owner)) return;
    if (!this.captureGrants.load()) return "unavailable";
    this.captureGrants.reap();
    const grant = this.captureGrants.entries.get(owner);
    const pid = processHeader === undefined ? undefined : Number(processHeader);
    const proof = this.liveHello()?.captureProof;
    if (pid !== proof?.pid) return false;
    const instance = this.liveHello()?.speechInstance;
    // Retirement can be waiting on storage after its signed exit is already durable.
    if (instance) {
      const exited = this.speech.launchExited(instance);
      if (exited === undefined) return "unavailable";
      if (exited) return "exited";
    }
    if (grant && (grant.process?.pid !== pid || grant.instance !== instance)) return false;
    if (grant && (!proof || grant.watch)) {
      grant.pauseRevision = undefined;
    } else {
      let watch: ReturnType<typeof watchCaptureProcess> | undefined;
      try {
        const process = proof && { pid: proof.pid, birth: voiceProcessBirth(proof.pid) };
        if (grant?.process && grant.process.birth !== process?.birth) return false;
        if (proof && process) {
          watch = watchCaptureProcess(join(dirname(this.speechDirectory), "voice-capture.lock"), proof.offset, proof.pid);
          if (voiceProcessBirth(proof.pid) !== process.birth) throw new Error("Capture owner exited during verification.");
        }
        if (!this.captureGrants.issue(owner, { instance, process, watch })) {
          watch?.close();
          return "unavailable";
        }
      } catch { watch?.close(); return false; }
    }
    const last = this.lastDirective;
    if (!last?.directive.capture || last.directive.revision !== directive.revision || last.issuedAt !== undefined) return;
    last.issuedAt = (this.deps.wallNow ?? Date.now)();
    this.manager?.captureGranted(last.issuedAt);
  }

  captureGrantTime(revision: string | undefined): number | undefined {
    if (!revision) return;
    const last = this.lastDirective;
    if (last?.directive.capture && last.directive.revision === revision) return last.issuedAt;
    return this.releases.get(revision)?.issuedAt;
  }

  releasedCapture(revision = this.latestRelease) {
    if (!revision) return undefined;
    const bounds = this.releases.get(revision);
    return bounds && { revision, pressedAtUs: bounds.pressedAtUs, at: bounds.at };
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
    if (!this.deps.enabled(VOICE_FLAG)) {
      this.recorder = undefined;
      this.hotkeyTrial = undefined;
      this.preview = undefined;
      this.lastMode = "off";
      return voiceStateOff();
    }
    const now = this.deps.now();
    const config = this.deps.config();
    if (this.hotkeyTrial && this.hotkeyTrial.previous !== config.hotkey) this.hotkeyTrial = undefined;
    const trial = this.hotkeyTrial;
    const listener = this.liveHello();
    const hello = listener?.hello ?? null;
    const refused = this.refused && now - this.refused.at < VOICE_HELLO_LAPSE_MS ? this.refused : null;
    const report = this.report && now - this.report.at < VOICE_SHELL_REPORT_LAPSE_MS ? this.report.report : null;
    const manager = this.speech;
    const failure = manager.listenerFailure;
    const reasons = voiceUnavailableReasons({
      listenerFailure: !!failure,
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
    if (failure) capabilities.listener = { available: false, reason: failure };
    const output = hello?.speech;
    const model = this.deps.speechBackend?.model() ?? { ...VOICE_MODEL_STATE_NONE };
    const catalog: VoiceSpeechCatalog = {
      neural: output?.audio && model.status === "ready" ? this.deps.speechBackend?.neural() ?? [] : [],
      system: (output?.systemVoices ?? []).filter(v => /^en(?:[-_]|$)/iu.test(v.language))
        .map(({ id, name, quality }) => ({ id, name, detail: quality })),
    };
    const unavailable = failure ?? (!hello ? "No listener is running." : !output ? "This listener cannot play speech."
      : !listener?.speechInstance || !manager.announced.has(listener.speechInstance) ? "this listener was not started by a supervisor"
      : !output.audio && !catalog.system.length ? "This listener cannot play speech." : null);
    const resolved = unavailable ? { reason: unavailable, voice: null } : resolveSpeechVoice(config, catalog);
    capabilities["speech-output"] = { available: !!resolved.voice, reason: resolved.reason };
    const live = manager.live;
    const job = live ? { id: live.id, purpose: live.purpose, state: live.state, cardId: live.cardId } : null;
    const mode = voiceMode({
      enabled: true,
      reasons,
      muted: config.muted,
      callActive: report?.callActive ?? false,
      autoMuteDuringCalls: config.autoMuteDuringCalls,
      pushToTalk: report?.pushToTalk ?? false,
    });
    if (mode !== this.lastMode) {
      this.lastMode = mode;
      this.modeRevision++;
    }
    const preview = this.preview;
    if (preview && (!voiceCaptures(mode) || !config.showTranscript || manager.held ||
        listener?.ownerId !== preview.owner || now - preview.at >= 6000 ||
        preview.grant !== (this.lastDirective?.directive.captureRevision ?? this.lastDirective?.directive.revision))) {
      this.preview = undefined;
    }
    return {
      ...(this.preview && { transcript: { style: config.transcriptStyle, corner: config.transcriptCorner,
        phase: this.preview.phase, text: transcriptTail(this.preview.text, config.transcriptWords) } }),
      planFormsByVoice: config.planFormsByVoice,
      muted: config.muted,
      mode,
      speech: { ...resolved, job, lastAudition: manager.lastAudition, catalog, model },
      modeVersion: { source: this.source, revision: this.modeRevision },
      reasons,
      capabilities,
      configuredHotkey: config.hotkey,
      ...(trial && (now < trial.expiresAt
        ? { pendingHotkey: trial.chord, pendingHotkeyId: trial.id }
        : { expiredHotkey: trial.chord })),
      ...(this.recorder && {
        recordingHotkey: true, recordingHotkeyId: this.recorder,
        ...(report?.registeredHotkey === null && report.capabilities.hotkey?.recordingId === this.recorder && { recordingHotkeyReady: true }),
      }),
      registeredHotkey: report?.registeredHotkey ?? null,
      hotkeyError: report?.hotkeyError ?? null,
      model: this.deps.model?.() ?? { ...VOICE_MODEL_STATE_NONE },
      roster: [...(this.rosterSource?.() ?? [])],
    };
  }

  routingState() {
    const { mode, roster } = this.state();
    const reported = this.liveHello()?.hello.backend ?? null;
    const backend = reported && this.backendSelected(reported) ? reported : null;
    return { mode, roster, backend, reportsSpeechOnset: this.liveHello()?.hello.reportsSpeechOnset === true };
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
  acceptHello(id: string | undefined, hello: VoiceListenerHello, speechInstance?: string, capturePid?: number): VoiceHelloResult {
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
    if (speechInstance) {
      const exited = this.speech.launchExited(speechInstance);
      if (exited === undefined) return { ok: false, error: "launch_unavailable", reason: "The launch record is unavailable.", protocol };
      if (exited) return { ok: false, error: "listener_exited", reason: "The supervisor reported this launch exited.", protocol };
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
    // A daemon-chosen byte binds this lease to a fresh kernel lock. A caller
    // cannot select a byte already locked by an unrelated process.
    const captureProof = capturePid === undefined ? undefined :
      live?.ownerId === id && live.captureProof?.pid === capturePid ? live.captureProof :
      { pid: capturePid, offset: randomInt(1, 2 ** 48 - 1) };
    this.hello = { at, ownerId: nextOwnerId, speechInstance, captureProof, hello };
    this.refused = null;
    this.microphone.listener = { at, reading: { permission: hello.microphone, source: "listener" } };
    this.publish();
    return { ok: true, protocol, ...(captureProof && { captureOffset: captureProof.offset }) };
  }

  /** Apply dated key events in capture order, independently of heartbeat or request arrival time. */
  acceptShellReport(report: VoiceShellReport): void {
    const at = this.deps.now();
    let observedAt = at;
    const order = report.reportedAtHostUs;
    if (this.lastReportHostUs >= 0 && (order === undefined || order <= this.lastReportHostUs)) return;
    if (order !== undefined) {
      const ageMs = (this.hostNowUs() - order) / 1000;
      if (ageMs < 0 || ageMs >= VOICE_SHELL_REPORT_LAPSE_MS) return;
      observedAt -= ageMs;
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
    this.report = { at: observedAt, keyChangedHostUs, report: { ...report, pushToTalk: down } };
    if (report.microphone) this.microphone.shell = { at: observedAt, reading: { permission: report.microphone, source: "shell" } };
    if (held?.capture && !staleKey && heldSince !== null && eventAt !== undefined && this.state().mode === "auto-muted") {
      const issuedAt = this.lastDirective!.issuedAt;
      this.directive();
      // Keep the wire header and drain backlog bounded even if a client never posts.
      if (this.releases.size >= 8) this.releases.delete(this.releases.keys().next().value!);
      // Only the wire cutoff rounds down. Event ordering keeps the full host timestamp.
      this.releases.set(held.revision, { issuedAt, pressedAtUs: heldSince, at: Math.floor(eventAt / 1000) });
      this.latestRelease = held.revision;
    }
    const trial = this.hotkeyTrial;
    if (trial && !this.recorder && order !== undefined && order > trial.requestedAtUs &&
        this.state().pendingHotkey === trial.chord && report.capabilities.hotkey?.available) {
      if (report.hotkeyError?.trialId === trial.id) this.hotkeyTrial = undefined;
      else if (!report.hotkeyError && report.registeredHotkey === trial.chord) {
        this.deps.saveHotkey?.(trial.chord);
        this.hotkeyTrial = undefined;
      }
    }
    this.publish();
  }

  /** Recompute and tell every subscriber, then arm the timer for the next lapse. */
  publish(): VoiceState {
    if (this.hello && !this.backendSelected(this.hello.hello.backend)) {
      this.hello = null;
      this.lastDirective = undefined;
    }
    const enabled = this.deps.enabled(VOICE_FLAG);
    this.manager?.setEnabled(enabled);
    const muted = enabled && this.deps.config().muted;
    const becomingMuted = muted && !this.muted;
    this.muted = muted;
    if (becomingMuted) this.manager?.stopAll();
    else if (enabled && this.report?.report.callActive && this.deps.now() - this.report.at < VOICE_SHELL_REPORT_LAPSE_MS &&
        this.deps.config().autoMuteDuringCalls) this.manager?.stopAll("ask");
    const state = this.state();
    if (this.lastDirective) {
      const directive = this.directive(state);
      if (this.preview && this.preview.grant !== (directive.captureRevision ?? directive.revision)) {
        this.preview = undefined;
        delete state.transcript;
      }
    }
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
    this.preview = undefined;
    this.recorder = undefined;
    this.hotkeyTrial = undefined;
    if (this.manager) this.manager.dispose();
    else this.deps.speechBackend?.synthesizer.stop();
    this.manager = undefined;
    this.muted = false;
    this.lastReportHostUs = -1;
    this.lastPhysicalKeyHostUs = -1;
    this.releases.clear();
    this.latestRelease = undefined;
    this.lastDirective = undefined;
    this.grants?.close();
    this.cancelWindowOpen = false;
    this.grants = undefined;
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
    const waitingForProcess = this.manager?.live?.state === "ready" &&
      (!this.captureGrants.load() || [...this.captureGrants.entries.values()].some(grant => grant.process));
    const lapses = [
      this.preview && this.preview.at + 6000,
      this.hotkeyTrial?.expiresAt,
      waitingForProcess ? now + 100 : null,
      this.hello ? this.hello.at + VOICE_HELLO_LAPSE_MS : null,
      this.refused ? this.refused.at + VOICE_HELLO_LAPSE_MS : null,
      this.report ? this.report.at + VOICE_SHELL_REPORT_LAPSE_MS : null,
    ].filter((at): at is number => at != null && at > now);
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
  saveHotkey: hotkey => { setVoiceConfig({ hotkey }); },
  model: () => voiceModelManager.state(),
  speechBackend: {
    model: () => speechModelManager.state(),
    neural: () => VOICE_SPEECH_NEURAL_VOICES.map(({ id, name, detail }) => ({ id, name, detail })),
    synthesizer: new NeuralSynthesizer(() => speechModelManager.state().directory),
  },
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
  speechModels: VoiceModelManager = speechModelManager,
): () => void {
  const stopStore = store.onChange(emit);
  const stopModels = models.onChange(() => { store.publish(); });
  const stopSpeechModels = speechModels.onChange(() => { store.publish(); });
  const stopFlags = onFeatureFlagsChanged(() => { models.sync(); speechModels.sync(); store.publish(); });
  const stopConfig = onVoiceConfigChanged(() => { models.sync(); store.publish(); });
  models.sync();
  speechModels.sync();
  store.publish();
  return () => {
    stopStore();
    stopModels();
    stopSpeechModels();
    stopFlags();
    stopConfig();
    store.reset();
    void models.stop();
    void speechModels.stop();
  };
}
