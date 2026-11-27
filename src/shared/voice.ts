// Voice addressing (`voice` preview flag): contracts A and B of
// `docs/plans/voice-addressing-for-agents/phased-plan.md`, said once for every side.
//
// Browser-safe: no `node:` import may reach this module. The daemon stores the config and
// computes the state with these schemas and `voiceMode`, the dashboard draws both, the shell
// follows the state, and a listener sends the hello, so none of them can disagree about what a
// field means or which mode a set of facts produces. A phase that needs a new capability id adds it to
// `VOICE_CAPABILITY_IDS` below.

import { SpeechVoiceSchema, SpeechHelloSchema, SpeakDirectiveSchema, type VoiceSpeechState } from "./voice-speech.ts";
import { z } from "zod";
import { ASYNC_INPUT_FLAG, FILED_PLAN_DECISIONS_FLAG } from "./async-input.ts";
import { INBOX_FLAG } from "./inbox.ts";
import type { SpokenName } from "./voice-names.ts";
import { boundedRecord } from "./zod-shapes.ts";
import { SeparatorWordSchema, VOICE_SEPARATOR_DEFAULT } from "./voice-separator.ts";

/** The preview flag for voice addressing. */
export const VOICE_FLAG = "voice" as const;

/**
 * The preview flag for the Always-on first-preview hold: a phrase shows no live words until it
 * holds `VOICE_FIRST_PREVIEW_VOICED_MS` of voiced audio. It changes only what the live preview
 * shows; final decoding, routing and delivery are the same with it on or off.
 */
export const VOICE_FIRST_PREVIEW_HOLD_FLAG = "voice-first-preview-hold" as const;

/**
 * Voiced audio an Always-on phrase must hold before its first live preview, while
 * `VOICE_FIRST_PREVIEW_HOLD_FLAG` is on. 300 ms is the knee the phantom-filler scout measured:
 * most of the false previews gone, for no measured median latency to the first correct preview.
 */
export const VOICE_FIRST_PREVIEW_VOICED_MS = 300;

/**
 * The flags voice depends on. A flag cannot require another, so voice reads as unavailable
 * with the reason `flags` while any of these is off, and the Setup panel's `voice-previews`
 * row offers to turn them on.
 */
export const VOICE_REQUIRED_FLAGS = [ASYNC_INPUT_FLAG, INBOX_FLAG, FILED_PLAN_DECISIONS_FLAG] as const;
export type VoiceRequiredFlag = (typeof VOICE_REQUIRED_FLAGS)[number];

// ---- contract A: the config ----

/** What happens when routing cannot tell who was addressed: show the candidates, or ask aloud. */
export const VOICE_WHEN_UNSURE = ["show", "ask"] as const;
export type VoiceWhenUnsure = (typeof VOICE_WHEN_UNSURE)[number];

/** Who answers the model step's questions when Voice settings names one. Null means automatic. */
export const VOICE_DECISION_PROVIDERS = ["off", "openai", "jev"] as const;
export type VoiceDecisionProvider = (typeof VOICE_DECISION_PROVIDERS)[number];

/** The listener backends behind the one listener protocol (contract I). */
export const VOICE_BACKENDS = ["fluidaudio", "sherpa-onnx"] as const;
export type VoiceBackend = (typeof VOICE_BACKENDS)[number];
/** The configured backend: one of the two, or `auto` to let the platform choose. */
export const VOICE_BACKEND_CHOICES = ["auto", ...VOICE_BACKENDS] as const;
export type VoiceBackendChoice = (typeof VOICE_BACKEND_CHOICES)[number];

export const VOICE_END_OF_SPEECH_MS = [500, 800, 1000, 1500, 2000, 3000, 5000] as const;
const EndOfSpeechMsSchema = z.literal(VOICE_END_OF_SPEECH_MS);

/** The bounds on the cancel window's length, in whole seconds. */
export const VOICE_CANCEL_WINDOW_SECONDS = { min: 1, max: 30 } as const;

/** The input devices every machine offers before a listener lists its own. */
export const VOICE_INPUT_DEVICE_BUILT_IN = "built-in" as const;
export const VOICE_INPUT_DEVICE_SYSTEM_DEFAULT = "system-default" as const;

/** Bounds on the strings the config and the listener carry. */
export const VOICE_LIMITS = {
  chordChars: 64,
  deviceIdChars: 256,
  deviceNameChars: 256,
  devices: 64,
  reasonChars: 500,
  versionChars: 32,
} as const;

