import {
  VOICE_CANCEL_WINDOW_SECONDS,
  VOICE_MODE_LABEL,
  VOICE_REASON_TEXT,
  type VoiceMode,
  type VoiceState,
  type VoiceWhenUnsure,
} from "@shared/voice.ts";
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
import type { VoiceConfigState } from "../useVoiceConfig.ts";
import { Tooltip } from "./Tooltip.tsx";

/** The lengths the cancel window offers. A stored length outside the list is offered as well. */
const CANCEL_WINDOW_CHOICES = [2, 3, 4, 5, 6, 8, 10, 15, 20, 30] as const;

const UNSURE_CHOICES: readonly { id: VoiceWhenUnsure; label: string; description: string }[] = [
  { id: "show", label: "Show on screen", description: "Show the agents it could have been, and say or click one." },
  { id: "ask", label: "Ask aloud", description: "Ask aloud which agent you meant, and answer by name." },
];

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

/**
 * Settings > Voice, behind the `voice` flag. The mode line, then who can be addressed, then the
 * behavior rows. The placement, indicators, hotkey and input device rows arrive with the phases
 * that make them do something.
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
  const seconds = config?.cancelWindow.seconds ?? 4;
  const lengths = CANCEL_WINDOW_CHOICES.includes(seconds as (typeof CANCEL_WINDOW_CHOICES)[number])
    ? CANCEL_WINDOW_CHOICES
    : [...CANCEL_WINDOW_CHOICES, seconds].sort((a, b) => a - b);
  const unsure = config?.whenUnsure ?? "show";
  return (
    <section className="settings-section voice-settings">
      <ModeLine voice={voice} onOpenSetup={() => onNavigate("setup", "setup/family-voice")} />
      {error && <p className="settings-error">{error}</p>}

      <RosterSection roster={voice?.roster ?? []} sessions={sessions} residentProfiles={residentProfiles} />

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
