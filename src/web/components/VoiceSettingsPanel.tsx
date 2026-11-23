import {
  VOICE_CANCEL_WINDOW_SECONDS,
  VOICE_INPUT_DEVICE_BUILT_IN,
  VOICE_INPUT_DEVICE_SYSTEM_DEFAULT,
  VOICE_MODE_LABEL,
  VOICE_REASON_TEXT,
  type VoiceMode,
  type VoiceState,
  type VoiceInputDevice,
  type VoiceWhenUnsure,
} from "@shared/voice.ts";
import type { SettingsNavigate } from "../lib/settings-registry.ts";
import { useVoiceDevices, type VoiceConfigState } from "../useVoiceConfig.ts";
import { Tooltip } from "./Tooltip.tsx";

/** The lengths the cancel window offers. A stored length outside the list is offered as well. */
const CANCEL_WINDOW_CHOICES = [2, 3, 4, 5, 6, 8, 10, 15, 20, 30] as const;

const UNSURE_CHOICES: readonly { id: VoiceWhenUnsure; label: string; description: string }[] = [
  { id: "show", label: "Show on screen", description: "Show the agents it could have been, and say or click one." },
  { id: "ask", label: "Ask aloud", description: "Ask aloud which agent you meant, and answer by name." },
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
          ? `${sentence(reasons.map((reason) => VOICE_REASON_TEXT[reason]))}.`
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

/**
 * Settings > Voice, behind the `voice` flag. The mode line, the input device, then the behavior
 * rows. The roster, placement, indicators and hotkey rows arrive with the phases that make them do
 * something.
 */
export function VoiceSettingsPanel({
  state,
  voice,
  onNavigate,
}: {
  state: VoiceConfigState;
  voice: VoiceState | null;
  onNavigate: SettingsNavigate;
}): React.JSX.Element {
  const { config, update, error } = state;
  const seconds = config?.cancelWindow.seconds ?? 4;
  const lengths = CANCEL_WINDOW_CHOICES.includes(seconds as (typeof CANCEL_WINDOW_CHOICES)[number])
    ? CANCEL_WINDOW_CHOICES
    : [...CANCEL_WINDOW_CHOICES, seconds].sort((a, b) => a - b);
  const unsure = config?.whenUnsure ?? "show";
  const devices = useVoiceDevices(true);
  const inputDevice = config?.inputDevice ?? VOICE_INPUT_DEVICE_BUILT_IN;
  const inputs = voiceInputChoices(devices.devices, inputDevice);
  return (
    <section className="settings-section voice-settings">
      <ModeLine voice={voice} onOpenSetup={() => onNavigate("setup", "setup/family-voice")} />
      {error && <p className="settings-error">{error}</p>}

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
      </div>

      <div className="settings-group">
        <p className="settings-group-label">Behavior</p>

        <div className="kb-row" data-anchor="voice/auto-mute">
          <div className="kb-row-text">
            <span className="kb-row-label">Auto-mute during calls</span>
            <span className="kb-row-desc">
              While another app is using the microphone, such as a call, voice stops listening
              until it is done.
            </span>
          </div>
          <div className="kb-row-controls">
            <Tooltip label="Stop listening while another app is using the microphone">
              <label className="skill-switch">
                <input
                  type="checkbox"
                  checked={config?.autoMuteDuringCalls ?? true}
                  disabled={!config}
                  onChange={(e) => void update({ autoMuteDuringCalls: e.target.checked })}
                  aria-label="Auto-mute during calls"
                />
              </label>
            </Tooltip>
          </div>
        </div>

        <div className="kb-row" data-anchor="voice/cancel-window">
          <div className="kb-row-text">
            <span className="kb-row-label">Cancel window</span>
            <span className="kb-row-desc">
              How long a spoken message waits for you to say “cancel” before it is sent. Off sends
              it at once.
            </span>
          </div>
          <div className="kb-row-controls">
            <Tooltip label="Wait for “cancel” before a spoken message is sent">
              <label className="skill-switch">
                <input
                  type="checkbox"
                  checked={config?.cancelWindow.enabled ?? true}
                  disabled={!config}
                  onChange={(e) => void update({ cancelWindow: { enabled: e.target.checked } })}
                  aria-label="Cancel window"
                />
              </label>
            </Tooltip>
            <Tooltip label="How many seconds a spoken message waits before it is sent">
              <select
                className="settings-select"
                value={seconds}
                disabled={!config || !config.cancelWindow.enabled}
                aria-label="Cancel window length"
                onChange={(e) => void update({ cancelWindow: { seconds: Number(e.target.value) } })}
              >
                {lengths
                  .filter((length) => length >= VOICE_CANCEL_WINDOW_SECONDS.min && length <= VOICE_CANCEL_WINDOW_SECONDS.max)
                  .map((length) => <option key={length} value={length}>{length} s</option>)}
              </select>
            </Tooltip>
          </div>
        </div>

        <div className="kb-row" data-anchor="voice/when-unsure">
          <div className="kb-row-text">
            <span className="kb-row-label">When routing is unsure</span>
            <span className="kb-row-desc">
              What happens when Mission Control cannot tell which agent you addressed.
            </span>
          </div>
          <div className="kb-row-controls">
            <div className="display-choice-options" role="radiogroup" aria-label="When routing is unsure">
              {UNSURE_CHOICES.map((choice) => (
                <Tooltip key={choice.id} label={choice.description}>
                  <label className={`display-choice-option${unsure === choice.id ? " is-on" : ""}`}>
                    <input
                      type="radio"
                      name="voice-when-unsure"
                      value={choice.id}
                      checked={unsure === choice.id}
                      disabled={!config}
                      onChange={() => void update({ whenUnsure: choice.id })}
                    />
                    {choice.label}
                  </label>
                </Tooltip>
              ))}
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
    </section>
  );
}