const ChordSchema = z.string().trim().min(1).max(VOICE_LIMITS.chordChars);

const CancelWindowSchema = z.object({
  enabled: z.boolean().default(true),
  seconds: z.number().int().min(VOICE_CANCEL_WINDOW_SECONDS.min).max(VOICE_CANCEL_WINDOW_SECONDS.max).default(4),
}).prefault({});

const TranscriptStyle = z.enum(["card", "capsule"]);
const TranscriptCorner = z.enum(["bottom-right", "bottom-left"]);
export const TranscriptSampleSchema = z.discriminatedUnion("phase", [
  z.object({ phase: z.literal("ready") }),
  z.object({ phase: z.literal("audio"), onset: z.int().nonnegative() }),
  z.object({ phase: z.literal("words"), onset: z.int().nonnegative(), text: z.string().trim().min(1).max(4096), final: z.literal(true).optional() }),
]);
export type TranscriptSample = z.infer<typeof TranscriptSampleSchema>;
export const TRANSCRIPT_WORD_LIMIT = 100;
const TranscriptWords = z.int().min(1).max(TRANSCRIPT_WORD_LIMIT);
export function transcriptTail(text: string, limit = TRANSCRIPT_WORD_LIMIT): string {
  return text.trim().split(/\s+/u).slice(-limit).join(" ");
}
const ListeningModeSchema = z.enum(["always-on", "push-to-talk"]);

/**
 * Voice settings, the `voice` app-config entry. Every field contract A names, with its default.
 *
 * Tolerant on read, like the rest of `app_config`: a key an older build never wrote parses to its
 * default, so no migration is owed when a later phase starts reading one. The patch schema below
 * is strict, so a bad write is a 400 rather than a stored default.
 */
export const VoiceConfigSchema = z.object({
  listeningMode: ListeningModeSchema.default("always-on"),
  /** Manual mute in Always-on mode. Operational: a restore leaves it alone. */
  muted: z.boolean().default(false),
  /**
   * Shared system-wide shortcut for manual mute or held capture, or null for none.
   */
  hotkey: ChordSchema.nullable().default("cmd+ctrl+alt+v"),
  autoMuteDuringCalls: z.boolean().default(true),
  showTranscript: z.boolean().default(true),
  transcriptWords: TranscriptWords.default(20),
  transcriptStyle: TranscriptStyle.default("card"),
  transcriptCorner: TranscriptCorner.default("bottom-right"),
  /** How long a routed message waits for "cancel" before it is delivered. */
  cancelWindow: CancelWindowSchema,
  endOfSpeechMs: EndOfSpeechMsSchema.default(2000),
  /** The standalone word that splits one Always-on capture into separate messages. */
  separatorWord: SeparatorWordSchema.default(VOICE_SEPARATOR_DEFAULT).catch(VOICE_SEPARATOR_DEFAULT),
  speech: z.object({ voice: SpeechVoiceSchema.nullable().default(null) }).prefault({}),
  whenUnsure: z.enum(VOICE_WHEN_UNSURE).default("show"),
  /** Whether speech may fill a plan-decision form. Voice stays on elsewhere when this is off. */
  planFormsByVoice: z.boolean().default(true),
  /** `built-in`, `system-default`, or a device id from a listener's hello. */
  inputDevice: z.string().trim().min(1).max(VOICE_LIMITS.deviceIdChars).default(VOICE_INPUT_DEVICE_BUILT_IN),
  /** Null means automatic: the first key present, in the order contract E fixes. */
  decisionProvider: z.enum(VOICE_DECISION_PROVIDERS).nullable().default(null),
  backend: z.enum(VOICE_BACKEND_CHOICES).default("auto"),
});
export type VoiceConfig = z.infer<typeof VoiceConfigSchema>;

export const VOICE_CONFIG_DEFAULTS: VoiceConfig = Object.freeze(VoiceConfigSchema.parse({}));

/**
 * One change to the voice config. Top-level fields replace; `cancelWindow` merges per key, so a
 * switch in one window and a length in another commute.
 */
