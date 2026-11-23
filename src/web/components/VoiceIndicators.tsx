import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import {
  voiceCapable, VOICE_INDICATOR_IDS, type VoiceConfig, type VoiceIndicatorId, type VoiceMode, type VoiceState,
} from "@shared/voice.ts";
import { api } from "../lib/api.ts";
import { formatChord } from "../lib/keybindings.ts";
import { updateUiConfig, useUiConfig } from "../lib/uiConfig.ts";
import { useVoiceConfig, type VoiceConfigState } from "../useVoiceConfig.ts";
import { Keycap } from "./Keycap.tsx";
import { Tooltip } from "./Tooltip.tsx";

export const VoiceWindow = createContext<{
  state: VoiceState;
  settings: VoiceConfigState;
  openSetup(): void;
} | null>(null);

export function VoiceWindowProvider({ state, enabled, openSetup, children }: {
  state: VoiceState | null; enabled: boolean; openSetup(): void; children: ReactNode;
}) {
  const { config, update, error } = useVoiceConfig(enabled);
  const value = useMemo(() => enabled && state ? {
    state, settings: { config, update, error }, openSetup,
  } : null, [enabled, state, config, update, error, openSetup]);
  return <VoiceWindow.Provider value={value}>{children}</VoiceWindow.Provider>;
}

export function hotkeyShown(state: VoiceState, config: VoiceConfig | null): boolean {
  return voiceCapable(state, "hotkey") && !state.hotkeyError && !!config?.hotkey;
}

const modes = {
  listening: ["Listening", "Say a name, then your message.", "M8 1.5a2 2 0 0 0-2 2v4a2 2 0 0 0 4 0v-4a2 2 0 0 0-2-2z M4 7.5a4 4 0 0 0 8 0M8 11.5v3M5.5 14.5h5"],
  muted: ["Muted", "Nothing is heard until you unmute.", "M10 6V3.5a2 2 0 0 0-3.7-1M6 6v1.5a2 2 0 0 0 3 1.7 M4 7.5a4 4 0 0 0 6.3 3.3M12 7.5a4 4 0 0 1-.3 1.5M8 11.5v3M5.5 14.5h5M2 1.5l12 13"],
  "auto-muted": ["On a call", "Another app is using the microphone.", "M3 2.5h2.5l1 3-1.5 1a7 7 0 0 0 3.5 3.5l1-1.5 3 1V12a1.5 1.5 0 0 1-1.5 1.5A9.5 9.5 0 0 1 1.5 4 1.5 1.5 0 0 1 3 2.5z"],
  "push-to-talk": ["Talk", "Listening while held.", "M8 3a1.7 1.7 0 0 0-1.7 1.7v3a1.7 1.7 0 0 0 3.4 0v-3A1.7 1.7 0 0 0 8 3z M4.8 8a3.2 3.2 0 0 0 6.4 0M8 11.2v2.3M2 4.5a7 7 0 0 0 0 5.5M14 4.5a7 7 0 0 1 0 5.5"],
  unavailable: ["Not listening", "Open Setup to see what voice needs.", "M8 2l6 11H2zM8 6v3m0 2v.1"],
} as const;

const styles: Record<VoiceIndicatorId, string> = {
  "status-line": "Status line", topbar: "Top-bar segment", floating: "Floating button",
  edge: "Edge light", composer: "Composer microphone",
};

