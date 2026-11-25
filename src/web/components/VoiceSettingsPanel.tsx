import { ConsoleSwitch } from "./settings-console.tsx";
import { useEffect, useState } from "react";
import { useChordCapture } from "../lib/useChordCapture.ts";
import { formatChord } from "../lib/keybindings.ts";
import { VoiceCardPlacement } from "./VoiceCardPlacement.tsx";
import { VoiceIndicatorSettings } from "./VoiceIndicators.tsx";
import { RecentlyHeard } from "./RecentlyHeard.tsx";
import {
  VOICE_CANCEL_WINDOW_SECONDS,
  VOICE_END_OF_SPEECH_MS,
  VOICE_CONFIG_DEFAULTS,
  VOICE_CALL_POLL_RETRY,
  VOICE_INPUT_DEVICE_BUILT_IN,
  VOICE_INPUT_DEVICE_SYSTEM_DEFAULT,
  VOICE_MODE_LABEL,
  VOICE_RECORDING_ID_HEADER,
  VOICE_REASON_TEXT,
  type VoiceDecisionProvider,
  type VoiceMode,
  type VoiceState,
  type VoiceInputDevice,
  type VoiceWhenUnsure,
} from "@shared/voice.ts";
import {
  VOICE_KEY_ENV,
  VOICE_KEY_PROVIDER_LABEL,
  VOICE_KEY_PROVIDERS,
  voiceRoutingWithoutProvider,
  type VoiceKeyProvider,
  type VoiceKeySource,
} from "@shared/voice-decide.ts";
import {
  spokenNameWarningLabel,
  spokenNameWarningText,
  validateSpokenName,
  type SpokenName,
} from "@shared/voice-names.ts";
import type { ResidentProfile } from "@shared/residents.ts";
import type { Session } from "@shared/types.ts";
import type { SettingsNavigate } from "../lib/settings-registry.ts";
import {
  rosterAgentName,
  rosterWithout,
  sessionsWithoutSpokenName,
  SPOKEN_NAME_STATE_LABEL,
} from "../lib/voice-roster.ts";
import { residentAccentStyle } from "../residents/marker.ts";
import { useVoiceDecisionKey, useVoiceDevices, type VoiceConfigState, type VoiceDecisionKeyState } from "../useVoiceConfig.ts";
import { Tooltip } from "./Tooltip.tsx";

/** The lengths the cancel window offers. A stored length outside the list is offered as well. */
const CANCEL_WINDOW_CHOICES = [2, 3, 4, 5, 6, 8, 10, 15, 20, 30] as const;

const UNSURE_CHOICES: readonly { id: VoiceWhenUnsure; label: string; description: string }[] = [
  { id: "ask", label: "Ask", description: "Ask aloud which agent you meant, and answer by name." },
  { id: "show", label: "Show", description: "Show the agents it could have been, and say or click one." },
];

const FIXED_INPUTS: readonly { id: string; label: string }[] = [
  { id: VOICE_INPUT_DEVICE_BUILT_IN, label: "Built-in microphone" },
  { id: VOICE_INPUT_DEVICE_SYSTEM_DEFAULT, label: "macOS default input" },
];

/**
 * What the input device menu offers: the built-in microphone, the system default, then each
 * device the live listener listed. A saved device that is not listed now (unplugged, or no
 * listener) stays offered under its id, so the menu never shows a choice that was not made.
 */
export function voiceInputChoices(
  devices: readonly VoiceInputDevice[],
  selected: string,
): { id: string; label: string }[] {
  const fixed = new Set(FIXED_INPUTS.map((input) => input.id));
  const listed = devices
    .filter((device) => !fixed.has(device.id))
    .map((device) => ({ id: device.id, label: device.builtIn ? `${device.name} (built in)` : device.name }));
  const choices = [...FIXED_INPUTS, ...listed];
  if (!choices.some((choice) => choice.id === selected)) choices.push({ id: selected, label: "Saved device (not connected)" });
  return choices;
}