export const VoiceConfigPatchSchema = z.object({
  listeningMode: ListeningModeSchema,
  muted: z.boolean(),
  hotkey: ChordSchema.nullable(),
  autoMuteDuringCalls: z.boolean(),
  showTranscript: z.boolean(),
  transcriptWords: TranscriptWords,
  transcriptStyle: TranscriptStyle,
  transcriptCorner: TranscriptCorner,
  endOfSpeechMs: EndOfSpeechMsSchema,
  separatorWord: SeparatorWordSchema,
  cancelWindow: z.object({
    enabled: z.boolean(),
    seconds: z.number().int().min(VOICE_CANCEL_WINDOW_SECONDS.min).max(VOICE_CANCEL_WINDOW_SECONDS.max),
  }).partial().strict(),
  speech: z.object({ voice: SpeechVoiceSchema.nullable() }).partial().strict(),
  whenUnsure: z.enum(VOICE_WHEN_UNSURE),
  planFormsByVoice: z.boolean(),
  inputDevice: z.string().trim().min(1).max(VOICE_LIMITS.deviceIdChars),
  decisionProvider: z.enum(VOICE_DECISION_PROVIDERS).nullable(),
  backend: z.enum(VOICE_BACKEND_CHOICES),
}).partial().strict().refine((patch) => Object.keys(patch).length > 0, { message: "empty voice config update" });
export type VoiceConfigPatch = z.infer<typeof VoiceConfigPatchSchema>;

// Allow the existing one-minute delayed reservation to complete within a single edit.
export const VOICE_PROVIDER_EDIT_TIMEOUT_MS = 75_000;
export const VoiceProviderGestureSchema = z.object({ group: z.uuid(), order: z.int().positive() }).strict();
export const VoiceProviderIntentSchema = z.object({
  writer: z.uuid(),
  observedRevision: z.string().min(1).max(80),
  expiresAt: z.int().positive().optional(),
  optOut: z.boolean().optional(),
  edit: z.int().positive().optional(),
  gesture: VoiceProviderGestureSchema.optional(),
  observedIntent: z.string().min(1).max(128).optional(),
  unchangedSince: z.string().min(1).max(80).optional(),
}).strict();
export type VoiceProviderIntent = z.infer<typeof VoiceProviderIntentSchema>;

/** Apply a patch over a config: fields replace, and `cancelWindow` merges per key. */
export function applyVoiceConfigPatch(config: VoiceConfig, patch: VoiceConfigPatch): VoiceConfig {
  return VoiceConfigSchema.parse({
    ...config,
    ...patch,
    speech: { ...config.speech, ...patch.speech },
    cancelWindow: { ...config.cancelWindow, ...patch.cancelWindow },
  });
}

/** `POST /api/voice/mute`. */
export const VoiceMuteRequestSchema = z.union([
  z.object({ muted: z.boolean() }).strict(),
  z.object({ toggle: z.literal(true) }).strict(),
]);

/** Where a routed message's confirmation card appears (Phases 6 and 12). */
export const VOICE_CONFIRMATION_PLACEMENTS = ["pill", "toast", "popover"] as const;
export type VoiceConfirmationPlacement = (typeof VOICE_CONFIRMATION_PLACEMENTS)[number];

/** The in-window indicators Phase 7 draws, each mounted while its id is listed. */
export const VOICE_INDICATOR_IDS = ["status-line", "topbar", "floating", "edge", "composer"] as const;
export type VoiceIndicatorId = (typeof VOICE_INDICATOR_IDS)[number];
/** Revisions are comparable within one daemon. A reconnect snapshot identifies a restart. */
export const VoiceRevisionSchema = z.object({ source: z.string(), revision: z.number().int().nonnegative() });
export type VoiceRevision = z.infer<typeof VoiceRevisionSchema>;
export const VoiceIndicatorSelectionSchema = z.object({
  id: z.enum(VOICE_INDICATOR_IDS),
  enabled: z.boolean(),
}).strict();

/** The bound on `ui.voice.indicators`, far above the five ids that exist. */
export const VOICE_INDICATORS_MAX = 32;

export const VOICE_UI_DEFAULTS = Object.freeze({
  confirmation: "pill" as VoiceConfirmationPlacement,
  indicators: Object.freeze(["status-line"]) as readonly string[],
});

/**
 * `ui.voice`, this dashboard's half of contract A. `confirmation` is `.catch`, like `skin`, so a
 * placement a newer build adds reads as the default after a downgrade. Indicator ids are not
 * validated, for the reason `hiddenDisplayItems` gives: an id a later build retires stays
 * readable and simply mounts nothing.
 */
export const VoiceUiConfigSchema = z.object({
  confirmation: z.enum(VOICE_CONFIRMATION_PLACEMENTS)
    .default(VOICE_UI_DEFAULTS.confirmation)
    .catch(VOICE_UI_DEFAULTS.confirmation),
  indicators: z.array(z.string().min(1).max(64)).max(VOICE_INDICATORS_MAX).default([...VOICE_UI_DEFAULTS.indicators]),
}).prefault({});
export type VoiceUiConfig = z.infer<typeof VoiceUiConfigSchema>;