export function VoiceIndicatorButton({ id, mode, chord, onClick }: {
  id: VoiceIndicatorId; mode: Exclude<VoiceMode, "off">; chord?: string; onClick?: () => void;
}): React.JSX.Element {
  const [word, hint, path] = modes[mode];
  const action = mode === "muted" ? "Unmute" : mode === "unavailable" ? "Open Setup" : "Mute";
  const keycap = chord && <Keycap chord={chord} />;
  const hold = mode === "auto-muted" && chord;
  const shortcut = hold ? <>Hold {keycap} to talk</> : <>{action} {keycap}</>;
  const name = `Voice: ${word.toLowerCase()}. ${action}`;
  const tip = `${hint} Click to ${action.toLowerCase()}.`;
  const cls = `vi vi-${id} vi-${mode}${id === "topbar" ? " pulse-seg pulse-btn" : ""}`;
  const face = <>
    <svg width="14" height="14" aria-hidden="true" viewBox="0 0 16 16"><path d={path} /></svg>
    <span className={id === "topbar" ? "tb-label" : "vi-word"}>{word}</span>
    {id === "status-line" && onClick && <><span className="vi-hint">{hint}</span><span className="vi-action">{chord ? shortcut : `Click to ${action.toLowerCase()}`}</span></>}
    {id === "floating" && onClick && <span className="vi-expanded">{hold ? <>· hold to talk {keycap}</> : <>· click to {action.toLowerCase()} {keycap}</>}</span>}
  </>;
  const button = onClick ? <Tooltip label={{
    description: `${tip}${chord ? " " + formatChord(chord) : ""}`,
    // The floating control expands into its own hint on hover or focus.
    content: id === "floating" ? null : <>{tip} {chord && shortcut}</>,
  }}><button type="button" className={cls} aria-label={name} onClick={onClick}>{face}</button></Tooltip>
    : <span className={cls}>{face}</span>;
  return id === "edge" ? <div className={`vi-edge-line vi-${mode}`}>{button}</div> : button;
}

export function useVoiceComposerHint(sessionId: string): string | null {
  const voice = useContext(VoiceWindow);
  const ui = useUiConfig();
  if (!voice || !ui.voice.indicators.includes("composer")) return null;
  const { state, settings } = voice;
  switch (state.mode) {
    case "listening": {
      const name = state.roster.find(entry => entry.sessionId === sessionId)?.name;
      return name ? `Message to send… or say "${name}, …"` : null;
    }
    case "muted": return "Voice is muted";
    case "push-to-talk": return "Listening while held";
    case "auto-muted": return hotkeyShown(state, settings.config)
      ? `On a call · hold ${formatChord(settings.config!.hotkey!)}` : "On a call";
    default: return null;
  }
}

export function VoiceIndicator({ id }: { id: VoiceIndicatorId }): React.JSX.Element | null {
  const voice = useContext(VoiceWindow);
  const ui = useUiConfig();
  const [error, setError] = useState("");
  if (!voice || voice.state.mode === "off" || !ui.voice.indicators.includes(id)) return null;
  const { state, settings, openSetup } = voice;
  const chord = state.mode !== "unavailable" && hotkeyShown(state, settings.config) ? settings.config?.hotkey : null;
  const activate = async () => {
    if (state.mode === "unavailable") return openSetup();
    const response = await api.setVoiceMuted(state.mode !== "muted");
    setError(response.ok ? "" : response.error ?? "Could not change voice mute.");
  };
  return <><VoiceIndicatorButton id={id} mode={voice.state.mode} chord={chord ?? undefined} onClick={() => void activate()} />
    {error && <span className="settings-error" role="alert">{error}</span>}</>;
}

const previewModes = ["listening", "muted", "auto-muted", "push-to-talk"] as const;

export function VoiceIndicatorSettings(): React.JSX.Element {
  const { voice } = useUiConfig();
  const [error, setError] = useState(false);
  const [saving, setSaving] = useState(false);
  return <fieldset className="settings-group vi-settings" data-anchor="voice/indicators">
    <legend className="settings-group-label">In the window</legend>
    {VOICE_INDICATOR_IDS.map(id => <div className="vi-choice" key={id}>
      <Tooltip label={`Show the ${styles[id].toLowerCase()} in the window`}><label>
        <input type="checkbox" disabled={saving} checked={voice.indicators.includes(id)} onChange={async e => {
          const indicators = e.target.checked ? [...voice.indicators, id] : voice.indicators.filter(item => item !== id);
          setSaving(true);
          setError(!await updateUiConfig({ voice: { ...voice, indicators } }));
          setSaving(false);
        }} /> {styles[id]}
      </label></Tooltip>
      <div className="vi-samples">{previewModes.map(mode => <div className="vi-sample" key={mode}>
        <VoiceIndicatorButton id={id} mode={mode} />
        {(id === "floating" || id === "composer") && modes[mode][0]}
      </div>)}</div>
    </div>)}
    {error && <p className="settings-error" role="alert">Could not save the indicator selection.</p>}
  </fieldset>;
}