/** The tone of the mode line's dot: listening, quiet on purpose, or not able to listen. */
function modeTone(mode: VoiceMode | null): "live" | "quiet" | "warn" | "off" {
  switch (mode) {
    case "listening":
    case "push-to-talk":
      return "live";
    case "muted":
    case "auto-muted":
      return "quiet";
    case "unavailable":
      return "warn";
    case "off":
    case null:
      return "off";
  }
}

/** Join reasons as one sentence: "a, b and c". */
function sentence(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/**
 * The line at the top of Settings > Voice: the mode, and when voice cannot listen, every reason
 * it cannot, with a link to the Setup family that fixes them.
 */
function ModeLine({ voice, onOpenSetup }: { voice: VoiceState | null; onOpenSetup(): void }): React.JSX.Element {
  const mode = voice?.mode ?? null;
  const tone = modeTone(mode);
  const reasons = mode === "unavailable" ? voice?.reasons ?? [] : [];
  return (
    <div className="voice-mode-line" data-anchor="voice/mode" role="status" aria-label="Voice mode">
      <span className={`voice-mode-dot voice-mode-dot-${tone}`} aria-hidden />
      <strong className="voice-mode-label">{mode ? VOICE_MODE_LABEL[mode] : "Checking…"}</strong>
      <span className="voice-mode-why">
        {reasons.length > 0
          ? `${sentence(reasons.map(reason => reason === "listener" && voice?.capabilities.listener?.reason
            ? voice.capabilities.listener.reason.replace(/\.$/, "") : VOICE_REASON_TEXT[reason]))}.`
          : mode === "muted"
            ? "Nothing is heard until you unmute."
            : mode === "auto-muted"
              ? "Another app is using the microphone."
              : null}
      </span>
      {reasons.length > 0 && (
        <Tooltip label="Open the Voice family in Settings > Setup, where each missing piece has its fix">
          <button type="button" className="settings-link" onClick={onOpenSetup}>Open Setup</button>
        </Tooltip>
      )}
    </div>
  );
}

/** One roster row's Check cell: "Distinct", or each warning in a few words. */
function RosterCheck({ entry, roster }: { entry: SpokenName; roster: readonly SpokenName[] }): React.JSX.Element {
  const warnings = validateSpokenName(entry.name, rosterWithout(roster, entry.key));
  if (warnings.length === 0) return <span className="voice-roster-ok">Distinct</span>;
  return (
    <Tooltip label={warnings.map((warning) => spokenNameWarningText(warning, entry.name)).join(" ")}>
      <span className="voice-roster-warn">
        <span aria-hidden>⚠</span> {warnings.map(spokenNameWarningLabel).join(" · ")}
      </span>
    </Tooltip>
  );
}

/** "1 session has", "3 sessions have". */
function sessionsHave(count: number): string {
  return count === 1 ? "1 session has" : `${count} sessions have`;
}

/**
 * Who can be addressed (the adopted roster-first design): every resident and every session with
 * a call sign, what to say, whether it is running, and any name warning. Names are reviewed here
 * and set elsewhere, so the table is read-only and says where.
 */
function RosterSection({
  roster,
  sessions,
  residentProfiles,
}: {
  roster: readonly SpokenName[];
  sessions: readonly Session[];
  residentProfiles: readonly ResidentProfile[];
}): React.JSX.Element {
  const unaddressed = sessionsWithoutSpokenName(sessions, roster);
  return (
    <div className="settings-group voice-roster" data-anchor="voice/roster">
      <p className="settings-group-label">Who you can address</p>
      {roster.length === 0 ? (
        <p className="settings-hint">No agent answers to a name yet.</p>
      ) : (
        <table className="voice-roster-table" aria-label="Agents that answer to a spoken name">
          <thead>
            <tr>
              <th scope="col">Agent</th>
              <th scope="col">Kind</th>
              <th scope="col">Say</th>
              <th scope="col">State</th>
              <th scope="col">Check</th>
            </tr>
          </thead>
          <tbody>
            {roster.map((entry) => (
              <tr key={entry.key}>
                <td>
                  <span
                    className={`voice-roster-agent${entry.colorId ? " agent-name-resident" : ""}`}
                    style={entry.colorId ? residentAccentStyle(entry.colorId) : undefined}
                  >
                    {rosterAgentName(entry, residentProfiles)}
                  </span>
                </td>
                <td className="voice-roster-kind">{entry.kind === "resident" ? "Resident" : "Session"}</td>
                <td className="voice-roster-say">{entry.name}</td>
                <td className={`voice-roster-state voice-roster-state-${entry.state}`}>{SPOKEN_NAME_STATE_LABEL[entry.state]}</td>
                <td><RosterCheck entry={entry} roster={roster} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="settings-hint">
        {unaddressed === 0
          ? "Every running session can be addressed by name."
          : `${sessionsHave(unaddressed)} no call sign. Answer one through its open card by starting with “reply”.`}
        {" "}A resident's reference name is set on its profile, and a session's call sign in Dispatch under Advanced.
      </p>
    </div>
  );
}

/** The provider menu's choices: Automatic is the stored null, Off stores `off`. */
const DECISION_PROVIDER_CHOICES: readonly { value: string; stored: VoiceDecisionProvider | null; label: string }[] = [
  { value: "auto", stored: null, label: "Automatic" },
  { value: "off", stored: "off", label: "Off" },
  { value: "openai", stored: "openai", label: VOICE_KEY_PROVIDER_LABEL.openai },
  { value: "jev", stored: "jev", label: VOICE_KEY_PROVIDER_LABEL.jev },
];

/** What a key row says about where its provider's key comes from. */
export const VOICE_KEY_SOURCE_TEXT: Record<Exclude<VoiceKeySource, null> | "none", string> = {
  environment: "From the environment",
  settings: "Saved on this Mac",
  none: "Not set",
};

/** The group's line when no decision model is in use. */
export const VOICE_ROUTING_WITHOUT_PROVIDER = `Not set: ${voiceRoutingWithoutProvider()}`;

/** The group's line: the provider in use and what it is sent, or that none is. */
export function fasterRoutingLine(provider: VoiceKeyProvider | null, savedKeysUnavailable = false): string {
  if (!provider) return savedKeysUnavailable ? `Saved key status unavailable: ${voiceRoutingWithoutProvider()}` : VOICE_ROUTING_WITHOUT_PROVIDER;
  const name = VOICE_KEY_PROVIDER_LABEL[provider];
  return `Using ${name}. Sends the sentence with candidate names or the card question, options and option details.`;
}

function DecisionKeyRow({ provider, keys }: {
  provider: VoiceKeyProvider;
  keys: VoiceDecisionKeyState;
}): React.JSX.Element {
  const [draft, setDraft] = useState("");
  const { busy } = keys;
  const canWrite = !busy && !!keys.report?.keyRevisions?.[provider];
  const label = VOICE_KEY_PROVIDER_LABEL[provider];
  const source = keys.report?.keys[provider].source;
  const savedKeysUnavailable = keys.report?.savedKeysUnavailable;
  const from = source == null && (keys.report === null || savedKeysUnavailable) ? "Status unavailable"
    : source === undefined ? "Reading…"
    : VOICE_KEY_SOURCE_TEXT[source ?? "none"];
  const save = async (): Promise<void> => {
    const key = draft.trim();
    if (!key) return;
    // Keep the draft for correction only when the daemon explicitly rejects the key.
    if (await keys.save(provider, key) !== "refused") setDraft("");
  };
  return (
    <div className="kb-row voice-key-row" data-anchor={`voice/key-${provider}`} role="group" aria-label={label}>
      <div className="kb-row-text">
        <span className="kb-row-label">{label} key</span>
        <span className="kb-row-desc">
          <span className="voice-key-source">{from}</span>
          {source === "environment" && <> · <code>{VOICE_KEY_ENV[provider]}</code>. {savedKeysUnavailable ? "Saved key status unavailable" : "A key saved here overrides it on this Mac"}</>}
          {source === null && !savedKeysUnavailable && <> · or set <code>{VOICE_KEY_ENV[provider]}</code> where the daemon runs</>}
        </span>
      </div>
      <form
        className="kb-row-controls"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <input
          className="field-input mono voice-key-input"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={source === "settings" ? "Type to replace it" : "Paste a key"}
          value={draft}
          disabled={busy}
          aria-label={`${label} key`}
          onChange={(event) => setDraft(event.target.value)}
        />
        <Tooltip label={`Save this key on this Mac. It is never shown again.`}>
          <button className="btn" type="submit" disabled={!canWrite || !draft.trim()}>Save</button>
        </Tooltip>
        {source === "settings" && (
          <Tooltip label={`Remove the ${label} key saved on this Mac`}>
            <button className="btn btn-ghost" type="button" disabled={!canWrite}
              onClick={() => void keys.remove(provider)}>
              Remove
            </button>
          </Tooltip>
        )}
      </form>
    </div>
  );
}

/**
 * Voice settings' "Faster routing" group (contract E): which decision model settles an ambiguous
 * sentence, and each provider's key. The line at the top names the provider in use and says what
 * is sent to it, so a key picked up from the environment is visible and one choice from Off.
 */
function FasterRoutingGroup({ state, keys }: {
  state: VoiceConfigState;
  keys: VoiceDecisionKeyState;
}): React.JSX.Element {
  const { config, update, confirmedDecisionProvider } = state;
  // A key report observes the selection and effective provider together, even if the
  // independent config poll is stalled. Keep an optimistic selection until its write settles.
  const stored = state.pendingDecisionProvider !== undefined ? state.pendingDecisionProvider
    : keys.report ? keys.report.selection : confirmedDecisionProvider;
  const chosen = DECISION_PROVIDER_CHOICES.find((choice) => choice.stored === stored)?.value ?? "unknown";
  const provider = keys.report?.provider ?? null;
  const status = keys.report ? fasterRoutingLine(provider, keys.report.savedKeysUnavailable)
    : keys.report === null ? "Key status unavailable"
    : confirmedDecisionProvider === "off" ? VOICE_ROUTING_WITHOUT_PROVIDER : "Reading…";
  return (
    <div className="settings-group voice-faster-routing" data-anchor="voice/faster-routing">
      <p className="settings-group-label">Faster routing</p>
      <p className={`voice-routing-line${provider ? " is-on" : ""}`} role="status" aria-label="Decision model in use">
        {status}
      </p>
      {keys.error && <p className="settings-error">{keys.error}</p>}

      <div className="kb-row" data-anchor="voice/decision-provider">
        <div className="kb-row-text">
          <span className="kb-row-label">Decision model</span>
          <span className="kb-row-desc">
            Settles a sentence the names alone could not. Automatic uses the first key it finds: one
            saved here, then <code>{VOICE_KEY_ENV.openai}</code> or <code>{VOICE_KEY_ENV.jev}</code> in
            the environment. Off never sends anything to either.
          </span>
        </div>
        <div className="kb-row-controls">
          <Tooltip label="Which decision model settles an ambiguous sentence">
            <select
              className="settings-select"
              value={chosen}
              disabled={!config && !keys.report}
              aria-label="Decision model provider"
              onChange={(event) => {
                const next = DECISION_PROVIDER_CHOICES.find((choice) => choice.value === event.target.value);
                if (next) void update({ decisionProvider: next.stored }, keys.report?.providerRevision);
              }}
            >
              {chosen === "unknown" && <option value="unknown" disabled>Checking selection…</option>}
              {DECISION_PROVIDER_CHOICES.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
            </select>
          </Tooltip>
        </div>
      </div>

      {VOICE_KEY_PROVIDERS.map((id) => (
        <DecisionKeyRow key={id} provider={id} keys={keys} />
      ))}
    </div>
  );
}

function MuteHotkey({ state, voice }: { state: VoiceConfigState; voice: VoiceState | null }) {
  const [recordingLabel, setRecordingLabel] = useState<string | null>(null);
  const [captureError, setCaptureError] = useState("");
  const [leaseId, setLeaseId] = useState<string | null>(null);
  const available = !!voice?.capabilities.hotkey?.available && !!state.config;
  const pending = voice?.pendingHotkey;
  const expired = voice?.expiredHotkey;
  const error = pending || (expired && voice?.hotkeyError?.trialId) ? null : voice?.hotkeyError;
  const chord = error ? error.chordInForce : voice ? voice.configuredHotkey : state.config?.hotkey;
  const label = chord ? formatChord(chord) : "Unset";
  const requested = recordingLabel !== null;
  const recording = requested && leaseId && voice?.recordingHotkeyId === leaseId && voice.recordingHotkeyReady;
  useEffect(() => {
    if (!requested) return;
    if (!available) { setRecordingLabel(null); return; }
    const controller = new AbortController();
    const cancel = () => setRecordingLabel(null);
    window.addEventListener("blur", cancel);
    void (async () => {
      try {
        const response = await fetch("/api/voice/hotkey-recording", {
          method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
        });
        if (!response.ok) throw Error(response.status === 409
          ? "Another window is recording a shortcut." : "Could not start shortcut recording.");
        const id = response.headers.get(VOICE_RECORDING_ID_HEADER);
        if (!id) throw Error("The desktop could not confirm the recording request.");
        if (!controller.signal.aborted) setLeaseId(id);
        await response.text();
      } catch (error) {
        if (!controller.signal.aborted) setCaptureError(error instanceof Error ? error.message : "Could not record shortcut.");
      } finally {
        if (!controller.signal.aborted) cancel();
      }
    })();
    return () => {
      controller.abort();
      setLeaseId(null);
      window.removeEventListener("blur", cancel);
    };
  }, [requested, available]);
  useChordCapture(requested && available, () => setRecordingLabel(null), captured => {
    if (!recording) return;
    setRecordingLabel(null);
    // The config trims strings. Spell a physical space explicitly on this wire.
    void state.update({ hotkey: captured.replace(/[ \u00a0]$/, "Space") });
  }, true);
  return (
    <div className={`kb-row${error || expired ? " has-conflict" : ""}`} data-anchor="voice/hotkey">
      <div className="kb-row-text">
        <span className="kb-row-label">Mute hotkey</span>
        {recording && available ? <span className="kb-row-desc">Press the chord you want. Esc keeps {recordingLabel}.</span>
          : captureError ? <span className="kb-row-conflict" role="alert">{captureError}</span>
          : pending ? <span className="kb-row-desc" role="status">Waiting for the desktop to confirm {formatChord(pending)}.</span>
          : <>
            {expired && <span className="kb-row-conflict" role="alert">
              The desktop did not confirm {formatChord(expired)}.{" "}
              {voice.configuredHotkey ? `${formatChord(voice.configuredHotkey)} is still saved.` : "No shortcut is saved."}
            </span>}
            {error && <span className="kb-row-conflict" role="alert">
              {error.reason}{" "}
              {chord ? `${label} is still your hotkey.` : "No hotkey is in force."}
            </span>}
          </>}
      </div>
      <div className="kb-row-controls">
        {available ? (
          <Tooltip label={recording ? "Press a shortcut, or Escape to cancel" : "Record a system-wide mute shortcut"}>
            <button type="button" aria-label="Mute hotkey" aria-pressed={!!recording} aria-busy={!!pending || (requested && !recording)}
              className={`kb-capture${recording ? " is-recording" : ""}`}
              onBlur={() => setRecordingLabel(null)} onClick={() => { setCaptureError(""); setRecordingLabel(requested ? null : label); }}>
              {recording ? <span className="kb-recording">Press a key…</span> : <kbd>{label}</kbd>}
            </button>
          </Tooltip>
        ) : <span className="kb-row-desc">{voice?.capabilities.hotkey?.reason ?? "Needs the desktop app"}</span>}
      </div>
    </div>
  );
}

/**
 * Settings > Voice, behind the `voice` flag. The mode line, then who can be addressed, the input
 * device, then the behavior rows. The indicator previews and recently heard table follow the behavior rows.
 */
export function VoiceSettingsPanel({
  state,
  voice,
  sessions = [],
  residentProfiles = [],
  onNavigate,
}: {
  state: VoiceConfigState;
  voice: VoiceState | null;
  sessions?: readonly Session[];
  residentProfiles?: readonly ResidentProfile[];
  onNavigate: SettingsNavigate;
}): React.JSX.Element {
  const { config, update, error } = state;
  const detection = voice?.capabilities["call-detection"];
  const pollFailed = detection?.reason?.startsWith(VOICE_CALL_POLL_RETRY) ||
    detection?.reason?.startsWith("CoreAudio input query failed"); // Older desktop shells.
  const seconds = config?.cancelWindow.seconds ?? 4;
  const lengths = CANCEL_WINDOW_CHOICES.includes(seconds as (typeof CANCEL_WINDOW_CHOICES)[number])
    ? CANCEL_WINDOW_CHOICES
    : [...CANCEL_WINDOW_CHOICES, seconds].sort((a, b) => a - b);
  const askReason = voice?.capabilities["speech-output"]?.available ? null : voice?.capabilities["speech-output"]?.reason ?? "No listener is running.";
  const unsure = config?.whenUnsure ?? "show";
  const devices = useVoiceDevices(true);
  const inputDevice = config?.inputDevice ?? VOICE_INPUT_DEVICE_BUILT_IN;
  const inputs = voiceInputChoices(devices.devices, inputDevice);
  const keys = useVoiceDecisionKey(true, state);
  return (
    <section className="settings-section voice-settings">
      <ModeLine voice={voice} onOpenSetup={() => onNavigate("setup", "setup/family-voice")} />
      {error && <p className="settings-error">{error}</p>}

      <RosterSection roster={voice?.roster ?? []} sessions={sessions} residentProfiles={residentProfiles} />

      <div className="settings-group">
        <p className="settings-group-label">Input</p>

        <div className="kb-row" data-anchor="voice/input-device">
          <div className="kb-row-text">
            <span className="kb-row-label">Input device</span>
            <span className="kb-row-desc">
              Voice listens on the built-in microphone unless you choose another input.
              {!devices.listener && (
                <span className="voice-input-device-hint"> Other inputs are listed while the listener is running.</span>
              )}
            </span>
          </div>
          <div className="kb-row-controls">
            <Tooltip label="The microphone voice listens on">
              <select
                className="settings-select"
                value={inputDevice}
                disabled={!config}
                aria-label="Input device"
                onChange={(e) => void update({ inputDevice: e.target.value })}
              >
                {inputs.map((input) => <option key={input.id} value={input.id}>{input.label}</option>)}
              </select>
            </Tooltip>
          </div>
        </div>
        <div className="kb-row" data-anchor="voice/end-of-speech">
          <div className="kb-row-text">
            <label className="kb-row-label" htmlFor="voice-end-of-speech">End-of-speech delay</label>
            <span className="kb-row-desc">How long to wait for more speech before submitting an automatic capture.</span>
          </div>
          <div className="kb-row-controls">
            <Tooltip label="Speech that resumes within this delay stays in the same utterance.">
              <select className="settings-select" id="voice-end-of-speech" disabled={!config}
                value={config?.endOfSpeechMs ?? VOICE_CONFIG_DEFAULTS.endOfSpeechMs}
                onChange={event => {
                  const duration = VOICE_END_OF_SPEECH_MS.find(ms => ms === Number(event.target.value));
                  if (duration !== undefined) void update({ endOfSpeechMs: duration });
                }}>
                {VOICE_END_OF_SPEECH_MS.map(ms => <option key={ms} value={ms}>{ms / 1000} s</option>)}
              </select>
            </Tooltip>
          </div>
        </div>
      </div>

      <div className="settings-group">
        <p className="settings-group-label">Behavior</p>

        <div className="voice-hardware-settings">
          <MuteHotkey state={state} voice={voice} />
          <div className="kb-row" data-anchor="voice/auto-mute">
            <div className="kb-row-text">
              <span className="kb-row-label">Auto-mute on calls</span>
              <span className="kb-row-desc">{voice?.capabilities["call-detection"]?.reason}</span>
            </div>
            <div className="kb-row-controls">
              <ConsoleSwitch label="Auto-mute on calls" tone="ok" checked={config?.autoMuteDuringCalls ?? true}
                disabled={!config || (detection?.available === false && !pollFailed)}
                onChange={autoMuteDuringCalls => void update({ autoMuteDuringCalls })}
                tooltip="Stop listening while another app is using the microphone" />
            </div>
          </div>

          <div className="kb-row" data-anchor="voice/cancel-window">
            <div className="kb-row-text"><span className="kb-row-label">Cancel window</span></div>
            <div className="kb-row-controls">
              <Tooltip label="How long to wait for “cancel” before sending a spoken message">
                <select
                  className="settings-select"
                  value={config?.cancelWindow.enabled === false ? "off" : seconds}
                  disabled={!config}
                  aria-label="Cancel window"
                  onChange={({ target: { value } }) => {
                    const cancelWindow = value === "off" ? { enabled: false }
                      : { enabled: true, seconds: Number(value) };
                    void update({ cancelWindow });
                  }}
                >
                  {lengths
                    .filter((length) => length >= VOICE_CANCEL_WINDOW_SECONDS.min && length <= VOICE_CANCEL_WINDOW_SECONDS.max)
                    .map((length) => <option key={length} value={length}>{length} s</option>)}
                  <option value="off">Off</option>
                </select>
              </Tooltip>
            </div>
          </div>

          <div className="kb-row" data-anchor="voice/when-unsure">
            <div className="kb-row-text">
              <span className="kb-row-label">Unsure</span>
              {askReason && <span className="kb-row-desc">{askReason}</span>}
            </div>
            <div className="kb-row-controls">
              <div className="display-choice-options" role="radiogroup" aria-label="When routing is unsure">
                {UNSURE_CHOICES.map((choice) => (
                  <Tooltip key={choice.id} label={choice.id === "ask" ? askReason ?? choice.description : choice.description}>
                    <label className={`display-choice-option${unsure === choice.id ? " is-on" : ""}`}>
                      <input type="radio" name="voice-when-unsure" value={choice.id}
                        aria-label={choice.id === "ask" ? "Ask aloud" : "Show on screen"}
                        aria-description={choice.id === "ask" ? askReason ?? undefined : undefined}
                        checked={unsure === choice.id} disabled={!config || (choice.id === "ask" && !!askReason)}
                        onChange={() => void update({ whenUnsure: choice.id })} />
                      {choice.label}
                    </label>
                  </Tooltip>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="kb-row" data-anchor="voice/plan-forms">
          <div className="kb-row-text">
            <span className="kb-row-label">Plan forms by voice</span>
            <span className="kb-row-desc">
              Let speech fill a plan-decision form. A form still waits for you to say submit or
              to click it. Voice keeps working everywhere else when this is off.
            </span>
          </div>
          <div className="kb-row-controls">
            <Tooltip label="Let speech fill a plan-decision form, which still waits for submit">
              <label className="skill-switch">
                <input
                  type="checkbox"
                  checked={config?.planFormsByVoice ?? true}
                  disabled={!config}
                  onChange={(e) => void update({ planFormsByVoice: e.target.checked })}
                  aria-label="Plan forms by voice"
                />
              </label>
            </Tooltip>
          </div>
        </div>
      </div>

      <FasterRoutingGroup state={state} keys={keys} />
      <VoiceCardPlacement />
      <VoiceIndicatorSettings />
      <RecentlyHeard roster={voice?.roster ?? []} />
    </section>
  );
}