/** The strict write form: an unknown placement is a 400, never a stored default. */
export const VoiceUiConfigPatchSchema = z.object({
  confirmation: z.enum(VOICE_CONFIRMATION_PLACEMENTS),
  indicators: z.array(z.string().min(1).max(64)).max(VOICE_INDICATORS_MAX),
}).strict();

// ---- contract B: the state ----

export const VOICE_MODES = ["off", "unavailable", "listening", "muted", "auto-muted", "push-to-talk", "waiting-for-key"] as const;
export type VoiceMode = (typeof VOICE_MODES)[number];

export function awaitingVoiceHold(mode: VoiceMode): boolean {
  return mode === "auto-muted" || mode === "waiting-for-key";
}

export function voiceCaptures(mode: VoiceMode): boolean {
  return mode === "listening" || mode === "push-to-talk";
}

/**
 * Whether cards title agents by the names a person says to them: while Always-on listens, and in
 * Push-to-talk between holds as well as during one, since the next hold may address any of them.
 * A hold during an Always-on call auto-mute also reads `push-to-talk`, but only the dedicated mode
 * carries a `pushToTalkSession`: muted, auto-muted (even while that hold is down), unavailable and
 * off keep the ordinary names.
 */
export function voiceCardsShowSpokenNames(state: Pick<VoiceState, "mode" | "pushToTalkSession"> | null | undefined): boolean {
  return state?.mode === "listening" || state?.mode === "waiting-for-key" ||
    (state?.mode === "push-to-talk" && !!state.pushToTalkSession);
}

/**
 * How a session card shows its call sign while voice can hear it (`voiceCardsShowSpokenNames`):
 * `title` in the dedicated Push-to-talk mode, waiting for the shortcut or held, where the call
 * sign replaces the title because the next hold may address any card; `element` while
 * Always-on listens, where the card keeps the session's title and draws the call sign beside it
 * in the operator's `callSignCardStyle`; null otherwise. Resident cards are not affected.
 */
export type VoiceCardCallSignMode = "title" | "element";

export function voiceCardCallSignMode(state: Pick<VoiceState, "mode" | "pushToTalkSession"> | null | undefined): VoiceCardCallSignMode | null {
  if (!voiceCardsShowSpokenNames(state)) return null;
  return state?.mode === "listening" ? "element" : "title";
}

export const VoiceListenerDirectiveSchema = z.object({
  speak: SpeakDirectiveSchema.nullable().default(null),
  capture: z.boolean(),
  roster: z.array(z.string()),
  inputDevice: z.string(),
  endOfSpeechMs: EndOfSpeechMsSchema.optional(),
  /**
   * The Always-on separator word, present only for automatic capture. The daemon splits at it;
   * a listener must not rewrite it into a spoken name when it opens a capture.
   */
  separator: z.string().min(1).optional(),
  /**
   * Voiced milliseconds an Always-on phrase must hold before its first live preview, present only
   * while `VOICE_FIRST_PREVIEW_HOLD_FLAG` is on. A listener that ignores it previews as before.
   */
  firstPreviewVoicedMs: z.number().int().positive().optional(),
  pauseMs: z.number().nullable().optional(),
  captureRevision: z.string().min(1).optional(),
  revision: z.string().min(1),
});
export type VoiceListenerDirective = z.infer<typeof VoiceListenerDirectiveSchema>;

/**
 * Why voice is unavailable, in the order they are reported.
 *
 * - `flags`: a required flag is off;
 * - `listener`: no hello in the last `VOICE_HELLO_LAPSE_MS`;
 * - `model`: the listener's hello says no model is loaded;
 * - `microphone`: a hello or a shell report says access is denied.
 */
export const VOICE_UNAVAILABLE_REASONS = ["flags", "listener", "model", "microphone", "shortcut"] as const;
export type VoiceUnavailableReason = (typeof VOICE_UNAVAILABLE_REASONS)[number];

/** What the shell, or the daemon for `listener`, can say is or is not available. */
export const VOICE_CAPABILITY_IDS = [
  "listener",
  "microphone",
  "hotkey",
  "call-detection",
  "speech-output",
  "tray",
  "floating-windows",
] as const;
export type VoiceCapabilityId = (typeof VOICE_CAPABILITY_IDS)[number];

export const VOICE_SPEECH_STOP_UNCONFIRMED = "speech_stop_unconfirmed";

export interface VoiceCapability {
  available: boolean;
  /** Why it is not available, when it is not; null when it is. */
  reason: string | null;
  /** Daemon-owned reason for a specific recovery action. The reason text is for display. */
  code?: typeof VOICE_SPEECH_STOP_UNCONFIRMED | "speech_playback_unsupported" | "speech_voice_unavailable";
}

/** A capability that was reported. One that was not is absent, which is not the same as false. */
export type VoiceCapabilities = Partial<Record<VoiceCapabilityId, VoiceCapability>>;

/** A failed sample is unavailable until the next poll. Its preference is still editable. */
export const VOICE_CALL_POLL_RETRY = "Retrying microphone check. ";

export const VOICE_MODEL_STATUSES = ["missing", "downloading", "verifying", "ready", "failed"] as const;
export type VoiceModelStatus = (typeof VOICE_MODEL_STATUSES)[number];

/**
 * The speech model on this machine, as the daemon's model manager (contract H) reads it.
 *
 * - `missing`: a file is not on disk, or no model is published for the backend (`revision` null);
 * - `downloading`: Download is running, with `doneBytes` of `totalBytes` and a rate;
 * - `verifying`: every file is on disk at its pinned size and is being hashed again;
 * - `ready`: every file matched its pinned SHA-256 in this daemon's lifetime, at `directory`;
 * - `failed`: a size or digest did not match, or the download failed; `error` says which.
 *
 * Whether a listener has LOADED the model is the hello's `modelLoaded` and the `model` reason,
 * never this.
 */
export interface VoiceModelState {
  status: VoiceModelStatus;
  /** The backend the model is for. Null while voice is off. */
  backend: VoiceBackend | null;
  /** The manifest revision, or null when this build publishes no model for the backend. */
  revision: string | null;
  totalBytes: number;
  /** Bytes downloaded (`downloading`) or hashed (`verifying`) so far. */
  doneBytes: number;
  /** The recent download rate while downloading, or null. */
  bytesPerSecond: number | null;
  /** The verified directory while `ready`, which a listener is given as its model directory. */
  directory: string | null;
  /** Why it `failed`, or why there is nothing to download. */
  error: string | null;
}

/** The model state with nothing known: voice off, or no manager reading yet. */
export const VOICE_MODEL_STATE_NONE: VoiceModelState = Object.freeze({
  status: "missing",
  backend: null,
  revision: null,
  totalBytes: 0,
  doneBytes: 0,
  bytesPerSecond: null,
  directory: null,
  error: null,
});

/** A hotkey the shell could not register, and the chord still in force (null for none). */
export interface VoiceHotkeyError {
  reason: string;
  chordInForce: string | null;
  /** Set only when this refusal came from an attempt to register a proposed shortcut. */
  trialId?: string;
}

/**
 * The one published voice state. The daemon computes it; the dashboard, the shell and a listener
 * follow it.
 */
export interface VoiceState {
  transcript?: { style: VoiceConfig["transcriptStyle"]; corner: VoiceConfig["transcriptCorner"];
    phase: TranscriptSample["phase"]; text: string };
  /** Present only in dedicated push-to-talk. The desktop echoes this generation on each edge. */
  pushToTalkSession?: string;
  /** Saved manual mute for Always-on, including while unavailable. */
  muted?: boolean;
  planFormsByVoice?: boolean;
  speech: VoiceSpeechState;
  mode: VoiceMode;
  /** Orders mode transitions within one daemon across HTTP replies and the event stream.
   * Absent on the off state and on snapshots from older daemons. */
  modeVersion?: VoiceRevision;
  /** Every reason that holds, in `VOICE_UNAVAILABLE_REASONS` order. Empty unless `unavailable`. */
  reasons: VoiceUnavailableReason[];
  /** From the latest shell report, plus the daemon's own reading of `listener`. */
  capabilities: VoiceCapabilities;
  /** The persisted shortcut, observed in the same snapshot as the shell's registration. */
  configuredHotkey: string | null;
  /** A replacement to try while the persisted shortcut remains the fallback. */
  pendingHotkey?: string;
  pendingHotkeyId?: string;
  /** The desktop missed the confirmation deadline for this replacement. */
  expiredHotkey?: string;
  /** A focused Settings recorder is waiting for the desktop to release its reservation. */
  recordingHotkey?: true;
  recordingHotkeyId?: string;
  recordingHotkeyReady?: true;
  /** Shortcut the shell last confirmed it registered, or null without a current confirmation. */
  registeredHotkey: string | null;
  /** From the latest shell report; null with no report. */
  hotkeyError: VoiceHotkeyError | null;
  model: VoiceModelState;
  /**
   * Who can be addressed (contract C): every live resident profile and every task with a call
   * sign, running or not. The daemon's `VoiceNameRegistry` fills it. A change to it alone is
   * published as `voice_roster`, not as a `voice_state` frame; see `canonicalVoiceState`.
   */
  roster: readonly SpokenName[];
}

/** Whether the state says a capability is reported and available. */
export function voiceCapable(state: Pick<VoiceState, "capabilities"> | null | undefined, id: VoiceCapabilityId): boolean {
  return state?.capabilities[id]?.available === true;
}

/** A hello older than this no longer counts: the `listener` reason holds. */
export const VOICE_HELLO_LAPSE_MS = 30_000;
/** How often a listener sends its hello. */
export const VOICE_HELLO_INTERVAL_MS = 10_000;
/** A shell report older than this no longer counts: its capabilities are absent again. */
export const VOICE_SHELL_REPORT_LAPSE_MS = 15_000;
/** Bound a missing physical key-up to the native listener’s two-minute audio buffer. */
export const VOICE_MAX_HOLD_MS = 120_000;

/** What `voiceMode` decides from. */
export interface VoiceModeInputs {
  /** The `voice` flag. */
  enabled: boolean;
  listeningMode?: VoiceConfig["listeningMode"];
  reasons: readonly VoiceUnavailableReason[];
  muted: boolean;
  /** Another app holds the microphone, from a live shell report. */
  callActive: boolean;
  autoMuteDuringCalls: boolean;
  /** The hotkey is held, from a live shell report. */
  pushToTalk: boolean;
}

/**
 * The pure rule for the mode, in order: off when the flag is off; unavailable when a reason
 * holds; then muted; then, during a call with auto-mute on, push-to-talk while the hotkey is held
 * and auto-muted otherwise; else listening.
 */
export function voiceMode(inputs: VoiceModeInputs): VoiceMode {
  if (!inputs.enabled) return "off";
  if (inputs.reasons.length > 0) return "unavailable";
  if (inputs.listeningMode === "push-to-talk") return inputs.pushToTalk ? "push-to-talk" : "waiting-for-key";
  if (inputs.muted) return "muted";
  if (inputs.callActive && inputs.autoMuteDuringCalls) return inputs.pushToTalk ? "push-to-talk" : "auto-muted";
  return "listening";
}

/** What `voiceUnavailableReasons` decides from: only what is live, lapsed readings already dropped. */
export interface VoiceReasonInputs {
  /** Whether each required flag is on. */
  requiredFlagsOn: boolean;
  /** An unresolved playback failure makes even a live listener unavailable. */
  listenerFailure?: boolean;
  /** The latest accepted hello, if it has not lapsed. */
  hello: Pick<VoiceListenerHello, "modelLoaded" | "microphone"> | null;
  /** The latest shell report's microphone permission, if the report has not lapsed. */
  shellMicrophone: VoiceMicrophonePermission | null;
}

/** Every reason that holds, in `VOICE_UNAVAILABLE_REASONS` order. */
export function voiceUnavailableReasons(inputs: VoiceReasonInputs): VoiceUnavailableReason[] {
  const reasons: VoiceUnavailableReason[] = [];
  if (!inputs.requiredFlagsOn) reasons.push("flags");
  if (!inputs.hello || inputs.listenerFailure) reasons.push("listener");
  if (inputs.hello && !inputs.hello.modelLoaded) reasons.push("model");
  if (inputs.hello?.microphone === "denied" || inputs.shellMicrophone === "denied") reasons.push("microphone");
  return reasons;
}

/** One sentence per reason, for the mode line and any other place that says why. */
export const VOICE_REASON_TEXT: Record<VoiceUnavailableReason, string> = {
  flags: "a preview it needs is off",
  listener: "no listener is running",
  model: "no speech model is loaded",
  microphone: "microphone access is denied",
  shortcut: "the desktop has no confirmed push-to-talk shortcut",
};

/** How each mode reads to a person. */
export const VOICE_MODE_LABEL: Record<VoiceMode, string> = {
  off: "Off",
  unavailable: "Not listening",
  listening: "Listening",
  muted: "Muted",
  "auto-muted": "Muted for a call",
  "waiting-for-key": "Waiting for hotkey",
  "push-to-talk": "Push to talk",
};

/**
 * The state as one string with its keys in a fixed order, so two states that say the same thing
 * compare equal. The registry uses it to drop a frame that restates the last one.
 *
 * The roster is left out: it travels on its own event, `voice_roster`, so an agent starting or
 * stopping does not wake the shell, which follows the mode and has no use for names. A
 * `voice_state` frame still carries the roster as it stands when it is sent.
 */
export function canonicalVoiceState(state: VoiceState): string {
  const capabilities: Record<string, VoiceCapability> = {};
  for (const id of VOICE_CAPABILITY_IDS) {
    const entry = state.capabilities[id];
    if (entry) capabilities[id] = { available: entry.available, reason: entry.reason, code: entry.code };
  }
  const { voice, reason, catalog, model, job, lastAudition } = state.speech;
  const entries = (voices: typeof catalog.system) => voices.map(v => [v.id, v.name, v.detail]);
  return JSON.stringify([
    state.mode,
    state.transcript,
    state.modeVersion?.source,
    state.modeVersion?.revision,
    state.muted ?? false,
    state.pushToTalkSession,
    state.planFormsByVoice ?? true,
    state.reasons,
    capabilities,
    state.configuredHotkey,
    state.pendingHotkey,
    state.pendingHotkeyId,
    state.expiredHotkey,
    state.recordingHotkey,
    state.recordingHotkeyId,
    state.recordingHotkeyReady,
    state.registeredHotkey,
    state.hotkeyError ? [state.hotkeyError.reason, state.hotkeyError.chordInForce, state.hotkeyError.trialId] : null,
    canonicalVoiceModel(state.model),
    voice && [voice.engine, voice.id], reason, job && [job.id, job.purpose, job.state, job.cardId],
    entries(catalog.neural), entries(catalog.system), canonicalVoiceModel(model), lastAudition && [lastAudition.id, lastAudition.state],
  ]);
}

function canonicalVoiceModel(model: VoiceModelState): unknown[] {
  return [
    model.status,
    model.backend,
    model.revision,
    model.totalBytes,
    model.doneBytes,
    model.bytesPerSecond,
    model.directory,
    model.error,
  ];
}

/**
 * The roster as one string, entries and fields in a fixed order, so the registry can drop a
 * `voice_roster` frame that restates the last one.
 */
export function canonicalVoiceRoster(roster: readonly SpokenName[]): string {
  return JSON.stringify(roster.map((entry) => [
    entry.key, entry.name, entry.kind, entry.taskId, entry.sessionId, entry.role, entry.colorId, entry.agent, entry.state, entry.isReferenceName,
  ]));
}

/** The state with the flag off: what every follower is told when voice is switched off. */
export function voiceStateOff(): VoiceState {
  return { mode: "off", speech: { voice: null, reason: "Voice is off.", job: null, lastAudition: null, catalog: { neural: [], system: [] }, model: { ...VOICE_MODEL_STATE_NONE } }, reasons: [], capabilities: {}, configuredHotkey: null, registeredHotkey: null, hotkeyError: null, model: { ...VOICE_MODEL_STATE_NONE }, roster: [] };
}

// ---- the listener's hello and the shell's report ----

/** The listener protocol this daemon speaks. A hello naming another major version is refused. */
export const VOICE_LISTENER_PROTOCOL_MAJOR = 4;
// 4.1 adds in-place timing edits. At 4.2 both peers support long FluidAudio captures.
export const VOICE_LISTENER_PROTOCOL_VERSION = `${VOICE_LISTENER_PROTOCOL_MAJOR}.2`;
export const VOICE_RECORDING_ID_HEADER = "x-voice-recording-id";
export const VOICE_LISTENER_ID_HEADER = "x-voice-listener-id";
/** A capture-only listener's process and the byte it must lock before opening the microphone. */
export const VOICE_CAPTURE_PID_HEADER = "x-voice-capture-pid";
export const VOICE_CAPTURE_LOCK_HEADER = "x-voice-capture-lock";
/** Response headers on the capture-off directive for an explicit push-to-talk key release. */
export const VOICE_RELEASE_REVISION_HEADER = "x-voice-release-revision";
export const VOICE_RELEASE_TIME_HEADER = "x-voice-release-host-ms";
export const VOICE_CAPTURE_END_HEADER = "x-voice-capture-end-host-ms";
export const VOICE_CAPTURE_START_HEADER = "x-voice-capture-start-host-us";
export const VOICE_SPEECH_START_HEADER = "x-voice-speech-start-host-us";
export const VOICE_FOCUS_UNCONFIRMED_HEADER = "x-voice-focus-unconfirmed";
export const VOICE_HELD_REVISION_HEADER = "x-voice-held-revision";
export const VOICE_DRAINING_REVISIONS_HEADER = "x-voice-draining-revisions";
export const VoiceListenerIdSchema = z.uuid();

/** The values macOS reports for a media permission, which a Linux listener can also name. */
export const VOICE_MICROPHONE_PERMISSIONS = ["granted", "denied", "not-determined", "restricted", "unknown"] as const;
export type VoiceMicrophonePermission = (typeof VOICE_MICROPHONE_PERMISSIONS)[number];

const VoiceInputDeviceSchema = z.object({
  id: z.string().min(1).max(VOICE_LIMITS.deviceIdChars),
  name: z.string().min(1).max(VOICE_LIMITS.deviceNameChars),
  builtIn: z.boolean().optional(),
  bluetooth: z.boolean().optional(),
});
export type VoiceInputDevice = z.infer<typeof VoiceInputDeviceSchema>;

/**
 * `POST /voice/listener/hello`, sent every `VOICE_HELLO_INTERVAL_MS` by a listener. `version` is
 * the listener protocol version, `major.minor`; only its major is compared.
 */
export const VoiceListenerHelloSchema = z.object({
  speech: SpeechHelloSchema.optional(),
  backend: z.enum(VOICE_BACKENDS),
  version: z.string().regex(/^\d+(\.\d+){0,2}$/).max(VOICE_LIMITS.versionChars),
  devices: z.array(VoiceInputDeviceSchema).max(VOICE_LIMITS.devices),
  modelLoaded: z.boolean(),
  primingAvailable: z.boolean().optional(),
  reportsSpeechOnset: z.literal(true).optional(),
  microphone: z.enum(VOICE_MICROPHONE_PERMISSIONS),
});
export type VoiceListenerHello = z.infer<typeof VoiceListenerHelloSchema>;

/** The major version a protocol string names. */
export function voiceProtocolMajor(version: string): number {
  return Number.parseInt(version.split(".")[0] ?? "", 10);
}

const VoiceCapabilityReportSchema = z.object({
  /** The hotkey producer released its reservation for this recorder. */
  recordingId: z.uuid().optional(),
  available: z.boolean(),
  reason: z.string().max(VOICE_LIMITS.reasonChars).nullable().default(null),
});

/**
 * `POST /voice/shell-report`. Capability ids this build does not know are dropped rather than
 * refused, so a newer shell's report still lands on an older daemon.
 */
export const VoiceShellReportSchema = z.object({
  pushToTalkSession: z.uuid().optional(),
  capabilities: boundedRecord(z.string().min(1).max(64), VoiceCapabilityReportSchema, 32).default({}),
  microphone: z.enum(VOICE_MICROPHONE_PERMISSIONS).nullable().default(null),
  callActive: z.boolean().default(false),
  pushToTalk: z.boolean().default(false),
  /** Legacy Unix fields are accepted for compatibility. They cannot authorize release. */
  pushToTalkPressedAt: z.number().int().nonnegative().optional().catch(undefined),
  pushToTalkReleasedAt: z.number().int().nonnegative().optional().catch(undefined),
  /** Monotonic host time when the shell sampled this snapshot, strictly increasing across reports. */
  reportedAtHostUs: z.number().int().nonnegative().optional().catch(undefined),
  /** Physical key event on the same monotonic microsecond clock as the snapshot. */
  pushToTalkPressedAtHostUs: z.number().int().nonnegative().optional().catch(undefined),
  pushToTalkReleasedAtHostUs: z.number().int().nonnegative().optional().catch(undefined),
  registeredHotkey: ChordSchema.nullable().optional(),
  hotkeyError: z.object({
    reason: z.string().min(1).max(VOICE_LIMITS.reasonChars),
    chordInForce: ChordSchema.nullable(),
    trialId: z.uuid().optional(),
  }).nullable().default(null),
});
export type VoiceShellReport = z.infer<typeof VoiceShellReportSchema>;

/** The known capabilities of a report, in `VOICE_CAPABILITY_IDS` order. */
export function knownVoiceCapabilities(reported: Record<string, VoiceCapability>): VoiceCapabilities {
  const known: VoiceCapabilities = {};
  for (const id of VOICE_CAPABILITY_IDS) {
    const entry = reported[id];
    if (entry) known[id] = { available: entry.available, reason: entry.available ? null : entry.reason };
  }
  return known;
}
